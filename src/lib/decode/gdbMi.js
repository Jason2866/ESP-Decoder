// @ts-check

import cp from 'node:child_process'

import { AbortError } from '../abort.js'

let clientSeq = 0

/**
 * @param {number} id
 * @param {import('./decode.js').Debug | undefined} debug
 * @returns {(...args: unknown[]) => void}
 */
function createLogger(id, debug) {
  const prefix = `[trbr][gdb-mi:${id}]`
  const writer =
    debug ?? (process.env.TRBR_DEBUG === 'true' ? console.log : undefined)
  return writer ? (...args) => writer(prefix, ...args) : () => {}
}

/**
 * @param {string} text
 * @param {number} [limit=400] Default is `400`
 * @returns {string}
 */
function preview(text, limit = 400) {
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`
}

/** Minimal GDB MI client for queueing commands and reading result records. */
export class GdbMiClient {
  /**
   * @param {string} gdbPath
   * @param {string[]} args
   * @param {import('./decode.js').DecodeOptions} [options={}] Default is `{}`
   */
  constructor(gdbPath, args, options = {}) {
    this.cp = cp.spawn(gdbPath, args, { stdio: 'pipe', signal: options.signal })
    this.id = ++clientSeq
    this.log = createLogger(this.id, options.debug)
    this.log('spawn', gdbPath, args.join(' '))
    /** @type {Error | undefined} */
    this.error = undefined
    /**
     * @type {{
     *   resolve: (value: string) => void
     *   reject: (err: Error) => void
     *   command: string
     *   startedAt: number
     * }[]}
     */
    this.commandQueue = []

    this.signal = options.signal
    if (this.signal) {
      this.signal.addEventListener('abort', () => {
        const abortErr = new AbortError()
        this.error = abortErr
        this.log('abort signal received')
        this.commandQueue.forEach((executor) => executor.reject(abortErr))
        this.commandQueue = []
      })
    }

    this.stdoutBuffer = ''
    this.cp.stdout.on('data', (chunk) => this._onData(chunk))
    this.cp.stderr.on('data', (chunk) => this._onData(chunk))
    this.cp.on('error', (err) => {
      this.error = err
      this.log('process error', err)
      this.commandQueue.forEach((executor) => executor.reject(err))
      this.commandQueue = []
    })
    this.cp.on('exit', (code, signal) => {
      this.log('process exit', { code, signal })
    })
  }

  /**
   * @param {string} command
   * @returns {Promise<string>}
   */
  sendCommand(command) {
    if (this.error) {
      return Promise.reject(this.error)
    }
    this.log('send', command)
    return new Promise((resolve, reject) => {
      const executor = { resolve, reject, command, startedAt: Date.now() }
      this.commandQueue.push(executor)
      this.cp.stdin.write(`${command}\n`)
    })
  }

  /** @param {Buffer} chunk */
  _onData(chunk) {
    if (this.error) {
      const error = this.error
      this.commandQueue.forEach((executor) => executor.reject(error))
      this.commandQueue = []
    }

    this.stdoutBuffer += chunk.toString()
    if (/\(gdb\)\s*$/m.test(this.stdoutBuffer)) {
      const output = this.stdoutBuffer
      this.stdoutBuffer = ''
      const executor = this.commandQueue.shift()
      if (executor) {
        const elapsed = Date.now() - executor.startedAt
        this.log('recv', `${executor.command} (${elapsed}ms)`, preview(output))
      } else {
        this.log('recv without queued command', preview(output))
      }
      executor?.resolve(output)
    }
  }

  close() {
    this.log('close')
    this.cp.stdin.end()
    this.cp.kill()
  }

  /** @returns {Promise<void>} */
  async drainHandshake() {
    this.log('handshake start')
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const onData = (/** @type {Buffer} */ chunk) => {
        if (this.error) {
          this.cp.stdout.off('data', onData)
          this.log('handshake error', this.error)
          reject(this.error)
          return
        }
        this.stdoutBuffer += chunk.toString()
        if (/\(gdb\)\s*$/m.test(this.stdoutBuffer)) {
          this.cp.stdout.off('data', onData)
          if (this.signal) {
            this.signal.removeEventListener('abort', onAbort)
          }
          this.stdoutBuffer = ''
          this.log('handshake done', `${Date.now() - startedAt}ms`)
          resolve()
        }
      }
      const onAbort = () => {
        this.cp.stdout.off('data', onData)
        this.signal?.removeEventListener('abort', onAbort)
        this.log('handshake aborted')
        reject(new AbortError())
      }
      this.cp.stdout.on('data', onData)
      this.signal?.addEventListener('abort', onAbort)
    })
  }
}

/**
 * @param {string} str
 * @param {string} key
 * @returns {string | undefined}
 */
export function extractMiListContent(str, key) {
  const keyPattern = `${key}=[`
  const idx = str.indexOf(keyPattern)
  if (idx < 0) {
    return undefined
  }
  const start = str.indexOf('[', idx)
  if (start < 0) {
    return undefined
  }
  let depth = 0
  for (let i = start; i < str.length; i++) {
    const c = str[i]
    if (c === '[') {
      depth++
    } else if (c === ']') {
      depth--
      if (depth === 0) {
        return str.substring(start + 1, i)
      }
    }
  }
  return undefined
}

/**
 * @param {string} listContent
 * @returns {string[]}
 */
function splitMiListItems(listContent) {
  const items = []
  let current = ''
  let depth = 0
  let inQuotes = false
  let escape = false

  for (const char of listContent) {
    if (escape) {
      current += char
      escape = false
      continue
    }

    if (inQuotes && char === '\\') {
      current += char
      escape = true
      continue
    }

    if (char === '"') {
      inQuotes = !inQuotes
      current += char
      continue
    }

    if (!inQuotes) {
      if (char === '{' || char === '[') {
        depth++
      } else if (char === '}' || char === ']') {
        depth = Math.max(0, depth - 1)
      } else if (char === ',' && depth === 0) {
        if (current.trim()) {
          items.push(current.trim())
        }
        current = ''
        continue
      }
    }

    current += char
  }

  if (current.trim()) {
    items.push(current.trim())
  }

  return items
}

/**
 * @param {string} value
 * @returns {string}
 */
function unescapeMiString(value) {
  let result = ''

  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char !== '\\') {
      result += char
      continue
    }

    const next = value[i + 1]
    if (!next) {
      result += '\\'
      continue
    }
    i++

    switch (next) {
      case '\\':
        result += '\\'
        break
      case '"':
        result += '"'
        break
      case 'n':
        result += '\n'
        break
      case 'r':
        result += '\r'
        break
      case 't':
        result += '\t'
        break
      default:
        result += next
        break
    }
  }

  return result
}

/**
 * @param {string} tupleContent
 * @returns {Record<string, string>}
 */
function parseMiTuple(tupleContent) {
  /** @type {Record<string, string>} */
  const result = {}
  for (const field of splitMiListItems(tupleContent)) {
    const idx = field.indexOf('=')
    if (idx === -1) {
      continue
    }
    const key = field.slice(0, idx).trim()
    const rawValue = field.slice(idx + 1).trim()
    const value =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? unescapeMiString(rawValue.slice(1, -1))
        : rawValue
    result[key] = value
  }
  return result
}

/**
 * @param {string} raw
 * @returns {Record<string, string>}
 */
export function parseMiResultRecord(raw) {
  const match = raw.match(/(?:^|\n)\d*\^done(?:,([^\r\n]*))?/)
  if (!match) {
    return {}
  }
  const content = (match[1] ?? '').trim()
  if (!content) {
    return {}
  }
  return parseMiTuple(content)
}

/**
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
export function stripMiList(value) {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1)
  }
  return undefined
}

/**
 * @param {string | undefined} listContent
 * @param {string} [tupleKey]
 * @returns {Record<string, string>[]}
 */
export function parseMiTupleList(listContent, tupleKey) {
  if (!listContent) {
    return []
  }
  const items = splitMiListItems(listContent)
  /** @type {Record<string, string>[]} */
  const tuples = []

  for (const item of items) {
    const trimmed = item.trim()
    let tupleBody
    if (tupleKey) {
      const prefix = `${tupleKey}={`
      if (!trimmed.startsWith(prefix) || !trimmed.endsWith('}')) {
        continue
      }
      tupleBody = trimmed.slice(prefix.length, -1)
    } else {
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        continue
      }
      tupleBody = trimmed.slice(1, -1)
    }
    tuples.push(parseMiTuple(tupleBody))
  }

  return tuples
}
