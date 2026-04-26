// @ts-check

/** @typedef {import('../tool.js').RiscvTargetArch} RiscvTargetArch */

const defaultRiscvTarget = /** @type {const} */ ('esp32c3')

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
  'MEPC',
])

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
 * @property {RiscvTargetArch} [target]
 */

/**
 * @typedef {Object} ParsePanicOutputResult
 * @property {RegisterDump[]} regDumps
 * @property {StackDump[]} stackDump
 * @property {number} programCounter
 * @property {number} [faultCode]
 * @property {number} [faultAddr]
 */

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

  const regNameValidator = createRegNameValidator(target ?? defaultRiscvTarget)

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
            programCounter = regAddr
          }
        } else if (regName === 'MCAUSE') {
          faultCode = regAddr
        } else if (regName === 'MTVAL') {
          faultAddr = regAddr
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
 * @param {GetStackAddrAndDataParams} params
 * @returns {{ stackBaseAddr: number; stackData: Buffer }}
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
    } else if (baseAddr !== prevBaseAddr + bytesInLine) {
      throw new Error('Invalid base address')
    }

    const lineData = Buffer.concat(
      line.data.map((word) => {
        const buf = Buffer.alloc(4)
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
 * @param {{ input: string; target?: RiscvTargetArch }} params
 * @returns {import('./decode.js').PanicInfoWithStackData}
 */
export function parseRiscvPanicOutput({ input, target }) {
  const resolvedTarget = target ?? defaultRiscvTarget
  const { regDumps, stackDump, programCounter, faultAddr, faultCode } = parse({
    input,
    target: resolvedTarget,
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
    target: resolvedTarget,
  }
}
