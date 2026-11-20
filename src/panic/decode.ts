import { AbortError } from './gdbStub';
import { decodeCoredumpFile } from './coredump';
import { decodeRiscv } from './decodeRiscv';
import { decodeXtensa } from './decodeXtensa';
import {
  isAddrLine,
  isGDBLine,
  isParsedGDBLine,
  type AddrLine,
  type AddrLocation,
  type CoredumpDecodeResult,
  type DecodeOptions,
  type DecodeParams,
  type DecodeResult,
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
  const fixedResult = fixDecodeResult(result);
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
    result: fixDecodeResult(threadDecodeResult.result),
    warning: threadDecodeResult.warning,
  }));
}

// --- result post-processing ------------------------------------------------

function fixDecodeResult(result: DecodeResult): DecodeResult {
  const fixedPathsResult = fixWindowsPaths(result);
  const filteredResult = filterFreeRTOSStackLines(fixedPathsResult);
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
