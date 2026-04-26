// @ts-check

/** @typedef {'eventDetected' | 'eventUpdated'} CapturerEventName */
/** @typedef {'xtensa' | 'riscv' | 'unknown'} CapturerEventKind */

/**
 * @typedef {Object} CapturerLightweight
 * @property {string | undefined} reasonLine
 * @property {number | undefined} programCounter
 * @property {number | undefined} faultCode
 * @property {number | undefined} faultAddr
 * @property {Record<string, number>} regs
 * @property {number[]} backtraceAddrs
 */

/**
 * @typedef {Object} CapturerEvaluated
 * @property {string} eventId
 * @property {number} evaluatedAt
 * @property {'stub' | 'decoded'} status
 * @property {import('../decode/decode.js').AddrLine[]} frames
 * @property {import('../decode/decode.js').DecodeResult} [decodeResult]
 */

/**
 * @typedef {Object} CapturerEvent
 * @property {string} id
 * @property {string} signature
 * @property {CapturerEventKind} kind
 * @property {string[]} lines
 * @property {string} rawText
 * @property {number} firstSeenAt
 * @property {number} lastSeenAt
 * @property {number} count
 * @property {CapturerLightweight} lightweight
 * @property {import('../decode/decode.js').AddrLine[] | undefined} fastFrames
 * @property {CapturerEvaluated | undefined} evaluated
 */

/** @typedef {(event: CapturerEvent) => void} CapturerListener */
/** @typedef {{ event: CapturerEvent; signal?: AbortSignal }} CapturerEvaluateContext */
/** @typedef {(context: CapturerEvaluateContext) => Promise<CapturerEvaluated>} CapturerEvaluateFn */

/**
 * @typedef {Object} CapturerOptions
 * @property {number} [quietPeriodMs]
 * @property {number} [dedupWindowMs]
 * @property {number} [maxEvents]
 * @property {number} [maxRawBytes]
 * @property {number} [maxRawLines]
 * @property {() => number} [now]
 * @property {CapturerEvaluateFn} [evaluateEvent]
 */

/**
 * @typedef {Object} ResolvedCapturerOptions
 * @property {number} quietPeriodMs
 * @property {number} dedupWindowMs
 * @property {number} maxEvents
 * @property {number} maxRawBytes
 * @property {number} maxRawLines
 * @property {() => number} now
 * @property {CapturerEvaluateFn | undefined} evaluateEvent
 */

/** @typedef {{ signal?: AbortSignal }} CapturerEvaluateOptions */

/**
 * @typedef {Object} FramedCrashBlock
 * @property {string[]} lines
 * @property {number} startedAt
 * @property {number} lastAt
 * @property {string | undefined} reasonLine
 */

/**
 * @typedef {Object} CapturerRawState
 * @property {Uint8Array[]} bytes
 * @property {number} byteLength
 * @property {string[]} lines
 */

export const __types = /** @type {const} */ ({})
