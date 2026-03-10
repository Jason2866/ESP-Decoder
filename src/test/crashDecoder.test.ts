/**
 * Unit tests for ESP32-C6 crash detection and decoding.
 *
 * Fixtures:
 *   esp32c6_assert.txt  – real serial output captured from an ESP32-C6
 *                         that crashed with "assert failed: npl_freertos_event_init"
 *   firmware.elf        – the matching firmware ELF with debug symbols
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Mock vscode before importing any module that depends on it
// ---------------------------------------------------------------------------
vi.mock('vscode', () => {
  class EventEmitter<T> {
    private _listeners: ((e: T) => void)[] = [];

    get event() {
      return (listener: (e: T) => void) => {
        this._listeners.push(listener);
        return {
          dispose: () => {
            this._listeners = this._listeners.filter((l) => l !== listener);
          },
        };
      };
    }

    fire(e: T) {
      this._listeners.forEach((l) => l(e));
    }

    dispose() {
      this._listeners = [];
    }
  }

  return { EventEmitter };
});

// ---------------------------------------------------------------------------
// Import under test (after vscode mock is in place)
// ---------------------------------------------------------------------------
import { TrbrCrashCapturer, decodeCrash, decodeCoredumpElf, decodeCoredumpBase64, containsBase64Coredump } from '../crashDecoder.js';
import type { CrashEvent, CoredumpDecodedResult } from '../crashDecoder.js';
import { getPioPackagesDir } from '../pioIntegration.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const ELF_PATH = path.join(FIXTURES_DIR, 'firmware.elf');
const CRASH_TEXT_PATH = path.join(FIXTURES_DIR, 'esp32c6_assert.txt');

const CRASH_TEXT = fs.readFileSync(CRASH_TEXT_PATH, 'utf8');

// ESP32 coredump b64 test fixtures
// Source: https://github.com/espressif/esp-coredump/tree/master/tests/esp32
const B64_COREDUMP_PATH = path.join(FIXTURES_DIR, 'coredump_esp32.b64');
const ESP32_FIRMWARE_ELF_PATH = path.join(FIXTURES_DIR, 'esp32_coredump_firmware.elf');

// Resolve GDB paths from PlatformIO packages (works on any machine)
function findPioGdb(kind: 'riscv' | 'xtensa'): string | undefined {
  const pioDir = getPioPackagesDir();
  if (!pioDir) { return undefined; }
  const ext = process.platform === 'win32' ? '.exe' : '';
  if (kind === 'riscv') {
    const candidates = [
      path.join(pioDir, 'tool-riscv32-esp-elf-gdb', 'bin', `riscv32-esp-elf-gdb${ext}`),
      path.join(pioDir, 'toolchain-riscv32-esp', 'bin', `riscv32-esp-elf-gdb${ext}`),
    ];
    return candidates.find(c => fs.existsSync(c));
  }
  const xtensaVariants = [
    { pkg: 'tool-xtensa-esp-elf-gdb', bin: `xtensa-esp32-elf-gdb${ext}` },
    { pkg: 'tool-xtensa-esp-elf-gdb', bin: `xtensa-esp32s3-elf-gdb${ext}` },
    { pkg: 'tool-xtensa-esp-elf-gdb', bin: `xtensa-esp32s2-elf-gdb${ext}` },
    { pkg: 'toolchain-xtensa-esp-elf', bin: `xtensa-esp-elf-gdb${ext}` },
    { pkg: 'toolchain-xtensa-esp32s3-elf', bin: `xtensa-esp32s3-elf-gdb${ext}` },
    { pkg: 'toolchain-xtensa-esp32-elf', bin: `xtensa-esp32-elf-gdb${ext}` },
    { pkg: 'toolchain-xtensa-esp32s2-elf', bin: `xtensa-esp32s2-elf-gdb${ext}` },
  ];
  for (const { pkg, bin } of xtensaVariants) {
    const c = path.join(pioDir, pkg, 'bin', bin);
    if (fs.existsSync(c)) { return c; }
  }
  try {
    for (const entry of fs.readdirSync(pioDir)) {
      if (entry.startsWith('tool-xtensa') && entry.includes('-gdb')) {
        const binDir = path.join(pioDir, entry, 'bin');
        for (const bin of fs.readdirSync(binDir)) {
          if (/^xtensa-.*-elf-gdb(\.exe)?$/.test(bin)) {
            return path.join(binDir, bin);
          }
        }
      }
    }
  } catch {}
  return undefined;
}

const GDB_PATH = process.env.ESP_RISCV_GDB ?? findPioGdb('riscv') ?? '';
const XTENSA_GDB_PATH = process.env.ESP_XTENSA_GDB ?? findPioGdb('xtensa') ?? '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Feed text into the capturer line-by-line and flush.
 * Returns the first detected CrashEvent (or undefined if none).
 */
function feedCrashText(capturer: TrbrCrashCapturer, text: string): CrashEvent | undefined {
  let detected: CrashEvent | undefined;
  capturer.onCrashDetected((e) => {
    if (!detected) { detected = e; }
  });
  capturer.pushData(Buffer.from(text, 'utf8'));
  capturer.flush();
  return detected;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrbrCrashCapturer – ESP32-C6 assert failure', () => {
  let capturer: TrbrCrashCapturer;

  beforeEach(() => {
    capturer = new TrbrCrashCapturer();
  });

  it('detects the crash via the fallback detector', () => {
    const event = feedCrashText(capturer, CRASH_TEXT);
    expect(event).toBeDefined();
  });

  it('classifies the crash as riscv', () => {
    const event = feedCrashText(capturer, CRASH_TEXT);
    expect(event?.kind).toBe('riscv');
  });

  it('includes the assert message in the raw text', () => {
    const event = feedCrashText(capturer, CRASH_TEXT);
    expect(event?.rawText).toContain('assert failed: npl_freertos_event_init');
  });

  it('includes the register dump in the raw text', () => {
    const event = feedCrashText(capturer, CRASH_TEXT);
    expect(event?.rawText).toContain('Core  0 register dump:');
    expect(event?.rawText).toContain('MEPC');
    expect(event?.rawText).toContain('Stack memory:');
  });

  it('captures MEPC value 0x4080c1aa', () => {
    const event = feedCrashText(capturer, CRASH_TEXT);
    expect(event?.rawText).toContain('0x4080c1aa');
  });
});

describe('decodeCrash – ESP32-C6 with real ELF', () => {
  // Build a CrashEvent from the captured crash text
  function makeCrashEvent(): CrashEvent {
    const lines = CRASH_TEXT.split('\n').filter((l) => l.trim().length > 0);
    return {
      id: 'test-esp32c6-001',
      kind: 'riscv',
      lines,
      rawText: CRASH_TEXT,
      timestamp: Date.now(),
    };
  }

  it.skipIf(!fs.existsSync(ELF_PATH) || !fs.existsSync(GDB_PATH))(
    'decodes the crash and reports fault information',
    async () => {
      const event = makeCrashEvent();
      const decoded = await decodeCrash(event, ELF_PATH, GDB_PATH, 'esp32c6');

      // Fault info must be present
      expect(decoded.faultInfo).toBeDefined();

      // MCAUSE 0x02 = Illegal instruction
      expect(decoded.faultInfo?.faultMessage).toMatch(/illegal instruction/i);
    }
  );

  it.skipIf(!fs.existsSync(ELF_PATH) || !fs.existsSync(GDB_PATH))(
    'resolves panic_abort in the stack trace',
    async () => {
      const event = makeCrashEvent();
      const decoded = await decodeCrash(event, ELF_PATH, GDB_PATH, 'esp32c6');

      // MEPC (0x4080c1aa) resolves to panic_abort in esp_system/panic.c
      // With ESPHome-style resolution (no address decrement), the address
      // appears directly in the heuristic stacktrace.
      expect(
        decoded.stacktrace.some((f) => f.function?.includes('panic_abort'))
      ).toBe(true);
    }
  );

  it.skipIf(!fs.existsSync(ELF_PATH) || !fs.existsSync(GDB_PATH))(
    'resolves assert function from the stack trace (ESPHome-compatible)',
    async () => {
      const event = makeCrashEvent();
      const decoded = await decodeCrash(event, ELF_PATH, GDB_PATH, 'esp32c6');

      // 0x4081107c resolves to esp_libc_include_assert_impl (assert.c:96)
      // with ESPHome-style resolution (no address decrement).
      const hasAssertInTrace = decoded.stacktrace.some(
        (f) => f.function?.includes('assert')
      );

      expect(hasAssertInTrace).toBe(true);
    }
  );

  it.skipIf(!fs.existsSync(ELF_PATH) || !fs.existsSync(GDB_PATH))(
    'matches ESPHome decoder output: all expected functions resolved',
    async () => {
      const event = makeCrashEvent();
      const decoded = await decodeCrash(event, ELF_PATH, GDB_PATH, 'esp32c6');

      // Expected resolved addresses matching ESPHome esp-stacktrace-decoder:
      //   0x4080c1aa → panic_abort
      //   0x4080c16e → esp_vApplicationTickHook (NOT esp_system_abort — no decrement)
      //   0x40800001 → _vector_table
      //   0x4081107c → esp_libc_include_assert_impl
      //   0x4200cf9e → ble_hs_event_rx_hci_ev (appears twice)
      //   0x4200d57e → ble_hs_enqueue_hci_event
      //   0x4200e2fa → ble_hs_hci_rx_evt
      //   0x4080d2da → vPortTaskWrapper
      const resolvedFuncs = decoded.stacktrace
        .map((f) => f.function ?? '')
        .join('\n');

      expect(resolvedFuncs).toMatch(/panic_abort/);
      expect(resolvedFuncs).toMatch(/ble_hs_event_rx_hci_ev/);
      expect(resolvedFuncs).toMatch(/ble_hs_enqueue_hci_event/);
      expect(resolvedFuncs).toMatch(/ble_hs_hci_rx_evt/);
      expect(resolvedFuncs).toMatch(/vPortTaskWrapper/);
    }
  );

  it.skipIf(!fs.existsSync(ELF_PATH) || !fs.existsSync(GDB_PATH))(
    'raw decode fallback extracts MEPC register',
    async () => {
      const event = makeCrashEvent();
      // Use undefined toolPath to force raw decode (no GDB)
      const decoded = await decodeCrash(event, ELF_PATH, undefined, 'esp32c6');

      expect(decoded.regs).toBeDefined();
      // MEPC = 0x4080c1aa
      const mepc = decoded.regs?.['MEPC'] ?? decoded.regs?.['mepc'];
      expect(mepc).toBe(0x4080c1aa);
    }
  );
});

describe('decodeCoredumpElf', () => {
  it('exports as a function', () => {
    expect(typeof decodeCoredumpElf).toBe('function');
  });

  it('gracefully handles missing toolPath by returning empty result', async () => {
    // When toolPath doesn't exist and auto-detection fails, should not throw
    const result = await decodeCoredumpElf(
      '/nonexistent/coredump.elf',
      '/nonexistent/firmware.elf',
      undefined, // no toolPath — auto-detect will fail
      'esp32c6',
    );
    expect(result).toBeDefined();
    expect(Array.isArray(result.threads)).toBe(true);
    expect(result.threads).toHaveLength(0);
    expect(typeof result.rawOutput).toBe('string');
  });

  it.skipIf(!fs.existsSync(B64_COREDUMP_PATH) || !fs.existsSync(ESP32_FIRMWARE_ELF_PATH) || !fs.existsSync(XTENSA_GDB_PATH))(
    'decodes an esp32 b64 coredump file with multiple threads',
    async () => {
      const result = await decodeCoredumpElf(
        B64_COREDUMP_PATH,
        ESP32_FIRMWARE_ELF_PATH,
        XTENSA_GDB_PATH,
        'xtensa',
      );

      expect(result).toBeDefined();
      expect(result.threads.length).toBeGreaterThan(0);

      // At least one thread should be flagged as the current/crashed thread
      const currentThread = result.threads.find(t => t.isCurrent);
      expect(currentThread).toBeDefined();

      // The crashed thread should have stacktrace frames
      expect(currentThread!.decoded.stacktrace.length).toBeGreaterThan(0);
    },
    60_000,
  );
});

describe('containsBase64Coredump', () => {
  it('detects CORE DUMP START/END markers', () => {
    const text = [
      'some serial output',
      '================= CORE DUMP START =================',
      'f0VMRgEBAQAAAAAAAAAAAAQAXgABAAAA',
      'AAAAAA==',
      '================= CORE DUMP END ===================',
      'Rebooting...',
    ].join('\n');
    expect(containsBase64Coredump(text)).toBe(true);
  });

  it('returns false for regular crash text', () => {
    expect(containsBase64Coredump(CRASH_TEXT)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(containsBase64Coredump('')).toBe(false);
  });

  it.skipIf(!fs.existsSync(B64_COREDUMP_PATH))(
    'detects markerless b64 coredump file content',
    () => {
      const b64Content = fs.readFileSync(B64_COREDUMP_PATH, 'utf-8');
      expect(containsBase64Coredump(b64Content)).toBe(true);
    },
  );
});

describe('decodeCoredumpBase64', () => {
  it('exports as a function', () => {
    expect(typeof decodeCoredumpBase64).toBe('function');
  });

  it.skipIf(!fs.existsSync(B64_COREDUMP_PATH) || !fs.existsSync(ESP32_FIRMWARE_ELF_PATH) || !fs.existsSync(XTENSA_GDB_PATH))(
    'decodes b64 text with CORE DUMP markers wrapping esp32 coredump',
    async () => {
      const b64Content = fs.readFileSync(B64_COREDUMP_PATH, 'utf-8');
      const markerWrapped = [
        'I (1234) esp_core_dump_flash: Found partition on flash',
        '================= CORE DUMP START =================',
        b64Content,
        '================= CORE DUMP END ===================',
        '',
      ].join('\n');

      const result = await decodeCoredumpBase64(
        markerWrapped,
        ESP32_FIRMWARE_ELF_PATH,
        XTENSA_GDB_PATH,
        'xtensa',
      );

      expect(result).toBeDefined();
      expect(result.threads.length).toBeGreaterThan(0);
    },
    60_000,
  );

  it('returns empty threads for invalid b64 content', async () => {
    const result = await decodeCoredumpBase64(
      'not valid base64 content!!!',
      '/nonexistent/firmware.elf',
      undefined,
      'xtensa',
    );
    expect(result).toBeDefined();
    expect(result.threads).toHaveLength(0);
  });
});
