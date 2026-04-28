// @ts-check

/** @typedef {import('./types.js').FramedCrashBlock} FramedCrashBlock */

const crashPatterns = [
  /Guru Meditation Error:/i,
  /panic'ed/i,
  /^Exception\s+\(\d+\):?/i,
  /^assert failed:/i,
  /^abort\(\) was called/i,
]

// Both the start and reason heuristics use the same set of crash markers.
const startPatterns = crashPatterns
const reasonPatterns = crashPatterns

/**
 * @typedef {Object} FramerState
 * @property {string[]} lines
 * @property {number} startedAt
 * @property {number} lastAt
 * @property {string | undefined} reasonLine
 */

export class CrashFramer {
  _quietPeriodMs
  /** @type {FramerState | undefined} */
  _active

  /** @param {{ quietPeriodMs: number }} options */
  constructor(options) {
    this._quietPeriodMs = options.quietPeriodMs
  }

  /**
   * @param {string} line
   * @param {number} atMs
   * @returns {FramedCrashBlock[]}
   */
  pushLine(line, atMs) {
    /** @type {FramedCrashBlock[]} */
    const finalized = []

    this._finalizeIfQuiet(finalized, atMs)

    if (isStartLine(line)) {
      this._finalize(finalized)
      this._active = {
        lines: [],
        startedAt: atMs,
        lastAt: atMs,
        reasonLine: undefined,
      }
    }

    if (!this._active) {
      return finalized
    }

    this._active.lines.push(line)
    this._active.lastAt = atMs
    if (!this._active.reasonLine && isReasonLine(line)) {
      this._active.reasonLine = line.trim()
    }

    if (isImmediateFinalizeLine(line)) {
      this._finalize(finalized)
    }

    return finalized
  }

  /**
   * @param {number} atMs
   * @returns {FramedCrashBlock[]}
   */
  flush(atMs) {
    /** @type {FramedCrashBlock[]} */
    const finalized = []
    this._finalizeIfQuiet(finalized, atMs)
    // Finalize any active crash block on flush. The _finalize method has
    // internal protection (hasSignal check) to avoid emitting incomplete
    // blocks without a valid reason line.
    if (this._active) {
      this._finalize(finalized)
    }
    return finalized
  }

  /**
   * @param {FramedCrashBlock[]} finalized
   * @param {number} atMs
   */
  _finalizeIfQuiet(finalized, atMs) {
    if (!this._active) {
      return
    }
    if (atMs - this._active.lastAt < this._quietPeriodMs) {
      return
    }
    this._finalize(finalized)
  }

  /** @param {FramedCrashBlock[]} finalized */
  _finalize(finalized) {
    if (!this._active) {
      return
    }
    const lines = this._active.lines
    const hasSignal = lines.some((line) => isStartLine(line))
    if (hasSignal && lines.length > 0 && isCompleteBlock(lines)) {
      finalized.push({
        lines: [...lines],
        startedAt: this._active.startedAt,
        lastAt: this._active.lastAt,
        reasonLine: this._active.reasonLine,
      })
    }
    this._active = undefined
  }
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isStartLine(line) {
  return startPatterns.some((pattern) => pattern.test(line))
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isReasonLine(line) {
  return reasonPatterns.some((pattern) => pattern.test(line))
}

/**
 * @param {string[]} lines
 * @returns {boolean}
 */
function isCompleteBlock(lines) {
  return lines.some((line) =>
    [
      /Backtrace:/i,
      /^Stack memory:/i,
      /^Rebooting\.\.\./i,
      /ELF file SHA256:/i,
      />>>stack>>>/i, // ESP8266 stack block start marker
      /^<<<stack<<</i, // ESP8266 stack block end marker
    ].some((pattern) => pattern.test(line.trim()))
  )
}

/**
 * End-of-crash lines that should finalize immediately (without quiet timeout).
 * @param {string} line
 * @returns {boolean}
 */
function isImmediateFinalizeLine(line) {
  const trimmed = line.trim()
  return /^Rebooting\.\.\./i.test(trimmed) || /^<<<stack<<</i.test(trimmed)
}
