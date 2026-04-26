// @ts-check

/**
 * @param {string} input
 * @returns {import('./decode.js').PanicInfoWithBacktrace}
 */
export function parseESP8266PanicOutput(input) {
  const lines = input.split(/\r?\n|\r/)
  /** @type {Record<string, number>} */
  const regs = {}
  const coreId = 0
  /** @type {number[]} */
  const backtraceAddrs = []
  /** @type {number | undefined} */
  let faultCode
  /** @type {number | undefined} */
  let faultAddr

  const regLine = input.match(/Exception\s+\((\d+)\)/)
  if (regLine) {
    faultCode = parseInt(regLine[1], 10)
  }

  for (const line of lines) {
    const epcMatches = line.matchAll(
      /(epc\d+|excvaddr|depc)=(0x[0-9a-fA-F]{8})/g
    )
    for (const match of epcMatches) {
      const [, reg, hex] = match
      regs[reg.toUpperCase()] = parseInt(hex, 16)
      if (reg.toLowerCase() === 'excvaddr') {
        faultAddr = parseInt(hex, 16)
      }
    }

    // Example line: 3fff10b0:  4021a5d4 00000033 3fff20dc 40201ed3
    const stackMatch = line.match(/^\s*[0-9a-f]{8}:\s+((?:[0-9a-f]{8}\s*)+)/i)
    if (stackMatch) {
      const words = stackMatch[1].trim().split(/\s+/)
      for (const word of words) {
        const addr = parseInt(word, 16)
        if (!Number.isNaN(addr) && addr & 0x40000000) {
          backtraceAddrs.push(addr)
        }
      }
    }
  }

  return {
    coreId,
    regs,
    backtraceAddrs,
    faultCode,
    faultAddr,
    programCounter: regs.EPC1,
  }
}

/**
 * @param {string} input
 * @returns {import('./decode.js').PanicInfoWithBacktrace}
 */
export function parseESP32PanicOutput(input) {
  const lines = input.split(/\r?\n|\r/)
  /** @type {Record<string, number>} */
  const regs = {}
  let coreId = 0
  /** @type {number[]} */
  const backtraceAddrs = []
  const coreIdMatch = input.match(/Guru Meditation Error: Core\s+(\d+)/)
  if (coreIdMatch) {
    coreId = parseInt(coreIdMatch[1], 10)
  }

  const regRegex = /([A-Z]+[0-9]*)\s*:\s*(0x[0-9a-fA-F]+)/g
  for (const line of lines) {
    for (const match of line.matchAll(regRegex)) {
      const [, regName, hexValue] = match
      const value = parseInt(hexValue, 16)
      if (!Number.isNaN(value)) {
        regs[regName] = value
      }
    }

    if (line.startsWith('Backtrace:')) {
      const matches = Array.from(line.matchAll(/0x[0-9a-fA-F]{8}/g))
      for (const match of matches) {
        const addr = parseInt(match[0], 16)
        if (!Number.isNaN(addr)) {
          backtraceAddrs.push(addr)
        }
      }
    }
  }

  return {
    coreId,
    regs,
    backtraceAddrs,
    faultCode: regs.EXCCAUSE,
    faultAddr: regs.EXCVADDR,
    programCounter: regs.PC,
  }
}
