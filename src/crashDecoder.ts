import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Import trbr as a library dependency
import {
  decode,
  stringifyDecodeResult,
  createDecodeParams,
  isParsedGDBLine,
  isGDBLine,
  createCapturer,
} from 'trbr';
import type {
  Capturer,
  CapturerEvent,
  CapturerEventKind,
  DecodeOptions,
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

/**
 * Wraps trbr's Capturer to detect crash events from raw serial byte chunks.
 * Uses trbr's proven crash framing logic (handles Stack memory, register dumps,
 * Backtrace lines, and Rebooting... terminators correctly).
 */
export class TrbrCrashCapturer {
  private capturer: Capturer;
  private readonly _onCrashDetected = new vscode.EventEmitter<CrashEvent>();
  readonly onCrashDetected = this._onCrashDetected.event;
  private unsubscribe: (() => void) | undefined;

  constructor() {
    this.capturer = createCapturer({ quietPeriodMs: 500 });
    this.unsubscribe = this.capturer.on('eventDetected', (capturerEvent: CapturerEvent) => {
      const event = capturerEventToCrashEvent(capturerEvent);
      this._onCrashDetected.fire(event);
    });
  }

  /**
   * Feed raw serial bytes. trbr's capturer handles line decoding,
   * crash block framing (including Stack memory: sections), and
   * deduplication internally.
   */
  pushData(data: Buffer | Uint8Array): void {
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.capturer.push(chunk);
  }

  /**
   * Flush any pending crash block (e.g. on disconnect or clear).
   */
  flush(): void {
    this.capturer.flush();
  }

  reset(): void {
    // Create a fresh capturer instance to reset all state
    this.unsubscribe?.();
    this.capturer = createCapturer({ quietPeriodMs: 500 });
    this.unsubscribe = this.capturer.on('eventDetected', (capturerEvent: CapturerEvent) => {
      const event = capturerEventToCrashEvent(capturerEvent);
      this._onCrashDetected.fire(event);
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this._onCrashDetected.dispose();
  }
}

/**
 * Convert a trbr CapturerEvent to our CrashEvent interface.
 */
function capturerEventToCrashEvent(ce: CapturerEvent): CrashEvent {
  return {
    id: ce.id,
    kind: ce.kind as 'xtensa' | 'riscv' | 'unknown',
    lines: ce.lines,
    rawText: ce.rawText,
    timestamp: ce.lastSeenAt,
  };
}

/**
 * Logger interface for structured decode logging.
 * When an OutputChannel is provided, all trbr debug output and decode
 * diagnostics are written there so users can inspect failures.
 */
export interface DecodeLogger {
  appendLine(value: string): void;
}

/**
 * Decode a crash event using the trbr library directly.
 * @param log - optional OutputChannel / logger; when provided, trbr's internal
 *              debug output and all decode diagnostics are streamed to it.
 */
export async function decodeCrash(
  crashEvent: CrashEvent,
  elfPath: string,
  toolPath?: string,
  targetArch?: string,
  log?: DecodeLogger
): Promise<DecodedCrash> {
  const abortController = new AbortController();
  const write = (msg: string) => {
    log?.appendLine(msg);
  };

  if (!toolPath) {
    write('[ESP Decoder] No toolPath (GDB/addr2line) configured — returning raw decode');
    return createRawDecode(crashEvent.rawText);
  }

  try {
    // Resolve target architecture to a value trbr understands
    const resolvedArch = resolveTargetArch(targetArch, crashEvent.kind);
    write(`[ESP Decoder] Resolved target arch: ${resolvedArch} (config=${targetArch ?? 'auto'}, crashKind=${crashEvent.kind})`);

    // Build DecodeParams via trbr's createDecodeParams
    let params: any;
    try {
      params = await createDecodeParams({
        elfPath,
        toolPath,
        targetArch: resolvedArch as any,
      });
      write(`[ESP Decoder] createDecodeParams OK`);
    } catch (e) {
      write(`[ESP Decoder] createDecodeParams failed, using raw params: ${e instanceof Error ? e.message : String(e)}`);
      params = { elfPath, toolPath, targetArch: resolvedArch };
    }

    write(`[ESP Decoder] Calling trbr decode — elfPath=${params.elfPath}, toolPath=${params.toolPath}, targetArch=${params.targetArch}`);
    write(`[ESP Decoder] Crash input (${crashEvent.rawText.length} chars, ${crashEvent.lines.length} lines, kind=${crashEvent.kind})`);

    // Build decode options with trbr debug callback routed to the output channel
    const decodeOptions: DecodeOptions = {
      signal: abortController.signal,
      debug: (formatter: any, ...args: any[]) => {
        // Format debug output: trbr passes a prefix string + args
        const parts = [String(formatter), ...args.map((a: any) => {
          if (typeof a === 'string') { return a; }
          try { return JSON.stringify(a); } catch { return String(a); }
        })];
        write(`[trbr] ${parts.join(' ')}`);
      },
    };

    const result = await decode(params, crashEvent.rawText, decodeOptions);

    const decRes = Array.isArray(result) ? result[0]?.result ?? result[0] : result;
    const summary = {
      stacktraceLinesCount: decRes?.stacktraceLines?.length ?? 0,
      hasFaultInfo: !!decRes?.faultInfo,
      faultMessage: decRes?.faultInfo?.faultMessage,
      hasRegs: !!decRes?.regs,
      regCount: decRes?.regs ? Object.keys(decRes.regs).length : 0,
      isCoredumpResult: Array.isArray(result),
    };
    write(`[ESP Decoder] trbr decode result: ${JSON.stringify(summary)}`);

    if (summary.stacktraceLinesCount === 0) {
      write('[ESP Decoder] WARNING: trbr returned 0 stacktrace lines — the GDB server/client may have failed to unwind the stack. Check that toolPath points to a working GDB and the ELF matches the firmware.');
    }

    // Convert trbr's DecodeResult to our DecodedCrash format
    const decoded = convertDecodeResult(result, crashEvent.rawText);

    // For RISC-V crashes: enhance with heuristic stack analysis when
    // trbr's GDB-server-based unwinding yields few frames.
    // The panic GDB server only serves stack RAM data — code/flash reads
    // return 0x00, preventing GDB from analyzing function prologues to
    // unwind the full call chain.  We extract candidate return addresses
    // from the Stack memory dump and resolve them via GDB batch mode.
    if (
      crashEvent.kind === 'riscv' &&
      decoded.stacktrace.length <= 3 &&
      /Stack memory:/i.test(crashEvent.rawText) &&
      toolPath
    ) {
      await enhanceWithHeuristicStackFrames(decoded, crashEvent, elfPath, toolPath, log);
    }

    return decoded;
  } catch (err) {
    const errMsg = err instanceof Error ? err.stack || err.message : String(err);
    write(`[ESP Decoder] trbr decode FAILED: ${errMsg}`);
    write('[ESP Decoder] Falling back to raw crash text parsing');
    return createRawDecode(crashEvent.rawText);
  }
}

/**
 * Valid trbr target architectures.
 */
const VALID_TRBR_TARGETS = ['xtensa', 'esp32c2', 'esp32c3', 'esp32c6', 'esp32h2', 'esp32h4', 'esp32p4'] as const;

/**
 * Resolve the target architecture from config and crash kind.
 * Must return a value from trbr's supported arches:
 *   'xtensa' | 'esp32c2' | 'esp32c3' | 'esp32c6' | 'esp32h2' | 'esp32h4' | 'esp32p4'
 */
function resolveTargetArch(
  configArch: string | undefined,
  crashKind: 'xtensa' | 'riscv' | 'unknown'
): string {
  if (configArch && configArch !== 'auto') {
    // Map legacy 'riscv32' to a concrete trbr target (default esp32c3)
    if (configArch === 'riscv32') {
      return 'esp32c3';
    }
    // Pass through if it's already a valid trbr target
    if ((VALID_TRBR_TARGETS as readonly string[]).includes(configArch)) {
      return configArch;
    }
    // Unknown arch, fall through to auto-detect
  }
  switch (crashKind) {
    case 'riscv':
      return 'esp32c3'; // default RISC-V target
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
 * Extract candidate return addresses from a RISC-V Stack memory hex dump.
 * Returns deduplicated addresses that fall within ESP code space (0x40000000–0x4FFFFFFF).
 */
function extractStackCandidateAddresses(crashText: string): string[] {
  const seen = new Set<number>();
  const addresses: string[] = [];
  const lines = crashText.split('\n');
  let inStackMemory = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Stack memory:/i.test(trimmed)) {
      inStackMemory = true;
      continue;
    }
    if (inStackMemory) {
      // Stack memory lines: "3fcc3460: 0x00000001 0x420529d0 0x3fcc3490 ..."
      const hexMatch = trimmed.match(/^[0-9a-fA-F]+:\s*((?:0x[0-9a-fA-F]+\s*)+)/);
      if (hexMatch) {
        const words = hexMatch[1].trim().split(/\s+/);
        for (const word of words) {
          const val = parseInt(word, 16);
          // Code space: 0x40000000–0x4FFFFFFF (covers flash-mapped code on all ESP chips)
          if (val >= 0x40000000 && val < 0x50000000 && !seen.has(val)) {
            seen.add(val);
            addresses.push(`0x${val.toString(16).padStart(8, '0')}`);
          }
        }
      } else {
        inStackMemory = false;
      }
    }
  }

  return addresses;
}

/**
 * Derive the addr2line binary path from a GDB binary path.
 *
 * Strategy (mirrors exec_decode.py's setup_paths approach):
 *   1. Replace '-gdb' with '-addr2line' in the filename and check the same directory.
 *   2. Navigate up to the PlatformIO packages directory and search toolchain-* packages
 *      for a matching addr2line binary.
 *
 * Examples:
 *   riscv32-esp-elf-gdb   → riscv32-esp-elf-addr2line
 *   xtensa-esp32-elf-gdb  → xtensa-esp32-elf-addr2line
 */
function deriveAddr2linePath(gdbPath: string, log?: DecodeLogger): string | undefined {
  const basename = path.basename(gdbPath);
  if (!basename.includes('-gdb')) {
    log?.appendLine(`[ESP Decoder] Cannot derive addr2line from '${basename}' — no '-gdb' suffix`);
    return undefined;
  }

  // Replace -gdb (or -gdb.exe) with -addr2line (keeping .exe if present)
  const addr2lineName = basename.replace(/-gdb(\.exe)?$/, '-addr2line$1');

  // 1. Same directory as GDB binary
  const sameDir = path.join(path.dirname(gdbPath), addr2lineName);
  if (fs.existsSync(sameDir)) {
    log?.appendLine(`[ESP Decoder] addr2line found next to GDB: ${sameDir}`);
    return sameDir;
  }

  // 2. Navigate to PlatformIO packages dir and search toolchain packages.
  //    GDB lives at: .../packages/tool-<arch>-gdb/bin/<arch>-gdb
  const packagesDir = path.dirname(path.dirname(path.dirname(gdbPath)));
  try {
    const entries = fs.readdirSync(packagesDir);
    for (const entry of entries) {
      if (entry.startsWith('toolchain-')) {
        const candidate = path.join(packagesDir, entry, 'bin', addr2lineName);
        if (fs.existsSync(candidate)) {
          log?.appendLine(`[ESP Decoder] addr2line found in toolchain: ${candidate}`);
          return candidate;
        }
      }
    }
  } catch { /* packagesDir might not exist or not be readable */ }

  log?.appendLine(`[ESP Decoder] addr2line not found for GDB '${gdbPath}'`);
  return undefined;
}

/**
 * Regex matching addr2line address header lines (same as exec_decode.py _ADDR2LINE_HEADER_RE).
 */
const ADDR2LINE_HEADER_RE = /^0x[0-9a-fA-F]+$/;

/**
 * Regex to strip discriminator annotations from addr2line output.
 */
const DISCRIMINATOR_RE = /\s*\(discriminator \d+\)/;

/**
 * Resolve candidate addresses to function/file/line using addr2line in batch mode.
 *
 * Uses the same `-fiaC` flags and output parsing as exec_decode.py's _decode_batch().
 * Each address is decremented by 1 (return-address convention) so addr2line reports
 * the call site instead of the instruction after the call.
 *
 * This is the heuristic fallback for RISC-V crashes where trbr's GDB-server-based
 * unwinding yields few frames (because the panic GDB server only serves stack RAM –
 * code/flash memory reads return 0x00, preventing prologue analysis).
 */
async function resolveAddressesViaAddr2line(
  candidateAddrs: string[],
  elfPath: string,
  addr2linePath: string,
  log?: DecodeLogger,
): Promise<StackFrame[]> {
  if (candidateAddrs.length === 0) { return []; }

  // Limit to 200 addresses to keep command-line length reasonable
  const addrs = candidateAddrs.slice(0, 200);

  // Decrement each address by 1 (return-address → call-site, like exec_decode.py)
  const lookupAddrs = addrs.map(a => {
    const val = parseInt(a, 16) - 1;
    return `0x${(val >>> 0).toString(16).padStart(8, '0')}`;
  });

  // Build args: addr2line -fiaC -e <elf> <addr1> <addr2> ...
  const args = ['-fiaC', '-e', elfPath, ...lookupAddrs];

  try {
    const { stdout } = await execFileAsync(addr2linePath, args, { timeout: 15000 });
    log?.appendLine(
      `[ESP Decoder] addr2line batch: ${stdout.length} chars output for ${addrs.length} addresses`
    );

    // Parse output using exec_decode.py's state-machine approach:
    //   Split into sections by address header lines (0x...),
    //   then parse function / file:line pairs from each section body.
    const rawLines = stdout.split('\n');
    const sections: string[][] = [];
    let currentBody: string[] = [];

    for (const rawLine of rawLines) {
      const stripped = rawLine.trim();
      if (!stripped) { continue; }
      if (ADDR2LINE_HEADER_RE.test(stripped)) {
        sections.push(currentBody);
        currentBody = [];
      } else {
        currentBody.push(stripped);
      }
    }
    sections.push(currentBody);

    // First section (before first address header) is empty — skip it
    const bodySections = sections.slice(1);

    const frames: StackFrame[] = [];

    for (let i = 0; i < addrs.length && i < bodySections.length; i++) {
      const originalAddr = addrs[i];
      const body = bodySections[i];

      // Parse function / file:line pairs (same logic as exec_decode.py _finalize_batch_entry)
      let j = 0;
      let funcName: string | undefined;
      let file: string | undefined;
      let lineNum: string | undefined;

      while (j + 1 < body.length) {
        const func = body[j];
        const loc = DISCRIMINATOR_RE.test(body[j + 1])
          ? body[j + 1].replace(DISCRIMINATOR_RE, '')
          : body[j + 1];

        if (func === '??' && loc.startsWith('??:')) {
          j += 2;
          continue;
        }

        // Take the first resolved (non-inlined) frame
        if (!funcName) {
          funcName = func;
          const colonIdx = loc.lastIndexOf(':');
          if (colonIdx > 0) {
            file = loc.substring(0, colonIdx);
            const ln = loc.substring(colonIdx + 1);
            lineNum = ln && ln !== '0' && ln !== '?' ? ln : undefined;
          }
        }
        j += 2;
      }

      if (funcName) {
        frames.push({
          address: originalAddr,
          function: funcName,
          file,
          line: lineNum,
        });
      }
    }

    return frames;
  } catch (err) {
    log?.appendLine(
      `[ESP Decoder] addr2line batch failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

/**
 * Fallback: resolve candidate addresses via GDB batch mode (echo markers + info line/symbol).
 * Used when addr2line binary is not available.
 */
async function resolveAddressesViaGdb(
  candidateAddrs: string[],
  elfPath: string,
  gdbPath: string,
  log?: DecodeLogger,
): Promise<StackFrame[]> {
  if (candidateAddrs.length === 0) { return []; }

  const addrs = candidateAddrs.slice(0, 200);
  const exArgs: string[] = ['--batch', '-n', elfPath, '-ex', 'set print demangle on'];
  for (const addr of addrs) {
    exArgs.push('-ex', `echo >>>${addr}\\n`);
    exArgs.push('-ex', `info line *${addr}`);
    exArgs.push('-ex', `info symbol ${addr}`);
  }
  exArgs.push('-ex', 'echo >>>END\\n');

  try {
    const { stdout } = await execFileAsync(gdbPath, exArgs, { timeout: 15000 });
    log?.appendLine(`[ESP Decoder] GDB batch resolve: ${stdout.length} chars output for ${addrs.length} addresses`);

    const frames: StackFrame[] = [];
    const sections = stdout.split(/^>>>(0x[0-9a-fA-F]+)$/m);

    for (let i = 1; i < sections.length - 1; i += 2) {
      const addr = sections[i];
      const content = sections[i + 1] || '';

      const lineMatch = content.match(
        /^Line\s+(\d+)\s+of\s+"([^"]+)"\s+starts at address\s+0x[0-9a-fA-F]+\s*(?:<([^>+]+))?/m
      );
      const symbolMatch = content.match(
        /^(.+?)\s+(?:\+\s*\d+\s+)?in section\s+/m
      );

      const funcName = lineMatch?.[3]?.trim() || symbolMatch?.[1]?.trim();
      const file = lineMatch?.[2];
      const lineNum = lineMatch?.[1];

      if (funcName) {
        frames.push({
          address: addr,
          function: funcName,
          file,
          line: lineNum && lineNum !== '0' ? lineNum : undefined,
        });
      }
    }

    return frames;
  } catch (err) {
    log?.appendLine(
      `[ESP Decoder] GDB batch resolve failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

/**
 * Enhance a decoded RISC-V crash with heuristic stack-extracted frames when
 * trbr's GDB-server-based unwinding yields few frames.
 * Mutates the decoded object by appending heuristic frames to its stacktrace.
 */
async function enhanceWithHeuristicStackFrames(
  decoded: DecodedCrash,
  crashEvent: CrashEvent,
  elfPath: string,
  toolPath: string,
  log?: DecodeLogger,
): Promise<void> {
  const write = (msg: string) => log?.appendLine(msg);

  const candidateAddrs = extractStackCandidateAddresses(crashEvent.rawText);

  // Remove addresses already in the resolved stacktrace
  const existingAddrs = new Set(
    decoded.stacktrace.map(f => parseInt(f.address, 16))
  );
  const newAddrs = candidateAddrs.filter(a => !existingAddrs.has(parseInt(a, 16)));

  if (newAddrs.length === 0) {
    write?.('[ESP Decoder] RISC-V heuristic: no new candidate addresses from stack dump');
    return;
  }

  write?.(
    `[ESP Decoder] RISC-V heuristic: only ${decoded.stacktrace.length} GDB frames — resolving ${newAddrs.length} candidate stack addresses`
  );

  // Prefer addr2line (fast, like exec_decode.py) — fall back to GDB batch if not found
  let heuristicFrames: StackFrame[] = [];
  const addr2linePath = deriveAddr2linePath(toolPath, log);

  if (addr2linePath) {
    write?.(`[ESP Decoder] Using addr2line for heuristic resolution: ${addr2linePath}`);
    heuristicFrames = await resolveAddressesViaAddr2line(newAddrs, elfPath, addr2linePath, log);
  } else {
    write?.('[ESP Decoder] addr2line not found — falling back to GDB batch mode');
    heuristicFrames = await resolveAddressesViaGdb(newAddrs, elfPath, toolPath, log);
  }

  if (heuristicFrames.length > 0) {
    write?.(
      `[ESP Decoder] Heuristic: resolved ${heuristicFrames.length} additional frames from stack memory`
    );
    // Append with a separator so the UI can distinguish GDB-unwound vs heuristic frames
    decoded.stacktrace.push(
      { address: '---', function: '— heuristic stack analysis (from stack memory dump) —' },
      ...heuristicFrames,
    );
  } else {
    write?.('[ESP Decoder] Heuristic: no candidate addresses resolved to known functions');
  }
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

  const frames: StackFrame[] = [];

  // Try Xtensa-style backtrace: 0xADDR:0xADDR pairs
  const btMatch = crashText.match(/Backtrace:\s*((?:0x[0-9a-fA-F]+[:\s]*)+)/i);
  if (btMatch) {
    const pairs = btMatch[1].trim().split(/\s+/);
    for (const pair of pairs) {
      const addr = pair.split(':')[0];
      if (addr) {
        frames.push({ address: addr });
      }
    }
  }

  // If no backtrace frames found, extract addresses from Stack memory dump (RISC-V)
  if (frames.length === 0) {
    const lines = crashText.split('\n');
    let inStackMemory = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^Stack memory:/i.test(trimmed)) {
        inStackMemory = true;
        continue;
      }
      if (inStackMemory) {
        const hexMatch = trimmed.match(/^[0-9a-fA-F]+:\s*((?:0x[0-9a-fA-F]+\s*)+)/);
        if (hexMatch) {
          const addrs = hexMatch[1].trim().split(/\s+/);
          for (const addr of addrs) {
            const val = parseInt(addr, 16);
            // Heuristic: addresses in code space (0x4000_0000+) are likely return addresses
            if (val >= 0x40000000) {
              frames.push({ address: addr });
            }
          }
        } else {
          inStackMemory = false;
        }
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
