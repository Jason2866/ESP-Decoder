/**
 * Shared types for panic decoding, modeled on esp-idf-panic-decoder's
 * gdb_panic_server approach: parse the panic handler output (registers &
 * stack dump), serve it to GDB over the remote serial protocol, and let GDB
 * produce the backtrace.
 */

export type RegAddr = string;

export interface GDBLine {
  regAddr: RegAddr;
  lineNumber: string; // '36' or '??'
}

export interface FrameArg {
  name: string;
  type?: string;
  value?: string;
}

export interface FrameVar {
  name: string;
  type?: string;
  value?: string;
  address?: string;
  children?: FrameVar[];
  scope?: 'local' | 'argument' | 'global';
}

export interface ParsedGDBLine extends GDBLine {
  file: string;
  method: string;
  args?: FrameArg[];
  locals?: FrameVar[];
  globals?: FrameVar[];
}

export type AddrLocation = RegAddr | GDBLine | ParsedGDBLine;

export interface AddrLine {
  addr?: number | string;
  location: AddrLocation;
}

export interface AllocInfo {
  allocAddr: AddrLocation;
  allocSize: number;
}

export interface FaultInfo {
  /** CPU core that crashed; absent when the source has no core metadata. */
  coreId?: number;
  programCounter?: AddrLine;
  faultAddr?: AddrLine;
  faultCode?: number;
  faultMessage?: string;
}

export interface DecodeResult {
  faultInfo?: FaultInfo;
  regs?: Record<string, number>;
  stacktraceLines: (GDBLine | ParsedGDBLine)[];
  allocInfo?: AllocInfo;
  globals?: FrameVar[];
}

export interface DecodeParams {
  elfPath: string;
  toolPath: string;
  targetArch: DecodeTarget;
  coredumpMode?: boolean;
}

export type DecodeTarget = 'xtensa' | 'riscv';

export type Debug = (...args: unknown[]) => void;

export interface DecodeOptions {
  signal?: AbortSignal;
  debug?: Debug;
}

export interface PanicInfo {
  coreId: number;
  programCounter?: number;
  faultAddr?: number;
  faultCode?: number;
  regs: Record<string, number>;
}

/** Parsed panic output with the raw stack dump needed by the GDB stub. */
export interface PanicInfoWithStackData extends PanicInfo {
  stackBaseAddr: number;
  stackData: Buffer;
}

/** Parsed panic output reduced to candidate code addresses. */
export interface PanicInfoWithBacktrace extends PanicInfo {
  backtraceAddrs: (AddrLine | number)[];
}

export interface ThreadDecodeResult {
  threadId: string;
  TCB: number;
  threadName?: string;
  result: DecodeResult;
  current?: boolean;
}

export type CoredumpDecodeResult = ThreadDecodeResult[];

// --- Type guards -----------------------------------------------------------

export function isGDBLine(arg: unknown): arg is GDBLine {
  return (
    arg !== null &&
    typeof arg === 'object' &&
    'regAddr' in arg &&
    typeof (arg as GDBLine).regAddr === 'string' &&
    'lineNumber' in arg &&
    typeof (arg as GDBLine).lineNumber === 'string'
  );
}

export function isParsedGDBLine(arg: unknown): arg is ParsedGDBLine {
  return (
    isGDBLine(arg) &&
    'file' in arg &&
    typeof (arg as ParsedGDBLine).file === 'string' &&
    'method' in arg &&
    typeof (arg as ParsedGDBLine).method === 'string'
  );
}

export function isAddrLine(arg: unknown): arg is AddrLine {
  if (arg === null || typeof arg !== 'object' || !('location' in arg)) {
    return false;
  }
  const a = arg as AddrLine;
  const addrOk =
    a.addr === undefined || typeof a.addr === 'number' || typeof a.addr === 'string';
  const loc = a.location;
  const locOk =
    typeof loc === 'string' || isGDBLine(loc) || isParsedGDBLine(loc);
  return addrOk && locOk;
}

export function getAddr(addrLocation: AddrLocation | undefined): number | undefined {
  if (!addrLocation) {
    return undefined;
  }
  const raw = isGDBLine(addrLocation) ? addrLocation.regAddr : String(addrLocation);
  const parsed = parseInt(raw, 16);
  return Number.isNaN(parsed) ? undefined : parsed;
}
