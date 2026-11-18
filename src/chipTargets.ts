import * as fs from 'fs';

export type ChipArch = 'xtensa' | 'riscv';

/**
 * Xtensa chips — ESP32, ESP32-S2, ESP32-S3 and ESP8266 are the only non-RISC-V
 * ESP targets.
 *
 * Like esp-idf-panic-decoder (which uses a single generic 'default' register
 * set), decoding only depends on the architecture family: every other chip is
 * RISC-V and shares the same ILP32 register layout and panic format, so no
 * per-MCU target is needed.
 */
export const XTENSA_CHIPS = ['esp32', 'esp32s2', 'esp32s3', 'esp8266'] as const;

const XTENSA_SET: ReadonlySet<string> = new Set(XTENSA_CHIPS);

/**
 * All known chip / IDF target names, used to detect the chip from board or
 * MCU strings (e.g. ROM ELF lookup). Sorted longest-first so 'esp32s31'
 * matches before 'esp32s3' and 'esp32c61' before 'esp32c6'. RISC-V names are
 * listed only for name detection — their arch is implied.
 */
export const KNOWN_CHIPS: readonly string[] = [
  'esp32c2',
  'esp32c3',
  'esp32c5',
  'esp32c6',
  'esp32c61',
  'esp32h2',
  'esp32h4',
  'esp32p4',
  'esp32s31',
  ...XTENSA_CHIPS,
].sort((a, b) => b.length - a.length);

/**
 * Architecture family for a chip / IDF target name: the four Xtensa chips
 * are 'xtensa', everything else is 'riscv'.
 */
export function chipArch(chip: string): ChipArch {
  return XTENSA_SET.has(chip.toLowerCase()) ? 'xtensa' : 'riscv';
}

// ELF e_machine values for the two supported architecture families.
const ELF_MACHINE_XTENSA = 94;
const ELF_MACHINE_RISCV = 243;

const elfArchCache = new Map<string, ChipArch | undefined>();

/**
 * Detect the architecture family from an ELF file's e_machine header field.
 * This is authoritative when board definitions or sdkconfig are missing —
 * guessing 'esp32' would select an Xtensa GDB for RISC-V firmware.
 * Returns undefined for unreadable or non-ESP ELF files.
 */
export function detectElfArch(elfPath: string): ChipArch | undefined {
  if (elfArchCache.has(elfPath)) {
    return elfArchCache.get(elfPath);
  }
  let arch: ChipArch | undefined;
  try {
    const fd = fs.openSync(elfPath, 'r');
    try {
      const buf = Buffer.alloc(20);
      if (
        fs.readSync(fd, buf, 0, 20, 0) === 20 &&
        buf.readUInt32BE(0) === 0x7f454c46 // \x7fELF
      ) {
        // EI_DATA at offset 5: 1 = little-endian, 2 = big-endian.
        const machine =
          buf[5] === 2 ? buf.readUInt16BE(18) : buf.readUInt16LE(18);
        if (machine === ELF_MACHINE_XTENSA) {
          arch = 'xtensa';
        } else if (machine === ELF_MACHINE_RISCV) {
          arch = 'riscv';
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // unreadable or non-ELF file
  }
  elfArchCache.set(elfPath, arch);
  return arch;
}
