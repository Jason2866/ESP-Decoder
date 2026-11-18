import { addr2line } from './addr2line';
import { GdbMiClient, extractMiListContent, parseMiTupleList, stripMiList } from './gdbMi';
import { parseLines } from './gdbLineParse';
import { GdbStubServer } from './gdbStub';
import {
  parseRiscvPanicOutput,
  toHexString,
} from './panicParse';
import {
  isGDBLine,
  isParsedGDBLine,
  type AddrLine,
  type DecodeOptions,
  type DecodeParams,
  type DecodeResult,
  type Debug,
  type FrameArg,
  type GDBLine,
  type ParsedGDBLine,
  type PanicInfoWithStackData,
} from './types';

// Based on esp-idf-panic-decoder's gdb_panic_server.py: parse the register/stack
// dump, serve it over the GDB remote protocol, and let GDB/MI produce the
// backtrace via `-stack-list-frames`.

const miErrorPattern = /^\^error/m;

function parseMiErrorMessage(raw: string): string | undefined {
  const match = raw.match(/\^error(?:,[^\n]*?msg="((?:\\.|[^"])*)")?/m);
  if (!match?.[1]) {
    return undefined;
  }
  return match[1]
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n');
}

function summarizeMiOutput(raw: string): string {
  const normalized = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  if (!normalized) {
    return 'empty MI response';
  }
  const maxLength = 240;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...[truncated ${normalized.length - maxLength} chars]`;
}

function describeMiFailure(raw: string): string {
  return parseMiErrorMessage(raw) ?? summarizeMiOutput(raw);
}

function toFrameArg(tuple: Record<string, string>): FrameArg | undefined {
  if (!tuple.name) {
    return undefined;
  }
  const arg: FrameArg = { name: tuple.name };
  if (tuple.type) {
    arg.type = tuple.type;
  }
  if (tuple.value !== undefined) {
    arg.value = tuple.value;
  }
  return arg;
}

function toParsedFrame(frame: Record<string, string>): GDBLine | ParsedGDBLine {
  const regAddr = frame.addr || '??';
  const method = frame.func && frame.func !== '??' ? frame.func : undefined;
  const fileRaw = frame.fullname || frame.file;
  const file = fileRaw && fileRaw !== '??' ? fileRaw : undefined;
  const lineNumber = frame.line && frame.line !== '??' ? frame.line : undefined;

  if (!method && !file && !lineNumber) {
    return { regAddr, lineNumber: '??' };
  }

  return {
    regAddr,
    method: method || '??',
    file: file || '??',
    lineNumber: lineNumber || '??',
  };
}

function parseMiFrames(raw: string): Record<string, string>[] {
  const listContent = extractMiListContent(raw, 'stack');
  return parseMiTupleList(listContent, 'frame');
}

function parseMiStackArgs(raw: string, frameLevel: string): FrameArg[] | undefined {
  if (miErrorPattern.test(raw)) {
    return undefined;
  }
  const listContent = extractMiListContent(raw, 'stack-args');
  if (listContent === undefined) {
    return undefined;
  }
  const frames = parseMiTupleList(listContent, 'frame');
  const frame = frames.find((entry) => entry.level === frameLevel) ?? frames[0];
  if (!frame || !frame.args) {
    return [];
  }
  const argsList = stripMiList(frame.args) ?? '';
  return parseMiTupleList(argsList)
    .map(toFrameArg)
    .filter((a): a is FrameArg => a !== undefined);
}

function stripEntrySuffix(name: string): string {
  return name.replace(/@entry$/, '');
}

function dedupeArgs(args: FrameArg[] | undefined): FrameArg[] {
  if (!args || !args.length) {
    return [];
  }
  const byName = new Map<string, { arg: FrameArg; fromEntry: boolean }>();
  const order: string[] = [];

  for (const arg of args) {
    if (!arg?.name) {
      continue;
    }
    const baseName = stripEntrySuffix(arg.name);
    const fromEntry = arg.name.endsWith('@entry');
    const existing = byName.get(baseName);
    if (!existing) {
      byName.set(baseName, { arg: { ...arg, name: baseName }, fromEntry });
      order.push(baseName);
      continue;
    }

    if (existing.fromEntry && !fromEntry) {
      byName.set(baseName, { arg: { ...arg, name: baseName }, fromEntry });
      continue;
    }

    if (!existing.arg.type && arg.type) {
      existing.arg.type = arg.type;
    }
    if (
      (!existing.arg.value || existing.arg.value === '<optimized out>') &&
      arg.value &&
      arg.value !== '<optimized out>'
    ) {
      existing.arg.value = arg.value;
    }
  }

  return order
    .map((name) => byName.get(name)?.arg)
    .filter((a): a is FrameArg => a !== undefined);
}

async function fetchStacktraceWithMi(
  params: DecodeParams,
  panicInfo: PanicInfoWithStackData,
  options: DecodeOptions = {},
  log: Debug = () => {},
): Promise<(GDBLine | ParsedGDBLine)[]> {
  const { elfPath, toolPath } = params;
  let server: GdbStubServer | undefined;
  let client: GdbMiClient | undefined;

  try {
    log('fetch stacktrace start', { elfPath, toolPath });
    const { signal, debug } = options;
    const gdbServer = new GdbStubServer(panicInfo, debug);
    const { remoteSpec } = await gdbServer.start(signal);
    server = gdbServer;
    log('gdb stub ready', { remoteSpec });

    client = new GdbMiClient(toolPath, ['--interpreter=mi2', '-n', elfPath], options);
    await client.drainHandshake();
    const targetResult = await client.sendCommand(`-target-select remote ${remoteSpec}`);
    if (miErrorPattern.test(targetResult)) {
      throw new Error(`Failed to connect to GDB remote target: ${describeMiFailure(targetResult)}`);
    }
    log('gdb remote connected');

    const framesRaw = await client.sendCommand('-stack-list-frames');
    if (miErrorPattern.test(framesRaw)) {
      throw new Error(`Failed to list stack frames: ${describeMiFailure(framesRaw)}`);
    }
    const frames = parseMiFrames(framesRaw);
    const stacktraceLines = frames.map(toParsedFrame);
    log('frames parsed', frames.length);

    for (let i = 0; i < frames.length; i++) {
      const frameLevel = frames[i].level ?? `${i}`;
      await client.sendCommand(`-stack-select-frame ${frameLevel}`);

      const argsRaw = await client.sendCommand(
        `-stack-list-arguments --simple-values ${frameLevel} ${frameLevel}`,
      );
      const rawArgs = parseMiStackArgs(argsRaw, frameLevel);
      const args = dedupeArgs(rawArgs);
      const parsedFrame = isParsedGDBLine(stacktraceLines[i])
        ? (stacktraceLines[i] as ParsedGDBLine)
        : undefined;
      if (args.length && parsedFrame) {
        parsedFrame.args = args;
        log('frame args', frameLevel, parsedFrame.args);
      }
    }

    log('fetch stacktrace done', stacktraceLines.length);
    return stacktraceLines;
  } finally {
    client?.close();
    server?.close();
  }
}

const exceptions: { code: number; description: string }[] = [
  { code: 0x0, description: 'Instruction address misaligned' },
  { code: 0x1, description: 'Instruction access fault' },
  { code: 0x2, description: 'Illegal instruction' },
  { code: 0x3, description: 'Breakpoint' },
  { code: 0x4, description: 'Load address misaligned' },
  { code: 0x5, description: 'Load access fault' },
  { code: 0x6, description: 'Store/AMO address misaligned' },
  { code: 0x7, description: 'Store/AMO access fault' },
  { code: 0x8, description: 'Environment call from U-mode' },
  { code: 0x9, description: 'Environment call from S-mode' },
  { code: 0xb, description: 'Environment call from M-mode' },
  { code: 0xc, description: 'Instruction page fault' },
  { code: 0xd, description: 'Load page fault' },
  { code: 0xf, description: 'Store/AMO page fault' },
];

function createDecodeResult(
  panicInfo: PanicInfoWithStackData,
  programCounter: AddrLine | undefined,
  faultAddr: AddrLine | undefined,
  stacktraceLines: (GDBLine | ParsedGDBLine)[],
): DecodeResult {
  const exception = exceptions.find((e) => e.code === panicInfo.faultCode);

  return {
    faultInfo: {
      coreId: panicInfo.coreId,
      programCounter,
      faultAddr,
      faultCode: panicInfo.faultCode,
      faultMessage: exception ? exception.description : undefined,
    },
    regs: panicInfo.regs,
    stacktraceLines,
  };
}

/**
 * PCs from firmware-printed 'Backtrace:' PC:SP pairs. Some ESP-IDF RISC-V
 * targets (e.g. ESP32-P4) print an unwound backtrace instead of a raw
 * 'Stack memory:' dump; those PCs are resolved directly via addr2line.
 */
export function extractPrintedBacktraceAddrs(input: string, coreId: number): number[] {
  const addrs: number[] = [];
  let currentCore: number | undefined;
  let sawCoreHeader = false;
  for (const line of input.split(/\r?\n/)) {
    // 'Backtrace:' lines belong to the core section they appear under — the
    // same attribution parseRiscvPanicDetailed applies to register dumps.
    const dumpMatch = line.match(/^\s*Core\s+(\d+)\s+register dump:/);
    if (dumpMatch) {
      currentCore = parseInt(dumpMatch[1], 10);
      sawCoreHeader = true;
      continue;
    }
    if (!/Backtrace:/.test(line)) {
      continue;
    }
    if (sawCoreHeader && currentCore !== coreId) {
      continue;
    }
    for (const match of line.matchAll(/(0x[0-9a-fA-F]+)\s*:\s*0x[0-9a-fA-F]+/g)) {
      const addr = parseInt(match[1], 16);
      if (!Number.isNaN(addr)) {
        addrs.push(addr);
      }
    }
  }
  return addrs;
}

/**
 * Minimum stack bytes worth unwinding via GDB/MI: below this a frame chain
 * cannot be recovered anyway (a saved ra/sp pair needs ~16 bytes per frame),
 * so a printed 'Backtrace:' stays the better source. ESP32-S31 dumps a
 * single mostly-zero 32-byte row — the firmware-printed backtrace is richer.
 */
const MIN_UNWIND_STACK_BYTES = 64;

/**
 * The printed-'Backtrace:' path applies only when the selected core printed
 * an unwound backtrace AND there is no usable raw 'Stack memory:' dump to
 * unwind — a real stack dump is the richer source and keeps the MI unwind
 * authoritative.
 */
export function printedBacktraceApplies(printedBacktrace: number[], stackData: Buffer): boolean {
  return printedBacktrace.length > 0 && stackData.length < MIN_UNWIND_STACK_BYTES;
}

/**
 * Decode a RISC-V panic output: parse registers/stack dump, serve it to GDB
 * over the remote protocol, and resolve frames via GDB/MI + addr2line.
 */
export async function decodeRiscv(
  params: DecodeParams,
  input: string,
  options: DecodeOptions = {},
): Promise<DecodeResult> {
  const log: Debug = options.debug ?? (() => {});
  log('decode start', { targetArch: params.targetArch });

  const panicInfo = parseRiscvPanicOutput(input);
  log('panic info', {
    coreId: panicInfo.coreId,
    programCounter: panicInfo.programCounter,
    faultAddr: panicInfo.faultAddr,
    faultCode: panicInfo.faultCode,
  });

  // Run the MI backtrace and the addr2line lookups under one decode-scoped
  // abort signal: if either fails, abort the sibling so its GDB processes
  // shut down instead of lingering until the outer timeout.
  const decodeAbort = new AbortController();
  const onOuterAbort = () => decodeAbort.abort();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (options.signal?.aborted) {
    decodeAbort.abort();
  }
  const childOptions: DecodeOptions = { ...options, signal: decodeAbort.signal };

  // When the firmware already printed an unwound 'Backtrace:' and there is
  // no raw stack memory to serve, resolve those PCs in order via addr2line
  // instead of asking GDB to unwind an empty stack. If a 'Stack memory:'
  // dump is present the MI unwind is the richer source and takes precedence.
  const printedBacktrace = extractPrintedBacktraceAddrs(input, panicInfo.coreId);
  const usePrintedBacktrace = printedBacktraceApplies(printedBacktrace, panicInfo.stackData);

  const addr2lineAddrs: (number | undefined)[] = [
    panicInfo.programCounter,
    panicInfo.faultAddr,
    ...(usePrintedBacktrace ? printedBacktrace : []),
  ];
  // addr2line throws on an empty address list; a missing MEPC/MTVAL must not
  // discard the MI-unwound frames, so skip the lookup entirely then.
  const hasLookupAddrs = addr2lineAddrs.some((a) => a !== undefined);
  const tasks = [
    usePrintedBacktrace
      ? Promise.resolve([] as (GDBLine | ParsedGDBLine)[])
      : fetchStacktraceWithMi(params, panicInfo, childOptions, log),
    hasLookupAddrs
      ? addr2line(params, addr2lineAddrs, childOptions)
      : Promise.resolve([] as (AddrLine | undefined)[]),
  ] as const;

  try {
    const [miLines, resolved] = await Promise.all(tasks);
    const [programCounter, faultAddr, ...frameLocations] = resolved;
    const stacktraceLines = usePrintedBacktrace
      ? frameLocations
          .map((line) => line?.location)
          .filter(isGDBLine)
      : miLines;
    log('addr2line done', { programCounter, faultAddr });
    stacktraceLines.forEach((line, index) => {
      log('stacktrace line', index, line);
    });

    return createDecodeResult(panicInfo, programCounter, faultAddr, stacktraceLines);
  } catch (err) {
    decodeAbort.abort();
    // Let the sibling settle so its GDB child processes exit cleanly.
    await Promise.allSettled(tasks);
    throw err;
  } finally {
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

// Re-exported for tests / callers that need the raw parsers.
export { parseLines, toHexString };
