// @ts-check

import { spawn } from 'node:child_process'

import { isParsedGDBLine } from './decode.js'
import { parseLines } from './regAddr.js'
import { toHexString } from './regs.js'

/**
 * @typedef {Object} CommandQueueItem
 * @property {string} cmd
 * @property {(result: string) => void} resolve
 * @property {(reason: unknown) => void} reject
 */

const prompt = '(gdb)'
const notExecutableFormat = 'not in executable format'
const fileFormatNotRecognized = 'file format not recognized'
const noSuchFileOrDirectory = 'No such file or directory'

class GDBSession {
  /**
   * @param {Pick<DecodeParams, 'elfPath' | 'toolPath'>} params
   * @param {DecodeOptions} [options={}] Default is `{}`
   */
  constructor({ toolPath, elfPath }, options = {}) {
    this.toolPath = toolPath
    this.elfPath = elfPath
    this.error = null
    this.didExecuteFirstCommand = false
    this.gdb = spawn(toolPath, [elfPath], {
      stdio: 'pipe',
      signal: options.signal,
    })
    this.buffer = ''
    /** @type {CommandQueueItem[]} */
    this.queue = []
    this.current = null
    this.gdb.stdout.on('data', (chunk) => this._onData(chunk))
    this.gdb.stderr.on('data', (chunk) => this._onData(chunk))
    this.gdb.on('error', (err) => this.current?.reject(err))
    this.gdb.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        console.warn(`GDB exited with code ${code} or signal ${signal}`)
      }
    })
  }

  /** @param {Buffer} chunk */
  _onData(chunk) {
    this.buffer += chunk.toString()
    if (!this.current) {
      return
    }
    const idx = this.buffer.indexOf(prompt)
    if (idx === -1) {
      return
    }
    const output = this.buffer.slice(0, idx)
    this.buffer = this.buffer.slice(idx + prompt.length)
    const { resolve } = this.current
    this.current = null
    resolve(output)
    this._processQueue()
  }

  _processQueue() {
    const item = this.queue.shift()
    if (this.current || !item) {
      return
    }
    const { cmd, resolve, reject } = item
    this.current = { resolve, reject }
    this.gdb.stdin.write(cmd + '\n')
  }

  start() {
    return new Promise((resolve, reject) => {
      // GDB not found
      const onError = (/** @type {Error} */ error) => {
        let userError = error
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          userError = new Error(`GDB tool not found at ${this.toolPath}`)
        }
        reject(userError)
      }

      const onData = (/** @type {Buffer} */ chunk) => {
        // ELF is not found
        if (
          !this.didExecuteFirstCommand &&
          this.buffer.includes(noSuchFileOrDirectory)
        ) {
          if (!this.error) {
            this.error = new Error(
              `The ELF file does not exist or is not readable: ${this.elfPath}`
            )
            reject(this.error)
          }
          return
        }

        // Not an ELF
        if (
          !this.didExecuteFirstCommand &&
          (this.buffer.includes(notExecutableFormat) ||
            this.buffer.includes(fileFormatNotRecognized))
        ) {
          if (!this.error) {
            this.error = new Error(
              `The ELF file is not in executable format: ${this.elfPath}`
            )
            reject(this.error)
          }
          return
        }

        this.buffer += chunk.toString()
        const idx = this.buffer.indexOf(prompt)
        if (idx !== -1) {
          this.buffer = this.buffer.slice(idx + prompt.length)
          resolve('')
        }
      }
      this.gdb.on('error', onError)
      this.gdb.stdout.on('data', onData)
      this.gdb.stderr.on('data', onData)
    })
  }

  /** @param {string} cmd */
  async exec(cmd) {
    if (this.error) {
      this.close()
      return Promise.reject(this.error)
    }
    const result = await new Promise((resolve, reject) => {
      this.queue.push({ cmd, resolve, reject })
      this._processQueue()
    })

    this.didExecuteFirstCommand = true
    return result
  }

  async close() {
    if (!this.gdb.killed) {
      this.gdb.stdin.end()
      this.gdb.kill('SIGTERM')
      if (typeof this.gdb.exitCode !== 'number') {
        await new Promise((resolve) => this.gdb.once('exit', resolve))
      }
    }
  }
}

/** @typedef {import('./decode.js').DecodeParams} DecodeParams */
/** @typedef {import('./decode.js').DecodeOptions} DecodeOptions */
/** @typedef {import('./decode.js').GDBLine} GDBLine */
/** @typedef {import('./decode.js').ParsedGDBLine} ParsedGDBLine */
/** @typedef {import('./decode.js').AddrLine} AddrLine */

/**
 * @param {(number | AddrLine | undefined)[]} addrs
 * @returns {number[]}
 */
function buildAddr2LineAddrs(addrs) {
  /** @type {Set<number>} */
  const dedupedAddrs = new Set()
  for (const addr of addrs) {
    let addrNumber
    if (typeof addr === 'object') {
      addrNumber = addr.addr
    } else if (typeof addr === 'number') {
      addrNumber = addr
    }
    if (addrNumber !== undefined && !dedupedAddrs.has(addrNumber)) {
      dedupedAddrs.add(addrNumber)
    }
  }
  return Array.from(dedupedAddrs.values())
}

/**
 * @typedef {Object} RegsInfo
 * @property {Record<number, Record<string, number>>} threadRegs
 * @property {number} [currentThreadAddr]
 */

/**
 * @param {Pick<DecodeParams, 'elfPath' | 'toolPath'>} params
 * @param {(number | AddrLine | undefined)[]} addrs
 * @param {DecodeOptions} [options={}] Default is `{}`
 * @returns {Promise<AddrLine[]>}
 */
export async function addr2line({ elfPath, toolPath }, addrs, options = {}) {
  const addresses = buildAddr2LineAddrs(addrs)
  if (!addresses.length) {
    throw new Error('No register addresses found to decode')
  }

  const results = new Map()
  const session = new GDBSession({ elfPath, toolPath }, options)

  try {
    await session.start()
    await session.exec('set pagination off')
    await session.exec('set listsize 1')
    for (const addr of addresses) {
      const hex = toHexString(addr)
      const listOutput = await session.exec(`list *${hex}`)
      let parsedLines = parseLines(listOutput, options.debug)
      let location = parsedLines.find(isParsedGDBLine)
      if (!location) {
        const lineOutput = await session.exec(`info line *${hex}`)
        parsedLines = parseLines(lineOutput, options.debug)
        location = parsedLines.find(isParsedGDBLine)
      }
      results.set(addr, {
        addr,
        location: location ?? { regAddr: hex, lineNumber: '??' },
      })
    }
  } finally {
    await session.close()
  }

  return addrs.map((addrOrLine) => {
    const addr = typeof addrOrLine === 'object' ? addrOrLine.addr : addrOrLine
    return results.get(addr) || { location: '??' }
  })
}
