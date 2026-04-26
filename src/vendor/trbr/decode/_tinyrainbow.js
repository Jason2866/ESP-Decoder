// Minimal in-tree replacement for the `tinyrainbow` package consumed by
// stringify.js. The original library auto-detects TTY/FORCE_COLOR and emits
// ANSI escape sequences. esp-decoder always invokes stringifyDecodeResult with
// `{ color: 'disable' }`, so the colored code paths are never executed and an
// identity-function shim is sufficient.

/** @typedef {(text: string) => string} ColorFn */

/** @type {ColorFn} */
const identity = (text) => String(text)

const palette = {
  red: identity,
  green: identity,
  blue: identity,
}

export function createColors() {
  return { ...palette }
}

export default palette
