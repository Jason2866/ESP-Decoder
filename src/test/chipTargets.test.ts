/**
 * Unit tests for chipTargets.ts — verifies chip names are classified into the
 * correct architecture family (xtensa | riscv). Like esp-idf-panic-decoder,
 * decoding only depends on the arch family: the four Xtensa chips are a fixed
 * set and everything else is RISC-V.
 */

import { describe, it, expect } from 'vitest';
import { XTENSA_CHIPS, KNOWN_CHIPS, chipArch, ChipArch } from '../chipTargets.js';

describe('chipTargets – Xtensa chips', () => {
  for (const chip of XTENSA_CHIPS) {
    it(`maps ${chip} to xtensa`, () => {
      expect(chipArch(chip)).toBe('xtensa');
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
      expect(chipArch(chip)).toBe('riscv');
    });
  }

  it('maps unknown / future chips to riscv', () => {
    expect(chipArch('esp32c9')).toBe('riscv');
    expect(chipArch('esp32x1')).toBe('riscv');
  });
});

describe('chipTargets – KNOWN_CHIPS', () => {
  it('contains every Xtensa chip', () => {
    for (const chip of XTENSA_CHIPS) {
      expect(KNOWN_CHIPS).toContain(chip);
    }
  });

  it('is sorted longest-first for substring matching', () => {
    for (let i = 1; i < KNOWN_CHIPS.length; i++) {
      expect(KNOWN_CHIPS[i - 1].length).toBeGreaterThanOrEqual(KNOWN_CHIPS[i].length);
    }
  });

  it('every known chip resolves to a valid arch family', () => {
    for (const chip of KNOWN_CHIPS) {
      const arch: ChipArch = chipArch(chip);
      expect(arch === 'xtensa' || arch === 'riscv', `${chip} has invalid arch '${arch}'`).toBe(true);
    }
  });
});
