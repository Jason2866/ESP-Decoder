import * as vscode from 'vscode';

// Import trbr as a library dependency
import {
  decode,
  stringifyDecodeResult,
  createDecodeParams,
  isParsedGDBLine,
  isGDBLine,
} from 'trbr';

/**
 * Represents a captured crash event from serial data.
 */
export interface CrashEvent {
  id: string;
  kind: 'xtensa' | 'riscv' | 'unknown';
  lines: string[];
  rawText: string;
  timestamp: number;
  decoded?: DecodedCrash;
}

/**
 * Decoded crash information.
 */
export interface DecodedCrash {
  faultInfo?: {
    coreId: number;
    programCounter?: string;
    faultAddr?: string;
    faultCode?: number;
    faultMessage?: string;
  };
  stacktrace: StackFrame[];
  regs?: Record<string, number>;
  allocInfo?: {
    allocAddr: string;
    allocSize: number;
  };
  rawOutput: string;
}

export interface StackFrame {
  address: string;
  function?: string;
  file?: string;
  line?: string;
}

// Pattern matchers for ESP crash output
const XTENSA_BACKTRACE_RE = /^Backtrace:\s*(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+\s*)+/;
const RISCV_BACKTRACE_RE = /^Backtrace:\s*(0x[0-9a-fA-F]+\s*)+/;
const PANIC_RE = /^(Guru Meditation Error|abort\(\)|Panic|LoadProhibited|StoreProhibited|InstrFetchProhibited|LoadStoreAlignment|LoadStoreError|IllegalInstruction)/i;
const EXCEPTION_RE = /^Exception was unhandled/i;
const ASSERT_RE = /^assert failed:/i;
const STACK_DUMP_RE = /^Stack memory:/i;
const REGISTER_RE = /^(EPC\d|EXCVADDR|EXCCAUSE|MTVAL|MEPC|MCAUSE|SP|A\d+|RA|GP|TP|S\d+|T\d+)[\s:]+0x[0-9a-fA-F]+/i;
const CRASH_FREE_HEAP_RE = /^last failed alloc/i;

// Crash block detection
const CRASH_START_PATTERNS = [
  /^Guru Meditation Error/i,
  /^abort\(\) was called/i,
  /^Backtrace:/i,
  /^assert failed:/i,
  /^Exception was unhandled/i,
  /^Panic /i,
  /^Stack smashing protect failure/i,
  /^LoadProhibited/i,
  /^StoreProhibited/i,
  /^InstrFetchProhibited/i,
  /^rst:0x/i,
];

const CRASH_END_PATTERNS = [
  /^Rebooting\.\.\./i,
  /^ets [A-Z]/i,
  /^ets_main\.c/i,
  /^ESP-ROM:/i,
  /^=+$/,
];

/**
 * Crash detector that buffers serial lines and detects crash blocks.
 */
export class CrashDetector {
  private buffer: string[] = [];
  private inCrashBlock = false;
  private crashLines: string[] = [];
  private quietTimer: NodeJS.Timeout | undefined;
  private nextId = 1;

  private readonly _onCrashDetected = new vscode.EventEmitter<CrashEvent>();
  readonly onCrashDetected = this._onCrashDetected.event;

  pushLine(line: string): void {
    this.buffer.push(line);

    // Trim buffer
    while (this.buffer.length > 10000) {
      this.buffer.shift();
    }

    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    if (!this.inCrashBlock) {
      // Check if this line starts a crash block
      if (CRASH_START_PATTERNS.some((p) => p.test(trimmed))) {
        this.inCrashBlock = true;
        this.crashLines = [trimmed];
        this.resetQuietTimer();
        return;
      }
    }

    if (this.inCrashBlock) {
      this.crashLines.push(trimmed);
      this.resetQuietTimer();

      // Check if this line ends the crash block
      if (CRASH_END_PATTERNS.some((p) => p.test(trimmed))) {
        this.finalizeCrashBlock();
      }
    }
  }

  private resetQuietTimer(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
    }
    this.quietTimer = setTimeout(() => {
      if (this.inCrashBlock && this.crashLines.length > 0) {
        this.finalizeCrashBlock();
      }
    }, 500);
  }

  private finalizeCrashBlock(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = undefined;
    }

    if (this.crashLines.length === 0) {
      this.inCrashBlock = false;
      return;
    }

    const rawText = this.crashLines.join('\n');
    const kind = this.detectKind(this.crashLines);

    const event: CrashEvent = {
      id: `crash-${String(this.nextId++).padStart(4, '0')}`,
      kind,
      lines: [...this.crashLines],
      rawText,
      timestamp: Date.now(),
    };

    this.inCrashBlock = false;
    this.crashLines = [];
    this._onCrashDetected.fire(event);
  }

  private detectKind(lines: string[]): 'xtensa' | 'riscv' | 'unknown' {
    const text = lines.join('\n');
    if (/MEPC|MCAUSE|MTVAL|riscv/i.test(text)) {
      return 'riscv';
    }
    if (/EPC\d|EXCVADDR|EXCCAUSE|Backtrace:.*0x[0-9a-fA-F]+:0x[0-9a-fA-F]+/i.test(text)) {
      return 'xtensa';
    }
    if (/Backtrace:/i.test(text)) {
      return 'xtensa'; // default to xtensa for backtrace
    }
    return 'unknown';
  }

  reset(): void {
    this.buffer = [];
    this.inCrashBlock = false;
    this.crashLines = [];
    this.nextId = 1;
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = undefined;
    }
  }

  dispose(): void {
    this.reset();
    this._onCrashDetected.dispose();
  }
}

/**
 * Decode a crash event using the trbr library directly.
 */
export async function decodeCrash(
  crashEvent: CrashEvent,
  elfPath: string,
  toolPath?: string,
  targetArch?: string
): Promise<DecodedCrash> {
  const abortController = new AbortController();

  try {
    // Resolve target architecture
    const resolvedArch = resolveTargetArch(targetArch, crashEvent.kind);

    // Build DecodeParams via trbr's createDecodeParams if we have a toolPath
    let params: any;
    if (toolPath) {
      try {
        params = await createDecodeParams({
          elfPath,
          toolPath,
          targetArch: resolvedArch as any,
        });
      } catch {
        // Fallback to raw params
        params = { elfPath, toolPath, targetArch: resolvedArch };
      }
    } else {
      params = { elfPath, toolPath: '', targetArch: resolvedArch };
    }

    // Use trbr's decode() with the crash text as input
    const result = await decode(params, crashEvent.rawText, {
      signal: abortController.signal,
    });

    // Convert trbr's DecodeResult to our DecodedCrash format
    return convertDecodeResult(result, crashEvent.rawText);
  } catch (err) {
    // If trbr decode fails, return a raw parse as fallback
    console.error('trbr decode error:', err);
    return createRawDecode(crashEvent.rawText);
  }
}

/**
 * Resolve the target architecture from config and crash kind.
 */
function resolveTargetArch(
  configArch: string | undefined,
  crashKind: 'xtensa' | 'riscv' | 'unknown'
): string {
  if (configArch && configArch !== 'auto') {
    return configArch;
  }
  switch (crashKind) {
    case 'riscv':
      return 'riscv32';
    case 'xtensa':
      return 'xtensa';
    default:
      return 'xtensa';
  }
}

/**
 * Convert trbr's DecodeResult (or CoredumpDecodeResult) to our DecodedCrash format.
 */
function convertDecodeResult(result: any, crashText: string): DecodedCrash {
  // Get the stringified output from trbr for rawOutput
  let rawOutput: string;
  try {
    rawOutput = stringifyDecodeResult(result, { color: 'disable' });
  } catch {
    rawOutput = crashText;
  }

  // If it's a coredump result (array), take the first thread
  const decodeResult = Array.isArray(result)
    ? result[0]?.result ?? result[0]
    : result;

  if (!decodeResult) {
    return createRawDecode(crashText);
  }

  // Extract fault info
  let faultInfo: DecodedCrash['faultInfo'] | undefined;
  if (decodeResult.faultInfo) {
    const fi = decodeResult.faultInfo;
    faultInfo = {
      coreId: fi.coreId ?? 0,
      programCounter: fi.programCounter
        ? stringifyAddrLocation(fi.programCounter.location ?? fi.programCounter)
        : undefined,
      faultAddr: fi.faultAddr
        ? stringifyAddrLocation(fi.faultAddr.location ?? fi.faultAddr)
        : undefined,
      faultCode: fi.faultCode,
      faultMessage: fi.faultMessage,
    };
  }

  // Extract stack trace from trbr's stacktraceLines
  const stacktrace: StackFrame[] = [];
  const traceLines = decodeResult.stacktraceLines ?? [];
  for (const traceLine of traceLines) {
    if (isParsedGDBLine(traceLine)) {
      stacktrace.push({
        address: traceLine.regAddr,
        function: traceLine.method,
        file: traceLine.file,
        line: traceLine.lineNumber !== '??' ? traceLine.lineNumber : undefined,
      });
    } else if (isGDBLine(traceLine)) {
      stacktrace.push({
        address: traceLine.regAddr,
        line: traceLine.lineNumber !== '??' ? traceLine.lineNumber : undefined,
      });
    } else if (typeof traceLine === 'string') {
      stacktrace.push({ address: traceLine });
    }
  }

  // Extract registers
  const regs = decodeResult.regs;

  // Extract alloc info
  let allocInfo: DecodedCrash['allocInfo'] | undefined;
  if (decodeResult.allocInfo) {
    allocInfo = {
      allocAddr: stringifyAddrLocation(decodeResult.allocInfo.allocAddr),
      allocSize: decodeResult.allocInfo.allocSize,
    };
  }

  return {
    faultInfo,
    stacktrace,
    regs: regs && Object.keys(regs).length > 0 ? regs : undefined,
    allocInfo,
    rawOutput,
  };
}

/**
 * Stringify an addr location from trbr's types.
 */
function stringifyAddrLocation(location: any): string {
  if (!location) {
    return '??';
  }
  if (typeof location === 'string') {
    return location;
  }
  if (location.regAddr) {
    if (location.method && location.file) {
      return `${location.regAddr} in ${location.method} at ${location.file}:${location.lineNumber ?? '??'}`;
    }
    return location.regAddr;
  }
  return String(location);
}

/**
 * Parse fault information from crash text (fallback when trbr can't decode).
 */
function parseFaultInfo(text: string): DecodedCrash['faultInfo'] | undefined {
  const lines = text.split('\n');

  for (const line of lines) {
    const guruMatch = line.match(/Core\s+(\d+)\s+panic'ed\s+\(([^)]+)\)/i);
    if (guruMatch) {
      return {
        coreId: parseInt(guruMatch[1], 10),
        faultMessage: guruMatch[2],
      };
    }
  }

  for (const line of lines) {
    const epcMatch = line.match(/EPC1?\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (epcMatch) {
      return { coreId: 0, programCounter: epcMatch[1] };
    }
    const mepcMatch = line.match(/MEPC\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (mepcMatch) {
      return { coreId: 0, programCounter: mepcMatch[1] };
    }
  }

  return undefined;
}

/**
 * Parse register values from crash text (fallback).
 */
function parseRegisters(text: string): Record<string, number> {
  const regs: Record<string, number> = {};
  const regPattern =
    /\b(EPC\d|EXCVADDR|EXCCAUSE|MTVAL|MEPC|MCAUSE|SP|A\d+|RA|GP|TP|S\d+|T\d+|PC)\s*[:=]\s*(0x[0-9a-fA-F]+)/gi;

  let match;
  while ((match = regPattern.exec(text)) !== null) {
    regs[match[1].toUpperCase()] = parseInt(match[2], 16);
  }

  return regs;
}

/**
 * Create a raw (unparsed) decode result as fallback.
 */
function createRawDecode(crashText: string): DecodedCrash {
  const faultInfo = parseFaultInfo(crashText);
  const regs = parseRegisters(crashText);

  const btMatch = crashText.match(/Backtrace:\s*((?:0x[0-9a-fA-F]+[:\s]*)+)/i);
  const frames: StackFrame[] = [];
  if (btMatch) {
    const pairs = btMatch[1].trim().split(/\s+/);
    for (const pair of pairs) {
      const addr = pair.split(':')[0];
      if (addr) {
        frames.push({ address: addr });
      }
    }
  }

  return {
    faultInfo,
    stacktrace: frames,
    regs: Object.keys(regs).length > 0 ? regs : undefined,
    rawOutput: crashText,
  };
}
