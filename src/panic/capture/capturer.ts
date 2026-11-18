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
  /** Framer block id → event id, so revisions of one block update in place.
   * Only the framer's still-open block keeps a mapping — a finalized block
   * can never emit again. */
  private readonly blockEventIndex = new Map<number, string>();
  /** Event id → block id that supplied the currently displayed snapshot
   * (lines/rawText/lightweight), so a revision knows whether it owns the
   * display or must win a completeness comparison first. */
  private readonly displayBlockIndex = new Map<string, number>();
  /** `${blockId}:${previewText}` of the last published pending-line preview. */
  private lastPreviewKey = '';
  /** First observed return address per event, kept as dedup evidence even
   * when no display snapshot reports it. */
  private readonly raEvidence = new Map<string, number>();
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
      // Timer path emits only complete blocks; an incomplete block stays
      // active so late-arriving backtrace lines can still join it. A pending
      // (unterminated) line is deliberately NOT flushed here: flushing it
      // mid-line would split one logical line into two and corrupt frames.
      // It completes via its terminator, the next push, or flush()/dispose().
      const blocks = this.framer.flush(this.options.now(), true);
      this.attachPendingPreview(blocks);
      this.finalizeBlocks(blocks);
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
    // Only the framer's still-open block can emit revisions; mappings for
    // finalized blocks are dead weight and are dropped here.
    const activeId = this.framer.peekActiveBlock()?.id;
    for (const blockId of this.blockEventIndex.keys()) {
      if (blockId !== activeId) {
        this.blockEventIndex.delete(blockId);
      }
    }
  }

  /**
   * Preview the buffered unterminated line into the last emitted block when
   * it already holds a complete crash record (e.g. a full 'Backtrace:' line
   * whose terminator has not arrived yet). The bytes stay buffered — the
   * completed line later revises the same block through the normal path.
   */
  private attachPendingPreview(blocks: FramedCrashBlock[]): void {
    const pending = this.lineDecoder.peekPendingLine().trim();
    const preview =
      pending !== '' && isCompletePendingCrashLine(pending) ? pending : undefined;

    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      if (preview && !last.lines.includes(preview)) {
        last.lines.push(preview);
      }
      this.lastPreviewKey = preview ? `${last.id}:${preview}` : '';
      return;
    }

    // No block was emitted this tick, but the still-open block may already
    // have an event whose pending preview grew — publish the change under
    // the same block id so it revises the existing event in place. The
    // preview is never written into the framer: when the line's terminator
    // arrives, the real line replaces it through the normal path.
    if (!preview) {
      this.lastPreviewKey = '';
      return;
    }
    const active = this.framer.peekActiveBlock();
    const eventId = active ? this.blockEventIndex.get(active.id) : undefined;
    if (!active || eventId === undefined || !this.eventsById.has(eventId)) {
      this.lastPreviewKey = '';
      return;
    }
    const key = `${active.id}:${preview}`;
    if (key === this.lastPreviewKey) {
      return;
    }
    this.lastPreviewKey = key;
    const lines = active.lines.includes(preview)
      ? [...active.lines]
      : [...active.lines, preview];
    this.mergeEvent({
      id: active.id,
      lines,
      startedAt: active.startedAt,
      lastAt: active.lastAt,
      reasonLine: active.reasonLine,
    });
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

    // A re-emit of a block the framer already reported (provisional quiet
    // emit followed by continuation rows or the final emit) is a revision of
    // the same crash occurrence — update the snapshot in place. This bypasses
    // the dedup window and kind/signature matching, which revisions could
    // legitimately fail (register lines arriving late change detectKind).
    const revisionId = this.blockEventIndex.get(block.id);
    const revision = revisionId === undefined ? undefined : this.eventsById.get(revisionId);
    if (revision && this.revisionCompatible(revision, candidate)) {
      this.applyRevision(revision, candidate, block.id);
      return;
    }
    if (revision) {
      // A provisional cross-block dedup match that now conflicts on
      // identifying data is a different crash: release the mapping and
      // fall through to normal dedup so the block can become its own
      // event (or match a compatible one).
      this.blockEventIndex.delete(block.id);
    }

    const exact = this.findRecentBySignature(candidate);
    if (exact) {
      // Signature only covers the first few backtrace frames; a matching
      // signature with a conflicting backtrace or return address is a
      // different crash.
      if (
        backtracesCompatible(exact.lightweight.backtraceAddrs, candidate.lightweight.backtraceAddrs) &&
        returnAddressesCompatible(this.matchLightweight(exact), candidate.lightweight)
      ) {
        this.mergeIntoExisting(exact, candidate, shouldPreferCandidate(exact, candidate), block.id);
        return;
      }
    }

    const byContainment = this.findRecentContainmentMatch(candidate);
    if (byContainment && returnAddressesCompatible(byContainment.lightweight, candidate.lightweight)) {
      this.mergeIntoExisting(byContainment, candidate, shouldPreferCandidate(byContainment, candidate), block.id);
      return;
    }

    const byFingerprint = this.findRecentFingerprintMatch(candidate);
    if (byFingerprint && returnAddressesCompatible(byFingerprint.lightweight, candidate.lightweight)) {
      this.mergeIntoExisting(byFingerprint, candidate, shouldPreferCandidate(byFingerprint, candidate), block.id);
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
    this.blockEventIndex.set(block.id, next.id);
    this.displayBlockIndex.set(next.id, block.id);
    this.trimEvents();
    this.emit('eventDetected', next);
  }

  /**
   * Adopt a richer snapshot of the SAME framed block (provisional emit →
   * continuation rows → final emit). The block id proves identity, so no
   * dedup heuristics run: count stays untouched (one occurrence), while
   * lines/rawText/lightweight/kind/signature refresh — including a kind
   * change when late register lines flip architecture detection.
   */
  /**
   * A mapped-block revision is normally the same crash growing — but a
   * provisional cross-block dedup match must be rechecked once the fuller
   * capture arrives: conflicting identifying data means the block is a
   * different crash. The return address always counts; backtrace frames
   * only when the kind is unchanged (addresses are not comparable across
   * architectures, so a kind flip cannot conflict here).
   */
  private revisionCompatible(
    existing: CapturerEvent,
    candidate: {
      kind: CapturerEventKind;
      lightweight: CapturerLightweight;
    },
  ): boolean {
    if (
      !returnAddressesCompatible(
        this.matchLightweight(existing),
        candidate.lightweight,
      )
    ) {
      return false;
    }
    return (
      existing.kind !== candidate.kind ||
      backtracesCompatible(
        existing.lightweight.backtraceAddrs,
        candidate.lightweight.backtraceAddrs,
      )
    );
  }

  private applyRevision(
    existing: CapturerEvent,
    candidate: {
      kind: CapturerEventKind;
      lines: string[];
      rawText: string;
      lightweight: CapturerLightweight;
      signature: string;
      firstSeenAt: number;
      lastSeenAt: number;
    },
    blockId: number,
  ): void {
    existing.firstSeenAt = Math.min(existing.firstSeenAt, candidate.firstSeenAt);
    existing.lastSeenAt = Math.max(existing.lastSeenAt, candidate.lastSeenAt);
    this.retainRa(existing, candidate.lightweight.regs?.RA);

    // The displayed snapshot belongs to the occurrence (block) that
    // supplied it. A revision of that same block always replaces it — the
    // capture only grows. A revision of a different occurrence merged into
    // this event replaces the snapshot only when it is richer, so a
    // shorter duplicate cannot clobber the better display.
    const ownsDisplay = this.displayBlockIndex.get(existing.id) === blockId;
    if (ownsDisplay || shouldPreferCandidate(existing, candidate)) {
      existing.kind = candidate.kind;
      existing.lines = [...candidate.lines];
      existing.rawText = candidate.rawText;
      // Same RA-evidence preservation as mergeIntoExisting: a richer capture
      // that omits RA must not erase a previously observed return address.
      const mergedRegs = { ...candidate.lightweight.regs };
      if (mergedRegs.RA === undefined && existing.lightweight.regs.RA !== undefined) {
        mergedRegs.RA = existing.lightweight.regs.RA;
      }
      existing.lightweight = { ...candidate.lightweight, regs: mergedRegs };
      this.reindexSignature(existing, candidate.signature);
      this.displayBlockIndex.set(existing.id, blockId);
    }
    this.emit('eventUpdated', existing);
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
      if (
        (existingContains || candidateContains) &&
        backtracesCompatible(
          existing.lightweight.backtraceAddrs,
          candidate.lightweight.backtraceAddrs,
        ) &&
        returnAddressesCompatible(this.matchLightweight(existing), candidate.lightweight)
      ) {
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
        ) &&
        returnAddressesCompatible(this.matchLightweight(existing), candidate.lightweight)
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
    blockId: number,
  ): void {
    // count tracks distinct crash occurrences: only a different framed
    // block merging via dedup increments it — revisions of the same block
    // take the applyRevision path and leave count untouched.
    existing.count += 1;
    this.blockEventIndex.set(blockId, existing.id);
    existing.lastSeenAt = Math.max(existing.lastSeenAt, candidate.lastSeenAt);

    if (preferCandidate) {
      existing.lines = [...candidate.lines];
      existing.rawText = candidate.rawText;
      // Keep a previously observed RA as dedup evidence when the richer
      // capture omits it — the displayed snapshot still comes from the
      // candidate, but a later capture with a conflicting RA must not merge.
      const mergedRegs = { ...candidate.lightweight.regs };
      if (mergedRegs.RA === undefined && existing.lightweight.regs.RA !== undefined) {
        mergedRegs.RA = existing.lightweight.regs.RA;
      }
      existing.lightweight = { ...candidate.lightweight, regs: mergedRegs };
      this.reindexSignature(existing, candidate.signature);
      this.displayBlockIndex.set(existing.id, blockId);
    }
    this.retainRa(existing, candidate.lightweight.regs?.RA);

    this.emit('eventUpdated', existing);
  }

  /**
   * Lightweight view used ONLY for dedup matching: fills RA from retained
   * evidence when the display snapshot never reported it. The first
   * observed RA stays dedup evidence regardless of which snapshot
   * preferCandidate selected — it is never written into a display snapshot
   * that did not report it.
   */
  private matchLightweight(event: CapturerEvent): CapturerLightweight {
    const ra = this.raEvidence.get(event.id);
    if (ra === undefined || event.lightweight.regs?.RA !== undefined) {
      return event.lightweight;
    }
    return { ...event.lightweight, regs: { ...event.lightweight.regs, RA: ra } };
  }

  /** Keep the earliest observed RA as dedup evidence for the event. */
  private retainRa(existing: CapturerEvent, candidateRa: number | undefined): void {
    const ra = existing.lightweight.regs?.RA ?? this.raEvidence.get(existing.id) ?? candidateRa;
    if (ra !== undefined) {
      this.raEvidence.set(existing.id, ra);
    }
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
      this.raEvidence.delete(removed.id);
      this.displayBlockIndex.delete(removed.id);
      for (const [blockId, eventId] of this.blockEventIndex) {
        if (eventId === removed.id) {
          this.blockEventIndex.delete(blockId);
        }
      }
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

/**
 * A pending (unterminated) line that already holds a complete crash record:
 * a Backtrace line with at least one full PC:SP pair, a stack-data row, a
 * register-dump row, or a section header. Truncated records (e.g. a
 * 'Backtrace:' line cut before its first PC:SP pair) do not qualify.
 */
function isCompletePendingCrashLine(text: string): boolean {
  return (
    /^Backtrace:\s*0x[0-9a-fA-F]+\s*:\s*0x[0-9a-fA-F]+/i.test(text) ||
    /^[0-9a-fA-F]{4,}\s*:\s+(?:0x[0-9a-fA-F]+|[0-9a-fA-F]{4,})(?:\s+(?:0x[0-9a-fA-F]+|[0-9a-fA-F]{4,}))*\s*$/.test(text) ||
    /^[A-Z][A-Z0-9/]*\s*:\s*0x[0-9a-fA-F]+/i.test(text) ||
    /^Stack memory:/i.test(text) ||
    /^Core\s+\d+\s+register dump:/i.test(text)
  );
}
