import { parseStackDataRow } from '../panicParse';
import { hasPrintedBacktracePair } from '../printedBacktrace';

export interface FramedCrashBlock {
  /**
   * Stable identity of the framed block: every emit of the same active
   * block (provisional quiet emits and the final emit) carries the same id,
   * so consumers can distinguish a revision from a distinct crash block.
   */
  id: number;
  lines: string[];
  startedAt: number;
  lastAt: number;
  reasonLine?: string;
  /** True when a buffered, unterminated line was appended for preview only. */
  pendingPreview?: boolean;
}

const crashPatterns = [
  /Guru Meditation Error:/i,
  /panic'ed/i,
  /^Exception\s+\(\d+\):?/i,
  /^assert failed:/i,
  /^abort\(\) was called/i,
  // ESP8266 SDK crash headers (followed by the >>>stack>>> dump).
  /^Abort called\b/i,
  /^Panic\b/i,
];

/**
 * Upper bound for lines kept in a block that never reaches a completeness
 * signal — guards against a start-marker false positive streaming forever.
 */
const MAX_INCOMPLETE_BLOCK_LINES = 500;

/**
 * Upper bound for a block that already has a completeness signal but the
 * stream never goes quiet — it is emitted at this size instead of growing
 * without limit. Kept well above realistic dump sizes (register dumps +
 * stack memory + backtrace stay far below this).
 */
const MAX_COMPLETE_BLOCK_LINES = 2000;

const startPatterns = crashPatterns;
const reasonPatterns = crashPatterns;

interface FramerState {
  id: number;
  lines: string[];
  startedAt: number;
  lastAt: number;
  reasonLine?: string;
  /** Set after a quiet-period emit: the block stays open for continuation rows. */
  provisional?: boolean;
  /** Continuation rows arrived since the last provisional emit. */
  dirty?: boolean;
}

/**
 * Frames a crash block from a stream of serial lines. A block starts at a
 * crash marker line, accumulates until a quiet period elapses or an
 * end-of-crash line (Rebooting..., <<<stack<<<) is seen, and is only emitted
 * when it contains a completeness signal (Backtrace, Stack memory, stack
 * dump markers, ...).
 */
export class CrashFramer {
  private active: FramerState | undefined;
  private nextBlockId = 1;

  constructor(private readonly quietPeriodMs: number) {}

  pushLine(line: string, atMs: number): FramedCrashBlock[] {
    const finalized: FramedCrashBlock[] = [];

    // A block already emitted by the quiet-period flush stays open for
    // continuation rows (stack memory, register dumps, Backtrace) so a pause
    // mid-dump cannot silently drop the rest of the capture. A recognized
    // crash start is never a continuation — even when its text also matches
    // a continuation pattern — it finalizes the open block and starts a
    // fresh one below. Any other unrelated line closes the block, but the
    // finalize still emits pending continuation rows instead of dropping
    // them; an unchanged provisional block stays suppressed.
    if (this.active?.provisional && !isStartLine(line)) {
      // Blank separator lines carry no information — they must not close an
      // open block before a continuation header (e.g. 'Core 1 register
      // dump:') arrives on the next line.
      if (line.trim() === '') {
        return finalized;
      }
      const isTail = isImmediateFinalizeLine(line);
      if (isTail || isContinuationLine(line)) {
        this.active.lines.push(line);
        this.active.lastAt = atMs;
        this.active.dirty = true;
        if (isTail || this.active.lines.length >= MAX_COMPLETE_BLOCK_LINES) {
          this.finalize(finalized);
        }
        return finalized;
      }
      this.finalize(finalized);
    }

    // `abort() was called` following an `assert failed:` line is part of the
    // same crash (ESP-IDF prints both before the backtrace), so it continues
    // the active block instead of starting a new one — but only while the
    // block has no completeness signal yet; an abort after a finished
    // backtrace belongs to the next crash.
    const continuesAssertBlock =
      isAbortCalledLine(line) &&
      this.active?.lines.some((l) => /^assert failed:/i.test(l.trim())) === true &&
      !isCompleteBlock(this.active.lines);

    if (isStartLine(line) && !continuesAssertBlock) {
      this.finalize(finalized);
      this.active = {
        id: this.nextBlockId++,
        lines: [],
        startedAt: atMs,
        lastAt: atMs,
        reasonLine: undefined,
      };
    }

    if (!this.active) {
      return finalized;
    }

    this.active.lines.push(line);
    this.active.lastAt = atMs;
    if (!this.active.reasonLine && isReasonLine(line)) {
      this.active.reasonLine = line.trim();
    }

    if (isImmediateFinalizeLine(line)) {
      this.finalize(finalized);
    }

    // Bound memory: blocks that never complete are discarded, and a
    // complete block that keeps growing without a quiet period is emitted
    // at the cap instead of accumulating forever.
    if (this.active) {
      if (
        this.active.lines.length >= MAX_INCOMPLETE_BLOCK_LINES &&
        !isCompleteBlock(this.active.lines)
      ) {
        // Finalize rather than drop outright: the lenient predicate still
        // emits recognized partial dumps (stack rows, register dumps)
        // while rejecting marker-only noise.
        this.finalize(finalized);
      } else if (this.active.lines.length >= MAX_COMPLETE_BLOCK_LINES) {
        this.finalize(finalized);
      }
    }

    return finalized;
  }

  /** Id of the still-open block, if any — for consumers that only need
   * identity (e.g. index pruning) without copying the accumulated lines. */
  activeBlockId(): number | undefined {
    return this.active?.id;
  }

  /**
   * Whether the still-open block would satisfy the quiet-period
   * completeness rule if the given line were appended. Lets consumers
   * preview an unterminated line that itself carries the completeness
   * signal (e.g. a final 'Backtrace:' line whose terminator never came).
   */
  isCompleteWithLine(line: string): boolean {
    if (!this.active) {
      return false;
    }
    return (
      this.active.lines.some(isStartLine) &&
      isCompleteBlock([...this.active.lines, line])
    );
  }

  /**
   * Snapshot of the still-open block, if any. Lets consumers preview the
   * buffered unterminated line against the active block's identity even
   * when no new block is emitted this tick.
   */
  peekActiveBlock(): FramedCrashBlock | undefined {
    if (!this.active) {
      return undefined;
    }
    return {
      id: this.active.id,
      lines: [...this.active.lines],
      startedAt: this.active.startedAt,
      lastAt: this.active.lastAt,
      reasonLine: this.active.reasonLine,
    };
  }

  /**
   * @param onlyComplete Timer path: emit only blocks that already contain a
   * completeness signal and leave incomplete blocks active for later lines.
   * Explicit flushes keep discarding incomplete blocks.
   */
  flush(atMs: number, onlyComplete = false): FramedCrashBlock[] {
    const finalized: FramedCrashBlock[] = [];
    if (onlyComplete) {
      if (this.active && this.isCompleteActive()) {
        // Provisional emit: the block is reported but stays open so late
        // stack/register rows can still join it (dedup merges the richer
        // capture into the same event). Re-emit only when new continuation
        // rows arrived since the last emit.
        if (!this.active.provisional || this.active.dirty) {
          finalized.push({
            id: this.active.id,
            lines: [...this.active.lines],
            startedAt: this.active.startedAt,
            lastAt: this.active.lastAt,
            reasonLine: this.active.reasonLine,
          });
          this.active.provisional = true;
          this.active.dirty = false;
        }
      }
      return finalized;
    }
    this.finalizeIfQuiet(finalized, atMs);
    if (this.active) {
      this.finalize(finalized);
    }
    return finalized;
  }

  private isCompleteActive(): boolean {
    const lines = this.active?.lines ?? [];
    return lines.some(isStartLine) && lines.length > 0 && isCompleteBlock(lines);
  }

  private finalizeIfQuiet(finalized: FramedCrashBlock[], atMs: number): void {
    if (!this.active) {
      return;
    }
    if (atMs - this.active.lastAt < this.quietPeriodMs) {
      return;
    }
    this.finalize(finalized);
  }

  private finalize(finalized: FramedCrashBlock[]): void {
    if (!this.active) {
      return;
    }
    // A provisional block with no new continuation rows was already
    // reported by the quiet-period emit — clear it without re-emitting so
    // explicit flushes and reboot lines do not inflate the event count.
    const unchangedProvisional = this.active.provisional === true && !this.active.dirty;
    const lines = this.active.lines;
    const hasSignal = lines.some((line) => isStartLine(line));
    if (!unchangedProvisional && hasSignal && lines.length > 0 && isFinalizableBlock(lines)) {
      finalized.push({
        id: this.active.id,
        lines: [...lines],
        startedAt: this.active.startedAt,
        lastAt: this.active.lastAt,
        reasonLine: this.active.reasonLine,
      });
    }
    this.active = undefined;
  }
}

function isStartLine(line: string): boolean {
  return startPatterns.some((pattern) => pattern.test(line));
}

function isReasonLine(line: string): boolean {
  return reasonPatterns.some((pattern) => pattern.test(line));
}

function isAbortCalledLine(line: string): boolean {
  return /^abort\(\) was called/i.test(line.trim());
}

/**
 * Strict completeness for the quiet-timer path: the block must contain
 * captured crash data, not just a section heading. A 'Stack memory:' line
 * alone does not count — at least one stack row must follow it — and an
 * ESP8266 '>>>stack>>>' dump stays open until its '<<<stack<<<' end marker
 * so the quiet timer cannot emit it before the stack rows arrive.
 */
function isCompleteBlock(lines: string[]): boolean {
  const trimmed = lines.map((line) => line.trim());
  const esp8266StackOpen =
    trimmed.some((line) => line.startsWith('>>>stack>>>')) &&
    !trimmed.some((line) => line.startsWith('<<<stack<<<'));
  for (const line of trimmed) {
    if (
      // Only a line-initial 'Backtrace:' record with at least one PC:SP pair
      // marks a complete dump — an assertion message merely mentioning the
      // marker does not.
      hasPrintedBacktracePair(line) ||
      /^Rebooting\.\.\./i.test(line) ||
      /^ELF file SHA256:/i.test(line) ||
      line.startsWith('<<<stack<<<')
    ) {
      return true;
    }
  }
  if (esp8266StackOpen) {
    return false;
  }
  return hasStackMemoryData(lines);
}

/**
 * Lenient completeness for explicit flushes, immediate finalization, and
 * the size caps: a block with a crash start marker plus any dump section
 * (even a bare 'Stack memory:' heading or an open ESP8266 stack) is still
 * emitted rather than silently dropped.
 */
function isFinalizableBlock(lines: string[]): boolean {
  return (
    isCompleteBlock(lines) ||
    lines.some((line) => {
      const trimmed = line.trim();
      return (
        trimmed.startsWith('>>>stack>>>') ||
        /^Stack memory:/i.test(trimmed) ||
        isStackDataRow(trimmed) ||
        /^[A-Z][A-Z0-9/]*\s*:\s*0x[0-9a-fA-F]+/.test(trimmed)
      );
    })
  );
}

/** True when a 'Stack memory:' heading is followed by at least one data row. */
function hasStackMemoryData(lines: string[]): boolean {
  let inStackMemory = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Stack memory:/i.test(trimmed)) {
      inStackMemory = true;
      continue;
    }
    if (inStackMemory && isStackDataRow(trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * Lines that may continue an already-emitted crash block: stack-memory rows
 * (RISC-V '0x'-prefixed and ESP8266 bare-hex), register-dump rows, section
 * headers ('Stack memory:', 'Core N register dump:' — multi-core dumps of
 * the same crash must stay in one block), and Backtrace lines. Used only
 * while a block is in its provisional state.
 */
function isContinuationLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    isStackDataRow(trimmed) ||
    /^[A-Z][A-Z0-9/]*\s*:\s*0x[0-9a-fA-F]+/.test(trimmed) ||
    /^Backtrace:/i.test(trimmed) ||
    /^Stack memory:/i.test(trimmed) ||
    /^Core\s+\d+\s+register dump:/i.test(trimmed) ||
    // ESP-IDF prints the firmware ELF SHA256 between the panic data and
    // 'Rebooting...' — keep a provisionally emitted block open for it.
    /^ELF file SHA256:/i.test(trimmed) ||
    trimmed.startsWith('>>>stack>>>')
  );
}

/** RISC-V 'Stack memory:' row — validated by the same parser the decoder
 * uses, so a row the framer accepts always supplies stack bytes and a
 * truncated/glued row never triggers emission. */
function isStackDataRow(line: string): boolean {
  return parseStackDataRow(line) !== undefined;
}

/** End-of-crash lines that finalize immediately (without quiet timeout). */
function isImmediateFinalizeLine(line: string): boolean {
  const trimmed = line.trim();
  return /^Rebooting\.\.\./i.test(trimmed) || /^<<<stack<<</i.test(trimmed);
}
