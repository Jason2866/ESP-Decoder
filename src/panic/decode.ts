import { AbortError } from './gdbStub';
import { decodeCoredumpFile } from './coredump';
import { decodeRiscv } from './decodeRiscv';
import { decodeXtensa } from './decodeXtensa';
import {
  isAddrLine,
  isGDBLine,
  isParsedGDBLine,
  getAddr,
  type AddrLine,
  type AddrLocation,
  type CoredumpDecodeResult,
  type DecodeOptions,
  type DecodeParams,
  type DecodeResult,
  type GDBLine,
  type ParsedGDBLine,
} from './types';

/**
 * Panic decoder entry points, modeled on esp-idf-panic-decoder's decode()
 * dispatch: 'xtensa' | 'riscv' family targets only.
 */

const decoders = {
  xtensa: decodeXtensa,
  riscv: decodeRiscv,
} as const;

export type DecodeTarget = keyof typeof decoders;

export function isDecodeTarget(arg: unknown): arg is DecodeTarget {
  return arg === 'xtensa' || arg === 'riscv';
}

/** Decode a captured panic text blob (register/stack dump). */
export async function decodePanicText(
  params: DecodeParams,
  input: string,
  options: DecodeOptions = {},
): Promise<DecodeResult> {
  const decoder = decoders[params.targetArch];
  if (!decoder) {
    throw new Error(`Unsupported decode target: ${params.targetArch}`);
  }
  const result = await decoder(params, input, options);
  const fixedResult = fixDecodeResult(result, false);
  if (options.signal?.aborted) {
    throw new AbortError();
  }
  return fixedResult;
}

/** Decode an ESP-IDF coredump ELF file (per-thread results). */
export async function decodeCoredump(
  params: DecodeParams,
  inputPath: string,
  options: DecodeOptions = {},
): Promise<CoredumpDecodeResult> {
  const result = await decodeCoredumpFile(params, inputPath, options);
  if (options.signal?.aborted) {
    throw new AbortError();
  }
  return result.map((threadDecodeResult) => ({
    ...threadDecodeResult,
    // GDB coredump frames come from a real unwind — they carry no stack
    // pointers, so the stack-pointer filter must not drop them.
    result: fixDecodeResult(threadDecodeResult.result, false),
  }));
}

// --- result post-processing ------------------------------------------------

function fixDecodeResult(result: DecodeResult, filterStackPointers = true): DecodeResult {
  const fixedPathsResult = fixWindowsPaths(result);
  let filteredResult = filterFreeRTOSStackLines(fixedPathsResult);
  if (filterStackPointers) {
    filteredResult = filterStackPointerLines(filteredResult);
  }
  return fixFaultInfo(filteredResult);
}

function fixWindowsPaths(result: DecodeResult): DecodeResult {
  return {
    ...result,
    faultInfo: result.faultInfo
      ? {
          ...result.faultInfo,
          programCounter: fixWindowsPathInLocation(
            result.faultInfo.programCounter,
          ),
          faultAddr: fixWindowsPathInLocation(result.faultInfo.faultAddr),
        }
      : undefined,
    stacktraceLines: result.stacktraceLines.map(fixWindowsPathInLocation),
    allocInfo: result.allocInfo
      ? {
          ...result.allocInfo,
          allocAddr: fixWindowsPathInLocation(result.allocInfo.allocAddr),
        }
      : undefined,
  };
}

function fixWindowsPathInLocation<T extends AddrLine | AddrLocation | undefined>(locationAware: T): T {
  if (!locationAware) {
    return locationAware;
  }

  if (isAddrLine(locationAware)) {
    const location = locationAware.location;
    if (isParsedGDBLine(location)) {
      const copy = JSON.parse(JSON.stringify(locationAware));
      copy.location.file = fixWindowsPath(location.file);
      return copy;
    }
  }

  if (isParsedGDBLine(locationAware)) {
    const copy = JSON.parse(JSON.stringify(locationAware));
    copy.file = fixWindowsPath(locationAware.file);
    return copy;
  }

  return locationAware;
}

function fixWindowsPath(path: string): string {
  return process.platform === 'win32' && /^[a-zA-Z]:\\/.test(path)
    ? path.replace(/\//g, '\\')
    : path;
}

function filterFreeRTOSStackLines(result: DecodeResult): DecodeResult {
  return {
    ...result,
    stacktraceLines: result.stacktraceLines.filter((line) => {
      if (isGDBLine(line) && line.lineNumber === '??' && line.regAddr.toLowerCase() === '0xfeefeffe') {
        return false;
      }
      return true;
    }),
  };
}

function filterStackPointerLines(result: DecodeResult): DecodeResult {
  return {
    ...result,
    stacktraceLines: result.stacktraceLines.filter(
      (line, index, lines) =>
        !(lines[index - 1] && isStackPointerLine(line, lines[index - 1])),
    ),
  };
}

function isStackPointerLine(line: GDBLine | ParsedGDBLine, prevLine: GDBLine | ParsedGDBLine): boolean {
  if (!isParsedGDBLine(prevLine)) {
    return false;
  }

  const prevAddr = getAddr(prevLine.regAddr);
  const addr = getAddr(line.regAddr);
  if (addr === undefined || prevAddr === undefined) {
    return false;
  }

  const isAddr3x = addr >>> 28 === 0x3;
  const isPrevAddr4x = prevAddr >>> 28 === 0x4;

  return line.lineNumber === '??' && isAddr3x && isPrevAddr4x;
}

function fixFaultInfo(result: DecodeResult): DecodeResult {
  if (
    result.faultInfo &&
    isGDBLine(result.faultInfo.faultAddr?.location) &&
    result.faultInfo.faultAddr.location.lineNumber === '??' &&
    result.faultInfo.faultAddr.addr === undefined
  ) {
    const copy = JSON.parse(JSON.stringify(result));
    delete copy.faultInfo.faultAddr;
    return copy;
  }

  return result;
}
