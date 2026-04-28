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
    this.gdb.on('error', (err) =>
      this._terminate(err instanceof Error ? err : new Error(String(err)))
    )
    this.gdb.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        const exitErr = new Error(
          `GDB exited unexpectedly (code=${code}, signal=${signal})`
        )
        console.warn(exitErr.message)
        this._terminate(exitErr)
      }
    })
  }

  /**
   * Mark the session as terminally failed and reject the in-flight command
   * plus every queued command with the given error so callers don't hang.
   *
   * @param {Error} err
   */
  _terminate(err) {
    if (!this.error) {
      this.error = err
    }
    if (this.current) {
      const { reject } = this.current
      this.current = null
      reject(this.error)
    }
    /** @type {CommandQueueItem | undefined} */
    let item
    while ((item = this.queue.shift())) {
      item.reject(this.error)
    }
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
      const cleanup = () => {
        this.gdb.off('error', onError)
        this.gdb.stdout.off('data', onData)
        this.gdb.stderr.off('data', onData)
      }

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
        cleanup()
        reject(userError)
      }

      const onData = () => {
        // The constructor's _onData listener has already appended the chunk
        // to this.buffer. Inspect it (do not re-append) and only consume the
        // initial GDB banner prompt here.

        // ELF is not found
        if (
          !this.didExecuteFirstCommand &&
          this.buffer.includes(noSuchFileOrDirectory)
        ) {
          if (!this.error) {
            this.error = new Error(
              `The ELF file does not exist or is not readable: ${this.elfPath}`
            )
            cleanup()
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
            cleanup()
            reject(this.error)
          }
          return
        }

        const idx = this.buffer.indexOf(prompt)
        if (idx !== -1) {
          this.buffer = this.buffer.slice(idx + prompt.length)
          cleanup()
          resolve('')
        }
      }
      this.gdb.on('error', onError)
      this.gdb.stdout.on('data', onData)
      this.gdb.stderr.on('data', onData)
      // Process any data already buffered by the constructor's _onData
      onData()
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
    if (typeof addr === 'object' && addr !== null) {
      const a = addr.addr
      if (typeof a === 'string') {
        addrNumber = parseInt(a, 16)
      } else if (typeof a === 'number') {
        addrNumber = a
      }
    } else if (typeof addr === 'number') {
      addrNumber = addr
    }
    if (addrNumber !== undefined && !Number.isNaN(addrNumber) && !dedupedAddrs.has(addrNumber)) {
      dedupedAddrs.add(addrNumber)
    }
  }
  return Array.from(dedupedAddrs.values())
}

/**
 * @param {Pick<DecodeParams, 'elfPath' | 'toolPath'>} params
 * @param {(number | AddrLine | undefined)[]} addrs
 * @param {DecodeOptions} [options={}] Default is `{}`
 * @returns {Promise<(AddrLine | undefined)[]>}
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
    if (addr === undefined) {
      return undefined
    }
    return results.get(addr)
  })
}
