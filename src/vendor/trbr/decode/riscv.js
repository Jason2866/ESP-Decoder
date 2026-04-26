// @ts-check

import net from 'node:net'

import { AbortError, neverSignal } from '../abort.js'
import { isRiscvTargetArch } from '../tool.js'
import { addr2line } from './addr2Line.js'
import {
  GdbMiClient,
  extractMiListContent,
  parseMiResultRecord,
  parseMiTupleList,
  stripMiList,
} from './gdbMi.js'
import { resolveGlobalSymbols } from './globals.js'
import { parseLines } from './regAddr.js'
import { toHexString } from './regs.js'

// Based on the work of:
//  - [Peter Dragun](https://github.com/peterdragun)
//  - [Ivan Grokhotkov](https://github.com/igrr)
//  - [suda-morris](https://github.com/suda-morris)
//
// https://github.com/espressif/esp-idf-monitor/blob/fae383ecf281655abaa5e65433f671e274316d10/esp_idf_monitor/gdb_panic_server.py

const riscvLogPrefix = '[trbr][riscv]'

/**
 * @param {Debug | undefined} debug
 * @returns {Debug}
 */
function createRiscvLogger(debug) {
  const writer =
    debug ?? (process.env.TRBR_DEBUG === 'true' ? console.log : undefined)
  return writer ? (...args) => writer(riscvLogPrefix, ...args) : () => {}
}

/** @typedef {import('./decode.js').DecodeParams} DecodeParams */
/** @typedef {import('./decode.js').DecodeResult} DecodeResult */
/** @typedef {import('./decode.js').DecodeFunction} DecodeFunction */
/** @typedef {import('./decode.js').DecodeOptions} DecodeOptions */
/** @typedef {import('./decode.js').GDBLine} GDBLine */
/** @typedef {import('./decode.js').ParsedGDBLine} ParsedGDBLine */
/** @typedef {import('./decode.js').FrameArg} FrameArg */
/** @typedef {import('./decode.js').FrameVar} FrameVar */
/** @typedef {import('./decode.js').Debug} Debug */
/** @typedef {import('./decode.js').RegAddr} RegAddr */
/** @typedef {import('./decode.js').AddrLine} AddrLine */
/** @typedef {import('./decode.js').PanicInfoWithStackData} PanicInfoWithStackData */
/** @typedef {import('../tool.js').RiscvTargetArch} RiscvTargetArch */
const gdbRegsInfoRiscvIlp32 = /** @type {const} */ ([
  'X0',
  'RA',
  'SP',
  'GP',
  'TP',
  'T0',
  'T1',
  'T2',
  'S0/FP',
  'S1',
  'A0',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
  'A7',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
  'S7',
  'S8',
  'S9',
  'S10',
  'S11',
  'T3',
  'T4',
  'T5',
  'T6',
  'MEPC', // where execution is happening (PC) and where it resumes after exception (MEPC).
])

/** @type {Record<RiscvTargetArch, DecodeFunction>} */
export const riscvDecoders = /** @type {const} */ ({
  esp32c2: decodeRiscv,
  esp32c3: decodeRiscv,
  esp32c6: decodeRiscv,
  esp32h2: decodeRiscv,
  esp32h4: decodeRiscv,
  esp32p4: decodeRiscv,
})

/** @type {Record<RiscvTargetArch, gdbRegsInfoRiscvIlp32>} */
const gdbRegsInfo = {
  esp32c2: gdbRegsInfoRiscvIlp32,
  esp32c3: gdbRegsInfoRiscvIlp32,
  esp32c6: gdbRegsInfoRiscvIlp32,
  esp32h2: gdbRegsInfoRiscvIlp32,
  esp32h4: gdbRegsInfoRiscvIlp32,
  esp32p4: gdbRegsInfoRiscvIlp32,
}

/**
 * @template {RiscvTargetArch} T
 * @param {T} type
 */
function createRegNameValidator(type) {
  const regsInfo = gdbRegsInfo[type]
  if (!regsInfo) {
    throw new Error(`Unsupported target: ${type}`)
  }
  /** @type {(regName: unknown) => regName is gdbRegsInfoRiscvIlp32} */
  return (regName) =>
    regsInfo.includes(
      /** @type {(typeof gdbRegsInfoRiscvIlp32)[number]} */ (regName)
    )
}

/**
 * @typedef {Object} RegisterDump
 * @property {number} coreId
 * @property {Record<string, number>} regs
 */

/**
 * @typedef {Object} StackDump
 * @property {number} baseAddr
 * @property {number[]} data
 */

/**
 * @typedef {Object} ParsePanicOutputParams
 * @property {string} input
 * @property {RiscvTargetArch} target
 */

/**
 * @typedef {Object} ParsePanicOutputResult
 * @property {RegisterDump[]} regDumps
 * @property {StackDump[]} stackDump
 * @property {number} programCounter
 * @property {number} [faultCode]
 * @property {number} [faultAddr]
 */

/**
 * @param {ParsePanicOutputParams} params
 * @returns {ParsePanicOutputResult}
 */
function parse({ input, target }) {
  const lines = input.split(/\r?\n|\r/)
  /** @type {RegisterDump[]} */
  const regDumps = []
  /** @type {StackDump[]} */
  const stackDump = []
  /** @type {RegisterDump | undefined} */
  let currentRegDump
  let inStackMemory = false
  /** @type {number | undefined} */
  let faultCode
  /** @type {number | undefined} */
  let faultAddr
  let programCounter = 0

  const regNameValidator = createRegNameValidator(target)

  lines.forEach((line) => {
    if (line.startsWith('Core')) {
      const match = line.match(/^Core\s+(\d+)\s+register dump:/)
      if (match) {
        currentRegDump = {
          coreId: parseInt(match[1], 10),
          regs: {},
        }
        regDumps.push(currentRegDump)
      }
    } else if (currentRegDump && !inStackMemory) {
      const regMatches = line.matchAll(/([A-Z_0-9/]+)\s*:\s*(0x[0-9a-fA-F]+)/g)
      for (const match of regMatches) {
        const regName = match[1]
        const regAddr = parseInt(match[2], 16)
        if (regAddr && regNameValidator(regName)) {
          currentRegDump.regs[regName] = regAddr
          if (regName === 'MEPC') {
            programCounter = regAddr // PC equivalent
          }
        } else if (regName === 'MCAUSE') {
          faultCode = regAddr // EXCCAUSE equivalent
        } else if (regName === 'MTVAL') {
          faultAddr = regAddr // EXCVADDR equivalent
        }
      }
      if (line.trim() === 'Stack memory:') {
        inStackMemory = true
      }
    } else if (inStackMemory) {
      const match = line.match(/^([0-9a-fA-F]+):\s*((?:0x[0-9a-fA-F]+\s*)+)/)
      if (match) {
        const baseAddr = parseInt(match[1], 16)
        const data = match[2]
          .trim()
          .split(/\s+/)
          .map((hex) => parseInt(hex, 16))
        stackDump.push({ baseAddr, data })
      }
    }
  })

  return { regDumps, stackDump, faultCode, faultAddr, programCounter }
}

/**
 * @typedef {Object} GetStackAddrAndDataParams
 * @property {StackDump[]} stackDump
 */

/**
 * @typedef {Object} GetStackAddrAndDataResult
 * @property {number} stackBaseAddr
 * @property {Buffer} stackData
 */

/**
 * @param {GetStackAddrAndDataParams} params
 * @returns {GetStackAddrAndDataResult}
 */
function getStackAddrAndData({ stackDump }) {
  let stackBaseAddr = 0
  let baseAddr = 0
  let bytesInLine = 0
  let stackData = Buffer.alloc(0)

  stackDump.forEach((line) => {
    const prevBaseAddr = baseAddr
    baseAddr = line.baseAddr
    if (stackBaseAddr === 0) {
      stackBaseAddr = baseAddr
    } else {
      if (baseAddr !== prevBaseAddr + bytesInLine) {
        throw new Error('Invalid base address')
      }
    }

    const lineData = Buffer.concat(
      line.data.map((word) => {
        const buf = Buffer.alloc(4)
        // Stack memory is little-endian; preserve byte order for GDB reads.
        buf.writeUInt32LE(word >>> 0)
        return buf
      })
    )
    bytesInLine = lineData.length
    stackData = Buffer.concat([stackData, lineData])
  })

  return { stackBaseAddr, stackData }
}

/**
 * @typedef {Object} ParseIdfRiscvPanicOutputParams
 * @property {string} input
 * @property {RiscvTargetArch} target
 */

/**
 * @param {ParseIdfRiscvPanicOutputParams} params
 * @returns {PanicInfoWithStackData}
 */
function parsePanicOutput({ input, target }) {
  const { regDumps, stackDump, programCounter, faultAddr, faultCode } = parse({
    input,
    target,
  })
  if (regDumps.length === 0) {
    throw new Error('No register dumps found')
  }
  if (regDumps.length > 1) {
    throw new Error('Handling of multi-core register dumps not implemented')
  }

  const { coreId, regs } = regDumps[0]
  const { stackBaseAddr, stackData } = getStackAddrAndData({ stackDump })

  return {
    coreId,
    programCounter,
    faultAddr,
    faultCode,
    regs,
    stackBaseAddr,
    stackData,
    target,
  }
}

/**
 * @typedef {Object} GdbServerParams
 * @property {PanicInfoWithStackData} panicInfo
 * @property {Debug} [debug]
 */

/**
 * @typedef {Object} StartGdbServerParams
 * @property {AbortSignal} [signal]
 */

export class GdbServer {
  /** @param {GdbServerParams} params */
  constructor(params) {
    this.panicInfo = params.panicInfo
    this.regList = gdbRegsInfo[params.panicInfo.target]
    this.debug = params.debug ?? (() => {})
  }

  /**
   * @param {StartGdbServerParams} [params]
   * @returns {Promise<net.AddressInfo>}
   */
  async start(params = {}) {
    if (this.server) {
      throw new Error('Server already started')
    }

    const { signal = neverSignal } = params
    const server = net.createServer()
    this.server = server

    await new Promise((resolve, reject) => {
      const abortHandler = () => {
        this.debug('User abort')
        reject(new AbortError())
        this.close()
      }

      if (signal.aborted) {
        abortHandler()
        return
      }

      signal.addEventListener('abort', abortHandler)
      server.on('listening', () => {
        signal.removeEventListener('abort', abortHandler)
        resolve(undefined)
      })
      server.listen(0)
    })

    const address = server.address()
    if (!address) {
      this.close()
      throw new Error('Failed to start server')
    }
    if (typeof address === 'string') {
      this.close()
      throw new Error(
        `Expected an address info object. Got a string: ${address}`
      )
    }

    server.on('connection', (socket) => {
      let pending = ''
      socket.on('data', (data) => {
        pending = this._consumePackets(pending + data.toString(), socket)
      })
    })

    return address
  }

  /**
   * @param {string} pending
   * @param {net.Socket} socket
   * @returns {string}
   */
  _consumePackets(pending, socket) {
    while (pending.length > 0) {
      if (pending.startsWith('+')) {
        pending = pending.slice(1)
        continue
      }

      if (pending.startsWith('-')) {
        this.debug(`Invalid command: ${pending}`)
        socket.write('-')
        socket.end()
        return ''
      }

      const packetStart = pending.indexOf('$')
      if (packetStart === -1) {
        this.debug(`Discarding non-packet data: ${JSON.stringify(pending)}`)
        return ''
      }
      if (packetStart > 0) {
        const ignored = pending.slice(0, packetStart)
        this.debug(`Discarding packet prefix: ${JSON.stringify(ignored)}`)
        pending = pending.slice(packetStart)
      }

      const checksumMark = pending.indexOf('#', 1)
      if (checksumMark === -1 || checksumMark + 2 >= pending.length) {
        return pending
      }

      const packet = pending.slice(0, checksumMark + 3)
      pending = pending.slice(checksumMark + 3)
      this.debug(`Command: ${packet}`)
      this._handleCommand(packet, socket)
    }

    return pending
  }

  close() {
    this.server?.close()
    this.server = undefined
  }

  /**
   * @param {string} buffer
   * @param {net.Socket} socket
   */
  _handleCommand(buffer, socket) {
    if (buffer.startsWith('+')) {
      buffer = buffer.slice(1) // ignore the leading '+'
    }

    const command = buffer.slice(1, -3) // ignore checksums
    // Acknowledge the command
    socket.write('+')
    this.debug(
      `Raw buffer (length ${buffer.length}): ${JSON.stringify(buffer)}`
    )
    this.debug(`Got command: ${command}`)
    if (command === '?') {
      // report sigtrap as the stop reason; the exact reason doesn't matter for backtracing
      this.debug('Responding with: T05')
      this._respond('T05', socket)
    } else if (command.startsWith('Hg') || command.startsWith('Hc')) {
      // Select thread command
      this.debug('Responding with: OK')
      this._respond('OK', socket)
    } else if (command === 'qfThreadInfo') {
      // Get list of threads.
      // Only one thread for now, can be extended to show one thread for each core,
      // if we dump both cores (e.g. on an interrupt watchdog)
      this.debug('Responding with: m1')
      this._respond('m1', socket)
    } else if (command === 'qC') {
      // That single thread is selected.
      this.debug('Responding with: QC1')
      this._respond('QC1', socket)
    } else if (command === 'g') {
      // Registers read
      this._respondRegs(socket)
    } else if (command.startsWith('m')) {
      // Memory read
      const [addr, size] = command
        .slice(1)
        .split(',')
        .map((v) => parseInt(v, 16))
      this._respondMem(addr, size, socket)
    } else if (command.startsWith('vKill') || command === 'k') {
      // Quit
      this.debug('Responding with: OK')
      this._respond('OK', socket)
      socket.end()
    } else {
      // Empty response required for any unknown command
      this.debug('Responding with: (empty)')
      this._respond('', socket)
    }
  }

  /**
   * @param {string} data
   * @param {net.Socket} socket
   */
  _respond(data, socket) {
    // calculate checksum
    const dataBytes = Buffer.from(data, 'ascii')
    const checksum = dataBytes.reduce((sum, byte) => sum + byte, 0) & 0xff
    // format and write the response
    const res = `$${data}#${checksum.toString(16).padStart(2, '0')}`
    socket.write(res)
    this.debug(`Wrote: ${res}`)
  }

  /** @param {net.Socket} socket */
  _respondRegs(socket) {
    let response = ''
    // https://github.com/espressif/esp-idf-monitor/blob/fae383ecf281655abaa5e65433f671e274316d10/esp_idf_monitor/gdb_panic_server.py#L242-L247
    // It loops over the list of register names.
    // For each register name, it gets the register value from panicInfo.regs.
    // It converts the register value to bytes in little-endian byte order.
    // It converts each byte to a hexadecimal string and joins them together.
    // It appends the hexadecimal string to the response string.
    for (const regName of this.regList) {
      const regVal = this.panicInfo.regs[regName] || 0
      const regBytes = Buffer.alloc(4)
      regBytes.writeUInt32LE(regVal)
      const regValHex = regBytes.toString('hex')
      response += regValHex
    }
    this.debug(
      `Register values: ${this.regList
        .map((r) => `${r}=${toHexString(this.panicInfo.regs[r] || 0)}`)
        .join(', ')}`
    )
    this.debug(`Register response: ${response}`)
    this._respond(response, socket)
  }

  /**
   * @param {number} startAddr
   * @param {number} size
   * @param {net.Socket} socket
   */
  _respondMem(startAddr, size, socket) {
    const stackAddrMin = this.panicInfo.stackBaseAddr
    const stackData = this.panicInfo.stackData
    const stackLen = stackData.length
    const stackAddrMax = stackAddrMin + stackLen

    const inStack = (/** @type {number} */ addr) =>
      stackAddrMin <= addr && addr < stackAddrMax

    let result = ''
    for (let addr = startAddr; addr < startAddr + size; addr++) {
      if (!inStack(addr)) {
        result += '00'
      } else {
        result += stackData[addr - stackAddrMin].toString(16).padStart(2, '0')
      }
    }

    this.debug(
      `Memory read request from 0x${startAddr.toString(16)} for ${size} bytes`
    )
    this.debug(`Responding with memory: ${result}`)
    this._respond(result, socket)
  }
}

const miErrorPattern = /^\^error/m

/**
 * @param {string} raw
 * @returns {string | undefined}
 */
function parseMiErrorMessage(raw) {
  const match = raw.match(/\^error(?:,[^\n]*?msg="((?:\\.|[^"])*)")?/m)
  if (!match?.[1]) {
    return undefined
  }
  return match[1]
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
}

/**
 * @param {string} raw
 * @returns {string}
 */
function summarizeMiOutput(raw) {
  const normalized = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
  if (!normalized) {
    return 'empty MI response'
  }
  const maxLength = 240
  if (normalized.length <= maxLength) {
    return normalized
  }
  return `${normalized.slice(0, maxLength)}...[truncated ${normalized.length - maxLength} chars]`
}

/**
 * @param {string} raw
 * @returns {string}
 */
function describeMiFailure(raw) {
  return parseMiErrorMessage(raw) ?? summarizeMiOutput(raw)
}

/**
 * @param {DecodeOptions | undefined} options
 * @returns {boolean}
 */
function shouldIncludeFrameVars(options) {
  return options?.includeFrameVars === true
}

/**
 * @param {Record<string, string>} tuple
 * @returns {FrameArg | undefined}
 */
function toFrameArg(tuple) {
  if (!tuple.name) {
    return undefined
  }
  /** @type {FrameArg} */
  const arg = { name: tuple.name }
  if (tuple.type) {
    arg.type = tuple.type
  }
  if (tuple.value !== undefined) {
    arg.value = tuple.value
  }
  return arg
}

/**
 * @param {Record<string, string>} tuple
 * @param {'local' | 'argument' | 'global'} scope
 * @returns {FrameVar | undefined}
 */
function toFrameVar(tuple, scope) {
  if (!tuple.name) {
    return undefined
  }
  /** @type {FrameVar} */
  const variable = { scope, name: tuple.name }
  if (tuple.type) {
    variable.type = tuple.type
  }
  if (tuple.value !== undefined) {
    variable.value = tuple.value
  }
  if (tuple.addr || tuple.address) {
    variable.address = tuple.addr || tuple.address
  }
  return variable
}

/**
 * @param {Record<string, string>} frame
 * @returns {GDBLine | ParsedGDBLine}
 */
function toParsedFrame(frame) {
  const regAddr = frame.addr || '??'
  const method = frame.func && frame.func !== '??' ? frame.func : undefined
  const fileRaw = frame.fullname || frame.file
  const file = fileRaw && fileRaw !== '??' ? fileRaw : undefined
  const lineNumber = frame.line && frame.line !== '??' ? frame.line : undefined

  if (!method && !file && !lineNumber) {
    return { regAddr, lineNumber: '??' }
  }

  return {
    regAddr,
    method: method || '??',
    file: file || '??',
    lineNumber: lineNumber || '??',
  }
}

/**
 * @param {string} raw
 * @returns {Record<string, string>[]}
 */
function parseMiFrames(raw) {
  const listContent = extractMiListContent(raw, 'stack')
  return parseMiTupleList(listContent, 'frame')
}

/**
 * @template T
 * @param {T | undefined} value
 * @returns {value is T}
 */
function isDefined(value) {
  return value !== undefined
}

/**
 * @param {string} raw
 * @param {string} frameLevel
 * @returns {FrameArg[] | undefined}
 */
function parseMiStackArgs(raw, frameLevel) {
  if (miErrorPattern.test(raw)) {
    return undefined
  }
  const listContent = extractMiListContent(raw, 'stack-args')
  if (listContent === undefined) {
    return undefined
  }
  const frames = parseMiTupleList(listContent, 'frame')
  const frame = frames.find((entry) => entry.level === frameLevel) ?? frames[0]
  if (!frame || !frame.args) {
    return []
  }
  const argsList = stripMiList(frame.args) ?? ''
  return parseMiTupleList(argsList).map(toFrameArg).filter(isDefined)
}

/**
 * @param {string} raw
 * @returns {FrameVar[] | undefined}
 */
function parseMiLocals(raw) {
  if (miErrorPattern.test(raw)) {
    return undefined
  }
  const listContent = extractMiListContent(raw, 'variables')
  if (listContent === undefined) {
    return undefined
  }
  return parseMiTupleList(listContent)
    .map((tuple) => toFrameVar(tuple, 'local'))
    .filter(isDefined)
}

/**
 * @param {string} name
 * @returns {string}
 */
function stripEntrySuffix(name) {
  return name.replace(/@entry$/, '')
}

/**
 * @param {FrameArg[]} [args]
 * @returns {Set<string>}
 */
function collectArgNames(args) {
  const names = new Set()
  if (!args) {
    return names
  }
  for (const arg of args) {
    if (!arg?.name) {
      continue
    }
    names.add(arg.name)
    names.add(stripEntrySuffix(arg.name))
  }
  return names
}

/**
 * @param {FrameArg[]} [args]
 * @returns {FrameArg[]}
 */
function dedupeArgs(args) {
  if (!args || !args.length) {
    return []
  }
  /** @type {Map<string, { arg: FrameArg; fromEntry: boolean }>} */
  const byName = new Map()
  /** @type {string[]} */
  const order = []

  for (const arg of args) {
    if (!arg?.name) {
      continue
    }
    const baseName = stripEntrySuffix(arg.name)
    const fromEntry = arg.name.endsWith('@entry')
    const existing = byName.get(baseName)
    if (!existing) {
      byName.set(baseName, { arg: { ...arg, name: baseName }, fromEntry })
      order.push(baseName)
      continue
    }

    if (existing.fromEntry && !fromEntry) {
      byName.set(baseName, { arg: { ...arg, name: baseName }, fromEntry })
      continue
    }

    if (!existing.arg.type && arg.type) {
      existing.arg.type = arg.type
    }
    if (
      (!existing.arg.value || existing.arg.value === '<optimized out>') &&
      arg.value &&
      arg.value !== '<optimized out>'
    ) {
      existing.arg.value = arg.value
    }
  }

  return order
    .map((name) => byName.get(name))
    .filter(isDefined)
    .map((entry) => entry.arg)
}

/**
 * @param {FrameVar[]} locals
 * @param {FrameArg[]} [args]
 * @returns {FrameVar[]}
 */
function filterArgLocals(locals, args) {
  const argNames = collectArgNames(args)
  if (!argNames.size) {
    return locals
  }
  return locals.filter((local) => {
    if (!local?.name) {
      return false
    }
    const name = local.name
    return !argNames.has(name) && !argNames.has(stripEntrySuffix(name))
  })
}

/**
 * @param {string} type
 * @returns {string}
 */
function normalizeType(type) {
  return type
    .replace(/\bconst\b/g, '')
    .replace(/\bvolatile\b/g, '')
    .replace(/\bstatic\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {string} type
 * @returns {boolean}
 */
function isPrimitiveType(type) {
  const cleaned = normalizeType(type)
    .replace(/\bstruct\b|\bclass\b|\bunion\b|\benum\b/g, '')
    .trim()
  return /^(unsigned|signed)?\s*(char|short|int|long|long long|float|double|bool|size_t|uintptr_t|intptr_t|uint\d+_t|int\d+_t)$/.test(
    cleaned
  )
}

/**
 * @param {FrameVar} variable
 * @returns {boolean}
 */
function shouldExpandVar(variable) {
  const type = variable.type
  if (!type) {
    return false
  }
  if (/\[.*\]/.test(type)) {
    return true
  }
  if (type.includes('*') || type.includes('&')) {
    return false
  }
  if (/\bstruct\b|\bclass\b|\bunion\b/.test(type)) {
    return true
  }
  return !isPrimitiveType(type)
}

/**
 * @param {string} value
 * @returns {string}
 */
function quoteMiArg(value) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}"`
}

/**
 * @param {Record<string, string>} tuple
 * @returns {FrameVar | undefined}
 */
/**
 * @typedef {Object} VarChildEntry
 * @property {string} [varObject]
 * @property {number} numChildren
 * @property {FrameVar} variable
 */

/**
 * @param {Record<string, string>} tuple
 * @returns {VarChildEntry | undefined}
 */
function toVarChildEntry(tuple) {
  const displayName = tuple.exp || tuple.name
  if (!displayName) {
    return undefined
  }
  /** @type {FrameVar} */
  const variable = { name: displayName }
  if (tuple.type) {
    variable.type = tuple.type
  }
  if (tuple.value !== undefined) {
    variable.value = tuple.value
  }
  return {
    varObject: tuple.name,
    numChildren: parseInt(tuple.numchild ?? '0', 10),
    variable,
  }
}

/**
 * @param {GdbMiClient} client
 * @param {string} expression
 * @returns {Promise<string | undefined>}
 */
async function evaluateExpression(client, expression) {
  const raw = await client.sendCommand(
    `-data-evaluate-expression ${quoteMiArg(expression)}`
  )
  if (miErrorPattern.test(raw)) {
    return undefined
  }
  const record = parseMiResultRecord(raw)
  return record.value
}

/**
 * @param {GdbMiClient} client
 * @param {string} varObject
 * @returns {Promise<VarChildEntry[] | undefined>}
 */
async function listVarChildren(client, varObject) {
  const raw = await client.sendCommand(
    `-var-list-children --simple-values ${varObject}`
  )
  if (miErrorPattern.test(raw)) {
    return undefined
  }
  const listContent = extractMiListContent(raw, 'children')
  if (listContent === undefined) {
    return undefined
  }
  return parseMiTupleList(listContent, 'child')
    .map(toVarChildEntry)
    .filter(isDefined)
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isAccessSpecifier(name) {
  return name === 'public' || name === 'private' || name === 'protected'
}

/**
 * @param {GdbMiClient} client
 * @param {string} varObject
 * @param {{ maxChildren: number; maxDepth: number }} options
 * @param {number} depth
 * @param {Set<string>} visited
 * @returns {Promise<FrameVar[]>}
 */
async function expandVarObjectChildren(
  client,
  varObject,
  options,
  depth,
  visited
) {
  if (!varObject || depth > options.maxDepth) {
    return []
  }
  if (visited.has(varObject)) {
    return []
  }
  visited.add(varObject)

  const children = await listVarChildren(client, varObject)
  if (!children || !children.length) {
    return []
  }

  /** @type {FrameVar[]} */
  const result = []

  for (const entry of children) {
    if (!entry) {
      continue
    }
    const variable = entry.variable
    const childVarObject = entry.varObject

    if (isAccessSpecifier(variable.name)) {
      if (childVarObject && depth < options.maxDepth) {
        const expanded = await expandVarObjectChildren(
          client,
          childVarObject,
          options,
          depth + 1,
          visited
        )
        for (const child of expanded) {
          result.push(child)
          if (result.length >= options.maxChildren) {
            return result.slice(0, options.maxChildren)
          }
        }
      }
      continue
    }

    if (
      childVarObject &&
      entry.numChildren > 0 &&
      depth < options.maxDepth &&
      shouldExpandVar(variable)
    ) {
      variable.children = await expandVarObjectChildren(
        client,
        childVarObject,
        options,
        depth + 1,
        visited
      )
    }

    result.push(variable)
    if (result.length >= options.maxChildren) {
      return result.slice(0, options.maxChildren)
    }
  }

  return result
}

/**
 * @param {GdbMiClient} client
 * @param {FrameVar} variable
 * @param {{ maxChildren: number; maxDepth: number }} options
 * @returns {Promise<void>}
 */
async function expandVariable(client, variable, options) {
  const expression = variable.name
  const createRaw = await client.sendCommand(
    `-var-create - * ${quoteMiArg(expression)}`
  )
  if (miErrorPattern.test(createRaw)) {
    return
  }
  const record = parseMiResultRecord(createRaw)
  const varObject = record.name
  const numChildren = parseInt(record.numchild ?? '0', 10)
  if (variable.value === undefined || variable.value === '<optimized out>') {
    if (record.value !== undefined) {
      variable.value = record.value
    } else {
      const evaluated = await evaluateExpression(client, expression)
      if (evaluated !== undefined) {
        variable.value = evaluated
      }
    }
  }
  if (varObject) {
    try {
      if (numChildren > 0) {
        const children = await expandVarObjectChildren(
          client,
          varObject,
          { maxChildren: options.maxChildren, maxDepth: options.maxDepth },
          0,
          new Set()
        )
        if (children.length) {
          variable.children = children
        }
      }
    } finally {
      await client.sendCommand(`-var-delete ${varObject}`)
    }
  }
}

/**
 * @param {GdbMiClient} client
 * @param {FrameVar[]} locals
 * @param {Debug} log
 * @returns {Promise<FrameVar[]>}
 */
async function expandLocals(client, locals, log) {
  const maxVars = 12
  const maxChildren = 16
  const maxDepth = 3
  let expanded = 0
  for (const variable of locals) {
    if (!shouldExpandVar(variable) || expanded >= maxVars) {
      continue
    }
    expanded += 1
    try {
      await expandVariable(client, variable, { maxChildren, maxDepth })
    } catch (error) {
      log('expand variable failed', variable.name, error)
    }
  }
  return locals
}

/**
 * @param {DecodeParams} params
 * @param {PanicInfoWithStackData} panicInfo
 * @param {DecodeOptions} options
 * @param {Debug} [log]
 * @returns {Promise<(GDBLine | ParsedGDBLine)[]>}
 */
async function fetchStacktraceWithMi(
  params,
  panicInfo,
  options = {},
  log = createRiscvLogger(options.debug)
) {
  const { elfPath, toolPath } = params
  const includeFrameVars = shouldIncludeFrameVars(options)
  let server
  /** @type {GdbMiClient | undefined} */
  let client

  try {
    log('fetch stacktrace start', { elfPath, toolPath })
    const { signal, debug } = options
    const gdbServer = new GdbServer({ panicInfo, debug })
    const { port } = await gdbServer.start({ signal })
    server = gdbServer
    log('gdb server started', { port })

    client = new GdbMiClient(
      toolPath,
      ['--interpreter=mi2', '-n', elfPath],
      options
    )
    await client.drainHandshake()
    const targetResult = await client.sendCommand(
      `-target-select remote :${port}`
    )
    if (miErrorPattern.test(targetResult)) {
      throw new Error(
        `Failed to connect to GDB remote target: ${describeMiFailure(targetResult)}`
      )
    }
    log('gdb remote connected')

    const framesRaw = await client.sendCommand('-stack-list-frames')
    if (miErrorPattern.test(framesRaw)) {
      throw new Error(
        `Failed to list stack frames: ${describeMiFailure(framesRaw)}`
      )
    }
    const frames = parseMiFrames(framesRaw)
    const stacktraceLines = frames.map(toParsedFrame)
    log('frames parsed', frames.length)
    frames.forEach((frame, index) => {
      log('frame', index, frame)
    })

    for (let i = 0; i < frames.length; i++) {
      const frameLevel = frames[i].level ?? `${i}`
      log('select frame', frameLevel)
      await client.sendCommand(`-stack-select-frame ${frameLevel}`)

      const argsRaw = await client.sendCommand(
        `-stack-list-arguments --simple-values ${frameLevel} ${frameLevel}`
      )
      const rawArgs = parseMiStackArgs(argsRaw, frameLevel)
      const args = rawArgs ? dedupeArgs(rawArgs) : undefined
      const parsedFrame =
        'method' in stacktraceLines[i]
          ? /** @type {ParsedGDBLine} */ (stacktraceLines[i])
          : undefined
      if (args !== undefined && parsedFrame) {
        parsedFrame.args = args.length ? args : []
        log('frame args', frameLevel, parsedFrame.args)
      }

      if (includeFrameVars) {
        const localsRaw = await client.sendCommand(
          '-stack-list-variables --simple-values'
        )
        let locals = parseMiLocals(localsRaw)
        if (locals !== undefined && parsedFrame) {
          locals = filterArgLocals(locals, args)
          locals = await expandLocals(client, locals, log)
          parsedFrame.locals = locals.length ? locals : []
          log('frame locals', frameLevel, parsedFrame.locals)
        }
      }
    }

    log('fetch stacktrace done', stacktraceLines.length)
    return stacktraceLines
  } finally {
    client?.close()
    server?.close()
  }
}

const exceptions = [
  { code: 0x0, description: 'Instruction address misaligned' },
  { code: 0x1, description: 'Instruction access fault' },
  { code: 0x2, description: 'Illegal instruction' },
  { code: 0x3, description: 'Breakpoint' },
  { code: 0x4, description: 'Load address misaligned' },
  { code: 0x5, description: 'Load access fault' },
  { code: 0x6, description: 'Store/AMO address misaligned' },
  { code: 0x7, description: 'Store/AMO access fault' },
  { code: 0x8, description: 'Environment call from U-mode' },
  { code: 0x9, description: 'Environment call from S-mode' },
  { code: 0xb, description: 'Environment call from M-mode' },
  { code: 0xc, description: 'Instruction page fault' },
  { code: 0xd, description: 'Load page fault' },
  { code: 0xf, description: 'Store/AMO page fault' },
]

/**
 * @param {string} elfPath
 * @param {number} port
 * @returns {string[]}
 */
function buildPanicServerArgs(elfPath, port) {
  return [
    '--batch',
    '-n',
    elfPath,
    // '-ex', // executes a command
    // `set remotetimeout ${debug ? 300 : 2}`, // Set the timeout limit to wait for the remote target to respond to num seconds. The default is 2 seconds. (https://sourceware.org/gdb/current/onlinedocs/gdb.html/Remote-Configuration.html)
    '-ex',
    `target remote :${port}`, // https://sourceware.org/gdb/current/onlinedocs/gdb.html/Server.html#Server
    '-ex',
    'bt',
  ]
}

/**
 * @param {DecodeParams} params
 * @param {PanicInfoWithStackData} panicInfo
 * @param {DecodeOptions} options
 * @param {Debug} [log]
 * @returns {Promise<(GDBLine | ParsedGDBLine)[]>}
 */
async function processPanicOutput(
  params,
  panicInfo,
  options = {},
  log = createRiscvLogger(options.debug)
) {
  return fetchStacktraceWithMi(params, panicInfo, options, log)
}

/**
 * @param {PanicInfoWithStackData} panicInfo
 * @param {AddrLine} programCounter
 * @param {AddrLine | undefined} faultAddr
 * @param {(GDBLine | ParsedGDBLine)[]} stacktraceLines
 * @param {FrameVar[]} [globals]
 * @returns {DecodeResult}
 */
function createDecodeResult(
  panicInfo,
  programCounter,
  faultAddr,
  stacktraceLines,
  globals
) {
  const exception = exceptions.find((e) => e.code === panicInfo.faultCode)

  return {
    faultInfo: {
      coreId: panicInfo.coreId,
      programCounter,
      faultAddr,
      faultCode: panicInfo.faultCode,
      faultMessage: exception ? exception.description : undefined,
    },
    regs: panicInfo.regs,
    stacktraceLines,
    allocInfo: undefined,
    globals,
  }
}

/** @type {import('./decode.js').DecodeFunction} */
export async function decodeRiscv(params, input, options) {
  const log = createRiscvLogger(options?.debug)
  const target = params.targetArch
  if (!isRiscvTargetArch(target)) {
    throw new Error(`Unsupported target: ${target}`)
  }
  log('decode start', { target, inputType: typeof input })

  /** @type {Exclude<typeof input, string>} */
  let panicInfo
  if (typeof input === 'string') {
    panicInfo = parsePanicOutput({
      input,
      target,
    })
  } else {
    panicInfo = input
  }

  if ('backtraceAddrs' in panicInfo) {
    throw new Error(
      'Unexpectedly received a panic info with backtrace addresses for RISC-V'
    )
  }
  log('panic info', {
    coreId: panicInfo.coreId,
    programCounter: panicInfo.programCounter,
    faultAddr: panicInfo.faultAddr,
    faultCode: panicInfo.faultCode,
  })

  const includeFrameVars = shouldIncludeFrameVars(options)
  const [stacktraceLines, [programCounter, faultAdd], globals] =
    await Promise.all([
      processPanicOutput(params, panicInfo, options, log),
      addr2line(
        params,
        [panicInfo.programCounter, panicInfo.faultAddr],
        options
      ),
      includeFrameVars
        ? resolveGlobalSymbols(params, options)
        : Promise.resolve([]),
    ])
  if (!includeFrameVars) {
    log('skip globals/locals (includeFrameVars=false)')
  }
  log('addr2line done', { programCounter, faultAdd })
  log('globals count', globals.length)
  stacktraceLines.forEach((line, index) => {
    log('stacktrace line', index, line)
  })

  return createDecodeResult(
    panicInfo,
    programCounter,
    faultAdd,
    stacktraceLines,
    globals
  )
}

/** (non-API) */
export const __tests = /** @type {const} */ ({
  createRegNameValidator,
  parsePanicOutput,
  buildPanicServerArgs,
  processPanicOutput,
  parseMiFrames,
  parseMiStackArgs,
  parseMiLocals,
  toParsedFrame,
  toHexString,
  parseGDBOutput: parseLines,
  getStackAddrAndData,
  gdbRegsInfoRiscvIlp32,
  gdbRegsInfo,
  createDecodeResult,
})
