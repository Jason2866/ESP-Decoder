// @ts-check

export const registerSets = /** @type {const} */ ({
  // Xtensa exception frame order used in ESP‑IDF v5 core dumps
  xtensa: [
    'PC',
    'PS',
    // loop registers + SAR
    'LBEG',
    'LEND',
    'LCOUNT',
    'SAR',
    // general‑purpose registers
    'A0',
    'A1',
    'A2',
    'A3',
    'A4',
    'A5',
    'A6',
    'A7',
    'A8',
    'A9',
    'A10',
    'A11',
    'A12',
    'A13',
    'A14',
    'A15',
    // remaining exception/window registers
    'EXCCAUSE',
    'EXCVADDR',
    'WINDOWBASE',
    'WINDOWSTART',
  ],
  // TODO: compare with gdbRegsInfoRiscvIlp32
  riscv: [
    'MEPC',
    'RA',
    'SP',
    'GP',
    'TP',
    'T0',
    'T1',
    'T2',
    'S0',
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
    'MSTATUS',
    'MTVEC',
    'MCAUSE',
    'MTVAL',
    'MHARTID',
  ],
})

/**
 * @param {number} number
 * @returns {string}
 */
export function toHexString(number = 0) {
  return `0x${number.toString(16).padStart(8, '0')}`
}
