// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { GdbMiClient, extractMiListContent } from './gdbMi.js'
import { resolveGlobalSymbols } from './globals.js'
import { toHexString } from './regs.js'

/** @typedef {import('./decode.js').Debug} Debug */

const coredumpLogPrefix = '[trbr][coredump]'

/**
 * @param {Debug | undefined} debug
 * @returns {Debug}
 */
function createCoredumpLogger(debug) {
  const writer =
    debug ?? (process.env.TRBR_DEBUG === 'true' ? console.log : undefined)
  return writer ? (...args) => writer(coredumpLogPrefix, ...args) : () => {}
}

/** @typedef {import('./decode.js').DecodeResult} DecodeResult */
/** @typedef {import('./decode.js').DecodeInputFileSource} DecodeInputFileSource */
/** @typedef {import('./decode.js').FrameArg} FrameArg */
/** @typedef {import('./decodeParams.js').DecodeCoredumpParams} DecodeCoredumpParams */

/**
 * Attempt to extract an embedded ELF from a raw ESP32 flash dump.
 *
 * @param {DecodeCoredumpParams} params
 * @param {Buffer} raw
 * @param {import('./decode.js').DecodeOptions} [options={}] Default is `{}`
 * @returns {Promise<CoredumpDecodeResult | undefined>}
 */
async function tryRawElfFallback(params, raw, options) {
  const expectedMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
  const offset = raw.indexOf(expectedMagic)
  if (offset !== -1) {
    // Estimate the total ELF size using program headers
    const e_phoff = raw.readUInt32LE(offset + 28)
    const e_phentsize = raw.readUInt16LE(offset + 42)
    const e_phnum = raw.readUInt16LE(offset + 44)
    const maxEnd = (() => {
      let max = 0
      for (let i = 0; i < e_phnum; i++) {
        const entryOffset = offset + e_phoff + i * e_phentsize
        const p_offset = raw.readUInt32LE(entryOffset + 4)
        const p_filesz = raw.readUInt32LE(entryOffset + 16)
        const end = p_offset + p_filesz
        if (end > max) {
          max = end
        }
      }
      return max
    })()
    const elfTotalSize = maxEnd
    if (raw.length >= offset + elfTotalSize) {
      const elfBuffer = raw.subarray(offset, offset + elfTotalSize)
      const tmpDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'trbr-'))
      const extractedElfPath = path.join(tmpDirPath, 'extracted.elf')
      await fs.writeFile(extractedElfPath, elfBuffer)
      try {
        const result = await decodeCoredump(
          {
            ...params,
          },
          { inputPath: extractedElfPath },
          options,
          false
        )
        return result
      } finally {
        await fs
          .rm(tmpDirPath, { recursive: true, force: true })
          .catch((err) => console.warn('Failed to clean up temp dir:', err))
      }
    }
  }
  return undefined
}

/**
 * @typedef {Object} ThreadDecodeResult
 * @property {string} threadId
 * @property {number} TCB
 * @property {string} [threadName]
 * @property {DecodeResult} result
 * @property {boolean} [current]
 */

/** @typedef {ThreadDecodeResult[]} CoredumpDecodeResult */

/**
 * Parses register values from MI output or "info registers" raw output.
 *
 * @param {string} regsRaw
 * @returns {Record<string, string>}
 */
function parseRegisters(regsRaw) {
  /** @type {Record<string, string>} */
  const result = {}

  // Try MI-style first: match optional frame-prefix then register-values
  const miMatch = regsRaw.match(
    /(?:frame=\{[^}]*\},)?register-values=\[([^\]]*)\]/
  )
  if (miMatch) {
    const inner = miMatch[1]
    const regex = /\{number="(\d+)",value="(0x[a-fA-F0-9]+)"\}/g
    for (const m of inner.matchAll(regex)) {
      result[m[1]] = m[2]
    }
    return result
  }

  // Try "info registers" style as fallback
  const lines = regsRaw.split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^~?"?(\w+)\s+(0x[a-fA-F0-9]+)\b/)
    if (match) {
      const [, name, value] = match
      result[name] = value
    }
  }

  return result
}

/**
 * @param {string} raw
 * @returns {Record<string, string>[]}
 */
function parseBacktrace(raw) {
  const entries = [...raw.matchAll(/frame=\{([^}]+)\}/g)].map((match) => {
    /** @type {Record<string, string>} */
    const obj = {}
    for (const pair of match[1].split(',')) {
      const [key, val] = pair.split('=')
      obj[key] = val?.startsWith('"') ? val.slice(1, -1) : val
    }
    return obj
  })
  return entries
}

/**
 * @param {string} str
 * @param {string} key
 * @returns {string | undefined}
 */
/**
 * @param {DecodeCoredumpParams} params
 * @param {DecodeInputFileSource} input
 * @param {boolean} [tryRepair]
 * @param {import('./decode.js').DecodeOptions} [options={}] Default is `{}`
 * @returns {Promise<CoredumpDecodeResult>}
 */
export async function decodeCoredump(
  params,
  input,
  options = {},
  tryRepair = true
) {
  const { elfPath, toolPath } = params
  const { inputPath } = input
  const log = createCoredumpLogger(options.debug)
  log('start', { toolPath, elfPath, inputPath })
  const client = new GdbMiClient(
    toolPath,
    ['--interpreter=mi2', '-c', inputPath, elfPath],
    options
  )
  /** @type {ThreadDecodeResult[]} */
  const results = []

  try {
    // Use -thread-info for a more reliable MI listing of threads
    await client.drainHandshake()
    const globals = await resolveGlobalSymbols(params, options)
    log('globals count', globals.length)

    const threadsRaw = await client.sendCommand('-thread-info')
    log('thread-info raw length', threadsRaw.length)

    const currentThreadMatch = threadsRaw.match(/current-thread-id="(\d+)"/)
    const currentThreadId = currentThreadMatch ? currentThreadMatch[1] : null

    // Extract the contents of the top-level threads=[ ... ] block, handling nested brackets
    const threadsContent = extractMiListContent(threadsRaw, 'threads')
    /** @type {[string, string][]} */
    const threadEntries = []
    if (threadsContent) {
      // Split into individual thread objects by balanced braces
      const objs = []
      let depth = 0
      let objStart = -1
      for (let i = 0; i < threadsContent.length; i++) {
        const ch = threadsContent[i]
        if (ch === '{') {
          if (depth === 0) {
            objStart = i
          }
          depth++
        } else if (ch === '}') {
          depth--
          if (depth === 0 && objStart >= 0) {
            objs.push(threadsContent.slice(objStart, i + 1))
          }
        }
      }
      // Extract id and TCB (target-id) from each object
      for (const objStr of objs) {
        const m = /id="([^"]+)"\s*,\s*target-id="process\s+(\d+)"/.exec(objStr)
        if (m) {
          threadEntries.push([m[1], m[2]])
        }
      }
    }
    const threadIds = threadEntries.map(([id]) => id)
    const threadTcbs = Object.fromEntries(
      threadEntries.map(([id, tcb]) => [id, Number(tcb)])
    )
    log('threads parsed', { threadIds, threadTcbs })

    for (const tid of threadIds) {
      log('select thread', tid)
      await client.sendCommand(`-thread-select ${tid}`)

      const regNamesRaw = await client.sendCommand('-data-list-register-names')
      const regNameMatch = regNamesRaw.match(/register-names=\[(.*?)\]/)
      const regNames = regNameMatch
        ? regNameMatch[1]
            .split(',')
            .map((s) => s.trim().replace(/^"|"$/g, ''))
            .map((name, i) => [i.toString(), name])
            .filter(([, name]) => !!name)
        : []
      const regNameMap = Object.fromEntries(regNames)

      const regsOut = await client.sendCommand('-data-list-register-values x')
      const parsedRegs = parseRegisters(regsOut)

      const regsAsNamed = Object.fromEntries(
        Object.entries(parsedRegs)
          .map(([num, val]) => [regNameMap[num], Number(val)])
          .filter(([name]) => !!name)
      )
      log('regs', tid, Object.keys(regsAsNamed))

      const programCounter = regsAsNamed['pc']

      const btOut = await client.sendCommand('-stack-list-frames')
      log('stack frames raw length', btOut.length)

      const argsOut = await client.sendCommand(
        '-stack-list-arguments --simple-values 0 100'
      )
      log('stack args raw length', argsOut.length)
      // Parse frame arguments safely, splitting on top-level frame boundaries
      const argsListMatch = argsOut.match(/stack-args=\[([\s\S]*)\]/)
      /** @type {{ level?: string; args: FrameArg[] }[]} */
      let frameArgs = []
      if (argsListMatch) {
        const content = argsListMatch[1]
        // Split on '},frame={' to avoid inner brace conflicts
        const parts = content.split(/},\s*frame=\{/).map((part, idx) => {
          if (idx === 0) {
            return part + '}'
          }
          return 'frame={' + part + '}'
        })
        frameArgs = parts.map((frameStr) => {
          const rawMatch = frameStr.match(/frame=\{([\s\S]*)\}/)
          const raw = rawMatch ? rawMatch[1] : ''
          /** @type {{ level?: string; args: FrameArg[] }} */
          const obj = { args: [] }
          // extract frame level
          const levelMatch = raw.match(/level="(\d+)"/)
          if (levelMatch) {
            obj.level = levelMatch[1]
          }
          // extract args array content
          const argsMatchInner = raw.match(/args=\[([\s\S]*)\]/)
          if (argsMatchInner && argsMatchInner[1].trim()) {
            const argsContent = argsMatchInner[1]
            const argRegex =
              /\{name="([^"]+)",type="([^"]+)",value="([^"]+)"\}/g
            let m
            while ((m = argRegex.exec(argsContent))) {
              obj.args.push({ name: m[1], type: m[2], value: m[3] })
            }
          }
          return obj
        })
      } else {
        frameArgs = []
      }

      const btParsed = parseBacktrace(btOut)
      const stacktraceLines = btParsed.map((frame, index) => {
        const args = frameArgs[index]?.args || ''
        return {
          regAddr: frame.addr,
          lineNumber: frame.line ?? '??',
          ...(frame.func && frame.file
            ? { method: frame.func, file: frame.file, args }
            : {}),
        }
      })
      log('stacktrace lines', tid, stacktraceLines.length)

      results.push({
        threadId: tid,
        TCB: threadTcbs[tid],
        result: {
          faultInfo: {
            coreId: parseInt(tid),
            programCounter: {
              addr: programCounter,
              location: stacktraceLines[0] ?? {
                regAddr: toHexString(programCounter),
                lineNumber: '??',
              },
            },
            faultCode: undefined, // Xtensa includes exccause, but the RISC-V variant does not include mcause, mtval, etc.
          },
          regs: regsAsNamed,
          stacktraceLines,
          globals,
        },
        current: tid === currentThreadId,
      })
    }
  } finally {
    client.close()
  }

  if (!results.length && tryRepair) {
    const raw = await fs.readFile(input.inputPath)
    const fallback = await tryRawElfFallback(params, raw)
    if (fallback) {
      return fallback
    }
  }

  return results
}
