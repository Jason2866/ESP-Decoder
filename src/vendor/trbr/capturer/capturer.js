// @ts-check

import { EventEmitter } from 'node:events'

import { AbortError } from '../abort.js'
import { parseRiscvPanicOutput } from '../decode/riscvPanicParse.js'
import {
  parseESP32PanicOutput,
  parseESP8266PanicOutput,
} from '../decode/xtensaPanicParse.js'
import { CrashFramer } from './framer.js'
import { LineDecoder } from './lineDecoder.js'

/** @typedef {import('./types.js').CapturerEvent} CapturerEvent */
/** @typedef {import('./types.js').CapturerLightweight} CapturerLightweight */
/** @typedef {import('./types.js').CapturerOptions} CapturerOptions */
/** @typedef {import('./types.js').ResolvedCapturerOptions} ResolvedCapturerOptions */
/** @typedef {import('./types.js').CapturerEventName} CapturerEventName */
/** @typedef {import('./types.js').CapturerListener} CapturerListener */
/** @typedef {import('./types.js').CapturerEvaluateOptions} CapturerEvaluateOptions */
/** @typedef {import('./types.js').FramedCrashBlock} FramedCrashBlock */
/** @typedef {import('./types.js').CapturerEvaluated} CapturerEvaluated */
/** @typedef {import('./types.js').CapturerRawState} CapturerRawState */
/** @typedef {import('./types.js').CapturerEvaluateContext} CapturerEvaluateContext */

const defaultOptions = /** @type {const} */ ({
  quietPeriodMs: 200,
  dedupWindowMs: 5000,
  maxEvents: 100,
  maxRawBytes: 128 * 1024,
  maxRawLines: 2000,
})

export class Capturer {
  _eventBus = new EventEmitter()
  _lineDecoder = new LineDecoder()
  /** @type {CrashFramer} */
  _framer
  /** @type {ResolvedCapturerOptions} */
  _options
  /** @type {CapturerEvent[]} */
  _events = []
  /** @type {Map<string, CapturerEvent>} */
  _eventsById = new Map()
  /** @type {Map<string, string>} */
  _signatureIndex = new Map()
  /** @type {Map<string, Promise<CapturerEvaluated>>} */
  _inFlightEvaluations = new Map()
  /** @type {Uint8Array[]} */
  _rawBytes = []
  _rawByteLength = 0
  /** @type {string[]} */
  _rawLines = []
  _nextId = 1

  /** @param {CapturerOptions} [options] */
  constructor(options = {}) {
    this._options = resolveOptions(options)
    this._framer = new CrashFramer({
      quietPeriodMs: this._options.quietPeriodMs,
    })
  }

  /**
   * @param {Uint8Array} chunk
   * @returns {void}
   */
  push(chunk) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('Expected a Uint8Array monitor chunk')
    }
    this._rememberRawBytes(chunk)
    const lines = this._lineDecoder.push(chunk)
    this._processLines(lines)
  }

  /** @returns {void} */
  flush() {
    this._processLines(this._lineDecoder.flush())
    this._finalizeBlocks(this._framer.flush(this._options.now()))
  }

  /** @returns {CapturerEvent[]} */
  getEvents() {
    return structuredClone(this._events)
  }

  /** @returns {CapturerRawState} */
  getRawState() {
    return {
      bytes: this._rawBytes.map((chunk) => chunk.slice()),
      byteLength: this._rawByteLength,
      lines: [...this._rawLines],
    }
  }

  /**
   * @param {CapturerEventName} eventName
   * @param {CapturerListener} listener
   * @returns {() => void}
   */
  on(eventName, listener) {
    this._eventBus.on(eventName, listener)
    return () => {
      this._eventBus.off(eventName, listener)
    }
  }

  /**
   * @param {string} eventId
   * @param {CapturerEvaluateOptions} [options]
   * @returns {Promise<CapturerEvaluated>}
   */
  async evaluate(eventId, options = {}) {
    const event = this._eventsById.get(eventId)
    if (!event) {
      throw new Error(`Unknown event id: ${eventId}`)
    }
    if (event.evaluated) {
      return event.evaluated
    }
    const existingJob = this._inFlightEvaluations.get(eventId)
    if (existingJob) {
      return existingJob
    }

    const job = this._evaluateEvent(event, options.signal)
    this._inFlightEvaluations.set(eventId, job)

    try {
      return await job
    } finally {
      this._inFlightEvaluations.delete(eventId)
    }
  }

  /**
   * @param {CapturerEvent} event
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<CapturerEvaluated>}
   */
  async _evaluateEvent(event, signal) {
    if (signal?.aborted) {
      throw new AbortError()
    }

    const evaluator = this._options.evaluateEvent

    if (evaluator) {
      const context = /** @type {CapturerEvaluateContext} */ ({
        event: structuredClone(event),
        signal,
      })
      const evaluated = await evaluator(context)

      if (signal?.aborted) {
        throw new AbortError()
      }

      event.evaluated = evaluated
      this._emit('eventUpdated', event)
      return evaluated
    }

    await Promise.resolve()

    if (signal?.aborted) {
      throw new AbortError()
    }

    const addrs = event.lightweight.backtraceAddrs.length
      ? event.lightweight.backtraceAddrs
      : toArray(event.lightweight.programCounter)
    const evaluated = {
      eventId: event.id,
      evaluatedAt: this._options.now(),
      status: /** @type {const} */ ('stub'),
      frames: addrs.map((addr) => ({
        addr,
        location: toHex(addr),
      })),
    }

    event.evaluated = evaluated
    this._emit('eventUpdated', event)
    return evaluated
  }

  /**
   * @param {Uint8Array} chunk
   * @returns {void}
   */
  _rememberRawBytes(chunk) {
    this._rawBytes.push(chunk.slice())
    this._rawByteLength += chunk.length

    while (
      this._rawByteLength > this._options.maxRawBytes &&
      this._rawBytes[0]
    ) {
      const overflow = this._rawByteLength - this._options.maxRawBytes
      const first = this._rawBytes[0]
      if (overflow >= first.length) {
        this._rawBytes.shift()
        this._rawByteLength -= first.length
        continue
      }
      this._rawBytes[0] = first.slice(overflow)
      this._rawByteLength -= overflow
    }
  }

  /**
   * @param {string[]} lines
   * @returns {void}
   */
  _processLines(lines) {
    for (const line of lines) {
      this._rememberRawLine(line)
      const blocks = this._framer.pushLine(line, this._options.now())
      this._finalizeBlocks(blocks)
    }
  }

  /**
   * @param {string} line
   * @returns {void}
   */
  _rememberRawLine(line) {
    this._rawLines.push(line)
    while (this._rawLines.length > this._options.maxRawLines) {
      this._rawLines.shift()
    }
  }

  /**
   * @param {FramedCrashBlock[]} blocks
   * @returns {void}
   */
  _finalizeBlocks(blocks) {
    for (const block of blocks) {
      this._mergeEvent(block)
    }
  }

  /**
   * @param {FramedCrashBlock} block
   * @returns {void}
   */
  _mergeEvent(block) {
    const rawText = block.lines.join('\n')
    const kind = detectKind(block.lines)
    const lightweight = parseLightweight(rawText, kind, block.reasonLine)
    const signature = createSignature(kind, lightweight.reasonLine, lightweight)
    const candidate = {
      kind,
      lines: [...block.lines],
      rawText,
      firstSeenAt: block.startedAt,
      lastSeenAt: block.lastAt,
      lightweight,
      signature,
    }

    const exact = this._findRecentBySignature(candidate)
    if (exact) {
      this._mergeIntoExisting(
        exact,
        candidate,
        shouldPreferCandidate(exact, candidate)
      )
      return
    }

    const byContainment = this._findRecentContainmentMatch(candidate)
    if (byContainment) {
      this._mergeIntoExisting(
        byContainment,
        candidate,
        shouldPreferCandidate(byContainment, candidate)
      )
      return
    }

    const byFingerprint = this._findRecentFingerprintMatch(candidate)
    if (byFingerprint) {
      this._mergeIntoExisting(
        byFingerprint,
        candidate,
        shouldPreferCandidate(byFingerprint, candidate)
      )
      return
    }

    const next = /** @type {CapturerEvent} */ ({
      id: `event-${String(this._nextId).padStart(6, '0')}`,
      signature,
      kind,
      lines: [...block.lines],
      rawText,
      firstSeenAt: block.startedAt,
      lastSeenAt: block.lastAt,
      count: 1,
      lightweight,
      fastFrames: undefined,
      evaluated: undefined,
    })
    this._nextId++

    this._events.push(next)
    this._eventsById.set(next.id, next)
    this._signatureIndex.set(next.signature, next.id)
    this._trimEvents()
    this._emit('eventDetected', next)
  }

  /**
   * @param {{
   *   signature: string
   *   lastSeenAt: number
   * }} candidate
   * @returns {CapturerEvent | undefined}
   */
  _findRecentBySignature(candidate) {
    const existingId = this._signatureIndex.get(candidate.signature)
    const existing = existingId ? this._eventsById.get(existingId) : undefined
    if (!existing) {
      return undefined
    }
    if (!this._isWithinDedupWindow(existing, candidate.lastSeenAt)) {
      return undefined
    }
    return existing
  }

  /**
   * @param {{
   *   kind: import('./types.js').CapturerEventKind
   *   rawText: string
   *   lastSeenAt: number
   *   lightweight: CapturerLightweight
   * }} candidate
   * @returns {CapturerEvent | undefined}
   */
  _findRecentContainmentMatch(candidate) {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const existing = this._events[i]
      if (!this._isWithinDedupWindow(existing, candidate.lastSeenAt)) {
        continue
      }
      if (!isLikelySameCrash(existing, candidate)) {
        continue
      }
      const existingContains = containsNormalizedText(
        existing.rawText,
        candidate.rawText
      )
      const candidateContains = containsNormalizedText(
        candidate.rawText,
        existing.rawText
      )
      if (existingContains || candidateContains) {
        return existing
      }
    }
    return undefined
  }

  /**
   * @param {{
   *   kind: import('./types.js').CapturerEventKind
   *   lightweight: CapturerLightweight
   *   lastSeenAt: number
   * }} candidate
   * @returns {CapturerEvent | undefined}
   */
  _findRecentFingerprintMatch(candidate) {
    const candidateFingerprint = createFingerprint(
      candidate.kind,
      candidate.lightweight
    )
    if (!candidateFingerprint) {
      return undefined
    }

    for (let i = this._events.length - 1; i >= 0; i--) {
      const existing = this._events[i]
      if (!this._isWithinDedupWindow(existing, candidate.lastSeenAt)) {
        continue
      }
      if (
        createFingerprint(existing.kind, existing.lightweight) ===
        candidateFingerprint
      ) {
        return existing
      }
    }
    return undefined
  }

  /**
   * @param {CapturerEvent} existing
   * @param {{
   *   lines: string[]
   *   rawText: string
   *   lightweight: CapturerLightweight
   *   signature: string
   *   lastSeenAt: number
   * }} candidate
   * @param {boolean} preferCandidate
   * @returns {void}
   */
  _mergeIntoExisting(existing, candidate, preferCandidate) {
    existing.count += 1
    existing.lastSeenAt = Math.max(existing.lastSeenAt, candidate.lastSeenAt)

    if (preferCandidate) {
      existing.lines = [...candidate.lines]
      existing.rawText = candidate.rawText
      existing.lightweight = candidate.lightweight
      this._reindexSignature(existing, candidate.signature)
    }

    this._emit('eventUpdated', existing)
  }

  /**
   * @param {CapturerEvent} existing
   * @param {string} signature
   * @returns {void}
   */
  _reindexSignature(existing, signature) {
    if (existing.signature === signature) {
      this._signatureIndex.set(signature, existing.id)
      return
    }

    const currentOwner = this._signatureIndex.get(existing.signature)
    if (currentOwner === existing.id) {
      this._signatureIndex.delete(existing.signature)
    }
    existing.signature = signature
    this._signatureIndex.set(signature, existing.id)
  }

  /**
   * @param {CapturerEvent} event
   * @param {number} atMs
   * @returns {boolean}
   */
  _isWithinDedupWindow(event, atMs) {
    return atMs - event.lastSeenAt <= this._options.dedupWindowMs
  }

  /** @returns {void} */
  _trimEvents() {
    while (this._events.length > this._options.maxEvents) {
      const removed = this._events.shift()
      if (!removed) {
        break
      }
      this._eventsById.delete(removed.id)
      if (this._signatureIndex.get(removed.signature) === removed.id) {
        this._signatureIndex.delete(removed.signature)
      }
    }
  }

  /**
   * @param {CapturerEventName} eventName
   * @param {CapturerEvent} event
   * @returns {void}
   */
  _emit(eventName, event) {
    this._eventBus.emit(eventName, structuredClone(event))
  }
}

/**
 * @param {CapturerOptions} [options]
 * @returns {Capturer}
 */
export function createCapturer(options) {
  return new Capturer(options)
}

/**
 * @param {CapturerOptions} options
 * @returns {ResolvedCapturerOptions}
 */
function resolveOptions(options) {
  return {
    quietPeriodMs: options.quietPeriodMs ?? defaultOptions.quietPeriodMs,
    dedupWindowMs: options.dedupWindowMs ?? defaultOptions.dedupWindowMs,
    maxEvents: options.maxEvents ?? defaultOptions.maxEvents,
    maxRawBytes: options.maxRawBytes ?? defaultOptions.maxRawBytes,
    maxRawLines: options.maxRawLines ?? defaultOptions.maxRawLines,
    now: options.now ?? Date.now,
    evaluateEvent: options.evaluateEvent,
  }
}

/**
 * @param {string[]} lines
 * @returns {import('./types.js').CapturerEventKind}
 */
function detectKind(lines) {
  const riscvHints = [/MCAUSE/, /\bMEPC\b/, /Stack memory:/, /MHARTID/]
  if (lines.some((line) => riscvHints.some((hint) => hint.test(line)))) {
    return 'riscv'
  }
  const xtensaHints = [
    /Backtrace:/,
    /EXCCAUSE/,
    /EXCVADDR/,
    /Guru Meditation Error:/,
  ]
  if (lines.some((line) => xtensaHints.some((hint) => hint.test(line)))) {
    return 'xtensa'
  }
  return 'unknown'
}

/**
 * @param {string} rawText
 * @param {import('./types.js').CapturerEventKind} kind
 * @param {string | undefined} reasonLine
 * @returns {CapturerLightweight}
 */
function parseLightweight(rawText, kind, reasonLine) {
  try {
    if (kind === 'riscv') {
      const parsed = parseRiscvPanicOutput({ input: rawText })
      return {
        reasonLine: reasonLine?.trim(),
        programCounter: parsed.programCounter,
        faultCode: parsed.faultCode,
        faultAddr: parsed.faultAddr,
        regs: parsed.regs,
        backtraceAddrs: toArray(parsed.programCounter),
      }
    }

    if (kind === 'xtensa') {
      let parsed = parseESP32PanicOutput(rawText)
      if (
        Object.keys(parsed.regs).length === 0 &&
        parsed.backtraceAddrs.length === 0 &&
        !parsed.programCounter
      ) {
        parsed = parseESP8266PanicOutput(rawText)
      }
      return {
        reasonLine: reasonLine?.trim(),
        programCounter: parsed.programCounter,
        faultCode: parsed.faultCode,
        faultAddr: parsed.faultAddr,
        regs: parsed.regs,
        backtraceAddrs: /** @type {number[]} */ (
          parsed.backtraceAddrs.filter((addr) => Number.isFinite(addr))
        ),
      }
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
  }
}

/**
 * @param {import('./types.js').CapturerEventKind} kind
 * @param {string | undefined} reasonLine
 * @param {CapturerLightweight} lightweight
 * @returns {string}
 */
function createSignature(kind, reasonLine, lightweight) {
  const normalizedReason = normalizeReason(reasonLine)
  const addrs = lightweight.backtraceAddrs.slice(0, 5)
  if (addrs.length === 0 && lightweight.programCounter !== undefined) {
    addrs.push(lightweight.programCounter)
  }
  const pcs = addrs.map((addr) => toHex(addr)).join(',')
  const faultCode = lightweight.faultCode
  return `${kind}|${normalizedReason || 'unknown'}|fc:${faultCode ?? 'na'}|${pcs || 'nopc'}`
}

/**
 * @param {string | undefined} line
 * @returns {string}
 */
function normalizeReason(line) {
  const text = String(line ?? '').replace(/\r/g, '')
  const guruStart = text.toLowerCase().indexOf('guru meditation error:')
  const scoped = guruStart >= 0 ? text.slice(guruStart) : text
  return scoped
    .toLowerCase()
    .replace(/0x[0-9a-f]+/gi, '0x')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {CapturerEvent
 *   | {
 *       rawText: string
 *       lightweight: CapturerLightweight
 *     }} existing
 * @param {{
 *   rawText: string
 *   lightweight: CapturerLightweight
 * }} candidate
 * @returns {boolean}
 */
function shouldPreferCandidate(existing, candidate) {
  const existingScore = computeCompleteness(
    existing.rawText,
    existing.lightweight
  )
  const candidateScore = computeCompleteness(
    candidate.rawText,
    candidate.lightweight
  )
  if (candidateScore > existingScore) {
    return true
  }
  if (candidateScore < existingScore) {
    return false
  }
  return candidate.rawText.length > existing.rawText.length
}

/**
 * @param {string} rawText
 * @param {CapturerLightweight} lightweight
 * @returns {number}
 */
function computeCompleteness(rawText, lightweight) {
  let score = 0
  if (normalizeReason(lightweight.reasonLine)) {
    score += 1
  }
  if (lightweight.faultCode !== undefined) {
    score += 1
  }
  if (lightweight.programCounter !== undefined) {
    score += 2
  }
  score += Math.min(lightweight.backtraceAddrs.length, 5) * 2
  if (Object.keys(lightweight.regs).length > 0) {
    score += 1
  }
  if (/Backtrace:|Stack memory:/i.test(rawText)) {
    score += 2
  }
  if (/Rebooting\.\.\./i.test(rawText)) {
    score += 1
  }
  return score
}

/**
 * @param {import('./types.js').CapturerEventKind} kind
 * @param {CapturerLightweight} lightweight
 * @returns {string}
 */
function createFingerprint(kind, lightweight) {
  const reason = normalizeReason(lightweight.reasonLine)
  const pc = getPrimaryAddr(lightweight)
  if (!reason && lightweight.faultCode === undefined && pc === undefined) {
    return ''
  }
  return `${kind}|${reason || 'unknown'}|fc:${lightweight.faultCode ?? 'na'}|pc:${pc !== undefined ? toHex(pc) : 'na'}`
}

/**
 * @param {string} container
 * @param {string} candidate
 * @returns {boolean}
 */
function containsNormalizedText(container, candidate) {
  const containerNormalized = normalizeTextForContainment(container)
  const candidateNormalized = normalizeTextForContainment(candidate)
  if (!containerNormalized || !candidateNormalized) {
    return false
  }
  return (
    containerNormalized === candidateNormalized ||
    containerNormalized.includes(candidateNormalized)
  )
}

/**
 * @param {string} input
 * @returns {string}
 */
function normalizeTextForContainment(input) {
  return input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * @param {CapturerEvent
 *   | {
 *       kind: import('./types.js').CapturerEventKind
 *       rawText: string
 *       lightweight: CapturerLightweight
 *     }} existing
 * @param {{
 *   kind: import('./types.js').CapturerEventKind
 *   rawText: string
 *   lightweight: CapturerLightweight
 * }} candidate
 * @returns {boolean}
 */
function isLikelySameCrash(existing, candidate) {
  if (existing.kind !== candidate.kind) {
    return false
  }

  const existingReason = normalizeReason(existing.lightweight.reasonLine)
  const candidateReason = normalizeReason(candidate.lightweight.reasonLine)
  if (existingReason && candidateReason) {
    return existingReason === candidateReason
  }

  const existingPc = getPrimaryAddr(existing.lightweight)
  const candidatePc = getPrimaryAddr(candidate.lightweight)
  if (existingPc !== undefined && candidatePc !== undefined) {
    return existingPc === candidatePc
  }

  if (
    existing.lightweight.faultCode !== undefined &&
    candidate.lightweight.faultCode !== undefined
  ) {
    return existing.lightweight.faultCode === candidate.lightweight.faultCode
  }

  return containsNormalizedText(existing.rawText, candidate.rawText)
}

/**
 * @param {CapturerLightweight} lightweight
 * @returns {number | undefined}
 */
function getPrimaryAddr(lightweight) {
  return lightweight.backtraceAddrs[0] ?? lightweight.programCounter
}

/**
 * @param {number} value
 * @returns {string}
 */
function toHex(value) {
  return `0x${(value >>> 0).toString(16)}`
}

/**
 * @param {number | undefined} value
 * @returns {number[]}
 */
function toArray(value) {
  return value === undefined ? [] : [value]
}
