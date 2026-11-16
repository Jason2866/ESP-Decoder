import { addr2line } from './addr2line';
import { GdbMiClient, extractMiListContent, parseMiTupleList, stripMiList } from './gdbMi';
import { parseLines } from './gdbLineParse';
import { GdbStubServer } from './gdbStub';
import {
  parseRiscvPanicOutput,
  toHexString,
} from './panicParse';
import {
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
    const { port } = await gdbServer.start(signal);
    server = gdbServer;
    log('gdb server started', { port });

    client = new GdbMiClient(toolPath, ['--interpreter=mi2', '-n', elfPath], options);
    await client.drainHandshake();
    const targetResult = await client.sendCommand(`-target-select remote 127.0.0.1:${port}`);
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

  const [stacktraceLines, [programCounter, faultAddr]] = await Promise.all([
    fetchStacktraceWithMi(params, panicInfo, options, log),
    addr2line(params, [panicInfo.programCounter, panicInfo.faultAddr], options),
  ]);
  log('addr2line done', { programCounter, faultAddr });
  stacktraceLines.forEach((line, index) => {
    log('stacktrace line', index, line);
  });

  return createDecodeResult(panicInfo, programCounter, faultAddr, stacktraceLines);
}

// Re-exported for tests / callers that need the raw parsers.
export { parseLines, toHexString };
