import type { PanicInfoWithBacktrace, PanicInfoWithStackData } from './types';

/**
 * Panic output parsers, modeled on esp-idf-panic-decoder's
 * parse_idf_riscv_panic_output (registers + stack dump) plus the Xtensa
 * formats used by ESP32/ESP32-S2/S3 and ESP8266.
 */

// ---------------------------------------------------------------------------
// Register tables (order matters: it is the GDB remote 'g' packet layout)
// ---------------------------------------------------------------------------

/** Xtensa exception frame order used in ESP-IDF v5 core dumps. */
export const registerSets = {
  xtensa: [
    'PC', 'PS',
    'LBEG', 'LEND', 'LCOUNT', 'SAR',
    'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7',
    'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15',
    'EXCCAUSE', 'EXCVADDR', 'WINDOWBASE', 'WINDOWSTART',
  ],
  // Order matches gdbRegsInfoRiscvIlp32 (source of truth)
  riscv: [
    'X0', 'RA', 'SP', 'GP', 'TP', 'T0', 'T1', 'T2',
    'S0/FP', 'S1', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5',
    'A6', 'A7', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7',
    'S8', 'S9', 'S10', 'S11', 'T3', 'T4', 'T5', 'T6',
    'MEPC',
  ],
} as const;

export const gdbRegsInfoRiscvIlp32 = registerSets.riscv;

export function toHexString(n = 0): string {
  return `0x${n.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// RISC-V panic output ("Core N register dump:" + "Stack memory:")
// ---------------------------------------------------------------------------

export interface RegisterDump {
  coreId: number;
  regs: Record<string, number>;
  programCounter?: number;
  faultCode?: number;
  faultAddr?: number;
}

export interface StackDumpSegment {
  coreId: number;
  baseAddr: number;
  data: number[];
}

export interface RisvPanicParseResult {
  regDumps: RegisterDump[];
  stackDump: StackDumpSegment[];
  programCounter: number;
  faultCode?: number;
  faultAddr?: number;
  /** Core named by the panic header ("Core N panic'ed"), if present. */
  panicCoreId?: number;
}

const RISCV_REG_NAMES = new Set<string>(gdbRegsInfoRiscvIlp32);

export function parseRiscvPanicDetailed(input: string): RisvPanicParseResult {
  const lines = input.split(/\r?\n|\r/);
  const regDumps: RegisterDump[] = [];
  const stackDump: StackDumpSegment[] = [];
  let currentRegDump: RegisterDump | undefined;
  let inStackMemory = false;
  let faultCode: number | undefined;
  let faultAddr: number | undefined;
  let programCounter = 0;
  const panicCoreMatch = input.match(/Core\s+(\d+)\s+panic/i);
  const panicCoreId = panicCoreMatch ? parseInt(panicCoreMatch[1], 10) : undefined;

  for (const line of lines) {
    if (line.startsWith('Core')) {
      const match = line.match(/^Core\s+(\d+)\s+register dump:/);
      if (match) {
        currentRegDump = { coreId: parseInt(match[1], 10), regs: {} };
        regDumps.push(currentRegDump);
      }
    } else if (currentRegDump && !inStackMemory) {
      for (const match of line.matchAll(/([A-Z_0-9/]+)\s*:\s*(0x[0-9a-fA-F]+)/g)) {
        const regName = match[1];
        const regAddr = parseInt(match[2], 16);
        if (Number.isNaN(regAddr)) {
          continue;
        }
        if (RISCV_REG_NAMES.has(regName)) {
          // Record the register even when its value is 0 (e.g. X0 is always 0).
          currentRegDump.regs[regName] = regAddr;
          if (regName === 'MEPC') {
            programCounter = regAddr; // PC equivalent
            currentRegDump.programCounter = regAddr;
          }
        } else if (regName === 'MCAUSE') {
          faultCode = regAddr; // EXCCAUSE equivalent
          currentRegDump.faultCode = regAddr;
        } else if (regName === 'MTVAL') {
          faultAddr = regAddr; // EXCVADDR equivalent
          currentRegDump.faultAddr = regAddr;
        }
      }
      if (line.trim() === 'Stack memory:') {
        inStackMemory = true;
      }
    } else if (inStackMemory && currentRegDump) {
      const match = line.match(/^([0-9a-fA-F]+):\s*((?:0x[0-9a-fA-F]+\s*)+)/);
      if (match) {
        const baseAddr = parseInt(match[1], 16);
        const data = match[2]
          .trim()
          .split(/\s+/)
          .map((hex) => parseInt(hex, 16));
        stackDump.push({ coreId: currentRegDump.coreId, baseAddr, data });
      }
    }
  }

  return { regDumps, stackDump, programCounter, faultCode, faultAddr, panicCoreId };
}

/**
 * Pick the register dump belonging to the panicking core named in the
 * panic header; fall back to the first dump when absent or unmatched.
 */
function selectActiveDump(result: RisvPanicParseResult): RegisterDump {
  if (result.panicCoreId !== undefined) {
    const match = result.regDumps.find((d) => d.coreId === result.panicCoreId);
    if (match) {
      return match;
    }
  }
  return result.regDumps[0];
}

function getStackAddrAndData(stackDump: StackDumpSegment[]): {
  stackBaseAddr: number;
  stackData: Buffer;
} {
  let stackBaseAddr = 0;
  let baseAddr = 0;
  let bytesInLine = 0;
  const chunks: Buffer[] = [];
  let totalLength = 0;

  for (const line of stackDump) {
    const prevBaseAddr = baseAddr;
    baseAddr = line.baseAddr;
    if (stackBaseAddr === 0) {
      stackBaseAddr = baseAddr;
    } else if (baseAddr !== prevBaseAddr + bytesInLine) {
      throw new Error('Invalid base address');
    }

    const lineData = Buffer.concat(
      line.data.map((word) => {
        const buf = Buffer.alloc(4);
        // Stack memory is little-endian; preserve byte order for GDB reads.
        buf.writeUInt32LE(word >>> 0);
        return buf;
      }),
    );
    bytesInLine = lineData.length;
    chunks.push(lineData);
    totalLength += bytesInLine;
  }

  return { stackBaseAddr, stackData: Buffer.concat(chunks, totalLength) };
}

/**
 * Parse a RISC-V panic output into PanicInfoWithStackData for the GDB stub.
 * When multiple cores are dumped, the first one is used (typically the
 * crashing core in ESP-IDF panic output).
 */
export function parseRiscvPanicOutput(input: string): PanicInfoWithStackData {
  const parsed = parseRiscvPanicDetailed(input);
  const { regDumps, stackDump, programCounter, faultAddr, faultCode } = parsed;
  if (regDumps.length === 0) {
    throw new Error('No register dumps found');
  }
  const active = selectActiveDump(parsed);
  if (regDumps.length > 1) {
    console.warn(
      `[panic-decoder] Multi-core dump detected (${regDumps.length} cores); ` +
        `decoding core ${active.coreId}` +
        (parsed.panicCoreId !== undefined ? ' (panic header)' : ' (first)'),
    );
  }
  const { coreId, regs } = active;
  // Filter stack segments to only those belonging to the selected core
  // to avoid "Invalid base address" errors from non-contiguous segments.
  const filtered = stackDump.filter((seg) => seg.coreId === coreId);
  const { stackBaseAddr, stackData } = getStackAddrAndData(filtered);

  return {
    coreId,
    programCounter: active.programCounter ?? programCounter,
    faultAddr: active.faultAddr ?? faultAddr,
    faultCode: active.faultCode ?? faultCode,
    regs,
    stackBaseAddr,
    stackData,
  };
}

/**
 * Lightweight parse used by the crash capturer: regs + PC/fault fields only.
 * Throws when no register dump is present.
 */
export function parseRiscvPanicLightweight(input: string): PanicInfoWithBacktrace {
  const parsed = parseRiscvPanicDetailed(input);
  const { regDumps, programCounter, faultCode, faultAddr } = parsed;
  if (regDumps.length === 0) {
    throw new Error('No register dumps found');
  }
  const active = selectActiveDump(parsed);
  const { coreId, regs } = active;
  return {
    coreId,
    programCounter: active.programCounter ?? programCounter,
    faultCode: active.faultCode ?? faultCode,
    faultAddr: active.faultAddr ?? faultAddr,
    regs,
    backtraceAddrs: (active.programCounter ?? programCounter)
      ? [active.programCounter ?? programCounter]
      : [],
  };
}

// ---------------------------------------------------------------------------
// Xtensa panic outputs (ESP32 / ESP32-S2 / ESP32-S3 and ESP8266)
// ---------------------------------------------------------------------------

/**
 * ESP8266 panic output: "Exception (N):" header, epcN=/excvaddr= register
 * assignments, and a >>>stack>>> hex dump of candidate return addresses.
 */
export function parseESP8266PanicOutput(input: string): PanicInfoWithBacktrace {
  const lines = input.split(/\r?\n|\r/);
  const regs: Record<string, number> = {};
  const coreId = 0;
  const backtraceAddrs: number[] = [];
  let faultCode: number | undefined;
  let faultAddr: number | undefined;

  const regLine = input.match(/Exception\s+\((\d+)\)/);
  if (regLine) {
    faultCode = parseInt(regLine[1], 10);
  }

  for (const line of lines) {
    for (const match of line.matchAll(/(epc\d+|excvaddr|depc)=(0x[0-9a-fA-F]{8})/g)) {
      const [, reg, hex] = match;
      regs[reg.toUpperCase()] = parseInt(hex, 16);
      if (reg.toLowerCase() === 'excvaddr') {
        faultAddr = parseInt(hex, 16);
      }
    }

    // Example line: 3fff10b0:  4021a5d4 00000033 3fff20dc 40201ed3
    const stackMatch = line.match(/^\s*[0-9a-f]{8}:\s+((?:[0-9a-f]{8}\s*)+)/i);
    if (stackMatch) {
      const words = stackMatch[1].trim().split(/\s+/);
      for (const word of words) {
        const addr = parseInt(word, 16);
        if (!Number.isNaN(addr) && addr & 0x40000000) {
          backtraceAddrs.push(addr);
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
  };
}

/**
 * ESP32/ESP32-S2/S3 panic output: "Guru Meditation Error: Core N panic'ed
 * (...)" header, "NAME : 0x..." register lines, and a "Backtrace:" line of
 * 0xPC:0xSP pairs.
 */
export function parseESP32PanicOutput(input: string): PanicInfoWithBacktrace {
  const lines = input.split(/\r?\n|\r/);
  const regs: Record<string, number> = {};
  let coreId = 0;
  const backtraceAddrs: number[] = [];
  const coreIdMatch = input.match(/Guru Meditation Error: Core\s+(\d+)/);
  if (coreIdMatch) {
    coreId = parseInt(coreIdMatch[1], 10);
  }

  const regRegex = /([A-Z]+[0-9]*)\s*:\s*(0x[0-9a-fA-F]+)/g;
  for (const line of lines) {
    for (const match of line.matchAll(regRegex)) {
      const [, regName, hexValue] = match;
      const value = parseInt(hexValue, 16);
      if (!Number.isNaN(value)) {
        regs[regName] = value;
      }
    }

    if (line.startsWith('Backtrace:')) {
      // Entries are "0xPC:0xSP" pairs — only the PC is a code address;
      // stack pointers must not be resolved as frames.
      for (const match of line.matchAll(/(0x[0-9a-fA-F]{8}):0x[0-9a-fA-F]{8}/g)) {
        const addr = parseInt(match[1], 16);
        if (!Number.isNaN(addr)) {
          backtraceAddrs.push(addr);
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
  };
}

/** Try ESP32 format first, fall back to ESP8266 when it yields nothing. */
export function parseXtensaPanicOutput(input: string): PanicInfoWithBacktrace {
  const parsed = parseESP32PanicOutput(input);
  if (
    Object.keys(parsed.regs).length === 0 &&
    parsed.backtraceAddrs.length === 0 &&
    !parsed.programCounter
  ) {
    return parseESP8266PanicOutput(input);
  }
  return parsed;
}
