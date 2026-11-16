// Type shims for deep imports into the vendored trbr JS (no per-module .d.ts).
declare module '*/vendor/trbr/decode/regs.js' {
  export const registerSets: { riscv: readonly string[] };
}

declare module '*/vendor/trbr/decode/riscvPanicParse.js' {
  export const gdbRegsInfoRiscvIlp32: readonly string[];
}
