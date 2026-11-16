export type ChipArch = 'xtensa' | 'riscv';

/**
 * Maps ESP chip / IDF target names to the decoder architecture family.
 *
 * Like esp-idf-panic-decoder (which uses a single generic 'default' register
 * set), decoding only depends on the architecture family — all RISC-V chips
 * share the same ILP32 register layout and panic format, so no per-MCU
 * target is needed.
 */
export const CHIP_TARGET_MAP: Record<string, ChipArch> = {
  esp32: 'xtensa',
  esp32s2: 'xtensa',
  esp32s3: 'xtensa',
  esp8266: 'xtensa',
  esp32c2: 'riscv',
  esp32c3: 'riscv',
  esp32c5: 'riscv',
  esp32c6: 'riscv',
  // ESP32-C61 shares the C6 crash/register decoding implementation.
  esp32c61: 'riscv',
  esp32h2: 'riscv',
  esp32h4: 'riscv',
  esp32p4: 'riscv',
  esp32s31: 'riscv',
};
