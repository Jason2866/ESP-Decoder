export const CHIP_TARGET_MAP: Record<string, string> = {
  esp32: 'xtensa',
  esp32s2: 'xtensa',
  esp32s3: 'xtensa',
  esp32c2: 'esp32c2',
  esp32c3: 'esp32c3',
  esp32c5: 'esp32c3',
  esp32c6: 'esp32c6',
  esp32h2: 'esp32h2',
  esp32h4: 'esp32h4',
  esp32p4: 'esp32p4',
  esp8266: 'xtensa',
};

export const RISCV_TARGETS = new Set([
  'esp32c2',
  'esp32c3',
  'esp32c5',
  'esp32c6',
  'esp32h2',
  'esp32h4',
  'esp32p4',
]);

export const XTENSA_CHIPS = new Set(['esp32', 'esp32s2', 'esp32s3', 'esp8266']);
