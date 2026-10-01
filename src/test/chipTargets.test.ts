/**
 * Unit tests for chipTargets.ts — verifies every chip is correctly classified
 * and that ESP32-S31 is fully registered as a RISC-V target.
 */

import { describe, it, expect } from 'vitest';
import { CHIP_TARGET_MAP, RISCV_TARGETS, XTENSA_CHIPS } from '../chipTargets.js';

// ---------------------------------------------------------------------------
// ESP32-S31 registration
// ---------------------------------------------------------------------------

describe('chipTargets – ESP32-S31', () => {
  it('maps esp32s31 to the esp32s31 trbr target', () => {
    expect(CHIP_TARGET_MAP['esp32s31']).toBe('esp32s31');
  });

  it('includes esp32s31 in RISCV_TARGETS', () => {
    expect(RISCV_TARGETS.has('esp32s31')).toBe(true);
  });

  it('does not include esp32s31 in XTENSA_CHIPS', () => {
    expect(XTENSA_CHIPS.has('esp32s31')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Xtensa chips
// ---------------------------------------------------------------------------

describe('chipTargets – Xtensa chips', () => {
  const xtensaChips = ['esp32', 'esp32s2', 'esp32s3', 'esp8266'];

  for (const chip of xtensaChips) {
    it(`maps ${chip} to xtensa`, () => {
      expect(CHIP_TARGET_MAP[chip]).toBe('xtensa');
    });

    it(`includes ${chip} in XTENSA_CHIPS`, () => {
      expect(XTENSA_CHIPS.has(chip)).toBe(true);
    });

    it(`does not include ${chip} in RISCV_TARGETS`, () => {
      expect(RISCV_TARGETS.has(chip)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// RISC-V chips
// ---------------------------------------------------------------------------

describe('chipTargets – RISC-V chips', () => {
  const riscvChips: Array<{ chip: string; expectedTarget: string }> = [
    { chip: 'esp32c2',  expectedTarget: 'esp32c2'  },
    { chip: 'esp32c3',  expectedTarget: 'esp32c3'  },
    { chip: 'esp32c5',  expectedTarget: 'esp32c5'  },
    { chip: 'esp32c6',  expectedTarget: 'esp32c6'  },
    { chip: 'esp32h2',  expectedTarget: 'esp32h2'  },
    { chip: 'esp32h4',  expectedTarget: 'esp32h4'  },
    { chip: 'esp32p4',  expectedTarget: 'esp32p4'  },
    { chip: 'esp32s31', expectedTarget: 'esp32s31' },
  ];

  for (const { chip, expectedTarget } of riscvChips) {
    it(`maps ${chip} to ${expectedTarget}`, () => {
      expect(CHIP_TARGET_MAP[chip]).toBe(expectedTarget);
    });

    it(`includes ${chip} in RISCV_TARGETS`, () => {
      expect(RISCV_TARGETS.has(chip)).toBe(true);
    });

    it(`does not include ${chip} in XTENSA_CHIPS`, () => {
      expect(XTENSA_CHIPS.has(chip)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Completeness: every CHIP_TARGET_MAP entry is classified in exactly one set
// ---------------------------------------------------------------------------

describe('chipTargets – classification completeness', () => {
  it('every chip in CHIP_TARGET_MAP is in either XTENSA_CHIPS or RISCV_TARGETS (never both)', () => {
    for (const chip of Object.keys(CHIP_TARGET_MAP)) {
      const isXtensa = XTENSA_CHIPS.has(chip);
      const isRiscv = RISCV_TARGETS.has(chip);
      // Exactly one must be true
      expect(
        isXtensa !== isRiscv,
        `${chip} should be in exactly one of XTENSA_CHIPS or RISCV_TARGETS`,
      ).toBe(true);
    }
  });

  it('every chip in RISCV_TARGETS has an entry in CHIP_TARGET_MAP', () => {
    for (const chip of RISCV_TARGETS) {
      expect(
        CHIP_TARGET_MAP[chip],
        `${chip} is in RISCV_TARGETS but missing from CHIP_TARGET_MAP`,
      ).toBeDefined();
    }
  });

  it('every chip in XTENSA_CHIPS has an entry in CHIP_TARGET_MAP', () => {
    for (const chip of XTENSA_CHIPS) {
      expect(
        CHIP_TARGET_MAP[chip],
        `${chip} is in XTENSA_CHIPS but missing from CHIP_TARGET_MAP`,
      ).toBeDefined();
    }
  });
});
