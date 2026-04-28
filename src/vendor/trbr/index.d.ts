// TypeScript declarations for the vendored `trbr` JavaScript source under
// src/vendor/trbr/. Only the surface consumed by esp-decoder is declared.
// The runtime implementation lives in ./index.js (and the files it imports).

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type RegAddr = string;

export interface GDBLine {
  regAddr: RegAddr;
  lineNumber: string;
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
  scope?: 'global' | 'local' | 'argument';
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
  addr?: number;
  location: AddrLocation;
}

export interface AllocInfo {
  allocAddr: AddrLocation;
  allocSize: number;
}

export interface FaultInfo {
  coreId: number;
  programCounter: AddrLine;
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

export interface ThreadDecodeResult {
  threadId: string;
  TCB: number;
  threadName?: string;
  result: DecodeResult;
  current?: boolean;
}

export type CoredumpDecodeResult = ThreadDecodeResult[];

export type DecodeTarget =
  | 'xtensa'
  | 'esp32c2'
  | 'esp32c3'
  | 'esp32c6'
  | 'esp32h2'
  | 'esp32h4'
  | 'esp32p4';

export interface DecodeParams {
  toolPath: string;
  elfPath: string;
  targetArch: DecodeTarget;
}

export type DecodeCoredumpParams = DecodeParams & { coredumpMode: true };

export type Debug = (formatter: unknown, ...args: unknown[]) => void;

export interface DecodeOptions {
  signal?: AbortSignal;
  debug?: Debug;
  includeFrameVars?: boolean;
}

export interface DecodeInputFileSource {
  inputPath: string;
}

export interface DecodeInputStreamSource {
  inputStream: NodeJS.ReadableStream;
}

export type DecodeInput = DecodeInputFileSource | DecodeInputStreamSource | string;

export interface CreateDecodeParamsParams {
  elfPath: string;
  toolPath: string;
  targetArch?: DecodeTarget;
  coredumpMode?: boolean;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export function decode(
  params: DecodeParams,
  decodeInput: DecodeInput,
  options?: DecodeOptions
): Promise<DecodeResult | CoredumpDecodeResult>;

export function isGDBLine(arg: unknown): arg is GDBLine;
export function isParsedGDBLine(arg: unknown): arg is ParsedGDBLine;

export function createDecodeParams(
  params: CreateDecodeParamsParams
): Promise<DecodeParams | DecodeCoredumpParams>;

export interface StringifyOptions {
  color?: 'force' | 'disable';
  lineSeparator?: string;
}

export function stringifyDecodeResult(
  result: DecodeResult | CoredumpDecodeResult,
  options?: StringifyOptions
): string;

// ---------------------------------------------------------------------------
// Capturer
// ---------------------------------------------------------------------------

export type CapturerEventName = 'eventDetected' | 'eventUpdated';
export type CapturerEventKind = 'xtensa' | 'riscv' | 'unknown';

export interface CapturerLightweight {
  reasonLine: string | undefined;
  programCounter: number | undefined;
  faultCode: number | undefined;
  faultAddr: number | undefined;
  regs: Record<string, number>;
  backtraceAddrs: number[];
}

export interface CapturerEvaluated {
  eventId: string;
  evaluatedAt: number;
  status: 'stub' | 'decoded';
  frames: AddrLine[];
  decodeResult?: DecodeResult;
}

export interface CapturerEvent {
  id: string;
  signature: string;
  kind: CapturerEventKind;
  lines: string[];
  rawText: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  lightweight: CapturerLightweight;
  fastFrames: AddrLine[] | undefined;
  evaluated: CapturerEvaluated | undefined;
}

export type CapturerListener = (event: CapturerEvent) => void;

export interface CapturerEvaluateContext {
  event: CapturerEvent;
  signal?: AbortSignal;
}

export type CapturerEvaluateFn = (
  context: CapturerEvaluateContext
) => Promise<CapturerEvaluated>;

export interface CapturerEvaluateOptions {
  signal?: AbortSignal;
}

export interface CapturerRawState {
  bytes: Uint8Array[];
  byteLength: number;
  lines: string[];
}

export interface CapturerOptions {
  quietPeriodMs?: number;
  dedupWindowMs?: number;
  maxEvents?: number;
  maxRawBytes?: number;
  maxRawLines?: number;
  now?: () => number;
  evaluateEvent?: CapturerEvaluateFn;
}

export class Capturer {
  constructor(options?: CapturerOptions);
  push(chunk: Uint8Array): void;
  flush(): void;
  getEvents(): CapturerEvent[];
  getRawState(): CapturerRawState;
  on(eventName: CapturerEventName, listener: CapturerListener): () => void;
  evaluate(eventId: string, options?: CapturerEvaluateOptions): Promise<CapturerEvaluated>;
}

export function createCapturer(options?: CapturerOptions): Capturer;

export class AbortError extends Error {
  constructor();
  name: 'AbortError';
  code: 'ABORT_ERR';
}
