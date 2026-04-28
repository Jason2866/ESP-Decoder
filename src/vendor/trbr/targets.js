// @ts-check

// Decoder target architectures supported by trbr. Keeping the constants in
// their own module lets the rest of the library reference them without
// pulling in any Arduino-CLI / FQBN tooling helpers.

export const defaultTargetArch = /** @type {const} */ ('xtensa')

const riscTargetArchs = /** @type {const} */ ([
  'esp32c2',
  'esp32c3',
  'esp32c5',
  'esp32c6',
  'esp32h2',
  'esp32h4',
  'esp32p4',
])

export const targetArchs = /** @type {const} */ ([
  defaultTargetArch,
  ...riscTargetArchs,
])

/** @typedef {(typeof targetArchs)[number]} DecodeTarget */
/** @typedef {(typeof riscTargetArchs)[number]} RiscvTargetArch */

/**
 * @param {unknown} arg
 * @returns {arg is RiscvTargetArch}
 */
export function isRiscvTargetArch(arg) {
  return (
    typeof arg === 'string' &&
    riscTargetArchs.includes(/** @type {RiscvTargetArch} */ (arg))
  )
}
