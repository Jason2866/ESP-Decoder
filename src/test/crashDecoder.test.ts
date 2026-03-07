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
import { TrbrCrashCapturer, decodeCrash } from '../crashDecoder.js';
import type { CrashEvent } from '../crashDecoder.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------
const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');
const ELF_PATH = path.join(FIXTURES_DIR, 'firmware.elf');
const CRASH_TEXT_PATH = path.join(FIXTURES_DIR, 'esp32c6_assert.txt');

const CRASH_TEXT = fs.readFileSync(CRASH_TEXT_PATH, 'utf8');

// Resolved from PlatformIO packages on this machine
const GDB_PATH = '/Users/claudia/.platformio/packages/tool-riscv32-esp-elf-gdb/bin/riscv32-esp-elf-gdb';

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
