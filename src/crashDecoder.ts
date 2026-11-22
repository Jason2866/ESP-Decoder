import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Upper bound for a single GDB-backed panic decode before aborting to raw decode. */
const DECODE_TIMEOUT_MS = 120_000;

// Panic decoding engine (modeled on esp-idf-panic-decoder's gdb_panic_server).
import {
  decodePanicText,
  decodeCoredump,
  stringifyDecodeResult,
  isParsedGDBLine,
  isGDBLine,
  createCapturer,
  parseESP32PanicOutput,
  parseRiscvPanicDetailed,
  parseStackDataRow,
  extractPrintedBacktraceAddrs,
} from './panic';
import type {
  Capturer,
  CapturerEvent,
  DecodeOptions,
  DecodeParams,
  DecodeTarget,
  PanicInfoWithBacktrace,
} from './panic';
import { findPioGdbToolPath, getPioPackagesDir } from './pioIntegration';
import { chipArch, KNOWN_CHIPS } from './chipTargets';
import { Addr2linePool } from './addr2lineResolver';

// Re-export for consumers
export { Addr2linePool } from './addr2lineResolver';

// ---------------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------------

/**
 * Check if an error indicates missing tools, permission issues, or spawn failures.
 * These are the only cases where we should set toolsMissing = true.
 */
function isToolAccessError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const message = err.message.toLowerCase();
  const errWithCode = err as Error & { code?: string };
  const code = errWithCode.code;

  // File system errors indicating missing or inaccessible tools
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
    return true;
  }

  // Spawn/execution failures
  if (message.includes('spawn') && (message.includes('enoent') || message.includes('failed'))) {
    return true;
  }

  // Permission denied messages
  if (message.includes('permission denied') || message.includes('access denied')) {
    return true;
  }

  // Tool not found messages - use stricter patterns to avoid false positives
  if (
    message.includes('command not found') ||
    message.includes(': not found') ||
    message.includes('is not recognized as an internal or external command') ||
    (message.includes('no such file') && message.includes('directory'))
  ) {
    return true;
  }

  return false;
}

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
  decodedContext?: CrashDecodeContext;
  /** Synthetic coredump event; its results use the coredump decoder. */
  isCoredump?: boolean;
}

/** Inputs that produced a cached decoded result. */
export interface CrashDecodeContext {
  captureText: string;
  captureKind: CrashEvent['kind'];
  elfPath: string;
  toolPath?: string;
  targetArch?: string;
  romElfPath?: string;
  /** Changes when the ELF file is rebuilt in place. */
  elfRevision?: number;
}

export function createCrashDecodeContext(
  captureText: string,
  captureKind: CrashEvent['kind'],
  elfPath: string,
  toolPath?: string,
  targetArch?: string,
  romElfPath?: string,
  elfRevision?: number,
): CrashDecodeContext {
  return { captureText, captureKind, elfPath, toolPath, targetArch, romElfPath, elfRevision };
}

export function sameCrashDecodeContext(
  left: CrashDecodeContext,
  right: CrashDecodeContext,
): boolean {
  return left.captureText === right.captureText &&
    left.captureKind === right.captureKind &&
    left.elfPath === right.elfPath &&
    left.toolPath === right.toolPath &&
    left.targetArch === right.targetArch &&
    left.romElfPath === right.romElfPath &&
    left.elfRevision === right.elfRevision;
}

export function hasCachedCrashDecode(
  event: CrashEvent,
  context: CrashDecodeContext,
): boolean {
  return event.decoded !== undefined &&
    !event.decoded.toolsMissing &&
    !event.decoded.decodeFailed &&
    event.decodedContext !== undefined &&
    event.rawText === context.captureText &&
    event.kind === context.captureKind &&
    sameCrashDecodeContext(event.decodedContext, context);
}

export function cacheCrashDecode(
  event: CrashEvent,
  decoded: DecodedCrash,
  context: CrashDecodeContext,
): void {
  event.decoded = decoded;
  event.decodedContext = { ...context };
}

/**
 * Decoded crash information.
 */
export interface DecodedCrash {
  faultInfo?: {
    coreId?: number;
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
  /** Set when decoding fell back to raw output because GDB/addr2line tools were not found. */
  toolsMissing?: boolean;
  /** The decoder returned raw output after a timeout or execution error. */
  decodeFailed?: boolean;
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
  /** Set when decoding failed because GDB/addr2line tools were not found. */
  toolsMissing?: boolean;
}

export interface ThreadDecodedCrash {
  threadId: string;
  threadName?: string;
  isCurrent?: boolean;
  decoded: DecodedCrash;
  warning?: string;
}

/**
 * Wraps the panic Capturer to detect crash events from raw serial byte chunks.
 * The capturer handles line decoding, crash block framing (Stack memory,
 * register dumps, Backtrace lines, Rebooting... terminators, and all
 * ESP-IDF crash formats), lightweight parsing, and deduplication.
 */
export class CrashCapturer {
  private capturer: Capturer;
  private readonly _onCrashDetected = new vscode.EventEmitter<CrashEvent>();
  readonly onCrashDetected = this._onCrashDetected.event;
  private readonly _onCrashUpdated = new vscode.EventEmitter<CrashEvent>();
  readonly onCrashUpdated = this._onCrashUpdated.event;
  private readonly _onCrashRemoved = new vscode.EventEmitter<CrashEvent>();
  readonly onCrashRemoved = this._onCrashRemoved.event;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeUpdated: (() => void) | undefined;
  private unsubscribeRemoved: (() => void) | undefined;

  constructor() {
    this.capturer = createCapturer({ quietPeriodMs: 500 });
    this.unsubscribe = this.capturer.on('eventDetected', (capturerEvent: CapturerEvent) => {
      this._onCrashDetected.fire(capturerEventToCrashEvent(capturerEvent));
    });
    this.unsubscribeUpdated = this.capturer.on('eventUpdated', (capturerEvent: CapturerEvent) => {
      this._onCrashUpdated.fire(capturerEventToCrashEvent(capturerEvent));
    });
    this.unsubscribeRemoved = this.capturer.on('eventRemoved', (capturerEvent: CapturerEvent) => {
      this._onCrashRemoved.fire(capturerEventToCrashEvent(capturerEvent));
    });
  }

  /**
   * Feed raw serial bytes. The capturer handles line decoding,
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
    this.unsubscribeUpdated?.();
    this.unsubscribeRemoved?.();
    this.capturer.dispose();
    this.capturer = createCapturer({ quietPeriodMs: 500 });
    this.unsubscribe = this.capturer.on('eventDetected', (capturerEvent: CapturerEvent) => {
      this._onCrashDetected.fire(capturerEventToCrashEvent(capturerEvent));
    });
    this.unsubscribeUpdated = this.capturer.on('eventUpdated', (capturerEvent: CapturerEvent) => {
      this._onCrashUpdated.fire(capturerEventToCrashEvent(capturerEvent));
    });
    this.unsubscribeRemoved = this.capturer.on('eventRemoved', (capturerEvent: CapturerEvent) => {
      this._onCrashRemoved.fire(capturerEventToCrashEvent(capturerEvent));
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribeUpdated?.();
    this.capturer.dispose();
    this._onCrashDetected.dispose();
    this._onCrashUpdated.dispose();
    this._onCrashRemoved.dispose();
  }
}

/**
 * Convert a CapturerEvent to our CrashEvent interface.
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
 * When an OutputChannel is provided, all decoder debug output and decode
 * diagnostics are written there so users can inspect failures.
 */
export interface DecodeLogger {
  appendLine(value: string): void;
}

/**
 * Decode a crash event into source-level information.
 * @param log - optional OutputChannel / logger; when provided, decoder
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

  // Capture the event's kind/text once: async waits below must not observe
  // a mutated crashEvent.
  const crashKind = crashEvent.kind;
  const crashText = crashEvent.rawText;

  // Resolve the configured architecture up front so tool discovery uses the
  // same family the decoder will use — a recognized targetArch override must
  // not fall back to crash-kind guessing (e.g. kind 'unknown' + riscv).
  let resolvedArch = resolveTargetArch(targetArch, crashKind);
  if (!targetArch || targetArch.trim().toLowerCase() === 'auto') {
    // Automatic decoding follows the selected ELF when its architecture is
    // available. Printed-only captures do not identify architecture in the
    // Backtrace syntax, so the ELF keeps them eligible for the right parser.
    resolvedArch = await detectElfArch(elfPath, log) ?? resolvedArch;
  }

  if (!toolPath) {
    const isEsp8266Crash = crashKind === 'xtensa'
      && />>>stack>>>/.test(crashText)
      && !/Backtrace:/i.test(crashText);
    // A configured chip/IDF target name lets discovery prefer the
    // chip-specific GDB binary; family-only settings ('riscv', 'xtensa',
    // 'auto') keep the generic lookup, and the ESP8266 text hint still
    // applies when no chip is configured.
    const configuredChip = configuredChipName(targetArch);
    toolPath = autoDetectPioToolPath(
      resolvedArch,
      log,
      configuredChip ?? (isEsp8266Crash ? 'esp8266' : undefined),
    );
    if (!toolPath) {
      write('[ESP Decoder] No toolPath (GDB/addr2line) found — returning raw decode');
      const raw = createRawDecode(crashText);
      raw.toolsMissing = true;
      return raw;
    }
  }

  // Validate that the resolved toolPath exists and is executable before invoking it.
  try {
    await fsPromises.access(toolPath, fs.constants.X_OK);
  } catch {
    write(`[ESP Decoder] toolPath '${toolPath}' is not executable or does not exist — returning raw decode`);
    const raw = createRawDecode(crashText);
    raw.toolsMissing = true;
    return raw;
  }

  try {

    // === Xtensa fast-path: resolve stack/backtrace addresses directly via addr2line ===
    // Covers both the "Backtrace: 0xPC:0xSP ..." format and the ESP8266
    // ">>>stack>>>" hex dump format (no Backtrace: lines).
    if (crashKind === 'xtensa' && resolvedArch === 'xtensa') {
      const isEsp8266Stack = />>>stack>>>/.test(crashText) && !/Backtrace:/i.test(crashText);
      // ESP32-family dumps can contain a register dump per core; select the
      // panicking core's registers and backtrace so another core's dump
      // (e.g. core 0 printed before core 1) cannot leak into the result.
      const xtensaParsed = isEsp8266Stack
        ? undefined
        : parseESP32PanicOutput(crashText);
      const candidateAddrs = isEsp8266Stack
        ? extractEsp8266StackAddresses(crashText)
        : (xtensaParsed?.backtraceAddrs ?? []).map((a) => `0x${a.toString(16)}`);

      if (candidateAddrs.length > 0) {
        const addr2linePath = deriveAddr2linePath(toolPath!, log);
        if (addr2linePath) {
          const faultInfo = isEsp8266Stack
            ? parseXtensaFaultInfo(crashText)
            : parseXtensaFaultInfoForCore(crashText, xtensaParsed);
          const regs = isEsp8266Stack
            ? parseRegisters(crashText)
            : (xtensaParsed?.regs ?? {});
          const hasRegs = Object.keys(regs).length > 0;

          // Resolve frames and register annotations in parallel
          const [frames, regAnnotations] = await Promise.all([
            resolveAddressesViaAddr2line(candidateAddrs, elfPath, addr2linePath, log, romElfPath, addr2linePool),
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

    const params: DecodeParams = { elfPath, toolPath, targetArch: resolvedArch };

    // Build decode options
    const decodeOptions: DecodeOptions = {
      signal: abortController.signal,
    };

    // Bound the GDB-backed decode so a stuck toolchain cannot hang the
    // monitor; on timeout the AbortError falls through to the raw decode.
    const decodeTimeout = setTimeout(() => abortController.abort(), DECODE_TIMEOUT_MS);
    decodeTimeout.unref?.();
    const result = await decodePanicText(params, crashText, decodeOptions)
      .finally(() => clearTimeout(decodeTimeout));

    const decRes = Array.isArray(result) ? result[0]?.result ?? result[0] : result;

    if ((decRes?.stacktraceLines?.length ?? 0) === 0) {
      write('[ESP Decoder] WARNING: decoder returned 0 stacktrace lines — check that toolPath points to a working GDB and the ELF matches the firmware.');
    }

    // Convert the decoder's DecodeResult to our DecodedCrash format
    const decoded = convertDecodeResult(result, crashText);

    // Post-processing: heuristic stack enhancement (RISC-V) + register annotations.
    // These use independent addr2line invocations, so run them in parallel.
    const postProcessTasks: Promise<void>[] = [];

    // For RISC-V crashes: enhance with heuristic stack analysis when
    // the decoder's GDB-server-based unwinding yields few frames.
    if (
      crashKind === 'riscv' &&
      /Stack memory:/i.test(crashText) &&
      toolPath
    ) {
      postProcessTasks.push(
        enhanceWithHeuristicStackFrames(decoded, crashText, elfPath, toolPath, log, romElfPath, addr2linePool)
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
    const raw = createRawDecode(crashText);
    raw.decodeFailed = true;
    // Only set toolsMissing for actual tool access/execution errors
    if (isToolAccessError(err)) {
      raw.toolsMissing = true;
    }
    
    return raw;
  }
}

/**
 * Decode an ESP coredump file, producing per-thread backtraces.
 * Supports both ELF format and base64-encoded (b64) format.
 * For b64 files, the content is decoded to a temporary ELF file before decoding.
 * The b64 format is used by ESP-IDF's esp-coredump tool and may
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
      const tmpDir = path.dirname(resolvedPath);
      try {
        await fsPromises.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
      } catch (cleanupErr) {
        write(`[ESP Decoder] Warning: Failed to clean up temp coredump dir ${tmpDir}: ${cleanupErr}`);
        console.warn('Failed to clean up temp coredump dir:', cleanupErr);
      }
    }
  }
}

/**
 * Decode a base64-encoded coredump from raw text content (e.g. pasted from serial).
 * Extracts the base64 payload (optionally between CORE DUMP START/END markers),
 * decodes it, and passes the resulting ELF to the coredump decoder.
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
      await fsPromises.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 });
    } catch (cleanupErr) {
      write(`[ESP Decoder] Warning: Failed to clean up temp coredump dir ${tmpDir}: ${cleanupErr}`);
      console.warn('Failed to clean up temp coredump dir:', cleanupErr);
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
  try {
    await fsPromises.writeFile(tmpPath, binary);
  } catch (writeError) {
    try {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Keep the original write failure as the useful error.
    }
    throw writeError;
  }
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

  // Resolve the decoder family BEFORE tool discovery: an explicit
  // targetArch or a readable ELF header identifies the family, and only a
  // compatible GDB can decode the coredump — never fall back to the other
  // family. Only a fully unknown ELF keeps the riscv-first/xtensa-fallback
  // search.
  const configuredFamily = configuredArchFamily(targetArch);
  const resolvedFamily = configuredFamily ?? detectedArch;

  let chosenArch: 'xtensa' | 'riscv' | 'unknown' = crashKind;
  if (!toolPath) {
    const configuredChip = configuredChipName(targetArch);
    if (resolvedFamily) {
      toolPath = autoDetectPioToolPath(resolvedFamily, log, configuredChip);
      if (toolPath) {
        chosenArch = resolvedFamily;
      }
    } else {
      const primaryKind = crashKind === 'xtensa' ? 'xtensa' : 'riscv';
      const fallbackKind = primaryKind === 'riscv' ? 'xtensa' : 'riscv';
      toolPath = autoDetectPioToolPath(primaryKind, log, configuredChip);
      if (toolPath) {
        chosenArch = primaryKind;
      } else {
        toolPath = autoDetectPioToolPath(fallbackKind, log, configuredChip);
        if (toolPath) {
          chosenArch = fallbackKind;
        }
      }
    }
    if (!toolPath) {
      write('[ESP Decoder] No toolPath (GDB) found for coredump decoding');
      return {
        threads: [],
        rawOutput: 'No GDB toolchain found. Please configure a tool path.',
        toolsMissing: true,
      };
    }
  }

  const resolvedArch = resolveTargetArch(targetArch, chosenArch);

  try {
    const params: DecodeParams = { elfPath, toolPath, targetArch: resolvedArch };
    // Same bound as the panic-text path: a stuck GDB must not hang the
    // monitor; the AbortError is handled by the catch below.
    const abortController = new AbortController();
    const decodeTimeout = setTimeout(() => abortController.abort(), DECODE_TIMEOUT_MS);
    decodeTimeout.unref?.();
    const decodeOptions: DecodeOptions = {
      signal: abortController.signal,
      onWarning: (msg) => write(`[ESP Decoder] Warning: ${msg}`),
    };

    // Pass the coredump file path to the coredump decoder
    const result = await decodeCoredump(params, coredumpPath, decodeOptions)
      .finally(() => clearTimeout(decodeTimeout));

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const threads: ThreadDecodedCrash[] = result.map((threadResult: any) => {
        const decoded = convertDecodeResult(threadResult.result ?? threadResult, '');
        return {
          threadId: threadResult.threadId ?? 'unknown',
          threadName: threadResult.threadName,
          isCurrent: threadResult.current ?? false,
          decoded,
          warning: threadResult.warning,
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
    
    const result: CoredumpDecodedResult = {
      threads: [],
      rawOutput: `Coredump decode failed: ${errMsg}`,
    };
    
    // Only set toolsMissing for actual tool access/execution errors
    if (isToolAccessError(err)) {
      result.toolsMissing = true;
    }
    
    return result;
  }
}

/**
 * Try to auto-detect a GDB binary from the local PlatformIO packages directory.
 * This is used as a fallback when no toolPath is configured in the extension settings.
 * Delegates to pioIntegration's findPioGdbToolPath, which covers both
 * RISC-V (riscv32-esp-elf-gdb) and Xtensa (xtensa-*-elf-gdb, incl. ESP8266 lx106)
 * tool packages.
 */
function autoDetectPioToolPath(
  crashKind: 'xtensa' | 'riscv' | 'unknown',
  log?: DecodeLogger,
  chip?: string,
): string | undefined {
  const pioPackagesDir = getPioPackagesDir();

  if (!pioPackagesDir) {
    log?.appendLine('[ESP Decoder] PlatformIO packages dir not found — cannot auto-detect tool');
    return undefined;
  }

  const arch = crashKind === 'riscv' ? 'riscv' : 'xtensa';
  const toolPath = findPioGdbToolPath(pioPackagesDir, arch, chip);
  if (!toolPath) {
    log?.appendLine(`[ESP Decoder] ${arch} GDB not found in PlatformIO packages`);
  }
  return toolPath;
}

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
 * Resolve the decode target from config and crash kind.
 * Accepts 'xtensa' / 'riscv' family names, legacy aliases ('riscv32',
 * 'esp32c3', ...) and 'auto'. All RISC-V values map to the single 'riscv'
 * decoder target — all RISC-V chips share the same generic ILP32 register
 * layout and decoder (mirroring esp-idf-panic-decoder's single target).
 */
/**
 * Normalized chip name when the configured targetArch is a known chip/IDF
 * target (e.g. 'esp32s3', 'esp32c6'); undefined for family names ('xtensa',
 * 'riscv', 'auto') and unrecognized values.
 */
function configuredChipName(targetArch: string | undefined): string | undefined {
  const normalized = targetArch?.trim().toLowerCase();
  return normalized && KNOWN_CHIPS.includes(normalized) ? normalized : undefined;
}

/**
 * Architecture family explicitly identified by the configured targetArch
 * ('xtensa'/'riscv'/chip names); undefined for 'auto' and unrecognized
 * values so callers can fall back to ELF-header detection.
 */
function configuredArchFamily(
  targetArch: string | undefined,
): 'xtensa' | 'riscv' | undefined {
  const normalized = targetArch?.trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    return undefined;
  }
  if (normalized === 'xtensa') {
    return 'xtensa';
  }
  if (normalized === 'riscv' || normalized === 'riscv32') {
    return 'riscv';
  }
  if (KNOWN_CHIPS.includes(normalized)) {
    return chipArch(normalized);
  }
  return undefined;
}

function resolveTargetArch(
  configArch: string | undefined,
  crashKind: 'xtensa' | 'riscv' | 'unknown'
): DecodeTarget {
  const normalized = configArch?.trim().toLowerCase();
  if (normalized && normalized !== 'auto') {
    if (normalized === 'xtensa') {
      return 'xtensa';
    }
    if (normalized === 'riscv' || normalized === 'riscv32') {
      return 'riscv';
    }
    // Chip / IDF target name: the four Xtensa chips are 'xtensa',
    // everything else is 'riscv'. Unrecognized values (casing variants,
    // unknown names) fall through to the crash-kind 'auto' behavior.
    if (KNOWN_CHIPS.includes(normalized)) {
      return chipArch(normalized);
    }
  }
  return crashKind === 'riscv' ? 'riscv' : 'xtensa';
}

/**
 * Convert the decoder's DecodeResult (or CoredumpDecodeResult) to our DecodedCrash format.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertDecodeResult(result: any, crashText: string): DecodedCrash {
  // Get the stringified output from the decoder for rawOutput
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
      coreId: fi.coreId,
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

  // Extract stack trace from the decoder's stacktraceLines
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
 * Stringify an addr location from the decoder's types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
 * Reduce a RISC-V panic capture to the section of the selected (panicking)
 * core: the 'Core N register dump:' block named by the panic header, or the
 * first dump when no core is named. Returns '' when sections exist but the
 * selected core's section is missing — never another core's section.
 * Unsectioned captures are returned unchanged.
 */
function extractRiscvCoreSection(crashText: string): string {
  try {
    const parsed = parseRiscvPanicDetailed(crashText);
    if (parsed.regDumps.length === 0) {
      return crashText;
    }
    const selectedCore = parsed.panicCoreId ?? parsed.regDumps[0].coreId;
    const out: string[] = [];
    // Lines before the first dump header (panic/assert preamble) belong to
    // the panicking core — the selected one.
    let currentCore: number | undefined = selectedCore;
    let captured = false;
    for (const line of crashText.split(/\r?\n|\r/)) {
      const header = line.match(/^\s*Core\s+(\d+)\s+register dump:/);
      if (header) {
        currentCore = parseInt(header[1], 10);
      }
      if (currentCore === selectedCore) {
        out.push(line);
        captured = true;
      }
    }
    return captured ? out.join('\n') : '';
  } catch {
    return crashText;
  }
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
 * This is the heuristic fallback for RISC-V crashes where the decoder's GDB-server-based
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
  crashText: string,
  elfPath: string,
  toolPath: string,
  log?: DecodeLogger,
  romElfPath?: string,
  pool?: Addr2linePool,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const write = (msg: string) => log?.appendLine(msg);

  const candidateAddrs = extractRiscvHeuristicCandidates(crashText);

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

  // The GDB/MI unwind stays authoritative for the frames it covers. Heuristic
  // results fill missing source fields on matching frames and append only
  // addresses the unwind did not reach.
  if (heuristicFrames.length > 0) {
    const known = new Map(
      decoded.stacktrace.map((f) => [f.address.replace(/^0x/i, '').toLowerCase(), f]),
    );
    const extra: typeof heuristicFrames = [];
    for (const f of heuristicFrames) {
      const key = f.address.replace(/^0x/i, '').toLowerCase();
      const existing = known.get(key);
      if (existing) {
        if ((!existing.function || existing.function === '??') && f.function && f.function !== '??') {
          existing.function = f.function;
        }
        if ((!existing.file || existing.file === '??') && f.file && f.file !== '??') {
          existing.file = f.file;
        }
        if ((!existing.line || existing.line === '??') && f.line && f.line !== '??') {
          existing.line = f.line;
        }
      } else {
        known.set(key, f);
        extra.push(f);
      }
    }
    if (extra.length > 0) {
      decoded.stacktrace = [...decoded.stacktrace, ...extra];
    }
  }
}

/**
 * Extract heuristic PCs only from the selected core's parsed stack words and
 * printed Backtrace pairs. Register values and other diagnostics are not
 * candidate frames.
 */
export function extractRiscvHeuristicCandidates(crashText: string): string[] {
  const parsed = parseRiscvPanicDetailed(crashText);
  const selectedCore = parsed.panicCoreId ?? parsed.regDumps[0]?.coreId ?? 0;
  const isCodeAddress = (value: number) => value >= 0x40000000 && value < 0x50000000;
  const stackAddresses = parsed.stackDump
    .filter((dump) => dump.coreId === selectedCore)
    .flatMap((dump) => dump.data)
    .filter(isCodeAddress)
    .map((address) => `0x${address.toString(16).padStart(8, '0')}`);
  const backtraceAddresses = extractPrintedBacktraceAddrs(crashText, selectedCore)
    .filter(isCodeAddress)
    .map((address) => `0x${address.toString(16).padStart(8, '0')}`);
  // Printed PCs are authoritative and get the limited batch slots first.
  // Deduplication preserves their order, then uses remaining slots for stack words.
  return [...new Set([...backtraceAddresses, ...stackAddresses])];
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
// ESP8266 / Xtensa exception code descriptions
// ESP8266_EXCEPTION_CODES table based on: 
// https://github.com/me-no-dev/EspExceptionDecoder
const XTENSA_EXCEPTIONS: (string | null)[] = [
  'Illegal instruction (Is the flash damaged?)',                                                                        // 0
  'SYSCALL instruction',                                                                                                // 1
  'InstructionFetchError: Processor internal physical address or data error during instruction fetch',                  // 2
  'LoadStoreError: Processor internal physical address or data error during load or store',                             // 3
  'Level1Interrupt: Level-1 interrupt as indicated by set level-1 bits in the INTERRUPT register',                      // 4
  "Alloca: MOVSP instruction, if caller's registers are not in the register file",                                      // 5
  'Integer Divide By Zero',                                                                                             // 6
  'reserved',                                                                                                           // 7
  'Privileged: Attempt to execute a privileged operation when CRING != 0',                                              // 8
  'LoadStoreAlignmentCause: Load or store to an unaligned address',                                                     // 9
  'reserved',                                                                                                           // 10
  'reserved',                                                                                                           // 11
  'InstrPIFDataError: PIF data error during instruction fetch',                                                         // 12
  'LoadStorePIFDataError: Synchronous PIF data error during LoadStore access',                                          // 13
  'InstrPIFAddrError: PIF address error during instruction fetch',                                                      // 14
  'LoadStorePIFAddrError: Synchronous PIF address error during LoadStore access',                                       // 15
  'InstTLBMiss: Error during Instruction TLB refill',                                                                   // 16
  'InstTLBMultiHit: Multiple instruction TLB entries matched',                                                          // 17
  'InstFetchPrivilege: An instruction fetch referenced a virtual address at a ring level less than CRING',              // 18
  'reserved',                                                                                                           // 19
  'InstFetchProhibited: An instruction fetch referenced a page mapped with an attribute that does not permit instruction fetch', // 20
  'reserved',                                                                                                           // 21
  'reserved',                                                                                                           // 22
  'reserved',                                                                                                           // 23
  'LoadStoreTLBMiss: Error during TLB refill for a load or store',                                                      // 24
  'LoadStoreTLBMultiHit: Multiple TLB entries matched for a load or store',                                             // 25
  'LoadStorePrivilege: A load or store referenced a virtual address at a ring level less than CRING',                   // 26
  'reserved',                                                                                                           // 27
  'Access to invalid address: LOAD (wild pointer?)',                                                                    // 28
  'Access to invalid address: STORE (wild pointer?)',                                                                   // 29
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
 * Extract candidate code addresses from ESP8266 >>>stack>>> / <<<stack<<< block.
 * Returns all 32-bit values in ESP code space (0x40000000–0x4FFFFFFF).
 */
function extractEsp8266StackAddresses(text: string): string[] {
  const addresses: string[] = [];
  const lines = text.split('\n');
  let inStack = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^>>>stack>>>/.test(trimmed)) {
      inStack = true;
      continue;
    }
    if (/^<<<stack<<</.test(trimmed)) {
      break;
    }
    if (inStack) {
      // Stack lines: "3ffffec0:  3ffee55c 3ffee55c 3ffee6dc 40201df1"
      const match = trimmed.match(/^([0-9a-fA-F]{8}):\s+((?:[0-9a-fA-F]{8}\s*)+)/);
      if (match) {
        const words = match[2].trim().split(/\s+/);
        for (const word of words) {
          const val = parseInt(word, 16);
          if (val >= 0x40000000 && val < 0x50000000) {
            addresses.push(`0x${val.toString(16).padStart(8, '0')}`);
          }
        }
      }
    }
  }

  return addresses;
}

/**
 * Extract PC addresses from Xtensa-style backtrace lines.
 * Format: "Backtrace: 0xPC:0xSP 0xPC:0xSP ..."
 */
/**
 * Xtensa fault info for the panic core: the panic header supplies the
 * message, while PC/fault fields come from the selected core's registers
 * (parseESP32PanicOutput already resolves multi-core dumps).
 */
function parseXtensaFaultInfoForCore(
  text: string,
  parsed: PanicInfoWithBacktrace | undefined,
): DecodedCrash['faultInfo'] | undefined {
  const guruMatch = text.match(/Core\s+(\d+)\s+panic'ed\s+\(([^)]+)\)/i);
  let faultMessage = guruMatch?.[2];
  const faultCode = parsed?.faultCode;

  if (faultCode !== undefined && faultCode < XTENSA_EXCEPTIONS.length) {
    const desc = XTENSA_EXCEPTIONS[faultCode];
    if (desc) {
      faultMessage = faultMessage
        ? `${faultMessage} (Exception ${faultCode}: ${desc})`
        : `Exception ${faultCode}: ${desc}`;
    }
  }

  const programCounter =
    parsed?.programCounter !== undefined ? `0x${parsed.programCounter.toString(16)}` : undefined;
  const faultAddr =
    parsed?.faultAddr !== undefined ? `0x${parsed.faultAddr.toString(16)}` : undefined;

  if (faultMessage || programCounter) {
    return {
      coreId: parsed?.coreId ?? 0,
      programCounter,
      faultAddr,
      faultCode,
      faultMessage,
    };
  }
  return undefined;
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
    // ESP8266 "Exception (N):" format
    const exceptionMatch = line.match(/^Exception\s+\((\d+)\):?/i);
    if (exceptionMatch && faultCode === undefined) {
      faultCode = parseInt(exceptionMatch[1], 10);
    }
    const pcMatch = line.match(/\bPC\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (pcMatch && !programCounter) { programCounter = pcMatch[1]; }
    // ESP8266 epc1= register format
    const epc1Match = line.match(/\bepc1\s*=\s*(0x[0-9a-fA-F]+)/i);
    if (epc1Match && !programCounter) { programCounter = epc1Match[1]; }
    const excvMatch = line.match(/\bEXCVADDR\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (excvMatch) { faultAddr = excvMatch[1]; }
    const exccMatch = line.match(/\bEXCCAUSE\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (exccMatch && faultCode === undefined) { faultCode = parseInt(exccMatch[1], 16); }
  }

  if (faultCode !== undefined && faultCode < XTENSA_EXCEPTIONS.length) {
    const desc = XTENSA_EXCEPTIONS[faultCode];
    if (desc && !faultMessage) {
      faultMessage = `Exception ${faultCode}: ${desc}`;
    } else if (desc && faultMessage) {
      faultMessage = `${faultMessage} (Exception ${faultCode}: ${desc})`;
    }
  }

  if (faultMessage || programCounter) {
    return { coreId, programCounter, faultAddr, faultCode, faultMessage };
  }
  return undefined;
}

/**
 * Parse fault information from crash text (fallback when the decoder cannot decode).
 */
function parseFaultInfo(
  text: string,
  selectedCoreId?: number,
): DecodedCrash['faultInfo'] | undefined {
  const lines = text.split('\n');
  const guruMatch = text.match(/Core\s+(\d+)\s+panic'ed\s+\(([^)]+)\)/i);
  const abortMatch = text.match(/abort\(\)\s+was\s+called.*?\bon\s+core\s+(\d+)/i);
  const headerCoreId = guruMatch
    ? parseInt(guruMatch[1], 10)
    : abortMatch
      ? parseInt(abortMatch[1], 10)
      : undefined;
  const firstDumpMatch = text.match(/^\s*Core\s+(\d+)\s+register dump:/im);
  const coreId = headerCoreId ?? selectedCoreId ?? (firstDumpMatch ? parseInt(firstDumpMatch[1], 10) : 0);
  const hasDumpHeaders = /^\s*Core\s+\d+\s+register dump:/im.test(text);
  let detailLines = lines;
  if (hasDumpHeaders) {
    detailLines = [];
    let currentCore: number | undefined;
    let inRegisterDump = false;
    for (const line of lines) {
      const dumpHeader = line.match(/^\s*Core\s+(\d+)\s+register dump:/i);
      if (dumpHeader) {
        currentCore = parseInt(dumpHeader[1], 10);
        inRegisterDump = true;
        if (currentCore === coreId) {
          detailLines.push(line);
        }
        continue;
      }
      if (/^\s*(?:Stack memory:|Backtrace:)/i.test(line)) {
        inRegisterDump = false;
        currentCore = undefined;
        continue;
      }
      if (inRegisterDump && currentCore === coreId) {
        detailLines.push(line);
      }
    }
  }

  // Detect fault messages from various crash formats
  let faultMessage: string | undefined = guruMatch?.[2];
  if (!faultMessage && abortMatch) {
    faultMessage = lines.find((line) => /abort\(\)\s+was\s+called/i.test(line))?.trim();
  }
  let faultCode: number | undefined;
  let faultAddr: string | undefined;
  for (const line of lines) {
    if (faultMessage) {
      break;
    }
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
    // ESP8266 "Exception (N):" format
    const exceptionMatch = line.match(/^Exception\s+\((\d+)\):?/i);
    if (exceptionMatch) {
      const exCode = parseInt(exceptionMatch[1], 10);
      faultCode = exCode;
      const desc = exCode >= 0 && exCode < XTENSA_EXCEPTIONS.length ? XTENSA_EXCEPTIONS[exCode] : null;
      faultMessage = desc ? `Exception ${exCode}: ${desc}` : `Exception ${exCode}`;
      break;
    }
  }

  let programCounter: string | undefined;
  for (const line of detailLines) {
    const faultAddrMatch = line.match(/\b(?:excvaddr|mtval)\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (faultAddrMatch) {
      faultAddr = faultAddrMatch[1];
    }
    const faultCodeMatch = line.match(/\b(?:exccause|mcause)\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (faultCodeMatch && faultCode === undefined) {
      faultCode = parseInt(faultCodeMatch[1], 16);
    }
    const epcMatch = line.match(/EPC1?\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    const mepcMatch = line.match(/MEPC\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    const pcMatch = line.match(/\bPC\s*[:=]\s*(0x[0-9a-fA-F]+)/i);
    if (!programCounter && (epcMatch || mepcMatch || pcMatch)) {
      programCounter = (epcMatch ?? mepcMatch ?? pcMatch)?.[1];
    }
  }

  // An abort header's PC belongs to the core named on that header, so it is
  // safe when that core's register dump is absent. Never use another dump's PC.
  if (!programCounter && headerCoreId !== undefined && headerCoreId === coreId) {
    const abortPcMatch = text.match(/abort\(\)\s+was\s+called.*?\bPC\s+(0x[0-9a-fA-F]+)/i);
    programCounter = abortPcMatch?.[1];
  }

  return faultMessage || programCounter || faultCode !== undefined || faultAddr
    ? { coreId, programCounter, faultCode, faultAddr, faultMessage }
    : undefined;
}

const RAW_REGISTER_PATTERN =
  /\b(EPC\d|EXCVADDR|EXCCAUSE|DEPC|MTVAL|MEPC|MCAUSE|MSTATUS|MTVEC|MHARTID|SP|A\d+|RA|GP|TP|S\d+(?:\/FP)?|T\d+|PC)\s*[:=]\s*(0x[0-9a-fA-F]+)/gi;

/**
 * Parse register values from crash text (fallback).
 */
function parseRegisters(text: string): Record<string, number> {
  const regs: Record<string, number> = {};
  for (const match of text.matchAll(RAW_REGISTER_PATTERN)) {
    regs[match[1].toUpperCase()] = parseInt(match[2], 16);
  }
  return regs;
}

/**
 * Register fields the detailed parser does not keep in `regs` (MCAUSE,
 * MTVAL, MHARTID, ...) collected only from register-dump lines inside the
 * selected core's section. Stack rows and the printed backtrace sit outside
 * the register boundaries, and keys the detailed parse already recorded
 * are never overwritten — a repeated or later register-looking line cannot
 * clobber the authoritative value.
 */
function collectMissingRegisters(section: string, regs: Record<string, number>): void {
  let inRegisterDump = false;
  for (const line of section.split(/\r\n?|\n/)) {
    if (/^\s*Core\s+\d+\s+register dump:/i.test(line)) {
      inRegisterDump = true;
      continue;
    }
    if (/^\s*(?:Stack memory:|Backtrace:)/i.test(line)) {
      inRegisterDump = false;
      continue;
    }
    if (!inRegisterDump) {
      continue;
    }
    for (const match of line.matchAll(RAW_REGISTER_PATTERN)) {
      const key = match[1].toUpperCase();
      if (!(key in regs)) {
        regs[key] = parseInt(match[2], 16);
      }
    }
  }
}

/**
 * Create a raw (unparsed) decode result as fallback.
 */
/**
 * Parse sectioned RISC-V dumps only when the capture really is RISC-V:
 * 'Core N register dump:' headers are shared with Xtensa output, so the
 * result is trusted only when a RISC-V register (MEPC/MCAUSE/MTVAL) or a
 * 'Stack memory:' segment was actually parsed.
 */
function parseRiscvSections(crashText: string) {
  try {
    const parsed = parseRiscvPanicDetailed(crashText);
    if (parsed.regDumps.length === 0) {
      return undefined;
    }
    const hasRiscvRegs = parsed.regDumps.some(
      (d) =>
        d.regs.MEPC !== undefined ||
        d.regs['S0/FP'] !== undefined ||
        d.faultCode !== undefined ||
        d.faultAddr !== undefined,
    );
    return hasRiscvRegs || parsed.stackDump.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Safe Xtensa parse for the raw fallback.
 *
 * Returns undefined only for unrecognized formats so the caller can keep
 * the generic register/backtrace scan. A sectioned ESP-IDF dump
 * ('Core N register dump:') whose selected core is missing is still a
 * recognized format — the empty parse is returned so the caller does not
 * fall back to scanning every core's registers and backtrace.
 */
function parseXtensaSections(crashText: string) {
  try {
    const parsed = parseESP32PanicOutput(crashText);
    const hasData =
      Object.keys(parsed.regs).length > 0 || parsed.backtraceAddrs.length > 0;
    if (hasData || /Core\s+\d+\s+register dump:/i.test(crashText)) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function createRawDecode(crashText: string): DecodedCrash {
  const frames: StackFrame[] = [];
  let regs: Record<string, number> = {};
  // Core the structured data belongs to; undefined = unsectioned capture.
  let selectedCoreId: number | undefined;
  let suppressStructured = false;

  const riscv = parseRiscvSections(crashText);
  if (riscv) {
    // When the panic header names a core whose register dump never
    // arrived, the capture only holds another core's data — keep the raw
    // text and header-derived fault info but omit structured fields.
    suppressStructured =
      riscv.panicCoreId !== undefined &&
      riscv.regDumps.length > 0 &&
      !riscv.regDumps.some((d) => d.coreId === riscv.panicCoreId);
    if (!suppressStructured) {
      const active =
        riscv.panicCoreId !== undefined
          ? riscv.regDumps.find((d) => d.coreId === riscv.panicCoreId)
          : riscv.regDumps[0];
      if (active) {
        // The detailed parse already scoped registers to the selected
        // core's dump — reuse it and collect only the extra fields it does
        // not keep (MCAUSE, MTVAL, MHARTID, ...) from register lines, so a
        // later register-looking line cannot overwrite values like RA.
        const section = extractRiscvCoreSection(crashText);
        regs = { ...active.regs };
        collectMissingRegisters(section, regs);
        selectedCoreId = riscv.panicCoreId ?? active.coreId;
        // Printed 'Backtrace:' PCs attributed to the selected core only.
        for (const addr of extractPrintedBacktraceAddrs(crashText, selectedCoreId)) {
          frames.push({ address: `0x${addr.toString(16)}` });
        }
      }
    } else {
      // The named core's register dump never arrived, but a printed
      // 'Backtrace:' may still carry its PCs — keep them without
      // borrowing another core's registers or stack data.
      for (const addr of extractPrintedBacktraceAddrs(crashText, riscv.panicCoreId ?? 0)) {
        frames.push({ address: `0x${addr.toString(16)}` });
      }
    }
  } else {
    // Xtensa / ESP8266 / unknown / unsectioned captures: the Xtensa parser
    // already attributes registers and backtrace PCs to the panicking
    // core's section (or the only section present).
    const xtensa = parseXtensaSections(crashText);
    if (xtensa) {
      regs = { ...xtensa.regs };
      selectedCoreId = xtensa.coreId;
      for (const addr of xtensa.backtraceAddrs) {
        frames.push({ address: `0x${addr.toString(16)}` });
      }
    } else {
      regs = parseRegisters(crashText);
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
    }
  }

  const faultInfo = parseFaultInfo(crashText, selectedCoreId);

  // If no backtrace frames found, extract addresses from stack dumps
  if (frames.length === 0 && !suppressStructured) {
    // Recognized RISC-V dumps: reuse the detailed parser's per-core stack
    // segments — they retain valid rows after blank or diagnostic lines
    // that the generic rescan below would treat as a section end.
    if (riscv && selectedCoreId !== undefined) {
      for (const seg of riscv.stackDump) {
        if (seg.coreId !== selectedCoreId) {
          continue;
        }
        for (const word of seg.data) {
          if (word >= 0x40000000 && word < 0x50000000) {
            frames.push({ address: `0x${word.toString(16)}` });
          }
        }
      }
    }
    if (frames.length === 0 && !riscv) {
      const lines = crashText.split(/\r\n?|\n/);
      let inStackMemory = false;
      let inEsp8266Stack = false;
      let currentCore: number | undefined;
      for (const line of lines) {
        const trimmed = line.trim();
        // Blank separator lines must not end an open 'Stack memory:' section —
        // dumps can contain them between data rows.
        if (trimmed === '') {
          continue;
        }
        const dumpHeader = trimmed.match(/^Core\s+(\d+)\s+register dump:/i);
        if (dumpHeader) {
          currentCore = parseInt(dumpHeader[1], 10);
          inStackMemory = false;
          inEsp8266Stack = false;
          continue;
        }
        // RISC-V "Stack memory:" format (values may be 0x-prefixed or bare hex)
        if (/^Stack memory:/i.test(trimmed)) {
          inStackMemory = true;
          inEsp8266Stack = false;
          continue;
        }
        // ESP8266 ">>>stack>>>" format (plain hex values)
        if (/^>>>stack>>>/.test(trimmed)) {
          inEsp8266Stack = true;
          inStackMemory = false;
          continue;
        }
        if (/^<<<stack<<</.test(trimmed)) {
          inEsp8266Stack = false;
          continue;
        }
        // Sectioned captures only contribute the selected core's rows.
        const otherCore =
          selectedCoreId !== undefined &&
          currentCore !== undefined &&
          currentCore !== selectedCoreId;
        if (inStackMemory && !otherCore) {
          const row = parseStackDataRow(trimmed);
          if (row) {
            for (const word of row.data) {
              if (word >= 0x40000000 && word < 0x50000000) {
                frames.push({
                  address: `0x${word.toString(16)}`,
                });
              }
            }
          } else {
            inStackMemory = false;
          }
        }
        if (inEsp8266Stack) {
          // ESP8266 stack lines: "3ffffec0:  3ffee55c 3ffee55c 3ffee6dc 40201df1"
          // Skip header lines (ctx:, sp:, end:, offset:)
          const hexMatch = trimmed.match(/^([0-9a-fA-F]{8}):\s+((?:[0-9a-fA-F]{8}\s*)+)/);
          if (hexMatch) {
            const words = hexMatch[2].trim().split(/\s+/);
            for (const word of words) {
              const val = parseInt(word, 16);
              if (val >= 0x40000000 && val < 0x50000000) {
                frames.push({ address: `0x${val.toString(16).padStart(8, '0')}` });
              }
            }
          }
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
