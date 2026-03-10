import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
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
  DecodeOptions,
  CoredumpDecodeResult,
} from 'trbr';
import { getPioPackagesDir } from './pioIntegration';
import { Addr2linePool } from './addr2lineResolver';

// Re-export for consumers
export { Addr2linePool } from './addr2lineResolver';

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
  regAnnotations?: Record<string, string>;
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
 * Decoded coredump with per-thread crash information.
 */
export interface CoredumpDecodedResult {
  threads: ThreadDecodedCrash[];
  rawOutput: string;
}

export interface ThreadDecodedCrash {
  threadId: string;
  threadName?: string;
  isCurrent?: boolean;
  decoded: DecodedCrash;
}

/**
 * Patterns that trbr's built-in framer recognizes as crash-block starters.
 * Used to determine whether trbr will detect a crash on its own.
 */
const TRBR_START_PATTERNS = [
  /Guru Meditation Error:/i,
  /panic'ed/i,
  /^Exception\s+\(\d+\):?/i,
];

/**
 * Additional crash-start patterns that trbr's framer does NOT recognize.
 * These occur on ESP32-C6/C2/H2 (RISC-V) chips when an assert or abort
 * fires without a "Guru Meditation Error:" wrapper.
 */
const FALLBACK_START_PATTERNS = [
  /^assert failed:/i,
  /^abort\(\) was called/i,
  /^Core\s+\d+\s+register dump:/i,
];

/**
 * Wraps trbr's Capturer to detect crash events from raw serial byte chunks.
 * Uses trbr's proven crash framing logic (handles Stack memory, register dumps,
 * Backtrace lines, and Rebooting... terminators correctly).
 *
 * Includes a fallback detector for crash formats that trbr's framer doesn't
 * recognize (e.g. "assert failed:" on RISC-V chips without "Guru Meditation Error:").
 */
export class TrbrCrashCapturer {
  private capturer: Capturer;
  private readonly _onCrashDetected = new vscode.EventEmitter<CrashEvent>();
  readonly onCrashDetected = this._onCrashDetected.event;
  private unsubscribe: (() => void) | undefined;

  // Fallback detector state
  private fbLineBuffer = '';
  private fbLines: string[] = [];
  private fbActive = false;
  private fbQuietTimer: ReturnType<typeof setTimeout> | undefined;
  private fbNextId = 1;
  private trbrFiredForCurrentBlock = false;

  constructor() {
    this.capturer = createCapturer({ quietPeriodMs: 500 });
    this.unsubscribe = this.capturer.on('eventDetected', (capturerEvent: CapturerEvent) => {
      this.trbrFiredForCurrentBlock = true;
      const event = capturerEventToCrashEvent(capturerEvent);
      this._onCrashDetected.fire(event);
    });
  }

  /**
   * Feed raw serial bytes. trbr's capturer handles line decoding,
   * crash block framing (including Stack memory: sections), and
   * deduplication internally.
   *
   * Also feeds data through the fallback detector for crash patterns
   * that trbr misses.
   */
  pushData(data: Buffer | Uint8Array): void {
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.capturer.push(chunk);
    this.fbPushData(data);
  }

  /**
   * Flush any pending crash block (e.g. on disconnect or clear).
   */
  flush(): void {
    this.capturer.flush();
    this.fbFlush();
  }

  reset(): void {
    // Create a fresh capturer instance to reset all state
    this.unsubscribe?.();
    this.capturer = createCapturer({ quietPeriodMs: 500 });
    this.unsubscribe = this.capturer.on('eventDetected', (capturerEvent: CapturerEvent) => {
      this.trbrFiredForCurrentBlock = true;
      const event = capturerEventToCrashEvent(capturerEvent);
      this._onCrashDetected.fire(event);
    });
    this.fbReset();
    this.fbLineBuffer = '';
  }

  dispose(): void {
    this.unsubscribe?.();
    this.fbReset();
    this._onCrashDetected.dispose();
  }

  // --- Fallback crash detector ---
  // Catches crash blocks that trbr's framer misses (e.g. assert failures
  // on RISC-V chips that lack "Guru Meditation Error:" prefix).

  private fbPushData(data: Buffer | Uint8Array): void {
    const text = Buffer.from(data).toString('utf-8');
    this.fbLineBuffer += text;

    const parts = this.fbLineBuffer.split(/\r?\n/);
    this.fbLineBuffer = parts.pop() || '';
    for (const line of parts) {
      this.fbProcessLine(line);
    }
  }

  private fbProcessLine(line: string): void {
    if (!this.fbActive) {
      // Only start fallback for patterns that trbr wouldn't catch
      const trbrWouldCatch = TRBR_START_PATTERNS.some(p => p.test(line));
      if (trbrWouldCatch) {
        return; // trbr will handle this crash — don't duplicate
      }
      if (FALLBACK_START_PATTERNS.some(p => p.test(line))) {
        this.fbActive = true;
        this.trbrFiredForCurrentBlock = false;
        this.fbLines = [];
      }
    }

    if (this.fbActive) {
      this.fbLines.push(line);
      this.fbResetTimer();
      if (/^Rebooting\.\.\./i.test(line.trim())) {
        this.fbFinalize();
      }
    }
  }

  private fbResetTimer(): void {
    if (this.fbQuietTimer) {
      clearTimeout(this.fbQuietTimer);
    }
    // Use a slightly longer quiet period than trbr (600ms vs 500ms)
    // so trbr fires first if it's going to detect this crash.
    this.fbQuietTimer = setTimeout(() => this.fbFinalize(), 600);
  }

  private fbFinalize(): void {
    if (this.fbQuietTimer) {
      clearTimeout(this.fbQuietTimer);
      this.fbQuietTimer = undefined;
    }
    if (!this.fbActive || this.fbLines.length === 0) {
      this.fbReset();
      return;
    }
    // Only fire if trbr didn't already detect this crash
    if (!this.trbrFiredForCurrentBlock && this.fbLooksLikeCrash()) {
      const rawText = this.fbLines.join('\n');
      const kind = this.fbDetectKind();
      const event: CrashEvent = {
        id: `fallback-${String(this.fbNextId++).padStart(6, '0')}`,
        kind,
        lines: [...this.fbLines],
        rawText,
        timestamp: Date.now(),
      };
      this._onCrashDetected.fire(event);
    }
    this.fbReset();
  }

  private fbLooksLikeCrash(): boolean {
    return this.fbLines.some(l =>
      /Core\s+\d+\s+register dump:/i.test(l) ||
      /^Stack memory:/i.test(l)
    );
  }

  private fbDetectKind(): 'xtensa' | 'riscv' | 'unknown' {
    const riscvPatterns = [/MCAUSE/, /\bMEPC\b/, /MHARTID/];
    const xtensaPatterns = [/Backtrace:/, /EXCCAUSE/, /EXCVADDR/];
    if (this.fbLines.some(l => riscvPatterns.some(p => p.test(l)))) { return 'riscv'; }
    if (this.fbLines.some(l => xtensaPatterns.some(p => p.test(l)))) { return 'xtensa'; }
    return 'unknown';
  }

  private fbReset(): void {
    this.fbActive = false;
    this.fbLines = [];
    if (this.fbQuietTimer) {
      clearTimeout(this.fbQuietTimer);
      this.fbQuietTimer = undefined;
    }
  }

  private fbFlush(): void {
    if (this.fbLineBuffer) {
      this.fbProcessLine(this.fbLineBuffer);
      this.fbLineBuffer = '';
    }
    this.fbFinalize();
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
  log?: DecodeLogger,
  romElfPath?: string,
  addr2linePool?: Addr2linePool,
): Promise<DecodedCrash> {
  const abortController = new AbortController();
  const write = (msg: string) => {
    log?.appendLine(msg);
  };

  if (!toolPath) {
    toolPath = autoDetectPioToolPath(crashEvent.kind, log);
    if (!toolPath) {
      write('[ESP Decoder] No toolPath (GDB/addr2line) found — returning raw decode');
      return createRawDecode(crashEvent.rawText);
    }
  }

  try {
    // Resolve target architecture to a value trbr understands
    const resolvedArch = resolveTargetArch(targetArch, crashEvent.kind);

    // === Xtensa fast-path: resolve backtrace addresses directly via addr2line ===
    if (crashEvent.kind === 'xtensa' && /Backtrace:/i.test(crashEvent.rawText)) {
      const addr2linePath = deriveAddr2linePath(toolPath!, log);
      if (addr2linePath) {
        const btAddrs = extractXtensaBacktraceAddresses(crashEvent.rawText);
        if (btAddrs.length > 0) {
          const faultInfo = parseXtensaFaultInfo(crashEvent.rawText);
          const regs = parseRegisters(crashEvent.rawText);
          const hasRegs = Object.keys(regs).length > 0;

          // Resolve backtrace frames and register annotations in parallel
          const [frames, regAnnotations] = await Promise.all([
            resolveAddressesViaAddr2line(btAddrs, elfPath, addr2linePath, log, romElfPath, addr2linePool),
            hasRegs
              ? resolveRegisterAddresses(regs, elfPath, addr2linePath, log, romElfPath)
              : Promise.resolve(undefined),
          ]);

          if (frames.length > 0) {
            return {
              faultInfo,
              stacktrace: frames,
              regs: hasRegs ? regs : undefined,
              regAnnotations,
              rawOutput: '',
            };
          }
        }
      }
    }

    // Build DecodeParams via trbr's createDecodeParams
    let params: any;
    try {
      params = await createDecodeParams({
        elfPath,
        toolPath,
        targetArch: resolvedArch as any,
      });
    } catch (e) {
      write(`[ESP Decoder] createDecodeParams failed, using raw params: ${e instanceof Error ? e.message : String(e)}`);
      params = { elfPath, toolPath, targetArch: resolvedArch };
    }

    // Build decode options
    const decodeOptions: DecodeOptions = {
      signal: abortController.signal,
    };

    const result = await decode(params, crashEvent.rawText, decodeOptions);

    const decRes = Array.isArray(result) ? result[0]?.result ?? result[0] : result;

    if ((decRes?.stacktraceLines?.length ?? 0) === 0) {
      write('[ESP Decoder] WARNING: trbr returned 0 stacktrace lines — check that toolPath points to a working GDB and the ELF matches the firmware.');
    }

    // Convert trbr's DecodeResult to our DecodedCrash format
    const decoded = convertDecodeResult(result, crashEvent.rawText);

    // Post-processing: heuristic stack enhancement (RISC-V) + register annotations.
    // These use independent addr2line invocations, so run them in parallel.
    const postProcessTasks: Promise<void>[] = [];

    // For RISC-V crashes: enhance with heuristic stack analysis when
    // trbr's GDB-server-based unwinding yields few frames.
    if (
      crashEvent.kind === 'riscv' &&
      /Stack memory:/i.test(crashEvent.rawText) &&
      toolPath
    ) {
      postProcessTasks.push(
        enhanceWithHeuristicStackFrames(decoded, crashEvent, elfPath, toolPath, log, romElfPath, addr2linePool)
      );
    }

    // Resolve register addresses to source locations
    if (decoded.regs && toolPath) {
      const addr2lineForRegs = deriveAddr2linePath(toolPath, log);
      if (addr2lineForRegs) {
        postProcessTasks.push(
          resolveRegisterAddresses(decoded.regs, elfPath, addr2lineForRegs, log, romElfPath)
            .then(annotations => { decoded.regAnnotations = annotations; })
        );
      }
    }

    if (postProcessTasks.length > 0) {
      await Promise.all(postProcessTasks);
    }

    return decoded;
  } catch (err) {
    const errMsg = err instanceof Error ? err.stack || err.message : String(err);
    write(`[ESP Decoder] decode failed: ${errMsg}`);
    return createRawDecode(crashEvent.rawText);
  }
}

/**
 * Decode an ESP coredump file using trbr's coredump mode.
 * Supports both ELF format and base64-encoded (b64) format.
 * For b64 files, the content is decoded to a temporary ELF file before passing
 * to trbr. The b64 format is used by ESP-IDF's esp-coredump tool and may
 * contain serial markers (CORE DUMP START / CORE DUMP END).
 *
 * @param coredumpPath - Path to the coredump file (ELF or b64)
 * @param elfPath - Path to the firmware ELF file (with debug symbols)
 * @param toolPath - Optional path to GDB binary
 * @param targetArch - Optional target architecture
 * @param log - Optional logger
 */
export async function decodeCoredumpElf(
  coredumpPath: string,
  elfPath: string,
  toolPath?: string,
  targetArch?: string,
  log?: DecodeLogger,
): Promise<CoredumpDecodedResult> {
  const write = (msg: string) => log?.appendLine(msg);

  // Detect whether the file is b64-encoded and convert if necessary
  const resolvedPath = await resolveCoredumpPath(coredumpPath, log);
  const needsCleanup = resolvedPath !== coredumpPath;

  try {
    return await decodeCoredumpElfInternal(resolvedPath, elfPath, toolPath, targetArch, log);
  } finally {
    if (needsCleanup) {
      // Clean up temporary decoded file
      try {
        await fsPromises.unlink(resolvedPath);
        const tmpDir = path.dirname(resolvedPath);
        await fsPromises.rmdir(tmpDir).catch(() => {});
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Decode a base64-encoded coredump from raw text content (e.g. pasted from serial).
 * Extracts the base64 payload (optionally between CORE DUMP START/END markers),
 * decodes it, and passes the resulting ELF to trbr's coredump decoder.
 *
 * @param b64Content - Base64-encoded coredump text (with or without markers)
 * @param elfPath - Path to the firmware ELF file (with debug symbols)
 * @param toolPath - Optional path to GDB binary
 * @param targetArch - Optional target architecture
 * @param log - Optional logger
 */
export async function decodeCoredumpBase64(
  b64Content: string,
  elfPath: string,
  toolPath?: string,
  targetArch?: string,
  log?: DecodeLogger,
): Promise<CoredumpDecodedResult> {
  const write = (msg: string) => log?.appendLine(msg);

  const binary = decodeBase64Payload(b64Content);
  if (!binary) {
    write('[ESP Decoder] No valid base64 coredump content found');
    return {
      threads: [],
      rawOutput: 'No valid base64 coredump content found in the provided text.',
    };
  }

  // Write decoded binary to temp file
  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'esp-coredump-'));
  const tmpPath = path.join(tmpDir, 'coredump.elf');
  try {
    await fsPromises.writeFile(tmpPath, binary);
    write(`[ESP Decoder] Decoded b64 coredump to temp file: ${tmpPath} (${binary.length} bytes)`);

    return await decodeCoredumpElfInternal(tmpPath, elfPath, toolPath, targetArch, log);
  } finally {
    try {
      await fsPromises.unlink(tmpPath);
      await fsPromises.rmdir(tmpDir).catch(() => {});
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Check whether text contains an ESP coredump in base64 format.
 * Matches either:
 *  - CORE DUMP START/END markers from ESP-IDF serial output, or
 *  - a markerless block of base64 lines whose decoded payload contains an ELF core.
 */
export function containsBase64Coredump(text: string): boolean {
  if (COREDUMP_START_RE.test(text) && COREDUMP_END_RE.test(text)) {
    return true;
  }

  // Markerless detection: at least 10 consecutive base64 lines that decode to
  // a buffer containing ELF magic (possibly after an esp-coredump header).
  const base64Lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && /^[A-Za-z0-9+/=]+$/.test(l));
  if (base64Lines.length < 10) {
    return false;
  }
  try {
    const buffers = base64Lines.map(l => Buffer.from(l, 'base64'));
    const binary = Buffer.concat(buffers);
    return binary.indexOf(ELF_MAGIC) >= 0;
  } catch {
    return false;
  }
}

/** Regex for ESP-IDF coredump serial markers */
const COREDUMP_START_RE = /={10,}\s*CORE\s+DUMP\s+START\s*={10,}/;
const COREDUMP_END_RE = /={10,}\s*CORE\s+DUMP\s+END\s*={10,}/;

/** ELF magic bytes: \x7fELF */
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/**
 * Detect whether a coredump file is base64-encoded and convert to a temp ELF if so.
 * Returns the original path if already ELF, or a temp path if converted.
 */
async function resolveCoredumpPath(
  coredumpPath: string,
  log?: DecodeLogger,
): Promise<string> {
  const write = (msg: string) => log?.appendLine(msg);

  let fd;
  try {
    fd = await fsPromises.open(coredumpPath, 'r');
  } catch {
    // File doesn't exist or isn't readable — return as-is and let the caller handle the error
    return coredumpPath;
  }
  try {
    const header = Buffer.alloc(4);
    await fd.read(header, 0, 4, 0);

    if (header.compare(ELF_MAGIC, 0, 4, 0, 4) === 0) {
      // Already an ELF file
      return coredumpPath;
    }
  } finally {
    await fd.close();
  }

  // Not ELF — assume base64-encoded
  write(`[ESP Decoder] File does not start with ELF magic, treating as b64: ${coredumpPath}`);
  const raw = await fsPromises.readFile(coredumpPath, 'utf-8');
  const binary = decodeBase64Payload(raw);
  if (!binary) {
    write('[ESP Decoder] Could not extract base64 payload — passing file as-is');
    return coredumpPath;
  }

  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'esp-coredump-'));
  const tmpPath = path.join(tmpDir, 'coredump.elf');
  await fsPromises.writeFile(tmpPath, binary);
  write(`[ESP Decoder] Decoded b64 coredump to temp ELF: ${tmpPath} (${binary.length} bytes)`);
  return tmpPath;
}

/**
 * Decode base64 payload from text, stripping optional CORE DUMP START/END markers.
 * Each line is decoded independently to handle esp-coredump's per-line padding format.
 * Returns the concatenated binary data, or undefined if no valid base64 found.
 */
function decodeBase64Payload(text: string): Buffer | undefined {
  let content = text;

  // If markers are present, extract only the content between them
  const startMatch = COREDUMP_START_RE.exec(content);
  const endMatch = COREDUMP_END_RE.exec(content);
  if (startMatch && endMatch && endMatch.index > startMatch.index) {
    content = content.slice(startMatch.index + startMatch[0].length, endMatch.index);
  }

  // Filter to only valid base64 lines (ignore empty lines, markers, and other output)
  const base64Lines = content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && /^[A-Za-z0-9+/=]+$/.test(l));

  if (base64Lines.length === 0) {
    return undefined;
  }

  // Decode each line independently — esp-coredump pads each line separately
  const buffers = base64Lines.map(line => Buffer.from(line, 'base64'));
  const binary = Buffer.concat(buffers);

  // esp-coredump wraps the ELF core with a proprietary header (total_len, version, etc.).
  // Strip it by locating the embedded ELF magic.
  const elfOffset = binary.indexOf(ELF_MAGIC);
  if (elfOffset === 0) {
    return binary;
  }
  if (elfOffset > 0) {
    return binary.subarray(elfOffset);
  }
  // No ELF magic found — not a valid coredump
  return undefined;
}

/**
 * Internal coredump decode — expects an actual ELF file path.
 */
async function decodeCoredumpElfInternal(
  coredumpPath: string,
  elfPath: string,
  toolPath?: string,
  targetArch?: string,
  log?: DecodeLogger,
): Promise<CoredumpDecodedResult> {
  const write = (msg: string) => log?.appendLine(msg);

  // Detect the architecture from the firmware ELF when not explicitly configured
  const detectedArch = await detectElfArch(elfPath, log);
  const crashKind: 'xtensa' | 'riscv' | 'unknown' = detectedArch ?? 'unknown';
  write(`[ESP Decoder] Coredump: firmware ELF arch detection = ${detectedArch ?? 'unknown'}`);

  let chosenArch: 'xtensa' | 'riscv' | 'unknown' = crashKind;
  if (!toolPath) {
    // Use the detected architecture to pick the right GDB
    const primaryKind = crashKind === 'xtensa' ? 'xtensa' : crashKind === 'riscv' ? 'riscv' : 'riscv';
    const fallbackKind = primaryKind === 'riscv' ? 'xtensa' : 'riscv';
    toolPath = autoDetectPioToolPath(primaryKind, log);
    if (toolPath) {
      chosenArch = primaryKind;
    } else {
      toolPath = autoDetectPioToolPath(fallbackKind, log);
      if (toolPath) {
        chosenArch = fallbackKind;
      }
    }
    if (!toolPath) {
      write('[ESP Decoder] No toolPath (GDB) found for coredump decoding');
      return {
        threads: [],
        rawOutput: 'No GDB toolchain found. Please configure a tool path.',
      };
    }
  }

  const resolvedArch = resolveTargetArch(targetArch, chosenArch);

  try {
    // Create decode params with coredumpMode enabled
    let params: any;
    try {
      params = await createDecodeParams({
        elfPath,
        toolPath,
        targetArch: resolvedArch as any,
        coredumpMode: true,
      });
    } catch (e) {
      write(`[ESP Decoder] createDecodeParams (coredump) failed: ${e instanceof Error ? e.message : String(e)}`);
      params = { elfPath, toolPath, targetArch: resolvedArch, coredumpMode: true };
    }

    const decodeOptions: DecodeOptions = {};

    // Pass the coredump file path as DecodeInputFileSource
    const result = await decode(params, { inputPath: coredumpPath }, decodeOptions);

    // Get stringified output for rawOutput
    let rawOutput: string;
    try {
      rawOutput = stringifyDecodeResult(result, { color: 'disable' });
    } catch {
      rawOutput = '';
    }

    // Convert CoredumpDecodeResult (ThreadDecodeResult[]) to our format
    if (Array.isArray(result)) {
      if (result.length === 0) {
        return { threads: [], rawOutput };
      }
      const threads: ThreadDecodedCrash[] = result.map((threadResult: any) => {
        const decoded = convertDecodeResult(threadResult.result ?? threadResult, '');
        return {
          threadId: threadResult.threadId ?? 'unknown',
          threadName: threadResult.threadName,
          isCurrent: threadResult.current ?? false,
          decoded,
        };
      });

      return { threads, rawOutput };
    }

    // Non-array result (single thread / fallback)
    const decoded = convertDecodeResult(result, '');
    return {
      threads: [{ threadId: '0', isCurrent: true, decoded }],
      rawOutput,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.stack || err.message : String(err);
    write(`[ESP Decoder] coredump decode failed: ${errMsg}`);
    return {
      threads: [],
      rawOutput: `Coredump decode failed: ${errMsg}`,
    };
  }
}

/**
 * Try to auto-detect a GDB binary from the local PlatformIO packages directory.
 * This is used as a fallback when no toolPath is configured in the extension settings.
 *
 * RISC-V (ESP32-C2/C3/C6/H2/H4/P4):
 *   ~/.platformio/packages/tool-riscv32-esp-elf-gdb/bin/riscv32-esp-elf-gdb
 *
 * Xtensa (ESP32/ESP32-S2/ESP32-S3/ESP8266):
 *   ~/.platformio/packages/toolchain-xtensa-esp<variant>/bin/xtensa-esp<variant>-elf-gdb
 *   or the new unified: toolchain-xtensa-esp-elf
 */
function autoDetectPioToolPath(
  crashKind: 'xtensa' | 'riscv' | 'unknown',
  log?: DecodeLogger,
): string | undefined {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const pioPackagesDir = getPioPackagesDir();

  if (!pioPackagesDir) {
    log?.appendLine('[ESP Decoder] PlatformIO packages dir not found — cannot auto-detect tool');
    return undefined;
  }

  if (crashKind === 'riscv') {
    // Prefer the dedicated GDB package, fall back to the toolchain package
    const candidates = [
      path.join(pioPackagesDir, 'tool-riscv32-esp-elf-gdb', 'bin', `riscv32-esp-elf-gdb${ext}`),
      path.join(pioPackagesDir, 'toolchain-riscv32-esp', 'bin', `riscv32-esp-elf-gdb${ext}`),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { return c; }
    }
    log?.appendLine('[ESP Decoder] RISC-V GDB not found in PlatformIO packages');
    return undefined;
  }

  // Xtensa — try common variants
  const xtensaVariants = [
    { pkg: 'tool-xtensa-esp-elf-gdb',     bin: `xtensa-esp32-elf-gdb${ext}` },
    { pkg: 'tool-xtensa-esp-elf-gdb',     bin: `xtensa-esp32s3-elf-gdb${ext}` },
    { pkg: 'tool-xtensa-esp-elf-gdb',     bin: `xtensa-esp32s2-elf-gdb${ext}` },
    { pkg: 'toolchain-xtensa-esp-elf',    bin: `xtensa-esp-elf-gdb${ext}` },
    { pkg: 'toolchain-xtensa-esp32s3-elf', bin: `xtensa-esp32s3-elf-gdb${ext}` },
    { pkg: 'toolchain-xtensa-esp32-elf',   bin: `xtensa-esp32-elf-gdb${ext}` },
    { pkg: 'toolchain-xtensa-esp32s2-elf', bin: `xtensa-esp32s2-elf-gdb${ext}` },
  ];
  for (const { pkg, bin } of xtensaVariants) {
    const c = path.join(pioPackagesDir, pkg, 'bin', bin);
    if (fs.existsSync(c)) { return c; }
  }

  // Also scan for any tool-xtensa-*-gdb package (handles future variants)
  try {
    for (const entry of fs.readdirSync(pioPackagesDir)) {
      if (entry.startsWith('tool-xtensa') && entry.includes('-gdb')) {
        const binDir = path.join(pioPackagesDir, entry, 'bin');
        try {
          for (const bin of fs.readdirSync(binDir)) {
            if (bin.match(/^xtensa-.*-elf-gdb(\.exe)?$/)) {
              const c = path.join(binDir, bin);
              if (fs.existsSync(c)) { return c; }
            }
          }
        } catch { /* bin dir unreadable */ }
      }
    }
  } catch { /* ignore */ }

  log?.appendLine('[ESP Decoder] Xtensa GDB not found in PlatformIO packages');
  return undefined;
}

/**
 * Valid trbr target architectures.
 */
const VALID_TRBR_TARGETS = ['xtensa', 'esp32c2', 'esp32c3', 'esp32c6', 'esp32h2', 'esp32h4', 'esp32p4'] as const;

/** ELF e_machine values for ESP chip families */
const ELF_MACHINE_XTENSA = 0x5e; // 94
const ELF_MACHINE_RISCV = 0xf3;  // 243

/**
 * Detect the architecture from a firmware ELF file's e_machine header field.
 * Returns 'xtensa' or 'riscv', or undefined if detection fails.
 */
async function detectElfArch(
  elfPath: string,
  log?: DecodeLogger,
): Promise<'xtensa' | 'riscv' | undefined> {
  try {
    const fd = await fsPromises.open(elfPath, 'r');
    try {
      const header = Buffer.alloc(20);
      const { bytesRead } = await fd.read(header, 0, 20, 0);
      if (bytesRead < 20) { return undefined; }

      // Verify ELF magic
      if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
        return undefined;
      }

      // e_machine is at offset 18, little-endian uint16
      const machine = header.readUInt16LE(18);
      if (machine === ELF_MACHINE_XTENSA) { return 'xtensa'; }
      if (machine === ELF_MACHINE_RISCV) { return 'riscv'; }

      log?.appendLine(`[ESP Decoder] Unknown ELF e_machine: 0x${machine.toString(16)}`);
      return undefined;
    } finally {
      await fd.close();
    }
  } catch {
    return undefined;
  }
}

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
 * Extract all candidate code addresses from crash text.
 * Finds all 8-hex-digit values starting with '4' (ESP code space 0x40000000–0x4FFFFFFF).
 * Preserves duplicates and order of appearance.
 */
function extractAllCandidateAddresses(crashText: string): string[] {
  const addresses: string[] = [];
  const re = /4[0-9a-fA-F]{7}\b/g;
  let match;
  while ((match = re.exec(crashText)) !== null) {
    addresses.push(`0x${match[0].toLowerCase()}`);
  }
  return addresses;
}

/**
 * Extract candidate return addresses from a RISC-V Stack memory hex dump.
 * Returns addresses (preserving duplicates) that fall within ESP code space (0x40000000–0x4FFFFFFF).
 * Used by createRawDecode fallback when no addr2line is available.
 */
function extractStackCandidateAddresses(crashText: string): string[] {
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
          if (val >= 0x40000000 && val < 0x50000000) {
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
 * Strategy (mirrors pioarduino/filter_exception_decoder.py's setup_paths approach):
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
          return candidate;
        }
      }
    }
  } catch { /* packagesDir might not exist or not be readable */ }

  log?.appendLine(`[ESP Decoder] addr2line not found for GDB '${gdbPath}'`);
  return undefined;
}

/**
 * Regex matching addr2line address header lines
 * (same as pioarduino/filter_exception_decoder.py's _ADDR2LINE_HEADER_RE).
 */
const ADDR2LINE_HEADER_RE = /^0x[0-9a-fA-F]+$/;

/**
 * Regex to strip discriminator annotations from addr2line output.
 */
const DISCRIMINATOR_RE = /\s*\(discriminator \d+\)/;

/**
 * Resolve candidate addresses to function/file/line using addr2line in batch mode.
 *
 * Uses the same `-fiaC` flags and output parsing as pioarduino/filter_exception_decoder.py's _decode_batch().
 * Addresses are passed directly (without decrement) which resolves raw addresses as-is.
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
  romElfPath?: string,
  pool?: Addr2linePool,
): Promise<StackFrame[]> {
  if (candidateAddrs.length === 0) { return []; }

  // Limit to 200 addresses to keep command-line length reasonable
  const addrs = candidateAddrs.slice(0, 200);

  // Use persistent addr2line process if pool is available
  if (pool) {
    try {
      const resolver = pool.get(addr2linePath, elfPath);
      const results = await resolver.resolveBatch(addrs);
      const frames: StackFrame[] = results
        .filter(r => r.function)
        .map(r => ({ address: r.address, function: r.function, file: r.file, line: r.line }));

      // Try ROM ELF for unresolved addresses
      if (romElfPath) {
        const resolvedAddrs = new Set(frames.map(f => f.address));
        const unresolvedAddrs = addrs.filter(a => !resolvedAddrs.has(a));
        if (unresolvedAddrs.length > 0) {
          const romResolver = pool.get(addr2linePath, romElfPath);
          const romResults = await romResolver.resolveBatch(unresolvedAddrs);
          for (const r of romResults) {
            if (r.function) {
              frames.push({ address: r.address, function: r.function, file: r.file, line: r.line });
            }
          }
        }
      }

      return frames;
    } catch (err) {
      log?.appendLine(`[ESP Decoder] Pool addr2line failed, falling back to one-shot: ${err instanceof Error ? err.message : String(err)}`);
      // Fall through to one-shot approach
    }
  }

  // Build args: addr2line -fiaC -e <elf> <addr1> <addr2> ...
  // Addresses are passed as-is (no decrement).
  const args = ['-fiaC', '-e', elfPath, ...addrs];

  try {
    const { stdout } = await execFileAsync(addr2linePath, args, { timeout: 15000 });

    // Parse output using pioarduino/filter_exception_decoder.py's state-machine approach:
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

      // Parse function / file:line pairs (same logic as pioarduino/filter_exception_decoder.py's _finalize_batch_entry)
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

    // Try ROM ELF for addresses not resolved by firmware ELF
    if (romElfPath) {
      const resolvedAddrs = new Set(frames.map(f => f.address));
      const unresolvedOrigAddrs = addrs.filter(a => !resolvedAddrs.has(a));
      if (unresolvedOrigAddrs.length > 0) {
        try {
          const { stdout: romStdout } = await execFileAsync(
            addr2linePath, ['-fiaC', '-e', romElfPath, ...unresolvedOrigAddrs], { timeout: 15000 }
          );
          const romRawLines = romStdout.split('\n');
          const romSections: string[][] = [];
          let romCurrentBody: string[] = [];
          for (const rawLine of romRawLines) {
            const stripped = rawLine.trim();
            if (!stripped) { continue; }
            if (ADDR2LINE_HEADER_RE.test(stripped)) {
              romSections.push(romCurrentBody);
              romCurrentBody = [];
            } else {
              romCurrentBody.push(stripped);
            }
          }
          romSections.push(romCurrentBody);
          const romBodySections = romSections.slice(1);

          for (let i = 0; i < unresolvedOrigAddrs.length && i < romBodySections.length; i++) {
            const originalAddr = unresolvedOrigAddrs[i];
            const body = romBodySections[i];
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
        } catch (romErr) {
          log?.appendLine(
            `[ESP Decoder] ROM ELF addr2line failed: ${romErr instanceof Error ? romErr.message : String(romErr)}`
          );
        }
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
 * Enhance a decoded RISC-V crash by resolving all code addresses found in the
 * crash text using addr2line.
 * esp-stacktrace-decoder: extract ALL 4xxxxxxx addresses from the entire crash
 * text, resolve them via addr2line (without decrement), and replace the
 * stacktrace with the results.
 */
async function enhanceWithHeuristicStackFrames(
  decoded: DecodedCrash,
  crashEvent: CrashEvent,
  elfPath: string,
  toolPath: string,
  log?: DecodeLogger,
  romElfPath?: string,
  pool?: Addr2linePool,
): Promise<void> {
  const write = (msg: string) => log?.appendLine(msg);

  // Extract ALL candidate code addresses from the crash text
  const candidateAddrs = extractAllCandidateAddresses(crashEvent.rawText);

  if (candidateAddrs.length === 0) {
    return;
  }

  // Prefer addr2line (fast) — fall back to GDB batch if not found
  let heuristicFrames: StackFrame[] = [];
  const addr2linePath = deriveAddr2linePath(toolPath, log);

  if (addr2linePath) {
    heuristicFrames = await resolveAddressesViaAddr2line(candidateAddrs, elfPath, addr2linePath, log, romElfPath, pool);
  } else {
    heuristicFrames = await resolveAddressesViaGdb(candidateAddrs, elfPath, toolPath, log);
  }

  if (heuristicFrames.length > 0) {
    decoded.stacktrace = heuristicFrames;
  }
}

/**
 * Registers that should not be resolved to code addresses.
 * These are data pointers, exception-related values, or status registers.
 */
const NON_CODE_REGISTERS = new Set([
  'EXCVADDR', 'MTVAL', 'MSTATUS', 'MHARTID',
  'PS', 'SAR', 'LBEG', 'LEND', 'LCOUNT',
  'EXCCAUSE', 'MCAUSE',
  'SP', 'GP', 'TP', 'X0',
]);

/**
 * RISC-V exception cause descriptions (same as filter_exception_decoder.py).
 */
const RISCV_EXCEPTIONS: Record<number, string> = {
  0x0: 'Instruction address misaligned',
  0x1: 'Instruction access fault',
  0x2: 'Illegal instruction',
  0x3: 'Breakpoint',
  0x4: 'Load address misaligned',
  0x5: 'Load access fault',
  0x6: 'Store/AMO address misaligned',
  0x7: 'Store/AMO access fault',
  0x8: 'Environment call from U-mode',
  0x9: 'Environment call from S-mode',
  0xb: 'Environment call from M-mode',
  0xc: 'Instruction page fault',
  0xd: 'Load page fault',
  0xf: 'Store/AMO page fault',
};

/**
 * Xtensa exception cause descriptions.
 */
const XTENSA_EXCEPTIONS: (string | null)[] = [
  'IllegalInstruction',         // 0
  'Syscall',                    // 1
  'InstructionFetchError',      // 2
  'LoadStoreError',             // 3
  'Level1Interrupt',            // 4
  'Alloca',                     // 5
  'IntegerDivideByZero',        // 6
  null,                         // 7 reserved
  'Privileged',                 // 8
  'LoadStoreAlignment',         // 9
  null, null,                   // 10-11 reserved
  'InstrPIFDataError',          // 12
  'LoadStorePIFDataError',      // 13
  'InstrPIFAddrError',          // 14
  'LoadStorePIFAddrError',      // 15
  'InstTLBMiss',                // 16
  'InstTLBMultiHit',            // 17
  'InstFetchPrivilege',         // 18
  null,                         // 19 reserved
  'InstFetchProhibited',        // 20
  null, null, null,             // 21-23 reserved
  'LoadStoreTLBMiss',           // 24
  'LoadStoreTLBMultiHit',       // 25
  'LoadStorePrivilege',         // 26
  null,                         // 27 reserved
  'LoadProhibited',             // 28
  'StoreProhibited',            // 29
];

/**
 * Resolve register addresses to source locations using addr2line.
 * Annotates code-address registers with function/file:line info,
 * similar to filter_exception_decoder.py's build_register_trace().
 * Also adds MCAUSE/EXCCAUSE exception descriptions.
 */
async function resolveRegisterAddresses(
  regs: Record<string, number>,
  elfPath: string,
  addr2linePath: string,
  log?: DecodeLogger,
  romElfPath?: string,
): Promise<Record<string, string>> {
  const annotations: Record<string, string> = {};

  // Handle MCAUSE / EXCCAUSE with exception descriptions
  for (const [name, value] of Object.entries(regs)) {
    const upperName = name.toUpperCase();
    if (upperName === 'MCAUSE') {
      if (value & 0x80000000) {
        const cause = value & 0x7FFFFFFF;
        annotations[name] = `Interrupt (cause ${cause})`;
      } else {
        const desc = RISCV_EXCEPTIONS[value];
        if (desc) {
          annotations[name] = desc;
        }
      }
    } else if (upperName === 'EXCCAUSE') {
      if (value >= 0 && value < XTENSA_EXCEPTIONS.length) {
        const desc = XTENSA_EXCEPTIONS[value];
        if (desc) {
          annotations[name] = desc;
        }
      }
    }
  }

  // Collect code-address registers for batch resolution
  const candidates: { reg: string; lookupAddr: string }[] = [];
  for (const [name, value] of Object.entries(regs)) {
    const upperName = name.toUpperCase();
    if (NON_CODE_REGISTERS.has(upperName)) { continue; }
    // Code space check (0x40000000–0x4FFFFFFF)
    if (value >= 0x40000000 && value < 0x50000000) {
      // RA is a return address — decrement by 1 for call-site resolution
      const isRetAddr = upperName === 'RA';
      const lookupVal = isRetAddr ? value - 1 : value;
      candidates.push({
        reg: name,
        lookupAddr: `0x${(lookupVal >>> 0).toString(16).padStart(8, '0')}`,
      });
    }
  }

  if (candidates.length === 0) { return annotations; }

  const lookupAddrs = candidates.map(c => c.lookupAddr);

  // Resolve against firmware ELF, then ROM ELF for unresolved
  const elfPaths = [elfPath];
  if (romElfPath) { elfPaths.push(romElfPath); }

  const resolvedMap = new Map<string, string>(); // lookupAddr → annotation

  for (const elf of elfPaths) {
    const unresolvedAddrs = lookupAddrs.filter(a => !resolvedMap.has(a));
    if (unresolvedAddrs.length === 0) { break; }

    const args = ['-fiaC', '-e', elf, ...unresolvedAddrs];
    try {
      const { stdout } = await execFileAsync(addr2linePath, args, { timeout: 15000 });
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
      const bodySections = sections.slice(1);

      for (let i = 0; i < unresolvedAddrs.length && i < bodySections.length; i++) {
        const addr = unresolvedAddrs[i];
        if (resolvedMap.has(addr)) { continue; }

        const body = bodySections[i];
        const parts: string[] = [];
        let j = 0;
        while (j + 1 < body.length) {
          const func = body[j];
          const loc = DISCRIMINATOR_RE.test(body[j + 1])
            ? body[j + 1].replace(DISCRIMINATOR_RE, '')
            : body[j + 1];
          if (func === '??' && loc.startsWith('??:')) {
            j += 2;
            continue;
          }
          parts.push(`${func} at ${loc}`);
          j += 2;
        }

        if (parts.length > 0) {
          let annotation = parts[0];
          for (let k = 1; k < parts.length; k++) {
            annotation += '\n     (inlined by) ' + parts[k];
          }
          resolvedMap.set(addr, annotation);
        }
      }
    } catch (err) {
      log?.appendLine(
        `[ESP Decoder] Register addr2line failed for ${elf}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Map back from lookup addresses to register names
  for (const candidate of candidates) {
    const annotation = resolvedMap.get(candidate.lookupAddr);
    if (annotation) {
      annotations[candidate.reg] = annotation;
    }
  }

  return annotations;
}

/**
 * Extract PC addresses from Xtensa-style backtrace lines.
 * Format: "Backtrace: 0xPC:0xSP 0xPC:0xSP ..."
 */
function extractXtensaBacktraceAddresses(text: string): string[] {
  const btMatch = text.match(/Backtrace:\s*((?:0x[0-9a-fA-F]+:0x[0-9a-fA-F]+\s*)+)/i);
  if (!btMatch) { return []; }
  const pairs = btMatch[1].trim().split(/\s+/);
  const addresses: string[] = [];
  for (const pair of pairs) {
    const pc = pair.split(':')[0];
    if (pc && /^0x[0-9a-fA-F]+$/i.test(pc)) {
      addresses.push(pc.toLowerCase());
    }
  }
  return addresses;
}

/**
 * Parse Xtensa-specific fault information including EXCVADDR/EXCCAUSE.
 */
function parseXtensaFaultInfo(text: string): DecodedCrash['faultInfo'] | undefined {
  const lines = text.split('\n');
  let coreId = 0;
  let faultMessage: string | undefined;
  let programCounter: string | undefined;
  let faultAddr: string | undefined;
  let faultCode: number | undefined;

  for (const line of lines) {
    const guruMatch = line.match(/Core\s+(\d+)\s+panic'ed\s+\(([^)]+)\)/i);
    if (guruMatch) {
      coreId = parseInt(guruMatch[1], 10);
      faultMessage = guruMatch[2];
    }
    const pcMatch = line.match(/\bPC\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (pcMatch && !programCounter) { programCounter = pcMatch[1]; }
    const excvMatch = line.match(/\bEXCVADDR\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (excvMatch) { faultAddr = excvMatch[1]; }
    const exccMatch = line.match(/\bEXCCAUSE\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (exccMatch) { faultCode = parseInt(exccMatch[1], 16); }
  }

  if (faultCode !== undefined && faultCode < XTENSA_EXCEPTIONS.length) {
    const desc = XTENSA_EXCEPTIONS[faultCode];
    if (desc && !faultMessage) {
      faultMessage = desc;
    } else if (desc && faultMessage) {
      faultMessage = `${faultMessage} (${desc})`;
    }
  }

  if (faultMessage || programCounter) {
    return { coreId, programCounter, faultAddr, faultCode, faultMessage };
  }
  return undefined;
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

  // Detect "assert failed:" / "abort() was called" fault messages (RISC-V chips)
  let faultMessage: string | undefined;
  for (const line of lines) {
    const assertMatch = line.match(/^(assert failed:.+)/i);
    if (assertMatch) {
      faultMessage = assertMatch[1];
      break;
    }
    const abortMatch = line.match(/^(abort\(\) was called.+)/i);
    if (abortMatch) {
      faultMessage = abortMatch[1];
      break;
    }
  }

  // Extract core ID from "Core N register dump:" if present
  let coreId = 0;
  for (const line of lines) {
    const coreMatch = line.match(/Core\s+(\d+)\s+register dump:/i);
    if (coreMatch) {
      coreId = parseInt(coreMatch[1], 10);
      break;
    }
  }

  for (const line of lines) {
    const epcMatch = line.match(/EPC1?\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (epcMatch) {
      return { coreId, programCounter: epcMatch[1], faultMessage };
    }
    const mepcMatch = line.match(/MEPC\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (mepcMatch) {
      return { coreId, programCounter: mepcMatch[1], faultMessage };
    }
  }

  if (faultMessage) {
    return { coreId, faultMessage };
  }

  return undefined;
}

/**
 * Parse register values from crash text (fallback).
 */
function parseRegisters(text: string): Record<string, number> {
  const regs: Record<string, number> = {};
  const regPattern =
    /\b(EPC\d|EXCVADDR|EXCCAUSE|MTVAL|MEPC|MCAUSE|MSTATUS|MTVEC|MHARTID|SP|A\d+|RA|GP|TP|S\d+(?:\/FP)?|T\d+|PC)\s*[:=]\s*(0x[0-9a-fA-F]+)/gi;

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
