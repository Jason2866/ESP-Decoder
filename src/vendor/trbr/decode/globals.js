// @ts-check

import { GdbMiClient, extractMiListContent, parseMiTupleList } from './gdbMi.js'

/** @typedef {import('./decode.js').DecodeParams} DecodeParams */
/** @typedef {import('./decode.js').DecodeOptions} DecodeOptions */
/** @typedef {import('./decode.js').FrameVar} FrameVar */
/** @typedef {import('./decode.js').Debug} Debug */

const envDebugEnabled = process.env.TRBR_DEBUG === 'true'
const allowInfoFallback =
  process.env.TRBR_GLOBALS_ALLOW_INFO_VARIABLES === 'true'
const miErrorPattern = /^\^error/m
const miUnsupportedPattern = /code="undefined-command"/
const globalsLogPrefix = '[trbr][globals]'
const defaultGlobalsTimeoutMs = 20_000
const xtensaLx106ToolHint = 'xtensa-lx106-elf-gdb'

/**
 * @param {Debug | undefined} debug
 * @returns {Debug}
 */
function createGlobalsLogger(debug) {
  const writer = debug ?? (envDebugEnabled ? console.log : undefined)
  return writer ? (...args) => writer(globalsLogPrefix, ...args) : () => {}
}

/** @returns {number} */
function getGlobalsTimeoutMs() {
  const raw = process.env.TRBR_GLOBALS_TIMEOUT_MS
  if (!raw) {
    return defaultGlobalsTimeoutMs
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : defaultGlobalsTimeoutMs
}

/**
 * @param {Pick<DecodeParams, 'toolPath' | 'elfPath'> & {
 *   coredumpMode?: boolean
 * }} params
 * @returns {boolean}
 */
function shouldAllowInfoFallback(params) {
  if (allowInfoFallback) {
    return true
  }
  return Boolean(params.coredumpMode)
}

/**
 * @param {string} value
 * @returns {string}
 */
function unescapeMiString(value) {
  return value
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
}

/**
 * @param {string} raw
 * @returns {string}
 */
function extractMiConsoleText(raw) {
  let text = ''
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^~"(.*)"$/)
    if (!match) {
      continue
    }
    text += unescapeMiString(match[1])
  }
  return text
}

/**
 * @param {string} line
 * @returns {{ name: string; type?: string; address?: string } | undefined}
 */
function parseVariableLine(line) {
  const trimmed = line.trim()
  if (!trimmed) {
    return undefined
  }

  const addrMatch = trimmed.match(/^(0x[0-9a-fA-F]+)\s+(.+)$/)
  if (addrMatch) {
    return { address: addrMatch[1], name: addrMatch[2].trim() }
  }

  const sanitized = trimmed.endsWith(';')
    ? trimmed.slice(0, -1).trim()
    : trimmed
  const lastSpace = sanitized.lastIndexOf(' ')
  if (lastSpace === -1) {
    return undefined
  }

  let rawName = sanitized.slice(lastSpace + 1).trim()
  let type = sanitized.slice(0, lastSpace).trim()
  if (!rawName) {
    return undefined
  }

  const pointerPrefix = rawName.match(/^[*&]+/)
  if (pointerPrefix) {
    rawName = rawName.slice(pointerPrefix[0].length)
    type = `${type} ${pointerPrefix[0]}`.trim()
  }

  const arrayMatch = rawName.match(/^(.*)(\[[^\]]+\])$/)
  if (arrayMatch) {
    rawName = arrayMatch[1]
    type = `${type} ${arrayMatch[2]}`.trim()
  }

  if (!rawName) {
    return undefined
  }

  return { name: rawName, type }
}

/**
 * @param {string} consoleText
 * @returns {FrameVar[]}
 */
function parseInfoVariables(consoleText) {
  /** @type {FrameVar[]} */
  const vars = []
  for (const line of consoleText.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (
      !trimmed ||
      trimmed.endsWith(':') ||
      trimmed.startsWith('All defined variables') ||
      trimmed.startsWith('File ') ||
      trimmed.startsWith('Non-debugging symbols')
    ) {
      continue
    }

    const parsed = parseVariableLine(trimmed)
    if (!parsed?.name) {
      continue
    }

    vars.push({
      scope: 'global',
      name: parsed.name,
      type: parsed.type,
      address: parsed.address,
    })
  }
  return vars
}

/**
 * @param {Record<string, string>} tuple
 * @returns {FrameVar | undefined}
 */
function toGlobalVar(tuple) {
  if (!tuple.name) {
    return undefined
  }
  /** @type {FrameVar} */
  const variable = { scope: 'global', name: tuple.name }
  if (tuple.type) {
    variable.type = tuple.type
  }
  if (tuple.addr || tuple.address) {
    variable.address = tuple.addr || tuple.address
  }
  return variable
}

/**
 * @param {GdbMiClient} client
 * @param {string} flag
 * @returns {Promise<FrameVar[] | null | undefined>}
 */
async function tryMiSymbolList(client, flag) {
  const raw = await client.sendCommand(`-symbol-list-variables ${flag}`)
  if (miErrorPattern.test(raw)) {
    if (miUnsupportedPattern.test(raw)) {
      return null
    }
    return undefined
  }

  const listContent = extractMiListContent(raw, 'variables')
  if (listContent === undefined) {
    return []
  }

  return /** @type {FrameVar[]} */ (
    parseMiTupleList(listContent)
      .map(toGlobalVar)
      .filter((value) => Boolean(value))
  )
}

/**
 * @param {FrameVar[]} vars
 * @returns {FrameVar[]}
 */
function dedupeGlobals(vars) {
  /** @type {Map<string, FrameVar>} */
  const map = new Map()
  for (const variable of vars) {
    if (!variable.name) {
      continue
    }
    const existing = map.get(variable.name)
    if (!existing) {
      map.set(variable.name, variable)
      continue
    }
    if (!existing.address && variable.address) {
      map.set(variable.name, { ...existing, ...variable })
      continue
    }
    if (!existing.type && variable.type) {
      map.set(variable.name, { ...existing, ...variable })
    }
  }
  return Array.from(map.values())
}

/**
 * @param {Pick<DecodeParams, 'toolPath' | 'elfPath'> & {
 *   coredumpMode?: boolean
 * }} params
 * @param {DecodeOptions} [options={}] Default is `{}`
 * @returns {Promise<FrameVar[]>}
 */
export async function listGlobalSymbols(params, options = {}) {
  const { toolPath, elfPath } = params
  const allowInfo = shouldAllowInfoFallback(params)
  const log = createGlobalsLogger(options.debug)
  log('start', { toolPath, elfPath })
  const client = new GdbMiClient(
    toolPath,
    ['--interpreter=mi2', '-n', elfPath],
    options
  )

  try {
    await client.drainHandshake()

    const globalVars = await tryMiSymbolList(client, '--global')
    const staticVars = await tryMiSymbolList(client, '--static')
    log('mi globals', globalVars ? globalVars.length : undefined)
    log('mi statics', staticVars ? staticVars.length : undefined)
    const miUnsupported = globalVars === null || staticVars === null

    let combined = [...(globalVars ?? []), ...(staticVars ?? [])]

    if (!combined.length && miUnsupported && !allowInfo) {
      log('skip info variables fallback', { reason: 'mi-unsupported' })
      return []
    }

    if (!combined.length) {
      log('fallback to info variables')
      const infoRaw = await client.sendCommand(
        '-interpreter-exec console "info variables"'
      )
      combined = parseInfoVariables(extractMiConsoleText(infoRaw))
      log('info variables count', combined.length)
    }

    const deduped = dedupeGlobals(combined)
    log('done', deduped.length)
    return deduped
  } finally {
    client.close()
  }
}

/**
 * @param {Pick<DecodeParams, 'toolPath' | 'elfPath'>} params
 * @param {DecodeOptions} [options={}] Default is `{}`
 * @returns {Promise<FrameVar[]>}
 */
export async function resolveGlobalSymbols(params, options = {}) {
  const log = createGlobalsLogger(options.debug)
  try {
    if (params.toolPath.includes(xtensaLx106ToolHint)) {
      log('skip globals for xtensa-lx106 gdb', params)
      return []
    }

    const timeoutMs = getGlobalsTimeoutMs()
    const controller = new AbortController()
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    const onAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort()
      }
    }
    options.signal?.addEventListener('abort', onAbort)

    log('resolve start', { timeoutMs })
    try {
      return await listGlobalSymbols(params, {
        ...options,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
      options.signal?.removeEventListener('abort', onAbort)
      if (timedOut) {
        log('resolve timeout', timeoutMs)
      }
    }
  } catch (err) {
    log('resolve error', err)
    if (options.debug) {
      options.debug('Failed to list global symbols:', err)
    }
    return []
  }
}
