// @ts-check

import colors, { createColors as tinyrainbowCreateColors } from './_tinyrainbow.js'

import { isParsedGDBLine } from './decode.js'

/** @typedef {import('./coredump.js').CoredumpDecodeResult} CoredumpDecodeResult */
/** @typedef {import('./coredump.js').ThreadDecodeResult} ThreadDecodeResult */

const defaultOptions = {
  lineSeparator: '\r\n',
}

/**
 * @typedef {Object} StringifyOptions
 * @property {'force' | 'disable'} [color]
 * @property {string} [lineSeparator='\r\n'] Default is `'\r\n'`
 */

/**
 * @param {CoredumpDecodeResult} result
 * @param {ColorizeFn} colorizeFn
 */
function stringifyCoredumpDecodeResult(result, colorizeFn) {
  const lines = [...stringifyThreadsInfo(result, colorizeFn), '']

  for (let i = 0; i < result.length; i++) {
    const thread = result[i]
    lines.push(
      formatThreadHeader(thread),
      ...stringifyThreadDecodeResult(thread, colorizeFn)
    )
    if (i < result.length - 1) {
      lines.push('')
    }
  }

  return lines
}

/**
 * @param {import('./decode.js').DecodeResult | CoredumpDecodeResult} result
 * @param {StringifyOptions} [options]
 */
export function stringifyDecodeResult(result, options = defaultOptions) {
  options = { ...defaultOptions, ...options }
  const { colorizeFn, resetColor } = createColorFn(options)

  try {
    const lines = Array.isArray(result)
      ? stringifyCoredumpDecodeResult(result, colorizeFn)
      : stringifySingleDecodeResult(result, colorizeFn)
    return lines.join(options.lineSeparator)
  } finally {
    resetColor()
  }
}

/**
 * @typedef {'red' | 'green' | 'blue'} Color
 *
 * @callback ColorizeFn
 * @param {string} text
 * @param {Color} [color]
 * @returns {string}
 */

/**
 * @param {Pick<StringifyOptions, 'color'>} options
 * @returns {{ colorizeFn: ColorizeFn; resetColor: () => void }}
 */
function createColorFn(options) {
  const create =
    (
      /** @type {(arg: string) => string} */ red,
      /** @type {(arg: string) => string} */ green,
      /** @type {(arg: string) => string} */ blue
    ) =>
    (/** @type {string} */ text, /** @type {Color | undefined} */ color) => {
      switch (color) {
        case 'red':
          return red(text)
        case 'green':
          return green(text)
        case 'blue':
          return blue(text)
        default:
          return text
      }
    }
  /** @type {() => void} */
  let resetColor = () => {
    /* NOOP */
  }

  if (options.color === 'disable') {
    return {
      colorizeFn: (text) => text,
      resetColor,
    }
  }

  if (options.color === 'force') {
    if (!process.env.FORCE_COLOR) {
      process.env.FORCE_COLOR = '1'
      resetColor = () => {
        delete process.env.FORCE_COLOR
      }
    }

    const { red, green, blue } = tinyrainbowCreateColors()
    const colorizeFn = create(red, green, blue)
    return {
      colorizeFn,
      resetColor,
    }
  }

  const { red, green, blue } = colors
  const colorizeFn = create(red, green, blue)
  return {
    colorizeFn,
    resetColor,
  }
}

/**
 * @param {import('./decode.js').DecodeResult} result
 * @param {ColorizeFn} colorizeFn
 */
function stringifySingleDecodeResult(result, colorizeFn) {
  const lines = []
  if (typeof result.faultInfo?.faultCode === 'number') {
    let faultCodeLine = `${result.faultInfo.coreId}`
    if (result.faultInfo.faultMessage) {
      faultCodeLine += ` | ${result.faultInfo.faultMessage}`
    }
    faultCodeLine += ` | ${result.faultInfo.faultCode}`
    lines.push(colorizeFn(faultCodeLine, 'red'))
  }

  const pc = result.faultInfo?.programCounter.location
  if (pc) {
    if (lines.length) {
      lines.push('')
    }
    lines.push(
      `${colorizeFn('PC -> ', 'red')}${stringifyAddrLocation(pc, colorizeFn)}`
    )
  }

  const faultAddr = result.faultInfo?.faultAddr?.location
  if (faultAddr) {
    lines.push(
      `${colorizeFn('Fault -> ', 'red')}${stringifyAddrLocation(
        faultAddr,
        colorizeFn
      )}`
    )
  }

  if (result.stacktraceLines.length && lines.length) {
    lines.push('')
  }

  for (const line of result.stacktraceLines) {
    lines.push(stringifyAddrLocation(line, colorizeFn))
  }

  if (result.allocInfo) {
    if (lines.length) {
      lines.push('')
    }
    lines.push(
      `${colorizeFn(
        `Memory allocation of ${result.allocInfo.allocSize} bytes failed`,
        'red'
      )}${colorizeFn(' at ')}${stringifyAddrLocation(
        result.allocInfo.allocAddr,
        colorizeFn
      )}`
    )
  }

  return lines
}

/**
 * @param {CoredumpDecodeResult} result
 * @param {ColorizeFn} colorizeFn
 */
function stringifyThreadsInfo(result, colorizeFn) {
  const lines = []
  lines.push('==================== THREADS INFO ====================')
  lines.push('  ID  Target ID            Frame')

  for (const thread of result) {
    const mark = thread.current ? '*' : ' '
    const tid = thread.threadId.toString().padStart(2)
    const tcb = thread.TCB.toString().padEnd(12)
    const top = thread.result.stacktraceLines?.[0]
    const topText = top ? stringifyAddrLocation(top, colorizeFn) : ''
    lines.push(` ${mark}${tid}  process ${tcb} ${topText}`)
  }
  return lines
}

/** @param {ThreadDecodeResult} thread */
function formatThreadHeader(thread) {
  return `==================== THREAD ${
    thread.threadId
  } (TCB: 0x${(+thread.TCB).toString(16)}) ====================`
}

/**
 * @param {ThreadDecodeResult} result
 * @param {ColorizeFn} colorizeFn
 */
function stringifyThreadDecodeResult(result, colorizeFn) {
  return result.result.stacktraceLines.map((line) =>
    stringifyAddrLocation(line, colorizeFn)
  )
}

/**
 * @typedef {Object} StringifyAddrLocationOptions
 * @property {(text: string, color?: 'green' | 'blue') => string} color
 */

/**
 * @param {import('./decode.js').AddrLocation} location
 * @param {ColorizeFn} colorizeFn
 */
function stringifyAddrLocation(location, colorizeFn) {
  if (typeof location === 'string') {
    return colorizeFn(location)
  }
  if (!isParsedGDBLine(location)) {
    const regAddr = colorizeFn(location.regAddr, 'green')
    const suffix = colorizeFn(`: ${location.lineNumber}`)
    return `${regAddr}${suffix}`
  }

  const args =
    location.args
      ?.map((arg) => `${arg.name}${arg.value ? `=${arg.value}` : ''}`)
      .join(', ') ?? ''

  const signature = `${location.method} (${args})`

  return `${colorizeFn(location.regAddr, 'green')}${colorizeFn(
    ': '
  )}${colorizeFn(signature, 'blue')}${colorizeFn(
    ` at ${location.file}:${location.lineNumber}`
  )}`
}
