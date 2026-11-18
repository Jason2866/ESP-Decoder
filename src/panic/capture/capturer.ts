import { EventEmitter } from 'node:events';
import {
  parseESP32PanicOutput,
  parseESP8266PanicOutput,
  parseRiscvPanicLightweight,
} from '../panicParse';
import { CrashFramer, type FramedCrashBlock } from './framer';
import { LineDecoder } from './lineDecoder';

export type CapturerEventKind = 'xtensa' | 'riscv' | 'unknown';

export interface CapturerLightweight {
  reasonLine?: string;
  programCounter?: number;
  faultCode?: number;
  faultAddr?: number;
  regs: Record<string, number>;
  backtraceAddrs: number[];
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
}

export type CapturerEventName = 'eventDetected' | 'eventUpdated';
export type CapturerListener = (event: CapturerEvent) => void;

export interface CapturerOptions {
  quietPeriodMs?: number;
  dedupWindowMs?: number;
  maxEvents?: number;
  now?: () => number;
}

interface ResolvedCapturerOptions {
  quietPeriodMs: number;
  dedupWindowMs: number;
  maxEvents: number;
  now: () => number;
}

const defaultOptions = {
  quietPeriodMs: 200,
  dedupWindowMs: 5000,
  maxEvents: 100,
} as const;

/**
 * Silence after which an unterminated line in LineDecoder is force-flushed
 * so a pending crash tail can complete its block.
 */
const PENDING_LINE_TIMEOUT_MS = 2000;

/**
 * Module-level event id allocator: capturer resets create fresh instances,
 * so a per-instance counter would restart at event-000001 and collide with
 * ids already emitted by a previous capturer.
 */
let nextEventId = 1;

/**
 * Captures crash events from a raw serial byte stream: incremental line
 * decoding, crash-block framing, lightweight parse, and deduplication.
 */
export class Capturer {
  private readonly eventBus = new EventEmitter();
  private readonly lineDecoder = new LineDecoder();
  private readonly framer: CrashFramer;
  private readonly options: ResolvedCapturerOptions;
  private events: CapturerEvent[] = [];
  private readonly eventsById = new Map<string, CapturerEvent>();
  private readonly signatureIndex = new Map<string, string>();
  private quietTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: CapturerOptions = {}) {
    this.options = {
      quietPeriodMs: options.quietPeriodMs ?? defaultOptions.quietPeriodMs,
      dedupWindowMs: options.dedupWindowMs ?? defaultOptions.dedupWindowMs,
      maxEvents: options.maxEvents ?? defaultOptions.maxEvents,
      now: options.now ?? Date.now,
    };
    this.framer = new CrashFramer(this.options.quietPeriodMs);
  }

  push(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('Expected a Uint8Array monitor chunk');
    }
    this.processLines(this.lineDecoder.push(chunk));
    this.scheduleQuietFlush();
  }

  flush(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = undefined;
    }
    this.processLines(this.lineDecoder.flush());
    this.finalizeBlocks(this.framer.flush(this.options.now()));
  }

  /** Cancel pending timers; the capturer emits no further events. */
  dispose(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = undefined;
    }
    this.eventBus.removeAllListeners();
  }

  getEvents(): CapturerEvent[] {
    return structuredClone(this.events);
  }

  on(eventName: CapturerEventName, listener: CapturerListener): () => void {
    this.eventBus.on(eventName, listener);
    return () => {
      this.eventBus.off(eventName, listener);
    };
  }

  /**
   * Finalize a pending crash block after the stream goes quiet, without
   * waiting for the next chunk or an explicit flush.
   */
  private scheduleQuietFlush(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
    }
    this.quietTimer = setTimeout(() => {
      this.quietTimer = undefined;
      if (this.lineDecoder.hasPendingLine()) {
        // The pending tail survives short pauses; after a longer silence,
        // run it through the normal line/block finalization flow so the
        // completed crash block (including the tail line) can emit without
        // new output or an explicit flush.
        this.quietTimer = setTimeout(() => {
          this.quietTimer = undefined;
          this.processLines(this.lineDecoder.flush());
          this.finalizeBlocks(this.framer.flush(this.options.now(), true));
        }, PENDING_LINE_TIMEOUT_MS);
        this.quietTimer.unref?.();
        return;
      }
      // Timer path emits only complete blocks; an incomplete block stays
      // active so late-arriving backtrace lines can still join it.
      this.finalizeBlocks(this.framer.flush(this.options.now(), true));
    }, this.options.quietPeriodMs);
    this.quietTimer.unref?.();
  }

  private processLines(lines: string[]): void {
    for (const line of lines) {
      const blocks = this.framer.pushLine(line, this.options.now());
      this.finalizeBlocks(blocks);
    }
  }

  private finalizeBlocks(blocks: FramedCrashBlock[]): void {
    for (const block of blocks) {
      this.mergeEvent(block);
    }
  }

  private mergeEvent(block: FramedCrashBlock): void {
    const rawText = block.lines.join('\n');
    const kind = detectKind(block.lines);
    const lightweight = parseLightweight(rawText, kind, block.reasonLine);
    const signature = createSignature(kind, lightweight.reasonLine, lightweight);
    const candidate = {
      kind,
      lines: [...block.lines],
      rawText,
      firstSeenAt: block.startedAt,
      lastSeenAt: block.lastAt,
      lightweight,
      signature,
    };

    const exact = this.findRecentBySignature(candidate);
    if (exact) {
      // Signature only covers the first few backtrace frames; a matching
      // signature with a conflicting backtrace or return address is a
      // different crash.
      if (
        backtracesCompatible(exact.lightweight.backtraceAddrs, candidate.lightweight.backtraceAddrs) &&
        returnAddressesCompatible(exact.lightweight, candidate.lightweight)
      ) {
        this.mergeIntoExisting(exact, candidate, shouldPreferCandidate(exact, candidate));
        return;
      }
    }

    const byContainment = this.findRecentContainmentMatch(candidate);
    if (byContainment && returnAddressesCompatible(byContainment.lightweight, candidate.lightweight)) {
      this.mergeIntoExisting(byContainment, candidate, shouldPreferCandidate(byContainment, candidate));
      return;
    }

    const byFingerprint = this.findRecentFingerprintMatch(candidate);
    if (byFingerprint && returnAddressesCompatible(byFingerprint.lightweight, candidate.lightweight)) {
      this.mergeIntoExisting(byFingerprint, candidate, shouldPreferCandidate(byFingerprint, candidate));
      return;
    }

    const next: CapturerEvent = {
      id: `event-${String(nextEventId++).padStart(6, '0')}`,
      signature,
      kind,
      lines: [...block.lines],
      rawText,
      firstSeenAt: block.startedAt,
      lastSeenAt: block.lastAt,
      count: 1,
      lightweight,
    };

    this.events.push(next);
    this.eventsById.set(next.id, next);
    this.signatureIndex.set(next.signature, next.id);
    this.trimEvents();
    this.emit('eventDetected', next);
  }

  private findRecentBySignature(candidate: {
    signature: string;
    lastSeenAt: number;
  }): CapturerEvent | undefined {
    const existingId = this.signatureIndex.get(candidate.signature);
    const existing = existingId ? this.eventsById.get(existingId) : undefined;
    if (!existing || !this.isWithinDedupWindow(existing, candidate.lastSeenAt)) {
      return undefined;
    }
    return existing;
  }

  private findRecentContainmentMatch(candidate: {
    kind: CapturerEventKind;
    rawText: string;
    lastSeenAt: number;
    lightweight: CapturerLightweight;
  }): CapturerEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const existing = this.events[i];
      if (!this.isWithinDedupWindow(existing, candidate.lastSeenAt)) {
        continue;
      }
      if (!isLikelySameCrash(existing, candidate)) {
        continue;
      }
      const existingContains = containsNormalizedText(existing.rawText, candidate.rawText);
      const candidateContains = containsNormalizedText(candidate.rawText, existing.rawText);
      if (existingContains || candidateContains) {
        return existing;
      }
    }
    return undefined;
  }

  private findRecentFingerprintMatch(candidate: {
    kind: CapturerEventKind;
    lightweight: CapturerLightweight;
    lastSeenAt: number;
  }): CapturerEvent | undefined {
    const candidateFingerprint = createFingerprint(candidate.kind, candidate.lightweight);
    if (!candidateFingerprint) {
      return undefined;
    }
    for (let i = this.events.length - 1; i >= 0; i--) {
      const existing = this.events[i];
      if (!this.isWithinDedupWindow(existing, candidate.lastSeenAt)) {
        continue;
      }
      if (
        createFingerprint(existing.kind, existing.lightweight) === candidateFingerprint &&
        backtracesCompatible(
          existing.lightweight.backtraceAddrs,
          candidate.lightweight.backtraceAddrs,
        )
      ) {
        return existing;
      }
    }
    return undefined;
  }

  private mergeIntoExisting(
    existing: CapturerEvent,
    candidate: {
      lines: string[];
      rawText: string;
      lightweight: CapturerLightweight;
      signature: string;
      lastSeenAt: number;
    },
    preferCandidate: boolean,
  ): void {
    existing.count += 1;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, candidate.lastSeenAt);

    if (preferCandidate) {
      existing.lines = [...candidate.lines];
      existing.rawText = candidate.rawText;
      existing.lightweight = candidate.lightweight;
      this.reindexSignature(existing, candidate.signature);
    }

    this.emit('eventUpdated', existing);
  }

  private reindexSignature(existing: CapturerEvent, signature: string): void {
    if (existing.signature === signature) {
      this.signatureIndex.set(signature, existing.id);
      return;
    }
    const currentOwner = this.signatureIndex.get(existing.signature);
    if (currentOwner === existing.id) {
      this.signatureIndex.delete(existing.signature);
    }
    existing.signature = signature;
    this.signatureIndex.set(signature, existing.id);
  }

  private isWithinDedupWindow(event: CapturerEvent, atMs: number): boolean {
    return atMs - event.lastSeenAt <= this.options.dedupWindowMs;
  }

  private trimEvents(): void {
    while (this.events.length > this.options.maxEvents) {
      const removed = this.events.shift();
      if (!removed) {
        break;
      }
      this.eventsById.delete(removed.id);
      if (this.signatureIndex.get(removed.signature) === removed.id) {
        this.signatureIndex.delete(removed.signature);
      }
    }
  }

  private emit(eventName: CapturerEventName, event: CapturerEvent): void {
    this.eventBus.emit(eventName, structuredClone(event));
  }
}

export function createCapturer(options?: CapturerOptions): Capturer {
  return new Capturer(options);
}

// --- helpers ---------------------------------------------------------------

function detectKind(lines: string[]): CapturerEventKind {
  const riscvHints = [/MCAUSE/i, /\bMEPC\b/i, /MHARTID/i];
  if (lines.some((line) => riscvHints.some((hint) => hint.test(line)))) {
    return 'riscv';
  }
  const xtensaHints = [
    /Backtrace:/i,
    /EXCCAUSE/i,
    /EXCVADDR/i,
    /Guru Meditation Error:/i,
    /^assert failed:/i,
    /^abort\(\) was called/i,
    /^Exception\s+\(\d+\):?/i,
    /^Abort called\b/i,
    /^Panic\b/i,
    />>>stack>>>/i, // ESP8266 stack dump marker
    /<<<stack<<</i,
  ];
  if (lines.some((line) => xtensaHints.some((hint) => hint.test(line)))) {
    return 'xtensa';
  }
  return 'unknown';
}

function parseLightweight(
  rawText: string,
  kind: CapturerEventKind,
  reasonLine: string | undefined,
): CapturerLightweight {
  try {
    if (kind === 'riscv') {
      const parsed = parseRiscvPanicLightweight(rawText);
      return {
        reasonLine: reasonLine?.trim(),
        programCounter: parsed.programCounter,
        faultCode: parsed.faultCode,
        faultAddr: parsed.faultAddr,
        regs: parsed.regs,
        backtraceAddrs: toArray(parsed.programCounter),
      };
    }

    if (kind === 'xtensa') {
      let parsed = parseESP32PanicOutput(rawText);
      if (Object.keys(parsed.regs).length === 0 && parsed.backtraceAddrs.length === 0 && !parsed.programCounter) {
        parsed = parseESP8266PanicOutput(rawText);
      }
      return {
        reasonLine: reasonLine?.trim(),
        programCounter: parsed.programCounter,
        faultCode: parsed.faultCode,
        faultAddr: parsed.faultAddr,
        regs: parsed.regs,
        backtraceAddrs: parsed.backtraceAddrs.filter(
          (addr): addr is number => typeof addr === 'number' && Number.isFinite(addr),
        ),
      };
    }
  } catch {
    // Keep capturer best-effort even when parsing fails.
  }

  return {
    reasonLine: reasonLine?.trim(),
    programCounter: undefined,
    faultCode: undefined,
    faultAddr: undefined,
    regs: {},
    backtraceAddrs: [],
  };
}

function createSignature(
  kind: CapturerEventKind,
  reasonLine: string | undefined,
  lightweight: CapturerLightweight,
): string {
  const normalizedReason = normalizeReason(reasonLine);
  const addrs = lightweight.backtraceAddrs.slice(0, 5);
  if (addrs.length === 0 && lightweight.programCounter !== undefined) {
    addrs.push(lightweight.programCounter);
  }
  const pcs = addrs.map((addr) => toHex(addr)).join(',');
  const faultCode = lightweight.faultCode;
  return `${kind}|${normalizedReason || 'unknown'}|fc:${faultCode ?? 'na'}|${pcs || 'nopc'}`;
}

function normalizeReason(line: string | undefined): string {
  const text = String(line ?? '').replace(/\r/g, '');
  const guruStart = text.toLowerCase().indexOf('guru meditation error:');
  const scoped = guruStart >= 0 ? text.slice(guruStart) : text;
  return scoped
    .toLowerCase()
    .replace(/0x[0-9a-f]+/gi, '0x')
    .replace(/\s+/g, ' ')
    .trim();
}

function shouldPreferCandidate(
  existing: { rawText: string; lightweight: CapturerLightweight },
  candidate: { rawText: string; lightweight: CapturerLightweight },
): boolean {
  const existingScore = computeCompleteness(existing.rawText, existing.lightweight);
  const candidateScore = computeCompleteness(candidate.rawText, candidate.lightweight);
  if (candidateScore > existingScore) {
    return true;
  }
  if (candidateScore < existingScore) {
    return false;
  }
  return candidate.rawText.length > existing.rawText.length;
}

function computeCompleteness(rawText: string, lightweight: CapturerLightweight): number {
  let score = 0;
  if (normalizeReason(lightweight.reasonLine)) {
    score += 1;
  }
  if (lightweight.faultCode !== undefined) {
    score += 1;
  }
  if (lightweight.programCounter !== undefined) {
    score += 2;
  }
  score += Math.min(lightweight.backtraceAddrs.length, 5) * 2;
  if (Object.keys(lightweight.regs).length > 0) {
    score += 1;
  }
  if (/Backtrace:|Stack memory:/i.test(rawText)) {
    score += 2;
  }
  if (/Rebooting\.\.\./i.test(rawText)) {
    score += 1;
  }
  return score;
}

function createFingerprint(
  kind: CapturerEventKind,
  lightweight: CapturerLightweight,
): string {
  const reason = normalizeReason(lightweight.reasonLine);
  const pc = getPrimaryAddr(lightweight);
  if (!reason && lightweight.faultCode === undefined && pc === undefined) {
    return '';
  }
  return `${kind}|${reason || 'unknown'}|fc:${lightweight.faultCode ?? 'na'}|pc:${pc !== undefined ? toHex(pc) : 'na'}`;
}

function containsNormalizedText(container: string, candidate: string): boolean {
  const containerNormalized = normalizeTextForContainment(container);
  const candidateNormalized = normalizeTextForContainment(candidate);
  if (!containerNormalized || !candidateNormalized) {
    return false;
  }
  return containerNormalized === candidateNormalized || containerNormalized.includes(candidateNormalized);
}

function normalizeTextForContainment(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function isLikelySameCrash(
  existing: { kind: CapturerEventKind; rawText: string; lightweight: CapturerLightweight },
  candidate: { kind: CapturerEventKind; rawText: string; lightweight: CapturerLightweight },
): boolean {
  if (existing.kind !== candidate.kind) {
    return false;
  }

  const existingReason = normalizeReason(existing.lightweight.reasonLine);
  const candidateReason = normalizeReason(candidate.lightweight.reasonLine);
  if (existingReason && candidateReason) {
    return existingReason === candidateReason;
  }

  const existingPc = getPrimaryAddr(existing.lightweight);
  const candidatePc = getPrimaryAddr(candidate.lightweight);
  if (existingPc !== undefined && candidatePc !== undefined) {
    return existingPc === candidatePc;
  }

  if (existing.lightweight.faultCode !== undefined && candidate.lightweight.faultCode !== undefined) {
    return existing.lightweight.faultCode === candidate.lightweight.faultCode;
  }

  return containsNormalizedText(existing.rawText, candidate.rawText);
}

/**
 * RISC-V dedup uses MEPC/MCAUSE for identity, but the return address (RA)
 * distinguishes call paths: two dumps with the same fault PC and cause but
 * different callers are different crashes. Compatible unless both sides
 * report an RA and the values differ.
 */
function returnAddressesCompatible(
  a: CapturerLightweight,
  b: CapturerLightweight,
): boolean {
  const raA = a.regs?.RA;
  const raB = b.regs?.RA;
  if (raA === undefined || raB === undefined) {
    return true;
  }
  return raA === raB;
}

/**
 * Two backtrace captures are compatible when they agree on every shared
 * frame; a shorter (partial) capture is compatible with a longer one.
 */
function backtracesCompatible(a: number[], b: number[]): boolean {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function getPrimaryAddr(lightweight: CapturerLightweight): number | undefined {
  return lightweight.backtraceAddrs[0] ?? lightweight.programCounter;
}

function toHex(value: number): string {
  return `0x${(value >>> 0).toString(16)}`;
}

function toArray(value: number | undefined): number[] {
  return value === undefined ? [] : [value];
}
