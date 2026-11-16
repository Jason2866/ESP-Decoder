/**
 * Unit tests for chipTargets.ts — verifies every chip is classified into the
 * correct architecture family (xtensa | riscv). Like esp-idf-panic-decoder,
 * decoding only depends on the arch family, not the specific MCU.
 */

import { describe, it, expect } from 'vitest';
import { CHIP_TARGET_MAP, ChipArch } from '../chipTargets.js';

describe('chipTargets – Xtensa chips', () => {
  const xtensaChips = ['esp32', 'esp32s2', 'esp32s3', 'esp8266'];

  for (const chip of xtensaChips) {
    it(`maps ${chip} to xtensa`, () => {
      expect(CHIP_TARGET_MAP[chip]).toBe('xtensa');
    });
  }
});

describe('chipTargets – RISC-V chips', () => {
  const riscvChips = [
    'esp32c2',
    'esp32c3',
    'esp32c5',
    'esp32c6',
    'esp32c61',
    'esp32h2',
    'esp32h4',
    'esp32p4',
    'esp32s31',
  ];

  for (const chip of riscvChips) {
    it(`maps ${chip} to riscv`, () => {
      expect(CHIP_TARGET_MAP[chip]).toBe('riscv');
    });
  }
});

describe('chipTargets – map completeness', () => {
  it('every entry maps to a valid arch family', () => {
    for (const [chip, arch] of Object.entries(CHIP_TARGET_MAP)) {
      expect(
        arch === 'xtensa' || arch === 'riscv',
        `${chip} has invalid arch '${arch}'`,
      ).toBe(true);
    }
  });

  it('all values are ChipArch', () => {
    const values: ChipArch[] = Object.values(CHIP_TARGET_MAP);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v === 'xtensa' || v === 'riscv')).toBe(true);
  });
});
