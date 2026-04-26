// @ts-check

import { isGDBLine, isParsedGDBLine } from './decode.js'

/** @typedef {import('./decode.js').Debug} Debug */

const envDebugEnabled = process.env.TRBR_DEBUG === 'true'
const regAddrLogPrefix = '[trbr][reg-addr]'

/**
 * @param {Debug} [debug]
 * @returns {Debug}
 */
function createRegAddrLogger(debug) {
  const writer = debug ?? (envDebugEnabled ? console.log : undefined)
  return writer ? (...args) => writer(regAddrLogPrefix, ...args) : () => {}
}

/**
 * @param {GDBLine | ParsedGDBLine | undefined} entry
 * @returns {entry is GDBLine | ParsedGDBLine}
 */
function isParsedOrGdbLine(entry) {
  return Boolean(entry) && (isGDBLine(entry) || isParsedGDBLine(entry))
}

/**
 * Parses a method signature string into its name and argument list.
 *
 * @param {string} sig
 * @returns {{
 *   name: string
 *   args: { name: string; value?: string; type?: string }[]
 * }}
 */
function parseMethodSignature(sig) {
  const nameMatch = sig.match(/^([^(]+)\s*\((.*)\)$/s)
  if (!nameMatch) {
    return { name: sig.trim(), args: [] }
  }

  const [, name, argsStr] = nameMatch
  const args =
    argsStr.match(/(?:[^,"']+|"[^"]*"|'[^']*')+/g)?.map((arg) => {
      const parts = arg.split('=')
      if (parts.length === 2) {
        const [name, value] = parts.map((s) => s.trim())
        return { name, value }
      } else {
        return { name: arg.trim() }
      }
    }) || []
  return { name: name.trim(), args }
}

/** @typedef {string} RegAddr `'0x12345678'` or `'this::loop'` */

/**
 * @typedef {Object} GDBLine
 * @property {RegAddr} regAddr
 * @property {string} lineNumber `'36'` or `'??'`
 */

/**
 * @typedef {GDBLine & {
 *   file: string
 *   method: string
 * }} ParsedGDBLine
 */

/**
 * @param {string} stdout
 * @param {Debug} [debug]
 * @returns {(GDBLine | ParsedGDBLine)[]}
 */
export function parseLines(stdout, debug) {
  const log = createRegAddrLogger(debug)
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseLine(line, log))
    .filter(isParsedOrGdbLine)
}

/**
 * @param {string} line
 * @param {Debug} [log]
 * @returns {GDBLine | ParsedGDBLine | undefined}
 */
export function parseLine(line, log = createRegAddrLogger()) {
  log('parse line', line)
  const patterns = [
    // GDB style with frame number and numeric file/line
    /#\d+\s+(0x[0-9a-f]+)\s+in\s+([^(]+\((?:"(?:\\.|[^"\\])*"|[^()])*?\))\s+at\s+(.+):(\d+)/i,
    // GDB style without frame number and numeric file/line
    /(0x[0-9a-f]+)\s+in\s+([^(]+(?:\([^()]*\))?)\s+at\s+(.+):(\d+)/i,
    // GDB style with frame number and ?? file/line
    /(?:#\d+\s+)?(0x[0-9a-f]+)\s+in\s+([^(]+(?:\([^()]*\))?)\s+at\s+(\?+):(\?+)/i,
    // "is in" format with numeric file/line
    /(0x[0-9a-f]+)\s+is\s+in\s+([^(]+(?:\([^()]*\))?)\s+\((.+):(\d+)\)/i,
    // "is in" format without line number
    /(0x[0-9a-f]+)\s+is\s+in\s+([^(]+(?:\([^()]*\))?)\s+\(([^():]+)\)/i,
    // Address with "is at" and numeric file/line
    /(0x[0-9a-f]+)\s+is\s+at\s+(.+):(\d+)/i,
    // Method with file/line but no address
    /(?:#\d+\s+)?([^(]+(?:\([^()]*\))?)\s+at\s+(.+):(\d+)/,
  ]

  for (const [i, pattern] of patterns.entries()) {
    const match = line.match(pattern)
    if (match) {
      // Numeric file/line after "in"
      if (i === 0 || i === 1) {
        const [, regAddr, method, file, lineNumber] = match
        return normalizeParsedLine({ regAddr, method, file, lineNumber })
      }
      // ?? file/line after "in"
      if (i === 2) {
        const [, regAddr, method, file, lineNumber] = match
        return normalizeParsedLine({ regAddr, method, file, lineNumber })
      }
      // "is in" with numeric file/line
      if (i === 3) {
        const [, regAddr, method, file, lineNumber] = match
        return normalizeParsedLine({ regAddr, method, file, lineNumber })
      }
      // "is in" without line number
      if (i === 4) {
        const [, regAddr, method, file] = match
        return normalizeParsedLine({ regAddr, method, file, lineNumber: '??' })
      }
      // "is at" with numeric file/line
      if (i === 5) {
        const [, regAddr, file, lineNumber] = match
        return normalizeParsedLine({ regAddr, method: '??', file, lineNumber })
      }
      // Method with file/line but no address
      if (i === 6) {
        const [, method, file, lineNumber] = match
        return normalizeParsedLine({ regAddr: '??', method, file, lineNumber })
      }
    }
  }
  // Fallback for addresses without file/line info
  const fallbackMatch = line.match(
    /(?:#\d+\s+)?(0x[0-9a-f]+)\s+(?:is\s+in|in)\s+([^(]+(?:\([^()]*\))?)/i
  )
  if (fallbackMatch) {
    const [, regAddr, method] = fallbackMatch
    return normalizeParsedLine({
      regAddr,
      method: method.trim(),
      file: '??',
      lineNumber: '??',
    })
  }
  log('no pattern matched', line)
  return undefined
}

/**
 * Normalize a parsed GDB line entry. If both file and lineNumber are missing or
 * unknown, omit them. If either is present but unknown, default to '??'.
 *
 * @param {ParsedGDBLine} entry
 * @returns {GDBLine | ParsedGDBLine}
 */
/**
 * Normalize a parsed GDB line entry. If both file and lineNumber are missing or
 * unknown, omit them. If either is present but unknown, default to '??'.
 *
 * @param {ParsedGDBLine} entry
 * @returns {GDBLine | ParsedGDBLine}
 */
function normalizeParsedLine(entry) {
  const { file, lineNumber, method, regAddr } = entry
  const parsedMethod = parseMethodSignature(method)

  const hasValidFile = file && file !== '' && file !== '??'
  const hasValidLine = lineNumber && lineNumber !== '' && lineNumber !== '??'

  if (hasValidFile || hasValidLine) {
    const result = {
      regAddr,
      method: parsedMethod.name,
      file: hasValidFile ? file : '??',
      lineNumber: hasValidLine ? lineNumber : '??',
    }
    if (parsedMethod.args && parsedMethod.args.length > 0) {
      Object.assign(result, { args: parsedMethod.args })
    }
    return result
  }

  const hasValidMethod =
    parsedMethod.name &&
    parsedMethod.name !== '' &&
    parsedMethod.name !== '??' &&
    parsedMethod.name !== '?? ()'

  if (!hasValidLine && hasValidMethod) {
    return { regAddr, lineNumber: parsedMethod.name }
  }

  return { regAddr, lineNumber: lineNumber || '??' }
}
