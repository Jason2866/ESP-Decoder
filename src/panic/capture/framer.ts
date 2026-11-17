export interface FramedCrashBlock {
  lines: string[];
  startedAt: number;
  lastAt: number;
  reasonLine?: string;
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
  lines: string[];
  startedAt: number;
  lastAt: number;
  reasonLine?: string;
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

  constructor(private readonly quietPeriodMs: number) {}

  pushLine(line: string, atMs: number): FramedCrashBlock[] {
    const finalized: FramedCrashBlock[] = [];

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
      this.active = { lines: [], startedAt: atMs, lastAt: atMs, reasonLine: undefined };
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
        this.active = undefined;
      } else if (this.active.lines.length >= MAX_COMPLETE_BLOCK_LINES) {
        this.finalize(finalized);
      }
    }

    return finalized;
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
        this.finalize(finalized);
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
    const lines = this.active.lines;
    const hasSignal = lines.some((line) => isStartLine(line));
    if (hasSignal && lines.length > 0 && isCompleteBlock(lines)) {
      finalized.push({
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

function isCompleteBlock(lines: string[]): boolean {
  return lines.some((line) =>
    [
      /Backtrace:/i,
      /^Stack memory:/i,
      /^Rebooting\.\.\./i,
      /ELF file SHA256:/i,
      />>>stack>>>/i, // ESP8266 stack block start marker
      /^<<<stack<<</i, // ESP8266 stack block end marker
    ].some((pattern) => pattern.test(line.trim())),
  );
}

/** End-of-crash lines that finalize immediately (without quiet timeout). */
function isImmediateFinalizeLine(line: string): boolean {
  const trimmed = line.trim();
  return /^Rebooting\.\.\./i.test(trimmed) || /^<<<stack<<</i.test(trimmed);
}
