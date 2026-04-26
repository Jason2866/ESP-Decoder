// @ts-check

/** @typedef {import('./types.js').FramedCrashBlock} FramedCrashBlock */

const startPatterns = [
  /Guru Meditation Error:/i,
  /panic'ed/i,
  /^Exception\s+\(\d+\):?/i,
]

const reasonPatterns = [
  /Guru Meditation Error:/i,
  /panic'ed/i,
  /^Exception\s+\(\d+\):?/i,
]

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

    if (/^Rebooting\.\.\./i.test(line.trim())) {
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
    // Finalize on flush only when the active crash already looks complete.
    // This avoids trailing partial events at stop-capture while still
    // emitting complete blocks without waiting for an extra quiet period.
    if (this._active && isCompleteBlock(this._active.lines)) {
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
    if (hasSignal && lines.length > 0) {
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
    ].some((pattern) => pattern.test(line.trim()))
  )
}
