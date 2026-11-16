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
];

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

    this.finalizeIfQuiet(finalized, atMs);

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

    return finalized;
  }

  flush(atMs: number): FramedCrashBlock[] {
    const finalized: FramedCrashBlock[] = [];
    this.finalizeIfQuiet(finalized, atMs);
    if (this.active) {
      this.finalize(finalized);
    }
    return finalized;
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
