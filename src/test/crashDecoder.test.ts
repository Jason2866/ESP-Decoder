/**
 * Unit tests for ESP32-C6 crash detection and decoding.
 *
 * Fixtures:
 *   esp32c6_assert.txt  – real serial output captured from an ESP32-C6
 *                         that crashed with "assert failed: npl_freertos_event_init"
 *   firmware.elf        – the matching firmware ELF with debug symbols
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import cp from 'node:child_process';

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
import { CrashCapturer, decodeCrash, decodeCoredumpElf, decodeCoredumpBase64, containsBase64Coredump, extractRiscvHeuristicCandidates } from '../crashDecoder.js';
import type { CrashEvent } from '../crashDecoder.js';
import { getPioPackagesDir } from '../pioIntegration.js';
import { countResolvedMiFrames, dedupeArgs } from '../panic/decodeRiscv.js';
import {
  registerSets,
  gdbRegsInfoRiscvIlp32,
  parseRiscvPanicDetailed,
  parseESP32PanicOutput,
  parseXtensaPanicOutput,
  addr2line,
  isParsedGDBLine,
  parseLine,
  LineDecoder,
  GdbMiClient,
  CrashFramer,
  Capturer,
  parseESP8266PanicOutput,
  parseStackDataRow,
  parseRiscvPanicOutput,
  extractPrintedBacktraceAddrs,
  printedBacktraceApplies,
  decodeCoredumpFile,
} from '../panic/index.js';
import type { CapturerEvent, ParsedGDBLine } from '../panic/index.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------
const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const ELF_PATH = path.join(FIXTURES_DIR, 'firmware.elf');
const CRASH_TEXT_PATH = path.join(FIXTURES_DIR, 'esp32c6_assert.txt');

const CRASH_TEXT = fs.readFileSync(CRASH_TEXT_PATH, 'utf8');

// ESP8266 crash fixture
const ESP8266_CRASH_TEXT_PATH = path.join(FIXTURES_DIR, 'esp8266_crash.txt');
const ESP8266_CRASH_TEXT = fs.readFileSync(ESP8266_CRASH_TEXT_PATH, 'utf8');

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
    { pkg: 'toolchain-xtensa', bin: `xtensa-lx106-elf-gdb${ext}` },
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

const GDB_PATH = process.env.ESP_RISCV_GDB ?? findPioGdb('riscv');
const XTENSA_GDB_PATH = process.env.ESP_XTENSA_GDB ?? findPioGdb('xtensa');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Feed text into the capturer line-by-line and flush.
 * Returns the first detected CrashEvent (or undefined if none).
 */
function feedCrashText(capturer: CrashCapturer, text: string): CrashEvent | undefined {
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

describe('CrashCapturer – ESP32-C6 assert failure', () => {
  let capturer: CrashCapturer;

  beforeEach(() => {
    capturer = new CrashCapturer();
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

describe('CrashCapturer – architecture hints', () => {
  it('requires a value after a RISC-V register name and matches multiple fields on a row', () => {
    const riscv = feedCrashText(new CrashCapturer(), [
      'assert failed: MCAUSE register check',
      'Core 0 register dump:',
      'MEPC: 0x42000001  MCAUSE: 0x00000002  MHARTID: 0x00000000',
      'Backtrace: 0x42000001:0x3fc80000',
    ].join('\n'));
    expect(riscv?.kind).toBe('riscv');

    const xtensa = feedCrashText(new CrashCapturer(), [
      'assert failed: MCAUSE register check',
      "Guru Meditation Error: Core 0 panic'ed (LoadProhibited).",
      'PC: 0x400d1234',
      'Backtrace: 0x400d1234:0x3ffb0000',
    ].join('\n'));
    expect(xtensa?.kind).toBe('xtensa');
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

  it('decodes the crash and reports fault information when GDB available', async () => {
    const event = makeCrashEvent();
    const decoded = await decodeCrash(event, ELF_PATH, GDB_PATH, 'esp32c6');

    // Check if GDB is executable (mirrors decodeCrash runtime behavior)
    let isExecutable = false;
    if (GDB_PATH) {
      try {
        fs.accessSync(GDB_PATH, fs.constants.X_OK);
        isExecutable = true;
      } catch {
        isExecutable = false;
      }
    }

    if (!isExecutable) {
      // When GDB is not available or not executable, should fall back to raw decode
      expect(decoded.toolsMissing).toBe(true);
      expect(decoded.regs).toBeDefined();
    } else {
      // When GDB is available, fault info must be present
      expect(decoded.faultInfo).toBeDefined();
      // MCAUSE 0x02 = Illegal instruction
      expect(decoded.faultInfo?.faultMessage).toMatch(/illegal instruction/i);
    }
  });

  it('resolves panic_abort in the stack trace when GDB available', async () => {
    const event = makeCrashEvent();
    const decoded = await decodeCrash(event, ELF_PATH, GDB_PATH, 'esp32c6');

    // Check if GDB is executable (mirrors decodeCrash runtime behavior)
    let isExecutable = false;
    if (GDB_PATH) {
      try {
        fs.accessSync(GDB_PATH, fs.constants.X_OK);
        isExecutable = true;
      } catch {
        isExecutable = false;
      }
    }

    if (!isExecutable) {
      // When GDB is not available, should indicate tools are missing
      expect(decoded.toolsMissing).toBe(true);
    } else {
      // MEPC (0x4080c1aa) resolves to panic_abort in esp_system/panic.c
      // With ESPHome-style resolution (no address decrement), the address
      // appears directly in the heuristic stacktrace.
      expect(
        decoded.stacktrace.some((f) => f.function?.includes('panic_abort'))
      ).toBe(true);
    }
  });

  it('resolves assert function from the stack trace when GDB available', async () => {
    const event = makeCrashEvent();
    const decoded = await decodeCrash(event, ELF_PATH, GDB_PATH, 'esp32c6');

    // Check if GDB is executable (mirrors decodeCrash runtime behavior)
    let isExecutable = false;
    if (GDB_PATH) {
      try {
        fs.accessSync(GDB_PATH, fs.constants.X_OK);
        isExecutable = true;
      } catch {
        isExecutable = false;
      }
    }

    if (!isExecutable) {
      // When GDB is not available, should indicate tools are missing
      expect(decoded.toolsMissing).toBe(true);
    } else {
      // 0x4081107c resolves to esp_libc_include_assert_impl (assert.c:96)
      // with ESPHome-style resolution (no address decrement).
      const hasAssertInTrace = decoded.stacktrace.some(
        (f) => f.function?.includes('assert')
      );
      expect(hasAssertInTrace).toBe(true);
    }
  });

  it('matches ESPHome decoder output when GDB available', async () => {
    const event = makeCrashEvent();
    const decoded = await decodeCrash(event, ELF_PATH, GDB_PATH, 'esp32c6');

    // Check if GDB is executable (mirrors decodeCrash runtime behavior)
    let isExecutable = false;
    if (GDB_PATH) {
      try {
        fs.accessSync(GDB_PATH, fs.constants.X_OK);
        isExecutable = true;
      } catch {
        isExecutable = false;
      }
    }

    if (!isExecutable) {
      // When GDB is not available, should indicate tools are missing
      expect(decoded.toolsMissing).toBe(true);
    } else {
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
  });

  it('raw decode fallback extracts MEPC register', async () => {
    const event = makeCrashEvent();
    // Use explicitly invalid toolPath to force raw decode (no GDB)
    const decoded = await decodeCrash(event, ELF_PATH, '/nonexistent/gdb', 'esp32c6');

    expect(decoded.toolsMissing).toBe(true);
    expect(decoded.regs).toBeDefined();
    // MEPC = 0x4080c1aa
    const mepc = decoded.regs?.['MEPC'] ?? decoded.regs?.['mepc'];
    expect(mepc).toBe(0x4080c1aa);
  });
});

// ---------------------------------------------------------------------------
// ESP8266 crash detection
// ---------------------------------------------------------------------------

describe('CrashCapturer – ESP8266 exception crash', () => {
  let capturer: CrashCapturer;

  beforeEach(() => {
    capturer = new CrashCapturer();
  });

  it('detects the crash', () => {
    const event = feedCrashText(capturer, ESP8266_CRASH_TEXT);
    expect(event).toBeDefined();
  });

  it('classifies the crash as xtensa', () => {
    const event = feedCrashText(capturer, ESP8266_CRASH_TEXT);
    expect(event?.kind).toBe('xtensa');
  });

  it('includes the exception number in the raw text', () => {
    const event = feedCrashText(capturer, ESP8266_CRASH_TEXT);
    expect(event?.rawText).toContain('Exception (28)');
  });

  it('includes epc1 and excvaddr registers', () => {
    const event = feedCrashText(capturer, ESP8266_CRASH_TEXT);
    expect(event?.rawText).toContain('epc1=0x4020e41c');
    expect(event?.rawText).toContain('excvaddr=0x00000000');
  });

  it('includes the stack dump', () => {
    const event = feedCrashText(capturer, ESP8266_CRASH_TEXT);
    expect(event?.rawText).toContain('>>>stack>>>');
    expect(event?.rawText).toContain('<<<stack<<<');
  });

  it('is captured without flush when ESP8266 stack end marker is present', () => {
    // ESP8266 fixture has no "Rebooting..." line, but it includes "<<<stack<<<"
    // which now finalizes the block immediately.
    let detected: CrashEvent | undefined;
    capturer.onCrashDetected((e) => { if (!detected) { detected = e; } });
    capturer.pushData(Buffer.from(ESP8266_CRASH_TEXT, 'utf8'));
    expect(detected).toBeDefined();
    expect(detected?.rawText).toContain('<<<stack<<<');
  });
});

// ---------------------------------------------------------------------------
// Regression: ESP32 Guru Meditation captured via the crash capturer
// ---------------------------------------------------------------------------

describe('CrashCapturer – ESP32 Guru Meditation (native capturer path)', () => {
  let capturer: CrashCapturer;

  beforeEach(() => {
    capturer = new CrashCapturer();
  });

  const GURU_CRASH = [
    'Guru Meditation Error: Core  0 panic\'ed (LoadProhibited). Exception was unhandled.',
    'Core  0 register dump:',
    'PC      : 0x400d1234  PS      : 0x00060030  A0      : 0x800d5678  A1      : 0x3ffb1234',
    'EXCVADDR: 0x00000000  EXCCAUSE: 0x0000001c',
    'Backtrace: 0x400d1234:0x3ffb1234 0x400d5678:0x3ffb5678',
    '',
    'Rebooting...',
  ].join('\n');

  it('detects the crash via the capturer (not fallback)', () => {
    const event = feedCrashText(capturer, GURU_CRASH);
    expect(event).toBeDefined();
    // capturer events have numeric IDs (e.g. "000001"), not "fallback-..." prefixed
    expect(event!.id).not.toMatch(/^fallback-/);
  });

  it('classifies the crash as xtensa', () => {
    const event = feedCrashText(capturer, GURU_CRASH);
    expect(event?.kind).toBe('xtensa');
  });

  it('includes backtrace and registers in the raw text', () => {
    const event = feedCrashText(capturer, GURU_CRASH);
    expect(event?.rawText).toContain('Backtrace:');
    expect(event?.rawText).toContain('EXCVADDR');
    expect(event?.rawText).toContain('EXCCAUSE');
  });
});

// ---------------------------------------------------------------------------
// assert failed: + abort() was called continuation
// ---------------------------------------------------------------------------

describe('CrashCapturer – assert/abort continuation', () => {
  it('keeps assert failed and abort() was called in a single crash block', () => {
    const capturer = new CrashCapturer();
    const events: CrashEvent[] = [];
    capturer.onCrashDetected((e) => events.push(e));
    capturer.pushData(
      Buffer.from(
        [
          'assert failed: npl_freertos_event_init',
          'abort() was called at PC 0x42001234 on core 0',
          'Backtrace: 0x42001234:0x3ffb1234 0x42005678:0x3ffb5678',
          'Rebooting...',
        ].join('\n'),
        'utf8',
      ),
    );
    capturer.flush();
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.rawText).toContain('assert failed: npl_freertos_event_init');
    expect(event.rawText).toContain('abort() was called');
    expect(event.rawText).toContain('Backtrace:');
    expect(event.lines.filter((l) => l.includes('assert failed:'))).toHaveLength(1);
  });

  it('starts a new block when abort() arrives after a completed backtrace', () => {
    const capturer = new CrashCapturer();
    const events: CrashEvent[] = [];
    capturer.onCrashDetected((e) => events.push(e));
    capturer.pushData(
      Buffer.from(
        [
          'assert failed: first_crash',
          'Backtrace: 0x42000001:0x3ffb0001 0x42000002:0x3ffb0002',
          'abort() was called at PC 0x42000003 on core 0',
          'Backtrace: 0x42000004:0x3ffb0004 0x42000005:0x3ffb0005',
          'Rebooting...',
        ].join('\n'),
        'utf8',
      ),
    );
    capturer.flush();
    // First block (assert + backtrace) and second block (abort + backtrace)
    // must not be merged into one event.
    expect(events.length).toBe(2);
    expect(events[0].rawText).toContain('assert failed: first_crash');
    expect(events[0].rawText).not.toContain('abort() was called');
    expect(events[1].rawText).toContain('abort() was called');
    expect(events[1].rawText).not.toContain('assert failed:');
  });
});

describe('CrashCapturer – quiet period with unterminated line', () => {
  it('emits the complete block while an unterminated tail stays buffered', async () => {
    const capturer = new CrashCapturer();
    const events: CrashEvent[] = [];
    const updates: CrashEvent[] = [];
    capturer.onCrashDetected((e) => events.push(e));
    capturer.onCrashUpdated((e) => updates.push(e));
    // No trailing newline: the last line stays buffered in LineDecoder.
    capturer.pushData(
      Buffer.from(
        [
          'assert failed: unterminated_tail',
          'Backtrace: 0x42000001:0x3ffb0001 0x42000002:0x3ffb0002',
          'Rebooting...',
        ].join('\n'),
        'utf8',
      ),
    );
    // Beyond the quiet period the complete block emits provisionally; the
    // unterminated 'Rebooting...' tail is not flushed mid-line.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(events.length).toBe(1);
    expect(events[0].rawText).toContain('assert failed: unterminated_tail');
    expect(events[0].rawText).not.toContain('Rebooting');

    // Explicit flush completes the tail line into the still-open block.
    capturer.flush();
    expect(updates.length).toBe(1);
    expect(updates[0].rawText).toContain('Rebooting...');
  });

  it('preserves the block when the stream ends mid-UTF-8-sequence', async () => {
    const capturer = new CrashCapturer();
    const events: CrashEvent[] = [];
    capturer.onCrashDetected((e) => events.push(e));
    // 'assert failed' line is complete, then only the first byte (0xC3) of a
    // two-byte UTF-8 sequence arrives — invisible to a decoded-text check.
    capturer.pushData(
      Buffer.concat([
        Buffer.from('assert failed: split_utf8\n', 'utf8'),
        Buffer.from([0xc3]),
      ]),
    );
    // Beyond the quiet period the framer must not drop the assert block.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(events.length).toBe(0);

    // Rest of the sequence ('é' = C3 A9) + newline, then the backtrace.
    capturer.pushData(
      Buffer.concat([
        Buffer.from([0xa9, 0x0a]),
        Buffer.from(
          'Backtrace: 0x42000001:0x3ffb0001 0x42000002:0x3ffb0002\nRebooting...\n',
          'utf8',
        ),
      ]),
    );
    capturer.flush();
    expect(events.length).toBe(1);
    expect(events[0].rawText).toContain('assert failed: split_utf8');
    expect(events[0].rawText).toContain('Backtrace:');
  });

  it('emits an unterminated final Backtrace line after the quiet period', async () => {
    const capturer = new CrashCapturer();
    const events: CrashEvent[] = [];
    const updates: CrashEvent[] = [];
    capturer.onCrashDetected((e) => events.push(e));
    capturer.onCrashUpdated((e) => updates.push(e));
    // Crash ends with a Backtrace line that has no trailing newline — the
    // pending line itself carries the completeness signal, so the quiet
    // period must publish it as a preview instead of waiting for flush().
    capturer.pushData(
      Buffer.from(
        'assert failed: unterminated_bt\n' +
          'Backtrace: 0x42000001:0x3ffb0001 0x42000002:0x3ffb0002',
        'utf8',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(events.length).toBe(1);
    expect(events[0].rawText).toContain('assert failed: unterminated_bt');
    expect(events[0].rawText).toContain('Backtrace: 0x42000001');

    // The terminator completes the SAME line — a revision, not a new event.
    capturer.pushData(Buffer.from('\n', 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(events.length).toBe(1);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.at(-1)?.rawText.split('Backtrace:').length).toBe(2);
  });

  it('emits a complete block after the quiet period without flush', async () => {
    const capturer = new CrashCapturer();
    const events: CrashEvent[] = [];
    capturer.onCrashDetected((e) => events.push(e));
    // Complete block (Backtrace signal) but no immediate-finalize line, so
    // only the quiet-period timer can emit it.
    capturer.pushData(
      Buffer.from(
        'assert failed: quiet_timer\n' +
          'Backtrace: 0x42000001:0x3ffb0001 0x42000002:0x3ffb0002\n',
        'utf8',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(events.length).toBe(1);
    expect(events[0].rawText).toContain('assert failed: quiet_timer');
    expect(events[0].rawText).toContain('Backtrace:');
  });
});

describe('CrashCapturer – signature dedup vs. backtrace divergence', () => {
  it('does not merge crashes that share the first frames but differ later', () => {
    const capturer = new CrashCapturer();
    const events: CrashEvent[] = [];
    capturer.onCrashDetected((e) => events.push(e));
    const crash = (lastAddr: string) =>
      [
        'Guru Meditation Error: Core 0 panic\'ed (StoreProhibited)',
        'Backtrace: 0x42000001:0x3ffb0001 0x42000002:0x3ffb0002 0x42000003:0x3ffb0003 0x42000004:0x3ffb0004 0x42000005:0x3ffb0005 0x42000006:0x3ffb0006 ' + lastAddr,
        'Rebooting...',
      ].join('\n');
    capturer.pushData(Buffer.from(crash('0x4200000a:0x3ffb000a') + '\n' + crash('0x4200000b:0x3ffb000b'), 'utf8'));
    capturer.flush();
    expect(events.length).toBe(2);
    expect(events[0].id).not.toBe(events[1].id);
  });
});

describe('CrashCapturer – event updates', () => {
  it('fires onCrashUpdated with the same id when a richer capture merges', () => {
    const capturer = new CrashCapturer();
    const detected: CrashEvent[] = [];
    const updated: CrashEvent[] = [];
    capturer.onCrashDetected((e) => detected.push(e));
    capturer.onCrashUpdated((e) => updated.push(e));

    capturer.pushData(
      Buffer.from('assert failed: merge_me\nBacktrace: 0x40000001:0x3ffb0001\n', 'utf8'),
    );
    capturer.flush();
    capturer.pushData(
      Buffer.from(
        'assert failed: merge_me\nBacktrace: 0x40000001:0x3ffb0001\nRebooting...\n',
        'utf8',
      ),
    );
    capturer.flush();

    expect(detected.length).toBe(1);
    expect(updated.length).toBe(1);
    expect(updated[0].id).toBe(detected[0].id);
    expect(updated[0].rawText).toContain('Rebooting...');
  });
});

describe('CrashFramer – complete block size cap', () => {
  it('finalizes a complete block at the cap even without a quiet period', () => {
    const capturer = new CrashCapturer();
    const events: CrashEvent[] = [];
    capturer.onCrashDetected((e) => events.push(e));

    const parts = ['assert failed: flood\n', 'Backtrace: 0x40000001:0x3ffb0001\n'];
    for (let i = 0; i < 2100; i++) {
      parts.push(`filler line ${i}\n`);
    }
    capturer.pushData(Buffer.from(parts.join(''), 'utf8'));

    expect(events.length).toBe(1);
    expect(events[0].rawText).toContain('assert failed: flood');
    expect(events[0].rawText).toContain('Backtrace:');
  });
});

// ---------------------------------------------------------------------------
// ESP8266 crash decoding (raw decode fallback)
// ---------------------------------------------------------------------------

describe('decodeCrash – ESP8266 raw decode', () => {
  function makeEsp8266CrashEvent(): CrashEvent {
    const lines = ESP8266_CRASH_TEXT.split('\n').filter((l) => l.trim().length > 0);
    return {
      id: 'test-esp8266-001',
      kind: 'xtensa',
      lines,
      rawText: ESP8266_CRASH_TEXT,
      timestamp: Date.now(),
    };
  }

  it('extracts Exception 28 as "Access to invalid address: LOAD" fault message', async () => {
    const event = makeEsp8266CrashEvent();
    const decoded = await decodeCrash(event, '/nonexistent/firmware.elf', '/nonexistent/gdb', 'xtensa');

    expect(decoded.toolsMissing).toBe(true);
    expect(decoded.faultInfo).toBeDefined();
    expect(decoded.faultInfo?.faultMessage).toContain('Access to invalid address: LOAD (wild pointer?)');
    expect(decoded.faultInfo?.faultCode).toBe(28);
  });

  it('extracts epc1 as program counter', async () => {
    const event = makeEsp8266CrashEvent();
    const decoded = await decodeCrash(event, '/nonexistent/firmware.elf', '/nonexistent/gdb', 'xtensa');

    expect(decoded.faultInfo?.programCounter).toBe('0x4020e41c');
  });

  it('parses ESP8266 registers from epc1=... format', async () => {
    const event = makeEsp8266CrashEvent();
    const decoded = await decodeCrash(event, '/nonexistent/firmware.elf', '/nonexistent/gdb', 'xtensa');

    expect(decoded.regs).toBeDefined();
    expect(decoded.regs?.['EPC1']).toBe(0x4020e41c);
    expect(decoded.regs?.['EPC2']).toBe(0x00000000);
    expect(decoded.regs?.['EXCVADDR']).toBe(0x00000000);
  });

  it('extracts code addresses from >>>stack>>> dump', async () => {
    const event = makeEsp8266CrashEvent();
    const decoded = await decodeCrash(event, '/nonexistent/firmware.elf', '/nonexistent/gdb', 'xtensa');

    expect(decoded.stacktrace.length).toBeGreaterThan(0);

    // Known code addresses from the fixture stack dump
    const addresses = decoded.stacktrace.map((f) => f.address.toLowerCase());
    expect(addresses).toContain('0x40201df1');
    expect(addresses).toContain('0x40201e29');
    expect(addresses).toContain('0x40201e62');
    expect(addresses).toContain('0x40202284');
    expect(addresses).toContain('0x40202b38');
    expect(addresses).toContain('0x40203e68');
    expect(addresses).toContain('0x40100b39');
  });

  it('does not include non-code addresses in stacktrace', async () => {
    const event = makeEsp8266CrashEvent();
    const decoded = await decodeCrash(event, '/nonexistent/firmware.elf', '/nonexistent/gdb', 'xtensa');

    // Data addresses (0x3fxxxxxx) should not appear in stacktrace
    for (const frame of decoded.stacktrace) {
      const val = parseInt(frame.address, 16);
      expect(val).toBeGreaterThanOrEqual(0x40000000);
      expect(val).toBeLessThan(0x50000000);
    }
  });

  it('includes excvaddr as fault address', async () => {
    const event = makeEsp8266CrashEvent();
    const decoded = await decodeCrash(event, '/nonexistent/firmware.elf', '/nonexistent/gdb', 'xtensa');

    expect(decoded.faultInfo?.faultAddr).toBe('0x00000000');
  });
});

// ---------------------------------------------------------------------------
// ESP8266 fast-path: addr2line resolution with a stubbed binary
// ---------------------------------------------------------------------------
const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('decodeCrash – ESP8266 addr2line fast-path', () => {
  // Create a temp directory with a fake GDB and addr2line binary pair
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esp-decoder-test-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const fakeGdbPath = path.join(binDir, 'xtensa-lx106-elf-gdb');
  const fakeAddr2linePath = path.join(binDir, 'xtensa-lx106-elf-addr2line');

  // The fake addr2line script outputs resolved function/file info for every address
  const addr2lineScript = `#!/bin/sh
for addr in "$@"; do
  case "$addr" in
    -* | /* ) continue ;;
    0x*)
      echo "$addr"
      echo "app_main"
      echo "/home/user/project/main.cpp:42"
      ;;
  esac
done
`;

  fs.writeFileSync(fakeGdbPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(fakeAddr2linePath, addr2lineScript, { mode: 0o755 });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEsp8266CrashEvent(): CrashEvent {
    const lines = ESP8266_CRASH_TEXT.split('\n').filter((l) => l.trim().length > 0);
    return {
      id: 'test-esp8266-fast-001',
      kind: 'xtensa',
      lines,
      rawText: ESP8266_CRASH_TEXT,
      timestamp: Date.now(),
    };
  }

  it('resolves frames via addr2line fast-path (toolsMissing is false)', async () => {
    const event = makeEsp8266CrashEvent();
    const decoded = await decodeCrash(event, '/nonexistent/firmware.elf', fakeGdbPath, 'xtensa');

    expect(decoded.toolsMissing).toBeFalsy();
    expect(decoded.stacktrace.length).toBeGreaterThan(0);

    // All frames should have resolved function and file info from the stub
    for (const frame of decoded.stacktrace) {
      expect(frame.function).toBe('app_main');
      expect(frame.file).toContain('main.cpp');
    }
  });

  it('resolves known address 0x40201df1 to a non-empty function/file', async () => {
    const event = makeEsp8266CrashEvent();
    const decoded = await decodeCrash(event, '/nonexistent/firmware.elf', fakeGdbPath, 'xtensa');

    const frame = decoded.stacktrace.find((f) => f.address.toLowerCase() === '0x40201df1');
    expect(frame).toBeDefined();
    expect(frame!.function).toBeTruthy();
    expect(frame!.file).toBeTruthy();
  });

  it('includes fault info from parseXtensaFaultInfo', async () => {
    const event = makeEsp8266CrashEvent();
    const decoded = await decodeCrash(event, '/nonexistent/firmware.elf', fakeGdbPath, 'xtensa');

    expect(decoded.faultInfo).toBeDefined();
    expect(decoded.faultInfo?.faultCode).toBe(28);
    expect(decoded.faultInfo?.faultMessage).toContain('Access to invalid address: LOAD (wild pointer?)');
  });
});

// ---------------------------------------------------------------------------
// Dual-core Xtensa fast-path: the panic core's backtrace/regs must win
// ---------------------------------------------------------------------------
describe.skipIf(isWindows)('decodeCrash – dual-core Xtensa fast-path', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esp-decoder-dualcore-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const fakeGdbPath = path.join(binDir, 'xtensa-esp32-elf-gdb');
  const fakeAddr2linePath = path.join(binDir, 'xtensa-esp32-elf-addr2line');

  // Echo the resolved address into the function name so tests can tell
  // which core's backtrace addresses were actually resolved.
  const addr2lineScript = `#!/bin/sh
for addr in "$@"; do
  case "$addr" in
    -* | /* ) continue ;;
    0x*)
      echo "$addr"
      echo "func_$addr"
      echo "/home/user/project/main.cpp:42"
      ;;
  esac
done
`;

  fs.writeFileSync(fakeGdbPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(fakeAddr2linePath, addr2lineScript, { mode: 0o755 });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const DUAL_CORE_CRASH = [
    'Guru Meditation Error: Core  1 panic\'ed (LoadProhibited). Exception was unhandled.',
    '',
    'Core  0 register dump:',
    'PC      : 0x40000001  PS      : 0x00060030  A0      : 0x3ffb0001  A1      : 0x3ffb0002',
    'EXCVADDR: 0x00000000  EXCCAUSE: 0x00000000',
    '',
    // Core 0's backtrace appears first but belongs to the non-panicking core.
    'Backtrace: 0x40000001:0x3ffb0001 0x40000009:0x3ffb0009',
    '',
    'Core  1 register dump:',
    'PC      : 0x40000002  PS      : 0x00060030  A0      : 0x3ffb0002  A1      : 0x3ffb0003',
    'EXCVADDR: 0x3ffb0004  EXCCAUSE: 0x0000000c',
    '',
    'Backtrace: 0x40000002:0x3ffb0002 0x40000003:0x3ffb0003',
  ].join('\n');

  function makeCrashEvent(): CrashEvent {
    return {
      id: 'test-dualcore-001',
      kind: 'xtensa',
      lines: DUAL_CORE_CRASH.split('\n').filter((l) => l.trim().length > 0),
      rawText: DUAL_CORE_CRASH,
      timestamp: Date.now(),
    };
  }

  it('resolves only the panicking core\'s backtrace when core 0 prints first', async () => {
    const decoded = await decodeCrash(makeCrashEvent(), '/nonexistent/firmware.elf', fakeGdbPath, 'xtensa');

    expect(decoded.toolsMissing).toBeFalsy();
    const addresses = decoded.stacktrace.map((f) => f.address.toLowerCase());
    // Core 1's PCs only — core 0's backtrace must not leak in.
    expect(addresses).toContain('0x40000002');
    expect(addresses).toContain('0x40000003');
    expect(addresses).not.toContain('0x40000001');
    expect(addresses).not.toContain('0x40000009');
    expect(decoded.stacktrace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address: '0x40000002',
          function: 'func_0x40000002',
          file: '/home/user/project/main.cpp',
          line: '42',
        }),
        expect.objectContaining({
          address: '0x40000003',
          function: 'func_0x40000003',
          file: '/home/user/project/main.cpp',
          line: '42',
        }),
      ]),
    );
  });

  it('reports the panicking core\'s registers and fault fields', async () => {
    const decoded = await decodeCrash(makeCrashEvent(), '/nonexistent/firmware.elf', fakeGdbPath, 'xtensa');

    expect(decoded.regs?.['PC']).toBe(0x40000002);
    expect(decoded.faultInfo?.coreId).toBe(1);
    expect(decoded.faultInfo?.programCounter).toBe('0x40000002');
    expect(decoded.faultInfo?.faultAddr).toBe('0x3ffb0004');
    expect(decoded.faultInfo?.faultCode).toBe(0xc);
  });
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

  it.skipIf(!fs.existsSync(B64_COREDUMP_PATH) || !fs.existsSync(ESP32_FIRMWARE_ELF_PATH) || !XTENSA_GDB_PATH || !fs.existsSync(XTENSA_GDB_PATH))(
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

  // Coredump + firmware ELF fixtures from espressif/esp-coredump@master/tests
  // (+ test_apps/built_apps). Each entry pairs a base64 coredump with the
  // matching firmware ELF; 'bin' variants use the binary core format.
  const coredumpCases: Array<{
    label: string;
    chip: string;
    arch: 'riscv' | 'xtensa';
    coredumpFile: string;
    elfFile: string;
  }> = [
    { label: 'esp32c3', chip: 'esp32c3', arch: 'riscv', coredumpFile: 'coredump_esp32c3.b64', elfFile: 'esp32c3_coredump_firmware.elf' },
    { label: 'esp32c3 bin', chip: 'esp32c3', arch: 'riscv', coredumpFile: 'coredump_esp32c3_bin.b64', elfFile: 'esp32c3_bin_coredump_firmware.elf' },
    { label: 'esp32c6', chip: 'esp32c6', arch: 'riscv', coredumpFile: 'coredump_esp32c6.b64', elfFile: 'esp32c6_coredump_firmware.elf' },
    { label: 'esp32s2', chip: 'esp32s2', arch: 'xtensa', coredumpFile: 'coredump_esp32s2.b64', elfFile: 'esp32s2_coredump_firmware.elf' },
    { label: 'esp32s3', chip: 'esp32s3', arch: 'xtensa', coredumpFile: 'coredump_esp32s3.b64', elfFile: 'esp32s3_coredump_firmware.elf' },
    { label: 'esp32s31', chip: 'esp32s31', arch: 'riscv', coredumpFile: 'coredump_esp32s31.b64', elfFile: 'esp32s31_coredump_firmware.elf' },
    { label: 'esp32s31 null_write', chip: 'esp32s31', arch: 'riscv', coredumpFile: 'coredump_esp32s31_null_write.b64', elfFile: 'esp32s31_null_write_coredump_firmware.elf' },
    { label: 'esp32s31 print_vars', chip: 'esp32s31', arch: 'riscv', coredumpFile: 'coredump_esp32s31_print_vars.b64', elfFile: 'esp32s31_print_vars_coredump_firmware.elf' },
    { label: 'esp32p4', chip: 'esp32p4', arch: 'riscv', coredumpFile: 'coredump_esp32p4.b64', elfFile: 'esp32p4_coredump_firmware.elf' },
    // NOTE: upstream's Xtensa 'coredump_bin.b64' is the legacy binary core
    // format (no embedded ELF) which this decoder does not support — GDB
    // requires an ELF core. The RISC-V '_bin' variants carry ELF cores and
    // are covered above.
  ];

  for (const { label, chip, arch, coredumpFile, elfFile } of coredumpCases) {
    const coredumpPath = path.join(FIXTURES_DIR, coredumpFile);
    const elfPath = path.join(FIXTURES_DIR, elfFile);
    const gdbPath = arch === 'riscv' ? GDB_PATH : XTENSA_GDB_PATH;
    const missing =
      !fs.existsSync(coredumpPath) ||
      !fs.existsSync(elfPath) ||
      !gdbPath ||
      !fs.existsSync(gdbPath);
    it.skipIf(missing)(
      `decodes the ${label} coredump with its matching firmware ELF`,
      async () => {
        const result = await decodeCoredumpElf(coredumpPath, elfPath, gdbPath!, chip);

        expect(result).toBeDefined();
        expect(result.threads.length).toBeGreaterThan(0);

        const currentThread = result.threads.find((t) => t.isCurrent);
        expect(currentThread).toBeDefined();
        expect(currentThread!.decoded.stacktrace.length).toBeGreaterThan(0);
      },
      60_000,
    );
  }
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

  it.skipIf(!fs.existsSync(B64_COREDUMP_PATH) || !fs.existsSync(ESP32_FIRMWARE_ELF_PATH) || !XTENSA_GDB_PATH || !fs.existsSync(XTENSA_GDB_PATH))(
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

// ---------------------------------------------------------------------------
// ESP32-S31 crash detection and raw decode
// ---------------------------------------------------------------------------

const ESP32S31_CRASH_TEXT_PATH = path.join(FIXTURES_DIR, 'esp32s31_crash.txt');
const ESP32S31_CRASH_TEXT = fs.readFileSync(ESP32S31_CRASH_TEXT_PATH, 'utf8');

describe('CrashCapturer – ESP32-S31 RISC-V crash', () => {
  let capturer: CrashCapturer;

  beforeEach(() => {
    capturer = new CrashCapturer();
  });

  it('detects the crash', () => {
    const event = feedCrashText(capturer, ESP32S31_CRASH_TEXT);
    expect(event).toBeDefined();
  });

  it('classifies the crash as riscv', () => {
    const event = feedCrashText(capturer, ESP32S31_CRASH_TEXT);
    expect(event?.kind).toBe('riscv');
  });

  it('includes the register dump in the raw text', () => {
    const event = feedCrashText(capturer, ESP32S31_CRASH_TEXT);
    expect(event?.rawText).toContain('Core  0 register dump:');
    expect(event?.rawText).toContain('MEPC');
  });

  it('includes the stack memory section', () => {
    const event = feedCrashText(capturer, ESP32S31_CRASH_TEXT);
    expect(event?.rawText).toContain('Stack memory:');
  });

  it('includes the backtrace line', () => {
    const event = feedCrashText(capturer, ESP32S31_CRASH_TEXT);
    expect(event?.rawText).toContain('Backtrace:');
  });

  it('captures MEPC value 0x42004abc', () => {
    const event = feedCrashText(capturer, ESP32S31_CRASH_TEXT);
    expect(event?.rawText).toContain('0x42004abc');
  });
});

describe('decodeCrash – ESP32-S31 raw decode fallback', () => {
  function makeCrashEvent(): CrashEvent {
    const lines = ESP32S31_CRASH_TEXT.split('\n').filter((l) => l.trim().length > 0);
    return {
      id: 'test-esp32s31-001',
      kind: 'riscv',
      lines,
      rawText: ESP32S31_CRASH_TEXT,
      timestamp: Date.now(),
    };
  }

  it('sets toolsMissing when GDB path does not exist', async () => {
    const event = makeCrashEvent();
    const decoded = await decodeCrash(event, ELF_PATH, '/nonexistent/riscv32-esp-elf-gdb', 'esp32s31');
    expect(decoded.toolsMissing).toBe(true);
  });

  it('extracts MEPC register (0x42004abc) from raw crash', async () => {
    const event = makeCrashEvent();
    const decoded = await decodeCrash(event, ELF_PATH, '/nonexistent/riscv32-esp-elf-gdb', 'esp32s31');
    expect(decoded.regs).toBeDefined();
    const mepc = decoded.regs?.['MEPC'] ?? decoded.regs?.['mepc'];
    expect(mepc).toBe(0x42004abc);
  });

  it('extracts MCAUSE register (0x00000002 = Illegal instruction)', async () => {
    const event = makeCrashEvent();
    const decoded = await decodeCrash(event, ELF_PATH, '/nonexistent/riscv32-esp-elf-gdb', 'esp32s31');
    expect(decoded.regs).toBeDefined();
    const mcause = decoded.regs?.['MCAUSE'] ?? decoded.regs?.['mcause'];
    expect(mcause).toBe(0x00000002);
  });

  it('extracts backtrace addresses from the crash', async () => {
    const event = makeCrashEvent();
    const decoded = await decodeCrash(event, ELF_PATH, '/nonexistent/riscv32-esp-elf-gdb', 'esp32s31');
    // Should still produce stacktrace entries from the Backtrace: line
    expect(decoded.stacktrace.length).toBeGreaterThan(0);
    const addresses = decoded.stacktrace.map((f) => f.address.toLowerCase());
    expect(addresses).toContain('0x42004abc');
  });
});

// ---------------------------------------------------------------------------
// RISC-V register layout validation
// ---------------------------------------------------------------------------

describe('RISC-V register layout', () => {
  it('has correct register count in registerSets.riscv', () => {
    expect(registerSets.riscv).toHaveLength(33);
  });

  it('has X0 at index 0 in registerSets.riscv', () => {
    expect(registerSets.riscv[0]).toBe('X0');
  });

  it('has S0/FP at index 8 in registerSets.riscv', () => {
    expect(registerSets.riscv[8]).toBe('S0/FP');
  });

  it('has MEPC at index 32 in registerSets.riscv', () => {
    expect(registerSets.riscv[32]).toBe('MEPC');
  });

  it('matches the expected GDB ILP32 register order', () => {
    // Use the canonical sequence from riscvPanicParse.js to avoid drift
    expect(registerSets.riscv).toEqual(gdbRegsInfoRiscvIlp32);
  });
});

// ---------------------------------------------------------------------------
// Multi-core RISC-V register dump parsing
// ---------------------------------------------------------------------------

describe('parseRiscvPanicDetailed – multi-core dumps', () => {
  it('parses registers of a core dumped after another core’s stack memory', () => {
    const text = [
      'Core  0 panic\'ed (Store access fault). Exception was unhandled.',
      '',
      'Core  0 register dump:',
      'MEPC    : 0x42000001  RA      : 0x42000002  SP      : 0x3fc80000  GP      : 0x3fc80001',
      'MCAUSE  : 0x00000007  MTVAL   : 0x3fc80002  MHARTID : 0x00000000',
      '',
      'Stack memory:',
      '3fc80000: 0x00000000 0x00000000 0x00000000 0x00000000',
      '',
      'Core  1 register dump:',
      'MEPC    : 0x42100001  RA      : 0x42100002  SP      : 0x3fc90000  GP      : 0x3fc90001',
      'MCAUSE  : 0x0000000b  MTVAL   : 0x3fc90002  MHARTID : 0x00000001',
      '',
      'Stack memory:',
      '3fc90000: 0x00000000 0x00000000 0x00000000 0x00000000',
    ].join('\n');

    const result = parseRiscvPanicDetailed(text);
    expect(result.regDumps).toHaveLength(2);
    expect(result.regDumps[0].regs.MEPC).toBe(0x42000001);
    // Core 1's registers must be parsed even though core 0 ended in
    // stack-memory mode.
    expect(result.regDumps[1].regs.MEPC).toBe(0x42100001);
    expect(result.regDumps[1].faultCode).toBe(0xb);
    expect(result.regDumps[1].faultAddr).toBe(0x3fc90002);
    // Stack segments stay attributed to their own core.
    expect(result.stackDump.map((s) => s.coreId)).toEqual([0, 1]);
  });
});

describe('RISC-V heuristic candidate extraction', () => {
  it('uses only selected-core stack words and printed backtrace PCs', () => {
    const text = [
      "Core 1 panic'ed (Store access fault).",
      'Core 0 register dump:',
      'MEPC: 0x42000001',
      'Stack memory:',
      '3fc80000: 0x42000002 0x00000000',
      'Backtrace: 0x42000003:0x3fc80000',
      'Core 1 register dump:',
      'MEPC: 0x42100001',
      'Stack memory:',
      '3fc90000: 0x42100002 0x00000000',
      'Backtrace: 0x42100003:0x3fc90000',
      'diagnostic address 0x4badcafe',
    ].join('\n');

    expect(extractRiscvHeuristicCandidates(text)).toEqual([
      '0x42100002',
      '0x42100003',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dual-core Xtensa panic parsing
// ---------------------------------------------------------------------------

describe('parseESP32PanicOutput – dual-core dumps', () => {
  it('selects registers and backtrace of the core named in the panic header', () => {
    const text = [
      'Guru Meditation Error: Core  1 panic\'ed (LoadProhibited). Exception was unhandled.',
      '',
      'Core  0 register dump:',
      'PC      : 0x40000001  PS      : 0x00060030  A0      : 0x3ffb0001  A1      : 0x3ffb0002',
      'EXCVADDR: 0x00000000  EXCCAUSE: 0x00000000',
      '',
      'Backtrace: 0x40000001:0x3ffb0001 0x40000009:0x3ffb0009',
      'PC      : 0x40009999  PS      : 0x00060030',
      '',
      'Core  1 register dump:',
      'PC      : 0x40000002  PS      : 0x00060030  A0      : 0x3ffb0002  A1      : 0x3ffb0003',
      'EXCVADDR: 0x3ffb0004  EXCCAUSE: 0x0000000c',
      '',
      'Backtrace: 0x40000002:0x3ffb0002 0x40000003:0x3ffb0003',
    ].join('\n');

    const parsed = parseESP32PanicOutput(text);
    expect(parsed.coreId).toBe(1);
    // Only core 1's registers — core 0's PC/EXCVADDR must not leak in.
    expect(parsed.regs.PC).toBe(0x40000002);
    expect(parsed.regs.EXCVADDR).toBe(0x3ffb0004);
    expect(parsed.faultAddr).toBe(0x3ffb0004);
    expect(parsed.faultCode).toBe(0xc);
    expect(parsed.programCounter).toBe(0x40000002);
    // Only core 1's backtrace PCs.
    expect(parsed.backtraceAddrs).toEqual([0x40000002, 0x40000003]);
    expect(typeof parsed.backtraceAddrs[0]).toBe('number');
  });

  it('retains an indented Backtrace line during panic-core selection', () => {
    const text = [
      'Guru Meditation Error: Core  1 panic\'ed (LoadProhibited). Exception was unhandled.',
      '',
      'Core  0 register dump:',
      'PC      : 0x40000001  PS      : 0x00060030',
      '  Backtrace: 0x40000001:0x3ffb0001 0x40000009:0x3ffb0009',
      '',
      '  Core  1 register dump:',
      'PC      : 0x40000002  PS      : 0x00060030',
      'EXCVADDR: 0x3ffb0004  EXCCAUSE: 0x0000000c',
      '  Backtrace: 0x40000002:0x3ffb0002 0x40000003:0x3ffb0003',
    ].join('\n');

    const parsed = parseESP32PanicOutput(text);
    expect(parsed.coreId).toBe(1);
    expect(parsed.regs.PC).toBe(0x40000002);
    expect(parsed.backtraceAddrs).toEqual([0x40000002, 0x40000003]);
  });

  it('accepts whitespace around backtrace colons and emits only PCs', () => {
    const parsed = parseESP32PanicOutput(
      'Backtrace: 0x40000001 : 0x3ffb0001 0x40000002: 0x3ffb0002',
    );
    expect(parsed.backtraceAddrs).toEqual([0x40000001, 0x40000002]);
  });

  it('rejects a backtrace pair with an overlong stack-pointer token', () => {
    const parsed = parseESP32PanicOutput(
      'Backtrace: 0x40000001:0x3ffb00001234 0x40000002:0x3ffb0002',
    );
    expect(parsed.backtraceAddrs).toEqual([0x40000002]);
  });
});

// ---------------------------------------------------------------------------
// LineDecoder – focused chunk/UTF-8/CRLF coverage (no timers, no vscode)
// ---------------------------------------------------------------------------

describe('LineDecoder', () => {
  const encode = (s: string) => new TextEncoder().encode(s);

  it('decodes a 3-byte UTF-8 sequence split at each interior byte', () => {
    // € = E2 82 AC
    const full = Uint8Array.from([0xe2, 0x82, 0xac]);
    for (const split of [1, 2]) {
      const decoder = new LineDecoder();
      expect(decoder.push(new Uint8Array([0x61, ...full.subarray(0, split)]))).toEqual([]);
      expect(decoder.hasPendingLine()).toBe(true);
      expect(decoder.push(new Uint8Array([...full.subarray(split), 0x0a]))).toEqual(['a€']);
    }
  });

  it('decodes a 4-byte UTF-8 sequence split at each interior byte', () => {
    // 😀 = F0 9F 98 80
    const full = Uint8Array.from([0xf0, 0x9f, 0x98, 0x80]);
    for (const split of [1, 2, 3]) {
      const decoder = new LineDecoder();
      expect(decoder.push(new Uint8Array([0x61, ...full.subarray(0, split)]))).toEqual([]);
      expect(decoder.hasPendingLine()).toBe(true);
      expect(decoder.push(new Uint8Array([...full.subarray(split), 0x0a]))).toEqual(['a😀']);
    }
  });

  it('treats split CRLF as a single line ending', () => {
    const decoder = new LineDecoder();
    expect(decoder.push(encode('a\r'))).toEqual(['a']);
    expect(decoder.push(encode('\nb'))).toEqual([]);
    expect(decoder.flush()).toEqual(['b']);
  });

  it('supports CR-only line endings', () => {
    const decoder = new LineDecoder();
    expect(decoder.push(encode('a\rb\r'))).toEqual(['a', 'b']);
    expect(decoder.flush()).toEqual([]);
  });

  it('produces exactly one empty line for "a\\r" followed by "\\r\\nb"', () => {
    const decoder = new LineDecoder();
    expect(decoder.push(encode('a\r'))).toEqual(['a']);
    expect(decoder.push(encode('\r\nb'))).toEqual(['']);
    expect(decoder.flush()).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// addr2line – '(gdb)' prompt must only match at the end of the response
// ---------------------------------------------------------------------------

describe.skipIf(isWindows)('addr2line – prompt boundary', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esp-decoder-a2l-'));
  const fakeGdbPath = path.join(tmpDir, 'fake-gdb.cjs');

  // Fake interactive GDB: emits a '(gdb) ' prompt after each command. Each
  // `list` response embeds a standalone '(gdb)' token mid-output, emitted
  // as a separate stdout event on the next tick so it really lands on a
  // transport chunk boundary. Each lookup gets a distinct location so the
  // test proves the second command still received its own response.
  fs.writeFileSync(
    fakeGdbPath,
    `#!/usr/bin/env node
const readline = require('readline');
process.stdout.write('Fake GNU gdb\\n(gdb) ');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.startsWith('list ')) {
    const addr = line.slice(5).trim();
    const num = parseInt(addr.replace('*', ''), 16);
    const file = '/src/main-' + num.toString(16) + '.c';
    const lineNo = (num & 0xff) + 1;
    process.stdout.write('note: token (gdb)', () => {
      setImmediate(() => {
        process.stdout.write(' appears mid-output\\n' + addr + ' is at ' + file + ':' + lineNo + '\\n(gdb) ');
      });
    });
  } else {
    process.stdout.write('OK\\n(gdb) ');
  }
});
`,
    { mode: 0o755 },
  );

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not terminate the response at a (gdb) token inside list output', async () => {
    // Two lookups: the second must still receive its own response after
    // the first one's embedded '(gdb)' token failed to fake a boundary.
    const results = await addr2line(
      { elfPath: '/nonexistent/firmware.elf', toolPath: fakeGdbPath },
      [0x40000000, 0x40000004],
    );

    expect(results).toHaveLength(2);
    // Each lookup resolved to its own distinct location — proving the
    // embedded '(gdb)' token did not truncate the first response and the
    // second command was still processed.
    const first = results[0]?.location as ParsedGDBLine | undefined;
    const second = results[1]?.location as ParsedGDBLine | undefined;
    expect(isParsedGDBLine(first)).toBe(true);
    expect(isParsedGDBLine(second)).toBe(true);
    expect(first?.file).toBe('/src/main-40000000.c');
    expect(first?.lineNumber).toBe('1');
    expect(second?.file).toBe('/src/main-40000004.c');
    expect(second?.lineNumber).toBe('5');
  }, 30_000);

  it('keeps the requested address when info line resolves to a range start', async () => {
    const infoGdbPath = path.join(tmpDir, 'info-gdb.cjs');
    fs.writeFileSync(
      infoGdbPath,
      `#!/usr/bin/env node
const readline = require('readline');
process.stdout.write('Fake GNU gdb\\n(gdb) ');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.startsWith('list ')) {
    process.stdout.write('No source available\\n(gdb) ');
  } else if (line.startsWith('info line ')) {
    process.stdout.write('Line 42 of \\\"/src/range.c\\\" starts at address 0x40000000\\n(gdb) ');
  } else {
    process.stdout.write('OK\\n(gdb) ');
  }
});
`,
      { mode: 0o755 },
    );

    const requested = 0x40000123;
    const [result] = await addr2line(
      { elfPath: '/nonexistent/firmware.elf', toolPath: infoGdbPath },
      [requested],
    );
    expect(result?.location).toMatchObject({
      regAddr: '0x40000123',
      file: '/src/range.c',
      lineNumber: '42',
    });
  });

  it('retains ENOENT on the friendly missing GDB error', async () => {
    const missingGdbPath = path.join(tmpDir, 'missing-gdb');
    await expect(
      addr2line({ elfPath: '/nonexistent/firmware.elf', toolPath: missingGdbPath }, [0x40000000]),
    ).rejects.toMatchObject({
      message: `GDB tool not found at ${missingGdbPath}`,
      code: 'ENOENT',
    });
  });

  it('rejects a missing ELF diagnostic delivered alongside the startup prompt', async () => {
    const badElfGdbPath = path.join(tmpDir, 'bad-elf-gdb.cjs');
    fs.writeFileSync(
      badElfGdbPath,
      `#!/usr/bin/env node
process.stderr.write('No such file or directory\\n');
process.stdout.write('Fake GNU gdb\\n(gdb) ');
process.stdin.resume();
`,
      { mode: 0o755 },
    );

    await expect(
      addr2line({ elfPath: '/missing/firmware.elf', toolPath: badElfGdbPath }, [0x40000000]),
    ).rejects.toThrow('The ELF file does not exist or is not readable: /missing/firmware.elf');
  });
});

describe('CrashCapturer – pending tail stays buffered', () => {
  it('emits the complete block at quiet period without flushing a partial line', async () => {
    const capturer = new CrashCapturer();
    const events: CrashEvent[] = [];
    const updates: CrashEvent[] = [];
    capturer.onCrashDetected((e) => events.push(e));
    capturer.onCrashUpdated((e) => updates.push(e));
    capturer.pushData(
      Buffer.from(
        'assert failed: pending_tail\n' +
          'Backtrace: 0x42000001:0x3ffb0001 0x42000002:0x3ffb0002\n' +
          'Rebooting...',
        'utf8',
      ),
    );
    // Quiet period (~500ms): the complete block emits provisionally; the
    // unterminated 'Rebooting...' tail is NOT flushed mid-line.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(events.length).toBe(1);
    expect(events[0].rawText).toContain('assert failed: pending_tail');
    expect(events[0].rawText).not.toContain('Rebooting');
    // Explicit flush completes the tail line; it joins the open block and
    // produces a richer update for the same event.
    capturer.flush();
    expect(updates.length).toBe(1);
    expect(updates[0].rawText).toContain('Rebooting...');
  }, 10_000);

  it('does not split a line that pauses mid-stream', async () => {
    const capturer = new CrashCapturer();
    const events: CrashEvent[] = [];
    capturer.onCrashDetected((e) => events.push(e));
    capturer.pushData(
      Buffer.from('assert failed: split\nBacktrace: 0x4200', 'utf8'),
    );
    // Wait well beyond the old 2.5s pending-line timeout: the partial
    // 'Backtrace: 0x4200' must stay buffered, not be emitted as a line.
    await new Promise((resolve) => setTimeout(resolve, 2800));
    expect(events.length).toBe(0);
    // The rest of the line arrives and completes the logical line intact.
    capturer.pushData(
      Buffer.from('4abc:0x3ffb0001\nRebooting...\n', 'utf8'),
    );
    capturer.flush();
    expect(events.length).toBe(1);
    expect(events[0].rawText).toContain('Backtrace: 0x42004abc:0x3ffb0001');
  }, 10_000);
});

describe('Capturer – block revisions', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('keeps count at 1 when a provisional block is enriched and finalized', async () => {
    const capturer = new Capturer({ quietPeriodMs: 50 });
    const detected: CapturerEvent[] = [];
    const updates: CapturerEvent[] = [];
    capturer.on('eventDetected', (e) => detected.push(e));
    capturer.on('eventUpdated', (e) => updates.push(e));

    capturer.push(
      Buffer.from('assert failed: revision_count\nBacktrace: 0x42000001:0x3ffb0001\n', 'utf8'),
    );
    // Quiet timer emits the complete block provisionally.
    await sleep(120);
    expect(detected).toHaveLength(1);
    expect(detected[0].count).toBe(1);

    // 'Rebooting...' finalizes the SAME framed block — a revision, not a
    // second occurrence.
    capturer.push(Buffer.from('Rebooting...\n', 'utf8'));
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe(detected[0].id);
    expect(updates[0].count).toBe(1);
    expect(updates[0].rawText).toContain('Rebooting...');
    capturer.dispose();
  });

  it('updates the same event even after the dedup window elapsed', async () => {
    const capturer = new Capturer({ quietPeriodMs: 50, dedupWindowMs: 1 });
    const detected: CapturerEvent[] = [];
    const updates: CapturerEvent[] = [];
    capturer.on('eventDetected', (e) => detected.push(e));
    capturer.on('eventUpdated', (e) => updates.push(e));

    capturer.push(
      Buffer.from('assert failed: slow_dump\nBacktrace: 0x42000001:0x3ffb0001\n', 'utf8'),
    );
    await sleep(120);
    expect(detected).toHaveLength(1);

    // Wait far beyond the 1 ms dedup window, then finalize the same block.
    await sleep(20);
    capturer.push(Buffer.from('Rebooting...\n', 'utf8'));
    expect(detected).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].count).toBe(1);
    capturer.dispose();
  });

  it('refreshes the detected kind when late register lines flip architecture', async () => {
    const capturer = new Capturer({ quietPeriodMs: 50 });
    const detected: CapturerEvent[] = [];
    const updates: CapturerEvent[] = [];
    capturer.on('eventDetected', (e) => detected.push(e));
    capturer.on('eventUpdated', (e) => updates.push(e));

    // Provisional emit before any RISC-V register lines: 'assert failed:'
    // classifies the block as xtensa.
    capturer.push(
      Buffer.from('assert failed: late_regs\nBacktrace: 0x42000001:0x3ffb0001\n', 'utf8'),
    );
    await sleep(120);
    expect(detected).toHaveLength(1);
    expect(detected[0].kind).toBe('xtensa');

    // Register lines arrive as continuation rows; the final emit reclassifies
    // the same block as riscv — still one event, kind updated in place.
    capturer.push(
      Buffer.from('MEPC    : 0x42004abc  MCAUSE  : 0x00000002\n', 'utf8'),
    );
    await sleep(120);
    capturer.push(Buffer.from('Rebooting...\n', 'utf8'));
    expect(detected).toHaveLength(1);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.at(-1)?.kind).toBe('riscv');
    expect(updates.at(-1)?.count).toBe(1);
    capturer.dispose();
  });

  it('waits for a pending register row to commit before consolidating the provisional event', async () => {
    const capturer = new Capturer({ quietPeriodMs: 50, dedupWindowMs: 60_000 });
    const removed: CapturerEvent[] = [];
    capturer.on('eventDetected', () => {});
    capturer.on('eventRemoved', (event) => removed.push(event));

    const first =
      "Core 0 panic'ed (Store access fault).\n" +
      'Core 0 register dump:\n' +
      'MEPC : 0x42000001\n' +
      'Backtrace: 0x42000001:0x3fc80000\n';
    capturer.push(Buffer.from(first, 'utf8'));
    capturer.flush();
    const finalizedId = capturer.getEvents()[0].id;

    // The repeat initially looks like Xtensa because its RISC-V register row
    // has not arrived yet, so it remains a provisional event of its own.
    capturer.push(Buffer.from(
      "Core 0 panic'ed (Store access fault).\n" +
        'Core 0 register dump:\n' +
        'Backtrace: 0x42000001:0x3fc80000\n',
      'utf8',
    ));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(capturer.getEvents()).toHaveLength(2);
    const provisionalId = capturer.getEvents().find((event) => event.id !== finalizedId)?.id;
    expect(provisionalId).toBeDefined();

    // The pending MEPC/MCAUSE row updates the preview and architecture, but
    // does not retire its ID or increment the finalized occurrence count.
    capturer.push(Buffer.from('MEPC : 0x42000001 MCAUSE : 0x00000007', 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pendingEvents = capturer.getEvents();
    expect(pendingEvents).toHaveLength(2);
    expect(pendingEvents.find((event) => event.id === provisionalId)?.kind).toBe('riscv');
    expect(pendingEvents.find((event) => event.id === finalizedId)?.count).toBe(1);
    expect(removed.some((event) => event.id === provisionalId)).toBe(false);

    // Once the row is committed, the matching finalized event absorbs the
    // occurrence and the provisional card is retired.
    capturer.push(Buffer.from('\n', 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = capturer.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(finalizedId);
    expect(events[0].count).toBe(2);
    expect(removed.some((event) => event.id === provisionalId)).toBe(true);
    capturer.dispose();
  });

  it('previews a complete pending Backtrace line without consuming its bytes', async () => {
    const capturer = new Capturer({ quietPeriodMs: 50 });
    const detected: CapturerEvent[] = [];
    const updates: CapturerEvent[] = [];
    capturer.on('eventDetected', (e) => detected.push(e));
    capturer.on('eventUpdated', (e) => updates.push(e));

    // The dump completes via 'Stack memory:' data; the trailing 'Backtrace:'
    // line arrives WITHOUT its terminator and must still preview into the
    // provisional event — its bytes stay buffered for the real line.
    capturer.push(
      Buffer.from(
        "Core 0 panic'ed (Illegal instruction)\n" +
          'Core 0 register dump:\n' +
          'MEPC    : 0x42004abc  MCAUSE  : 0x00000002\n' +
          'Stack memory:\n' +
          '3fc8f2d0: 0x00000000 0x00000000 0x00000000 0x00000000\n' +
          'Backtrace: 0x42004abc : 0x3fc8f2d0 0x42000001:0x3fc8f2e0',
        'utf8',
      ),
    );
    await sleep(120);
    expect(detected).toHaveLength(1);
    expect(detected[0].rawText).toContain('Backtrace: 0x42004abc : 0x3fc8f2d0');
    expect(detected[0].lightweight.regs?.MEPC).toBe(0x42004abc);

    // The terminator completes the SAME logical line — a revision, not a
    // new event and not a duplicated line.
    capturer.push(Buffer.from('\n', 'utf8'));
    await sleep(120);
    expect(detected).toHaveLength(1);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.at(-1)?.rawText.split('Backtrace:').length).toBe(2);
    capturer.dispose();
  });

  it('does not replace Xtensa registers with lines after Backtrace', async () => {
    const capturer = new Capturer({ quietPeriodMs: 50 });
    const detected: CapturerEvent[] = [];
    capturer.on('eventDetected', (e) => detected.push(e));

    // The dump's saved RA precedes Backtrace. A later unterminated register
    // line must not replace it because Backtrace closes this core's dump.
    capturer.push(
      Buffer.from(
        'assert failed: same_reason\n' +
          'RA      : 0x11111111\n' +
          'Backtrace: 0x400d1000:0x3ffb1000\n' +
          'RA      : 0x4200',
        'utf8',
      ),
    );
    await sleep(120);
    expect(detected).toHaveLength(1);
    expect(detected[0].lightweight.regs?.RA).toBe(0x11111111);

    // Completing that later line must keep the original crash register and
    // remain a revision of the same block.
    capturer.push(Buffer.from('1234\nRebooting...\n', 'utf8'));
    await sleep(120);
    capturer.flush();
    await sleep(80);

    expect(detected).toHaveLength(1);
    expect(capturer.getEvents()).toHaveLength(1);
    expect(capturer.getEvents()[0].lightweight.regs?.RA).toBe(0x11111111);
    capturer.dispose();
  });

  it('retains the first observed RA as dedup evidence without displaying it', async () => {
    const capturer = new Capturer({ quietPeriodMs: 50 });
    const detected: CapturerEvent[] = [];
    capturer.on('eventDetected', (e) => detected.push(e));

    const dump = (raLine: string | undefined, stackRows: number) =>
      "Core 0 panic'ed (Illegal instruction)\n" +
      'Core 0 register dump:\n' +
      'MEPC    : 0x42004abc  SP      : 0x3fc80000\n' +
      'MCAUSE  : 0x00000002  MTVAL   : 0x00000000\n' +
      (raLine ? `${raLine}\n` : '') +
      'Stack memory:\n' +
      Array.from(
        { length: stackRows },
        (_, i) =>
          `3fc8${(i * 0x10).toString(16).padStart(4, '0')}: 0x00000000 0x00000000 0x00000000 0x00000000`,
      ).join('\n') +
      '\nBacktrace: 0x42004abc:0x3fc80000\n';

    const flush = async () => {
      capturer.flush();
      await sleep(80);
    };

    // Event A: no RA reported. Event B: same crash + RA, shorter capture —
    // merges without becoming the display snapshot, RA kept as evidence.
    capturer.push(Buffer.from(dump(undefined, 3), 'utf8'));
    await flush();
    capturer.push(Buffer.from(dump('RA      : 0x11111111', 1), 'utf8'));
    await flush();
    expect(detected).toHaveLength(1);
    // getEvents() reflects merges; emitted snapshots are frozen at emit time.
    expect(capturer.getEvents()).toHaveLength(1);
    expect(capturer.getEvents()[0].count).toBe(2);
    // Display snapshot still has no RA — evidence stays internal.
    expect(capturer.getEvents()[0].lightweight.regs?.RA).toBeUndefined();

    // Event C: same crash but a DIFFERENT RA — must not merge into the
    // event whose retained evidence says 0x11111111.
    capturer.push(Buffer.from(dump('RA      : 0x99999999', 1), 'utf8'));
    await flush();
    expect(capturer.getEvents()).toHaveLength(2);
    expect(capturer.getEvents()[1].count).toBe(1);
    capturer.dispose();
  });

  it('splits a provisional cross-block match when later evidence conflicts', async () => {
    const capturer = new Capturer({ quietPeriodMs: 50, dedupWindowMs: 60_000 });
    capturer.on('eventDetected', () => {});
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Event A: Xtensa crash with a two-frame printed backtrace.
    capturer.push(
      Buffer.from(
        'assert failed: same_reason\n' +
          'Backtrace: 0x400d1000:0x3ffb1000 0x400d2000:0x3ffb2000\n',
        'utf8',
      ),
    );
    capturer.flush();
    await sleep(80);
    expect(capturer.getEvents()).toHaveLength(1);

    // Block B: same reason + a prefix of A's backtrace — provisionally
    // dedups into event A via the fingerprint path while still open.
    capturer.push(
      Buffer.from('assert failed: same_reason\nBacktrace: 0x400d1000:0x3ffb1000\n', 'utf8'),
    );
    await sleep(120);
    expect(capturer.getEvents()).toHaveLength(1);
    expect(capturer.getEvents()[0].count).toBe(2);

    // B's block revises with a conflicting second frame — the provisional
    // match was wrong: B must split into its own event instead of
    // rewriting A's snapshot.
    capturer.push(Buffer.from('Backtrace: 0x400d3000:0x3ffb3000\n', 'utf8'));
    await sleep(120);
    capturer.push(Buffer.from('Rebooting...\n', 'utf8'));
    capturer.flush();
    await sleep(80);

    const events = capturer.getEvents();
    expect(events).toHaveLength(2);
    // B's provisional merge contributed +1 to A's count; the split must
    // roll it back — two distinct crashes count as two, not three.
    expect(events[0].count).toBe(1);
    expect(events[1].count).toBe(1);
    expect(events[1].lightweight.backtraceAddrs).toContain(0x400d3000);
    expect(events[0].lightweight.backtraceAddrs).toEqual([0x400d1000, 0x400d2000]);
    capturer.dispose();
  });

  it('restores the remaining block’s capture when a display-owning merge splits', async () => {
    const capturer = new Capturer({ quietPeriodMs: 50, dedupWindowMs: 60_000 });
    capturer.on('eventDetected', () => {});
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Event A: two-frame backtrace with RA — becomes its own event.
    capturer.push(
      Buffer.from(
        'assert failed: shared_reason\n' +
          'Core 0 register dump:\n' +
          'PC      : 0x400d1000  RA      : 0x11111111\n' +
          'Backtrace: 0x400d1000:0x3ffb1000 0x400d2000:0x3ffb2000\n',
        'utf8',
      ),
    );
    capturer.flush();
    await sleep(80);
    expect(capturer.getEvents()).toHaveLength(1);

    // Block B: compatible prefix plus a third frame — richer, so it takes
    // over the display snapshot via the fingerprint merge (count=2).
    capturer.push(
      Buffer.from(
        'assert failed: shared_reason\n' +
          'Core 0 register dump:\n' +
          'PC      : 0x400d1000\n' +
          'Backtrace: 0x400d1000:0x3ffb1000 0x400d2000:0x3ffb2000 0x400d3000:0x3ffb3000\n',
        'utf8',
      ),
    );
    await sleep(120);
    expect(capturer.getEvents()).toHaveLength(1);
    expect(capturer.getEvents()[0].count).toBe(2);
    expect(capturer.getEvents()[0].rawText).toContain('0x400d3000');

    // B revises with a conflicting PC in a new core dump section — the
    // provisional merge was wrong. B splits out and event A must revert to
    // its own capture: lines, registers, backtrace, and count all roll back.
    capturer.push(
      Buffer.from('Core 0 register dump:\nPC      : 0x400d9999\n', 'utf8'),
    );
    await sleep(120);
    capturer.push(Buffer.from('Rebooting...\n', 'utf8'));
    capturer.flush();
    await sleep(80);

    const events = capturer.getEvents();
    expect(events).toHaveLength(2);
    const [a, b] = events;
    expect(a.count).toBe(1);
    expect(a.rawText).toContain('RA      : 0x11111111');
    expect(a.rawText).not.toContain('0x400d3000');
    expect(a.lightweight.regs?.RA).toBe(0x11111111);
    expect(a.lightweight.backtraceAddrs).toEqual([0x400d1000, 0x400d2000]);
    expect(b.count).toBe(1);
    expect(b.lightweight.programCounter).toBe(0x400d9999);
    expect(b.lightweight.backtraceAddrs).toContain(0x400d3000);
    capturer.dispose();
  });

  it('preserves the richer display snapshot when a shorter duplicate is revised', async () => {
    const capturer = new Capturer({ quietPeriodMs: 50, dedupWindowMs: 60_000 });
    capturer.on('eventDetected', () => {});
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const rich =
      "Core 0 panic'ed (Store access fault). Exception was unhandled.\n" +
      'Core 0 register dump:\n' +
      'MEPC    : 0x42000001  MCAUSE  : 0x00000007\n' +
      'RA      : 0x11111111  SP      : 0x3fc80000\n' +
      'Stack memory:\n' +
      '3fc80000: 0x00000000 0x00000000 0x00000000 0x00000000\n' +
      '3fc80010: 0x00000000 0x00000000 0x00000000 0x00000000\n' +
      'Backtrace: 0x42000001:0x3ffb0001 0x42000002:0x3ffb0002\n';
    const poor =
      "Core 0 panic'ed (Store access fault). Exception was unhandled.\n" +
      'Core 0 register dump:\n' +
      'MEPC    : 0x42000001  MCAUSE  : 0x00000007\n' +
      'Backtrace: 0x42000001:0x3ffb0001\n';

    // Rich occurrence becomes event E and owns the display snapshot.
    capturer.push(Buffer.from(rich, 'utf8'));
    await sleep(120);
    expect(capturer.getEvents()).toHaveLength(1);

    // Poorer duplicate dedups into E (count=2) but does not take over the
    // display — it stays provisional and can still be revised.
    capturer.push(Buffer.from(poor, 'utf8'));
    await sleep(120);
    expect(capturer.getEvents()).toHaveLength(1);
    expect(capturer.getEvents()[0].count).toBe(2);
    expect(capturer.getEvents()[0].rawText).toContain('Stack memory:');

    // The poor block revises with one more compatible Backtrace pair —
    // still shorter than the rich display, so the snapshot must NOT be
    // replaced by it.
    capturer.push(Buffer.from('Backtrace: 0x42000002:0x3ffb0002\n', 'utf8'));
    await sleep(120);

    const event = capturer.getEvents()[0];
    expect(capturer.getEvents()).toHaveLength(1);
    expect(event.count).toBe(2);
    expect(event.rawText).toContain('Stack memory:');
    expect(event.lines).toContain('3fc80010: 0x00000000 0x00000000 0x00000000 0x00000000');
    expect(event.lightweight.regs?.RA).toBe(0x11111111);
    capturer.dispose();
  });

});
describe('GdbMiClient – close()', () => {
  const isWindows = process.platform === 'win32';
  let tmpDir: string;
  let fakeGdbPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdbmi-close-'));
    fakeGdbPath = path.join(tmpDir, 'fake-gdb.sh');
    fs.writeFileSync(
      fakeGdbPath,
      '#!/usr/bin/env node\nprocess.stdin.resume();\n',
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(isWindows)(
    'rejects pending and subsequent commands on close',
    async () => {
      const client = new GdbMiClient(fakeGdbPath, []);
      const pending = client.sendCommand('-version');
      const pendingAssertion = expect(pending).rejects.toThrow('GDB client closed');
      client.close();
      await pendingAssertion;
      await expect(client.sendCommand('-version')).rejects.toThrow('GDB client closed');
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// LineDecoder – oversized line handling
// ---------------------------------------------------------------------------

describe('LineDecoder – oversized lines', () => {
  const encode = (s: string) => new TextEncoder().encode(s);
  const BIG = 'x'.repeat(70 * 1024); // > 64 KiB MAX_LINE_LENGTH

  it('drops a complete oversized line delivered in a single chunk', () => {
    const decoder = new LineDecoder();
    const lines = decoder.push(encode(`${BIG}\nok\n`));
    expect(lines).toEqual(['ok']);
  });

  it('ends discard mode when the oversized line terminator arrives alone', () => {
    const decoder = new LineDecoder();
    // No delimiter: the tail exceeds the limit and enters discard mode.
    expect(decoder.push(encode(BIG))).toEqual([]);
    // The LF that terminates the oversized line must end discard mode —
    // the next valid line has to survive.
    expect(decoder.push(encode('\n'))).toEqual([]);
    expect(decoder.push(encode('ok\n'))).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------
// gdbLineParse – GDB 'No line number information' keeps the symbol name
// ---------------------------------------------------------------------------

describe('parseLine – symbol without line info', () => {
  it('preserves the symbol from "No line number information available"', () => {
    const parsed = parseLine(
      'No line number information available for address 0x400d1234 <app_main+0x10>',
    );
    expect(parsed).toBeDefined();
    expect(isParsedGDBLine(parsed!)).toBe(true);
    const line = parsed as ParsedGDBLine;
    expect(line.method).toBe('app_main');
    expect(line.file).toBe('??');
    expect(line.lineNumber).toBe('??');
  });

  it('captures template names through their inner closing bracket', () => {
    const parsed = parseLine(
      'No line number information available for address 0x400d5678 <ns::worker<int>()+16>',
    );
    expect(parsed).toBeDefined();
    const line = parsed as ParsedGDBLine;
    // Trailing '+16' offset stripped; the template's inner '>' must not
    // truncate the symbol at 'ns::worker<int'.
    expect(line.method).toContain('ns::worker<int>');
    expect(line.file).toBe('??');
    expect(line.lineNumber).toBe('??');
  });

  it('keeps parentheses inside template arguments as part of the symbol', () => {
    const parsed = parseLine(
      '0x400d5678 in ns::worker<void (int)()>() at /fw/main.cpp:42',
    );
    expect(parsed).toBeDefined();
    const line = parsed as ParsedGDBLine;
    // Only the top-level '()' is the argument list — '(int)' inside the
    // template argument must not truncate the symbol name.
    expect(line.method).toBe('ns::worker<void (int)()>');
    expect(line.file).toBe('/fw/main.cpp');
    expect(line.lineNumber).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// GdbMiClient – terminal ^exit record without a following prompt
// ---------------------------------------------------------------------------

describe('GdbMiClient – ^exit without prompt', () => {
  const isWindows = process.platform === 'win32';
  let tmpDir: string;
  let fakeGdbPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdbmi-exit-'));
    fakeGdbPath = path.join(tmpDir, 'fake-gdb.cjs');
    // Emits the handshake prompt, then answers every command with a bare
    // '^exit' record and no '(gdb)' prompt — like -gdb-exit does.
    fs.writeFileSync(
      fakeGdbPath,
      `#!/usr/bin/env node
const readline = require('readline');
process.stdout.write('Fake GNU gdb\\n(gdb) ');
readline.createInterface({ input: process.stdin }).on('line', () => {
  process.stdout.write('^exit\\n');
});
`,
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(isWindows)('settles a pending command on ^exit', async () => {
    const client = new GdbMiClient(fakeGdbPath, []);
    try {
      await client.drainHandshake();
      await expect(client.sendCommand('-gdb-exit')).resolves.toContain('^exit');
    } finally {
      client.close();
    }
  }, 15_000);

  it.skipIf(isWindows)(
    'settles the terminal command when the child exits right after ^exit',
    async () => {
      // The child answers '-gdb-exit' with '^exit' and exits immediately —
      // the 'exit' event can race the final stdout chunk, so the response
      // must still settle the command before pending work is rejected.
      const exitGdbPath = path.join(tmpDir, 'fake-gdb-exit.cjs');
      fs.writeFileSync(
        exitGdbPath,
        `#!/usr/bin/env node
const readline = require('readline');
process.stdout.write('Fake GNU gdb\\n(gdb) ');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  process.stdout.write('^exit\\n', () => {
    if (line.includes('-gdb-exit')) { process.exit(0); }
  });
});
`,
        { mode: 0o755 },
      );
      const client = new GdbMiClient(exitGdbPath, []);
      try {
        await client.drainHandshake();
        await expect(client.sendCommand('-gdb-exit')).resolves.toContain('^exit');
      } finally {
        client.close();
      }
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// GdbMiClient – controlled child event order (exit → ^exit → close)
// ---------------------------------------------------------------------------

describe('GdbMiClient – controlled exit event order', () => {
  interface FakeGdbChild extends EventEmitter {
    killed: boolean;
    kill(): void;
    stdout: EventEmitter & { setEncoding(encoding: string): void };
    stderr: EventEmitter & { setEncoding(encoding: string): void };
    stdin: EventEmitter & { write(chunk: string): boolean; end(): void };
  }

  function makeFakeChild() {
    const child = new EventEmitter() as unknown as FakeGdbChild;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    const stdout = new EventEmitter() as FakeGdbChild['stdout'];
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter() as FakeGdbChild['stderr'];
    stderr.setEncoding = () => {};
    const stdin = new EventEmitter() as FakeGdbChild['stdin'];
    stdin.write = () => true;
    stdin.end = () => {};
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    return { child, stdout, stdin };
  }

  it('settles the terminal command on post-exit stdout and rejects unanswered work', async () => {
    const { child, stdout, stdin } = makeFakeChild();
    const written: string[] = [];
    stdin.write = (cmd: string) => {
      written.push(cmd);
      return true;
    };

    const client = new GdbMiClient('fake-gdb', [], {
      spawnProcess: (() => child) as unknown as typeof cp.spawn,
    });
    try {
      stdout.emit('data', 'Fake GNU gdb\n(gdb) ');
      await client.drainHandshake();

      const terminal = client.sendCommand('-gdb-exit');
      const unanswered = client.sendCommand('-stack-list-frames');
      const unansweredAssertion = expect(unanswered).rejects.toThrow(
        'GDB exited unexpectedly',
      );

      // Controlled order — 'exit' first, then the buffered '^exit' record
      // on stdout, then 'close'. No reliance on the write callback.
      child.emit('exit', 0, null);
      stdout.emit('data', '^exit\n');
      child.emit('close');

      await expect(terminal).resolves.toContain('^exit');
      await unansweredAssertion;
      // The queued command was never dispatched to the dead child.
      expect(written).toEqual(['-gdb-exit\n']);
    } finally {
      client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// gdbStubMain – memory reads partially overlapping the captured stack
// ---------------------------------------------------------------------------

describe('gdbStubMain – partial stack reads', () => {
  const nodeRequire = createRequire(import.meta.url);
  const { Stub } = nodeRequire('../panic/gdbStubMain.js') as {
    Stub: new (info: {
      stackBaseAddr: number;
      stackData: Buffer;
      regs: Record<string, number>;
    }) => { out: string; respondMem(addr: number, size: number): void };
  };

  const mkStub = () =>
    new Stub({
      stackBaseAddr: 0x1000,
      stackData: Buffer.from([0x11, 0x22, 0x33, 0x44]),
      regs: {},
    });
  const packetData = (out: string) => out.replace(/^\$/, '').replace(/#[0-9a-f]{2}$/, '');

  it('rejects reads that only partially overlap the captured stack', () => {
    const stub = mkStub();
    stub.respondMem(0xffe, 8); // spans the stack start
    expect(packetData(stub.out)).toBe('E01');
    stub.out = '';
    stub.respondMem(0x1002, 4); // runs past the stack end
    expect(packetData(stub.out)).toBe('E01');
  });

  it('returns real bytes inside the capture and E01 for wholly outside reads', () => {
    const stub = mkStub();
    stub.respondMem(0x1000, 4);
    expect(packetData(stub.out)).toBe('11223344');
    stub.out = '';
    stub.respondMem(0x2000, 4);
    expect(packetData(stub.out)).toBe('E01');
  });
});

// ---------------------------------------------------------------------------
// CrashFramer – provisional quiet-period emit keeps the block open
// ---------------------------------------------------------------------------

describe('CrashFramer – provisional quiet flush', () => {
  it('only recognizes a stack marker at the start of a trimmed line', () => {
    const assertionOnly = new CrashFramer(500);
    assertionOnly.pushLine('assert failed: text mentions >>>stack>>> here', 0);
    expect(assertionOnly.flush(1000)).toEqual([]);

    const standaloneMarker = new CrashFramer(500);
    standaloneMarker.pushLine('assert failed: stack dump follows', 1100);
    standaloneMarker.pushLine('  >>>stack>>>', 1110);
    const partial = standaloneMarker.flush(2000);
    expect(partial).toHaveLength(1);
    expect(partial[0].lines).toContain('  >>>stack>>>');
  });

  it('only treats a leading ELF checksum marker as complete', () => {
    const embedded = new CrashFramer(500);
    embedded.pushLine('assert failed: checksum text', 0);
    embedded.pushLine('assertion mentions ELF file SHA256: deadbeef', 10);
    expect(embedded.flush(1000, true)).toEqual([]);

    const standalone = new CrashFramer(500);
    standalone.pushLine('assert failed: checksum record', 0);
    standalone.pushLine(' elf FILE SHA256: deadbeef', 10);
    expect(standalone.flush(1000, true)).toHaveLength(1);
  });

  it('keeps the block open for continuation rows after a quiet emit', () => {
    const framer = new CrashFramer(500);
    framer.pushLine('assert failed: boom', 0);
    framer.pushLine('Backtrace: 0x42000001:0x3ffb0001', 10);

    // Quiet-period emit reports the complete block but keeps it open.
    const first = framer.flush(1000, true);
    expect(first).toHaveLength(1);
    expect(first[0].lines).toContain('Backtrace: 0x42000001:0x3ffb0001');

    // No new rows → no duplicate emit.
    expect(framer.flush(1500, true)).toEqual([]);

    // A late stack row (even indented) joins the still-open block.
    expect(framer.pushLine('  40800000: 0x42000000 0x42000001', 1600)).toEqual([]);
    const second = framer.flush(1700, true);
    expect(second).toHaveLength(1);
    expect(second[0].lines.length).toBeGreaterThan(first[0].lines.length);
    expect(second[0].lines).toContain('  40800000: 0x42000000 0x42000001');
  });

  it('closes a provisional block on an unrelated line without re-emitting', () => {
    const framer = new CrashFramer(500);
    framer.pushLine('assert failed: boom', 0);
    framer.pushLine('Backtrace: 0x42000001:0x3ffb0001', 10);
    expect(framer.flush(1000, true)).toHaveLength(1);

    // Unrelated output ends the provisional block silently.
    expect(framer.pushLine('normal log line', 1100)).toEqual([]);
    // Explicit flush must not emit the unchanged provisional block again.
    expect(framer.flush(1200)).toEqual([]);

    // A subsequent crash starts a fresh block.
    framer.pushLine('assert failed: second', 1300);
    framer.pushLine('Backtrace: 0x42000009:0x3ffb0009', 1310);
    const out = framer.flush(2000, true);
    expect(out).toHaveLength(1);
    expect(out[0].lines[0]).toBe('assert failed: second');
  });

  it('accepts section headers as continuation lines of a multi-core dump', () => {
    const framer = new CrashFramer(500);
    framer.pushLine("Core 0 panic'ed (Store access fault)", 0);
    framer.pushLine('Backtrace: 0x42000001:0x3ffb0001', 10);
    expect(framer.flush(1000, true)).toHaveLength(1);

    // The second core's dump belongs to the same crash — its header and
    // rows must join the still-open block instead of closing it.
    expect(framer.pushLine('Core 1 register dump:', 1100)).toEqual([]);
    expect(framer.pushLine('MEPC    : 0x42100001', 1110)).toEqual([]);
    const out = framer.flush(2000, true);
    expect(out).toHaveLength(1);
    expect(out[0].lines).toContain('Core 1 register dump:');
    expect(out[0].lines).toContain('MEPC    : 0x42100001');
  });

  it('emits pending continuation rows when an unrelated line closes the block', () => {
    const framer = new CrashFramer(500);
    framer.pushLine('assert failed: dirty_close', 0);
    framer.pushLine('Backtrace: 0x42000001:0x3ffb0001', 10);
    expect(framer.flush(1000, true)).toHaveLength(1);

    // Continuation row arrives (dirty, not yet emitted), then unrelated
    // output closes the block — the row must reach the decoder.
    expect(framer.pushLine('  40800000: 0x42000000 0x42000001', 1100)).toEqual([]);
    const out = framer.pushLine('normal log line', 1200);
    expect(out).toHaveLength(1);
    expect(out[0].lines).toContain('  40800000: 0x42000000 0x42000001');
  });

  it('starts a fresh block for an assertion that mentions Backtrace mid-line', () => {
    const framer = new CrashFramer(500);
    framer.pushLine('assert failed: first', 0);
    framer.pushLine('Backtrace: 0x42000001:0x3ffb0001', 10);
    expect(framer.flush(1000, true)).toHaveLength(1);

    // The mid-line 'Backtrace:' mention is diagnostic text, not a
    // continuation row, so the assertion starts its own block.
    expect(
      framer.pushLine('assert failed: second crash Backtrace: 0x42000009:0x3ffb0009', 1100),
    ).toEqual([]);
    framer.pushLine('Backtrace: 0x42000009:0x3ffb0009', 1110);
    const out = framer.flush(2000, true);
    expect(out).toHaveLength(1);
    expect(out[0].lines[0]).toBe('assert failed: second crash Backtrace: 0x42000009:0x3ffb0009');
  });

  it('keeps a provisional block open across blank separator lines', () => {
    const framer = new CrashFramer(500);
    framer.pushLine("Core 0 panic'ed (Store access fault)", 0);
    framer.pushLine('Backtrace: 0x42000001:0x3ffb0001', 10);
    expect(framer.flush(1000, true)).toHaveLength(1);

    // Blank lines carry no information — they must not close the block
    // before the next core's dump header arrives.
    expect(framer.pushLine('', 1100)).toEqual([]);
    expect(framer.pushLine('   ', 1110)).toEqual([]);
    expect(framer.pushLine('Core 1 register dump:', 1200)).toEqual([]);
    const out = framer.flush(2000, true);
    expect(out).toHaveLength(1);
    expect(out[0].lines).toContain('Core 1 register dump:');
  });
});

// ---------------------------------------------------------------------------
// parseRiscvPanicDetailed – whitespace-tolerant core dump headers
// ---------------------------------------------------------------------------

describe('parseRiscvPanicOutput – bare-hex stack words', () => {
  it('parses stack memory rows whose words lack 0x prefixes', () => {
    const text = [
      'Core 0 register dump:',
      'MEPC    : 0x42004abc  MCAUSE  : 0x00000002',
      'Stack memory:',
      '3fc8f2d0: 00000000 00000000 00000000 00000000 42004abc 00000000 00000000 00000000',
    ].join('\n');
    const info = parseRiscvPanicOutput(text);
    expect(info.stackBaseAddr).toBe(0x3fc8f2d0);
    expect(info.stackData.length).toBe(32);
  });

  it('stops accepting stack rows once Backtrace: is reached', () => {
    const text = [
      'Core 0 register dump:',
      'MEPC    : 0x42004abc  MCAUSE  : 0x00000002',
      'Stack memory:',
      '3fc8f2d0: 00000000 00000000 00000000 00000000',
      'Backtrace: 0x42004abc:0x3fc8f2d0',
      // Looks like a stack row but follows the Backtrace — must be ignored.
      '3fc8f310: 11111111 11111111 11111111 11111111',
    ].join('\n');
    const result = parseRiscvPanicDetailed(text);
    expect(result.stackDump).toHaveLength(1);
    expect(result.stackDump[0].data).toEqual([0, 0, 0, 0]);
  });

  it('keeps a zero stack base and checks contiguity after it', () => {
    const contiguous = parseRiscvPanicOutput([
      'Core 0 register dump:',
      'MEPC : 0x42004abc',
      'Stack memory:',
      '00000000: 0x00000001',
      '00000004: 0x00000002',
    ].join('\n'));
    expect(contiguous.stackBaseAddr).toBe(0);
    expect(contiguous.stackData.length).toBe(8);

    const gap = parseRiscvPanicOutput([
      'Core 0 register dump:',
      'MEPC : 0x42004abc',
      'Stack memory:',
      '00000000: 0x00000001',
      '00000008: 0x00000002',
    ].join('\n'));
    expect(gap.stackBaseAddr).toBe(0);
    expect(gap.stackData.length).toBe(0);
  });

  it('rejects rows with glued or truncated stack-word tokens', () => {
    const text = [
      'Core 0 register dump:',
      'MEPC    : 0x42004abc  MCAUSE  : 0x00000002',
      'Stack memory:',
      // '000000000x1111' glues two words without whitespace — invalid row.
      '3fc8f2d0: 000000000x1111 00000000',
      // Trailing non-hex junk invalidates the whole row.
      '3fc8f2f0: 00000000 deadbeef xyz',
    ].join('\n');
    const result = parseRiscvPanicDetailed(text);
    expect(result.stackDump).toHaveLength(0);
  });
});

describe('parseRiscvPanicDetailed – indented dump headers', () => {
  it('parses an indented Core register dump header', () => {
    const text = [
      '  Core 1 register dump:',
      'MEPC    : 0x42100001  MCAUSE  : 0x00000002',
    ].join('\n');
    const result = parseRiscvPanicDetailed(text);
    expect(result.regDumps).toHaveLength(1);
    expect(result.regDumps[0].coreId).toBe(1);
    expect(result.regDumps[0].regs.MEPC).toBe(0x42100001);
  });
});

describe('parseRiscvPanicDetailed – post-backtrace section close', () => {
  it('ignores register fields after Backtrace until the next core header', () => {
    const text = [
      'Core 0 register dump:',
      'MEPC    : 0x42001000  MCAUSE  : 0x00000002',
      'Stack memory:',
      '3fc80000: 0x00000000 0x00000000',
      'Backtrace: 0x42001000:0x3ffb0001',
      // Later diagnostics must not overwrite the crash registers.
      'MEPC    : 0xdeadbeef  MCAUSE  : 0xffffffff',
      'Core 1 register dump:',
      'MEPC    : 0x42101000  MCAUSE  : 0x00000005',
    ].join('\n');
    const parsed = parseRiscvPanicDetailed(text);
    const core0 = parsed.regDumps.find((d) => d.coreId === 0);
    const core1 = parsed.regDumps.find((d) => d.coreId === 1);
    expect(core0?.regs.MEPC).toBe(0x42001000);
    expect(core0?.faultCode).toBe(0x00000002);
    expect(core1?.regs.MEPC).toBe(0x42101000);
    expect(core1?.faultCode).toBe(0x00000005);
  });

  it('rejects stack rows containing words wider than 32 bits', () => {
    const text = [
      'Core 0 register dump:',
      'MEPC    : 0x42001000',
      'Stack memory:',
      '3fc80000: 0x00000000 0x100000000 0x00000000',
      '3fc80010: 0x00000000 0x00000000 0x00000000 0x00000000',
    ].join('\n');
    const parsed = parseRiscvPanicDetailed(text);
    expect(parsed.stackDump).toHaveLength(1);
    expect(parsed.stackDump[0].baseAddr).toBe(0x3fc80010);
    expect(parsed.stackDump[0].data).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// decodeRiscv – printed Backtrace attribution & stack-dump precedence
// ---------------------------------------------------------------------------

describe('extractPrintedBacktraceAddrs – multi-core', () => {
  const multiCore = [
    'Core 0 register dump:',
    'MEPC    : 0x42001000  MCAUSE  : 0x00000002',
    'Backtrace: 0x42000001:0x3ffb0001 0x42000002:0x3ffb0002',
    'Core 1 register dump:',
    'MEPC    : 0x42101000  MCAUSE  : 0x00000002',
    'Backtrace: 0x42100001:0x3ffb1001 0x42100002:0x3ffb1002',
  ].join('\n');

  it('collects only the selected core\'s printed backtrace', () => {
    expect(extractPrintedBacktraceAddrs(multiCore, 0)).toEqual([0x42000001, 0x42000002]);
    expect(extractPrintedBacktraceAddrs(multiCore, 1)).toEqual([0x42100001, 0x42100002]);
  });

  it('collects every Backtrace line when no core headers exist', () => {
    const single = 'Backtrace: 0x42000001:0x3ffb0001\nBacktrace: 0x42000002:0x3ffb0002';
    expect(extractPrintedBacktraceAddrs(single, 0)).toEqual([0x42000001, 0x42000002]);
  });

  it('attributes backtraces per core with CR-only line endings', () => {
    const crText = [
      'Core 0 register dump:',
      'MEPC    : 0x42001000  MCAUSE  : 0x00000002',
      'Backtrace: 0x42000001:0x3ffb0001 0x42000002:0x3ffb0002',
      'Core 1 register dump:',
      'MEPC    : 0x42101000  MCAUSE  : 0x00000002',
      'Backtrace: 0x42100001:0x3ffb1001 0x42100002:0x3ffb1002',
    ].join('\r');
    expect(extractPrintedBacktraceAddrs(crText, 0)).toEqual([0x42000001, 0x42000002]);
    expect(extractPrintedBacktraceAddrs(crText, 1)).toEqual([0x42100001, 0x42100002]);
  });
});

describe('printedBacktraceApplies', () => {
  it('applies when printed PCs exist and the stack has no recoverable frame chain', () => {
    expect(printedBacktraceApplies([0x42000001], Buffer.alloc(0))).toBe(true);
    expect(printedBacktraceApplies([], Buffer.alloc(0))).toBe(false);
    // Below MIN_UNWIND_STACK_BYTES (64) the printed backtrace stays better.
    expect(printedBacktraceApplies([0x42000001], Buffer.alloc(16))).toBe(true);
    expect(printedBacktraceApplies([0x42000001], Buffer.alloc(32))).toBe(true);
    expect(printedBacktraceApplies([], Buffer.alloc(16))).toBe(false);
    // A large but contentless dump cannot be unwound either — the size
    // threshold alone must not suppress the printed PCs.
    expect(printedBacktraceApplies([0x42000001], Buffer.alloc(64))).toBe(true);
    expect(printedBacktraceApplies([0x42000001], Buffer.alloc(256))).toBe(true);
  });

  it('defers to the MI unwind only when the stack holds recoverable frame candidates', () => {
    // Two code-space words (saved ra candidates) in a >=64-byte dump.
    const chain = Buffer.alloc(64);
    chain.writeUInt32LE(0x42001000, 12);
    chain.writeUInt32LE(0x42102000, 44);
    expect(printedBacktraceApplies([0x42000001], chain)).toBe(false);
    // A single code-space word is not a recoverable chain.
    const single = Buffer.alloc(64);
    single.writeUInt32LE(0x42001000, 12);
    expect(printedBacktraceApplies([0x42000001], single)).toBe(true);
    // Data pointers outside the code range do not count either.
    const dataOnly = Buffer.alloc(64);
    dataOnly.writeUInt32LE(0x3fc80000, 12);
    dataOnly.writeUInt32LE(0x3fc81000, 44);
    expect(printedBacktraceApplies([0x42000001], dataOnly)).toBe(true);
  });

  it('a Stack memory dump keeps the MI unwind authoritative', () => {
    const text = [
      'Core 0 register dump:',
      'MEPC    : 0x42001000  MCAUSE  : 0x00000002',
      'Stack memory:',
      '3fc80000: 0x00000000 0x42000001 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000',
      '3fc80020: 0x00000000 0x42000009 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000',
      '3fc80040: 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000 0x00000000',
      'Backtrace: 0x42000001:0x3ffb0001',
    ].join('\n');
    const info = parseRiscvPanicOutput(text);
    const printed = extractPrintedBacktraceAddrs(text, info.coreId);
    expect(printed.length).toBeGreaterThan(0);
    expect(info.stackData.length).toBeGreaterThan(0);
    expect(printedBacktraceApplies(printed, info.stackData)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decodeCrash – raw fallback must not mix cores
// ---------------------------------------------------------------------------

describe('decodeCrash – raw fallback core isolation', () => {
  const MISSING_CORE_DUMP = [
    "Core  1 panic'ed (Store access fault). Exception was unhandled.",
    '',
    'Core  0 register dump:',
    'MEPC    : 0x42000001  RA      : 0x42000002  SP      : 0x3fc80000',
    'MCAUSE  : 0x00000007  MTVAL   : 0x3fc80002  MHARTID : 0x00000000',
    '',
    'Stack memory:',
    '3fc80000: 0x00000000 0x400d1234 0x00000000 0x00000000',
    '',
    'Backtrace: 0x42000001:0x3ffb0001 0x42000002:0x3ffb0002',
  ].join('\n');

  const BOTH_CORES = [
    "Core  1 panic'ed (Store access fault). Exception was unhandled.",
    '',
    'Core  0 register dump:',
    'MEPC    : 0x42000001  MCAUSE  : 0x00000007',
    '',
    'Core  1 register dump:',
    'MEPC    : 0x42100001  MCAUSE  : 0x0000000b  MTVAL   : 0x3fc90002',
    '',
    'Backtrace: 0x42100001:0x3ffb1001',
  ].join('\n');

  function makeEvent(rawText: string, kind: 'xtensa' | 'riscv' | 'unknown' = 'riscv'): CrashEvent {
    return {
      id: 'test-raw-core',
      kind,
      lines: rawText.split('\n').filter((l) => l.trim().length > 0),
      rawText,
      timestamp: Date.now(),
    };
  }

  it('omits another core\'s registers and frames when the named core dump is missing', async () => {
    const decoded = await decodeCrash(
      makeEvent(MISSING_CORE_DUMP),
      ELF_PATH,
      '/nonexistent/riscv32-esp-elf-gdb',
      'esp32s31',
    );
    expect(decoded.faultInfo?.coreId).toBe(1);
    expect(decoded.faultInfo?.programCounter).toBeUndefined();
    expect(decoded.faultInfo?.faultCode).toBeUndefined();
    expect(decoded.faultInfo?.faultAddr).toBeUndefined();
    expect(decoded.regs).toBeUndefined();
    expect(decoded.stacktrace).toEqual([]);
    // The raw capture is preserved for display.
    expect(decoded.rawOutput).toContain('Core  0 register dump:');
  });

  it('keeps structured data when the named core dump is present', async () => {
    const decoded = await decodeCrash(
      makeEvent(BOTH_CORES),
      ELF_PATH,
      '/nonexistent/riscv32-esp-elf-gdb',
      'esp32s31',
    );
    expect(decoded.faultInfo?.coreId).toBe(1);
    expect(decoded.regs?.['MEPC']).toBe(0x42100001);
    expect(decoded.stacktrace.length).toBeGreaterThan(0);
  });

  it('recognizes the RISC-V S0/FP register without relying on shared A0', async () => {
    const text = [
      'Core 0 register dump:',
      'S0/FP : 0x3fc80000',
    ].join('\n');
    const decoded = await decodeCrash(
      makeEvent(text),
      ELF_PATH,
      '/nonexistent/riscv32-esp-elf-gdb',
      'esp32s31',
    );
    expect(decoded.regs?.['S0/FP']).toBe(0x3fc80000);
  });

  it('does not take selected-core fault registers from diagnostics after Backtrace', async () => {
    const text = [
      "Core 0 panic'ed (Store access fault). Exception was unhandled.",
      'Core 0 register dump:',
      'MEPC : 0x42000001  MCAUSE : 0x00000007  MTVAL : 0x3fc80002',
      'Backtrace: 0x42000001:0x3ffb0001',
      'diagnostic MTVAL : 0xdeadbeef MCAUSE : 0xffffffff',
    ].join('\n');
    const decoded = await decodeCrash(
      makeEvent(text),
      ELF_PATH,
      '/nonexistent/riscv32-esp-elf-gdb',
      'esp32s31',
    );
    expect(decoded.faultInfo?.faultAddr).toBe('0x3fc80002');
    expect(decoded.faultInfo?.faultCode).toBe(0x7);
  });

  it('suppresses another core\'s registers for a sectioned Xtensa dump with a missing selected core', async () => {
    // 'Core 1 panic'ed but only core 0's dump arrived — the raw fallback
    // must keep the fault header without attributing core 0's registers
    // or backtrace PCs to core 1.
    const text = [
      "Guru Meditation Error: Core  1 panic'ed (Store access fault). Exception was unhandled.",
      '',
      'Core  0 register dump:',
      'PC       : 0x400d1234  EXCCAUSE: 0x0000001d',
      'Backtrace: 0x400d1234:0x3ffb0001',
    ].join('\n');
    const decoded = await decodeCrash(
      makeEvent(text, 'xtensa'),
      ELF_PATH,
      '/nonexistent/xtensa-esp32-elf-gdb',
      'esp32',
    );
    expect(decoded.faultInfo?.coreId).toBe(1);
    expect(decoded.faultInfo?.programCounter).toBeUndefined();
    expect(decoded.regs).toBeUndefined();
    expect(decoded.stacktrace).toEqual([]);
    expect(decoded.rawOutput).toContain('Core  0 register dump:');
  });
});

// ---------------------------------------------------------------------------
// decodeCrash – raw fallback selects the panicking core's data
// ---------------------------------------------------------------------------

describe('decodeCrash – raw fallback selected-core extraction', () => {
  const dumpSection = (core: number, mepc: string, mcause: string, bt: string) =>
    [
      `Core  ${core} register dump:`,
      `MEPC    : ${mepc}  RA      : 0x${(parseInt(mepc, 16) + 1).toString(16)}  SP      : 0x3fc8${core}000`,
      `MCAUSE  : ${mcause}  MTVAL   : 0x00000000`,
      '',
      'Stack memory:',
      `3fc8${core}000: 0x00000000 0x00000000 0x00000000 0x00000000`,
      '',
      bt,
    ].join('\n');

  const makeTwoCoreText = (core0First: boolean) => {
    const core0 = dumpSection(0, '0x42000001', '0x00000007', 'Backtrace: 0x42000001:0x3ffb0001 0x42000009:0x3ffb0009');
    const core1 = dumpSection(1, '0x42100001', '0x0000000b', 'Backtrace: 0x42100001:0x3ffb1001 0x42100009:0x3ffb1009');
    return [
      "Core  1 panic'ed (Store access fault). Exception was unhandled.",
      '',
      core0First ? core0 : core1,
      '',
      core0First ? core1 : core0,
    ].join('\n');
  };

  function makeEvent(rawText: string, kind: 'xtensa' | 'riscv' | 'unknown' = 'riscv'): CrashEvent {
    return {
      id: 'test-selected-core',
      kind,
      lines: rawText.split('\n').filter((l) => l.trim().length > 0),
      rawText,
      timestamp: Date.now(),
    };
  }

  for (const core0First of [true, false]) {
    it(`extracts only core 1's registers and PCs (core0 ${core0First ? 'first' : 'second'})`, async () => {
      const decoded = await decodeCrash(
        makeEvent(makeTwoCoreText(core0First)),
        ELF_PATH,
        '/nonexistent/riscv32-esp-elf-gdb',
        'esp32s31',
      );
      expect(decoded.faultInfo?.coreId).toBe(1);
      expect(decoded.regs?.['MEPC']).toBe(0x42100001);
      expect(decoded.regs?.['MCAUSE']).toBe(0xb);
      expect(decoded.faultInfo?.programCounter).toBe('0x42100001');
      expect(decoded.faultInfo?.faultCode).toBe(0xb);
      expect(decoded.faultInfo?.faultAddr).toBe('0x00000000');
      const addresses = decoded.stacktrace.map((f) => f.address.toLowerCase());
      expect(addresses).toEqual(['0x42100001', '0x42100009']);
      expect(addresses).not.toContain('0x42000001');
      expect(addresses).not.toContain('0x42000009');
    });
  }

  it('preserves unsectioned Xtensa registers and printed PC in the raw fallback', async () => {
    // No 'Core N register dump:' sections — the missing-dump guard must
    // not suppress this capture's own registers and backtrace.
    const text = [
      "Guru Meditation Error: Core  0 panic'ed (LoadProhibited). Exception was unhandled.",
      'PC      : 0x400d1234  PS      : 0x00060030  A0      : 0x3ffb0001',
      'EXCVADDR: 0x3ffb0004  EXCCAUSE: 0x0000000c',
      'Backtrace: 0x400d1234:0x3ffb0001 0x400d5678:0x3ffb0002',
    ].join('\n');
    const decoded = await decodeCrash(
      makeEvent(text, 'xtensa'),
      ELF_PATH,
      '/nonexistent/xtensa-esp-elf-gdb',
      'esp32',
    );
    expect(decoded.regs?.['PC']).toBe(0x400d1234);
    expect(decoded.regs?.['EXCVADDR']).toBe(0x3ffb0004);
    const addresses = decoded.stacktrace.map((f) => f.address.toLowerCase());
    expect(addresses).toContain('0x400d1234');
    expect(addresses).toContain('0x400d5678');
  });
});

// ---------------------------------------------------------------------------
// parseXtensaPanicOutput – ESP8266 fallback guard
// ---------------------------------------------------------------------------

describe('parseXtensaPanicOutput – named-core header guard', () => {
  it('does not fall back to ESP8266 parsing for a core-named panic header', () => {
    // A 'Guru Meditation Error: Core N' header marks ESP32-format output;
    // even when the named core has no data, the ESP8266 parser must not
    // attribute its fields (epc1, >>>stack>>> rows) to this capture.
    const text = [
      "Guru Meditation Error: Core  0 panic'ed (LoadProhibited). Exception was unhandled.",
      'Core 1 register dump:',
      'PC      : 0x400d1111  PS      : 0x00060030',
      '',
      'Exception (28):',
      'epc1=0x4020e41c epc2=0x00000000',
    ].join('\n');
    const parsed = parseXtensaPanicOutput(text);
    expect(parsed.coreId).toBe(0);
    expect(Object.keys(parsed.regs)).toHaveLength(0);
    expect(parsed.backtraceAddrs).toHaveLength(0);
    expect(parsed.programCounter).toBeUndefined();
  });

  it('still falls back to ESP8266 parsing without a core-named header', () => {
    const parsed = parseXtensaPanicOutput(ESP8266_CRASH_TEXT);
    expect(parsed.programCounter).toBeDefined();
    expect(Object.keys(parsed.regs).length).toBeGreaterThan(0);
  });
});

describe('parseESP32PanicOutput – abort header PC', () => {
  it('uses the abort header PC when the selected core has no captured PC register', () => {
    const parsed = parseESP32PanicOutput([
      'abort() was called at PC 0x40081234 on core 1',
      'Core 1 register dump:',
      'EXCCAUSE: 0x0000001d',
    ].join('\n'));
    expect(parsed.programCounter).toBe(0x40081234);
  });

  it('keeps the captured PC register ahead of the abort header PC', () => {
    const parsed = parseESP32PanicOutput([
      'abort() was called at PC 0x40081234 on core 1',
      'Core 1 register dump:',
      'PC: 0x40085678',
    ].join('\n'));
    expect(parsed.programCounter).toBe(0x40085678);
  });
});

describe('ESP8266 stack row parsing', () => {
  it('accepts only complete eight-digit words with or without the prefix', () => {
    expect(parseStackDataRow('3fc80000: 0x00004200 00004200')).toEqual({
      baseAddr: 0x3fc80000,
      data: [0x4200, 0x4200],
    });
    expect(parseStackDataRow('3fc80000: 0x4200')).toBeUndefined();
  });

  it('reads stack rows only inside the ESP8266 marked stack block', () => {
    const parsed = parseESP8266PanicOutput([
      '3fff10b0: 4021a5d4 00000033',
      '>>>stack>>>',
      '3fff10b0: 4021a5d4 00000033',
      '<<<stack<<<',
      '3fff10b8: 4021b000 00000044',
    ].join('\n'));
    expect(parsed.backtraceAddrs).toEqual([0x4021a5d4]);
  });
});

describe('CrashFramer – Backtrace continuation rows', () => {
  it('does not continue on a line that only mentions Backtrace later in the text', () => {
    const framer = new CrashFramer(1000);
    framer.pushLine('assert failed: first', 0);
    framer.pushLine('Backtrace: 0x40000001:0x3ffb0001', 1);
    expect(framer.flush(1000, true)).toHaveLength(1);

    framer.pushLine('diagnostic mentions Backtrace: 0x40000002', 1001);
    expect(framer.activeBlockId()).toBeUndefined();
    framer.pushLine('assert failed: second', 1002);
    expect(framer.peekActiveBlock()?.lines).toEqual(['assert failed: second']);
  });
});

// ---------------------------------------------------------------------------
// parseRiscvPanicOutput – stack row gaps
// ---------------------------------------------------------------------------

describe('parseRiscvPanicOutput – stack row gaps', () => {
  it('marks the stack unavailable on a row gap but keeps registers', () => {
    const text = [
      'Core 0 register dump:',
      'MEPC    : 0x42004abc  MCAUSE  : 0x00000002',
      'Stack memory:',
      '3fc8f2d0: 00000000 00000000 00000000 00000000',
      // Gap: expected next row at 0x3fc8f2e0, this one starts at 0x3fc8f2f0.
      '3fc8f2f0: 00000000 00000000 00000000 00000000',
    ].join('\n');
    const info = parseRiscvPanicOutput(text);
    expect(info.regs['MEPC']).toBe(0x42004abc);
    expect(info.stackData.length).toBe(0);
  });

  it('keeps contiguous stacks on the existing unwind path', () => {
    const text = [
      'Core 0 register dump:',
      'MEPC    : 0x42004abc  MCAUSE  : 0x00000002',
      'Stack memory:',
      '3fc8f2d0: 00000000 00000000 00000000 00000000',
      '3fc8f2e0: 00000000 00000000 00000000 00000000',
    ].join('\n');
    const info = parseRiscvPanicOutput(text);
    expect(info.stackBaseAddr).toBe(0x3fc8f2d0);
    expect(info.stackData.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// parseLine – frame arguments split at the first '=' only
// ---------------------------------------------------------------------------

describe('parseLine – argument values containing equals signs', () => {
  it('keeps the full value when an argument contains additional equals signs', () => {
    const parsed = parseLine(
      '0x400d5678 in worker(count=1, blob=a=b=c) at /fw/main.cpp:42',
    ) as ParsedGDBLine;
    expect(parsed.method).toBe('worker');
    expect(parsed.args).toEqual([
      { name: 'count', value: '1' },
      { name: 'blob', value: 'a=b=c' },
    ]);
  });

  it('parses symbols containing operator< and templates', () => {
    const parsed = parseLine(
      'No line number information available for address 0x400d1234 <foo::operator<(int)+0x10>',
    ) as ParsedGDBLine;
    expect(parsed.method).toBe('foo::operator<');
    expect(parsed.regAddr).toBe('0x400d1234');
  });

  it('preserves args when line/file info is missing', () => {
    const parsed = parseLine(
      '0x400d5678 in worker(count=1, blob=test)',
    ) as ParsedGDBLine;
    expect(parsed.method).toBe('worker');
    expect(parsed.args).toEqual([
      { name: 'count', value: '1' },
      { name: 'blob', value: 'test' },
    ]);
  });
});

describe('RISC-V MI frame and argument selection', () => {
  it('prefers current values regardless of tuple order and labels entry fallbacks', () => {
    const current = { name: 'value', value: 'current' };
    const entry = { name: 'value@entry', value: 'entry' };
    expect(dedupeArgs([entry, current])).toEqual([{ name: 'value', value: 'current' }]);
    expect(dedupeArgs([current, entry])).toEqual([{ name: 'value', value: 'current' }]);
    expect(dedupeArgs([{ name: 'value@entry', value: 'entry' }])).toEqual([
      { name: 'value@entry', value: 'entry' },
    ]);
    expect(dedupeArgs([
      { name: 'value', value: '<optimized out>' },
      { name: 'value@entry', value: 'entry' },
    ])).toEqual([{ name: 'value@entry', value: 'entry' }]);
  });

  it('counts only MI frames with a resolved method or file', () => {
    expect(countResolvedMiFrames([
      { regAddr: '0x42000001', lineNumber: '??' },
      { regAddr: '0x42000002', lineNumber: '12', method: '??', file: '??' },
      { regAddr: '0x42000003', lineNumber: '??', method: 'worker', file: '??' },
      { regAddr: '0x42000004', lineNumber: '??', method: '??', file: 'main.c' },
    ])).toBe(2);
  });
});

describe('abort core extraction', () => {
  it('extracts core from abort() header for Xtensa', () => {
    const text = 'abort() was called at PC 0x40081234 on core 1\nCore 1 register dump:\nPC: 0x40081234';
    const parsed = parseESP32PanicOutput(text);
    expect(parsed.coreId).toBe(1);
  });

  it('extracts core from abort() header for RISC-V', () => {
    const text = 'abort() was called at PC 0x42001234 on core 1\nCore 1 register dump:\nMEPC: 0x42001234';
    const parsed = parseRiscvPanicDetailed(text);
    expect(parsed.panicCoreId).toBe(1);
  });
});

describe('gdbStubMain – missing register encoding', () => {
  const nodeRequire = createRequire(import.meta.url);
  const { Stub } = nodeRequire('../panic/gdbStubMain.js') as {
    Stub: new (info: {
      stackBaseAddr: number;
      stackData: Buffer;
      regs: Record<string, number>;
    }) => { out: string; respondRegs(): void; handleCommand(buffer: string): void; flush(): void };
  };

  it('encodes missing registers with eight x characters', () => {
    const stub = new Stub({
      stackBaseAddr: 0,
      stackData: Buffer.alloc(0),
      regs: { RA: 0x42001234 },
    });
    stub.respondRegs();
    const packet = stub.out.replace(/^\$/, '').replace(/#[0-9a-f]{2}$/, '');
    expect(packet.startsWith('00000000')).toBe(true);
    expect(packet).toContain('xxxxxxxx');
  });

  it('ends the thread list after returning the available thread', () => {
    const stub = new Stub({
      stackBaseAddr: 0,
      stackData: Buffer.alloc(0),
      regs: {},
    });
    stub.flush = () => {};
    stub.handleCommand('$qfThreadInfo#00');
    expect(stub.out).toContain('$m1#');
    stub.out = '';
    stub.handleCommand('$qsThreadInfo#00');
    expect(stub.out).toContain('$l#');
  });
});

// ---------------------------------------------------------------------------
// GdbStubServer – Windows remote spec must survive MI c-string parsing
// ---------------------------------------------------------------------------

import { fetchStacktraceWithMi } from '../panic/decodeRiscv.js';
import type { DecodeParams, PanicInfoWithStackData } from '../panic/types.js';

describe('GdbStubServer – Windows remote spec', () => {
  it('passes the direct exec spec to target-select unchanged', async () => {
    const prevElectronNode = process.env.ELECTRON_RUN_AS_NODE;
    const platformSpy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    const sendSpy = vi
      .spyOn(GdbMiClient.prototype, 'sendCommand')
      .mockResolvedValue('^done\n');
    const handshakeSpy = vi.spyOn(GdbMiClient.prototype, 'drainHandshake').mockResolvedValue(undefined);
    const closeSpy = vi.spyOn(GdbMiClient.prototype, 'close').mockResolvedValue(undefined);
    try {
      const panicInfo: PanicInfoWithStackData = {
        coreId: 0,
        programCounter: 0x40000000,
        regs: {},
        stackBaseAddr: 0,
        stackData: Buffer.alloc(0),
      };
      // fetchStacktraceWithMi builds its own stub + MI client; the mocked
      // platform makes buildRemoteSpec emit a direct-exec spec (no cmd.exe
      // wrapper), so paths with & are passed literally.
      const stdout = Object.assign(new EventEmitter(), {
        setEncoding: () => {},
      });
      const stderr = Object.assign(new EventEmitter(), {
        setEncoding: () => {},
      });
      const stdin = Object.assign(new EventEmitter(), {
        write: () => true,
        end: () => {},
      });
      const child = Object.assign(new EventEmitter(), {
        killed: false,
        pid: undefined,
        exitCode: null,
        signalCode: null,
        stdout,
        stderr,
        stdin,
        kill: () => true,
      }) as unknown as cp.ChildProcess;
      let childEnv: NodeJS.ProcessEnv | undefined;
      const spawnProcess = ((_command: string, _args: string[], spawnOptions: { env?: NodeJS.ProcessEnv }) => {
        childEnv = spawnOptions.env;
        return child;
      }) as unknown as typeof cp.spawn;
      const params = { elfPath: '/nonexistent.elf', toolPath: 'fake-gdb' } as DecodeParams;
      await fetchStacktraceWithMi(
        params,
        panicInfo,
        { spawnProcess },
        () => {},
      );

      const targetCmd = sendSpy.mock.calls
        .map((c) => c[0])
        .find((c) => c.startsWith('-target-select remote '));
      expect(targetCmd).toBeDefined();
      const spec = targetCmd!.slice('-target-select remote '.length);
      // The spec must NOT route through cmd.exe — paths with & are safe.
      expect(spec).not.toContain('cmd.exe');
      expect(spec).not.toContain(' /d /c ');
      // The spec's embedded quotes must reach GDB unescaped.
      expect(spec.startsWith('|"')).toBe(true);
      // The flag belongs to the GDB child environment, not the host process.
      expect(childEnv?.ELECTRON_RUN_AS_NODE).toBe('1');
      expect(process.env.ELECTRON_RUN_AS_NODE).toBe(prevElectronNode);
    } finally {
      sendSpy.mockRestore();
      handshakeSpy.mockRestore();
      closeSpy.mockRestore();
      platformSpy.mockRestore();
    }
  });
});

describe('Capturer – retained PC evidence prevents conflict merges', () => {
  it('preserves initial fault PC as evidence when a richer PC-less snapshot replaces display', () => {
    const capturer = new Capturer({ dedupWindowMs: 5000 });
    const detected: CapturerEvent[] = [];
    const updated: CapturerEvent[] = [];
    capturer.on('eventDetected', (e) => detected.push(e));
    capturer.on('eventUpdated', (e) => updated.push(e));

    const enc = (s: string) => new TextEncoder().encode(s);

    // Crash 1: Has fault PC 0x42000001 (via MEPC) and short backtrace
    capturer.push(
      enc(
        "Core 0 panic'ed (Load access fault)\n" +
          'Core 0 register dump:\n' +
          'MCAUSE  : 0x00000005\n' +
          'MEPC    : 0x42000001\n' +
          'RA      : 0x42000001\n' +
          'Backtrace: 0x42000001:0x3ffb0001\n\n',
      ),
    );
    capturer.flush();
    expect(detected).toHaveLength(1);
    expect(detected[0].lightweight.programCounter).toBe(0x42000001);

    // Crash 2: Merges into Crash 1. Richer (longer backtrace + stack rows) but lacks MEPC/fault PC row
    capturer.push(
      enc(
        "Core 0 panic'ed (Load access fault)\n" +
          'Core 0 register dump:\n' +
          'MCAUSE  : 0x00000005\n' +
          'RA      : 0x42000001\n' +
          'Backtrace: 0x42000001:0x3ffb0001 0x42000002:0x3ffb0002 0x42000003:0x3ffb0003\n' +
          'Stack memory:\n' +
          '3fc80000: 0x00000000 0x00000000\n\n',
      ),
    );
    capturer.flush();
    expect(detected).toHaveLength(1);
    expect(updated).toHaveLength(1);
    // Display snapshot was replaced by the richer candidate which has no programCounter
    expect(updated[0].lightweight.programCounter).toBeUndefined();

    // Crash 3: Same signature prefix (Backtrace: 0x42000001:0x3ffb0001...) but reports conflicting MEPC 0x42009999
    capturer.push(
      enc(
        "Core 0 panic'ed (Load access fault)\n" +
          'Core 0 register dump:\n' +
          'MCAUSE  : 0x00000005\n' +
          'MEPC    : 0x42009999\n' +
          'RA      : 0x42000001\n' +
          'Backtrace: 0x42000001:0x3ffb0001\n\n',
      ),
    );
    capturer.flush();

    // Retained PC evidence (0x42000001) must prevent Crash 3 (0x42009999) from merging!
    expect(detected).toHaveLength(2);
    expect(detected[1].id).not.toBe(detected[0].id);
    expect(detected[1].lightweight.programCounter).toBe(0x42009999);
  });
});

describe('decodeCoredumpFile – thread attribution and error resilience', () => {
  it('reports the thread-selection error when no thread can be decoded', async () => {
    const handshakeSpy = vi.spyOn(GdbMiClient.prototype, 'drainHandshake').mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(GdbMiClient.prototype, 'sendCommand').mockImplementation(async (cmd: string) => {
      if (cmd === '-thread-info') {
        return '^done,threads=[{id="1",target-id="process 100"}]\n';
      }
      if (cmd === '-thread-select 1') {
        return '^error,msg="Thread ID 1 not known."\n';
      }
      return '^done\n';
    });
    const closeSpy = vi.spyOn(GdbMiClient.prototype, 'close').mockResolvedValue(undefined);

    try {
      await expect(decodeCoredumpFile(
        { elfPath: '/dummy.elf', toolPath: 'fake-gdb' } as DecodeParams,
        '/dummy-coredump.elf',
        {},
        false,
      )).rejects.toThrow('Thread 1: thread selection failed');
    } finally {
      sendSpy.mockRestore();
      handshakeSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('preserves the thread-selection error when raw ELF repair fails', async () => {
    const handshakeSpy = vi.spyOn(GdbMiClient.prototype, 'drainHandshake').mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(GdbMiClient.prototype, 'sendCommand').mockImplementation(async (cmd: string) => {
      if (cmd === '-thread-info') {
        return '^done,threads=[{id="1",target-id="process 100"}]\n';
      }
      if (cmd === '-thread-select 1') {
        return '^error,msg="Thread ID 1 not known."\n';
      }
      return '^done\n';
    });
    const closeSpy = vi.spyOn(GdbMiClient.prototype, 'close').mockResolvedValue(undefined);

    try {
      await expect(decodeCoredumpFile(
        { elfPath: '/dummy.elf', toolPath: 'fake-gdb' } as DecodeParams,
        '/missing-coredump-for-repair.elf',
        {},
        true,
      )).rejects.toThrow('Thread 1: thread selection failed');
    } finally {
      sendSpy.mockRestore();
      handshakeSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('preserves the no-thread error when a warning callback is supplied', async () => {
    const handshakeSpy = vi.spyOn(GdbMiClient.prototype, 'drainHandshake').mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(GdbMiClient.prototype, 'sendCommand').mockResolvedValue('^done,threads=[]\n');
    const closeSpy = vi.spyOn(GdbMiClient.prototype, 'close').mockResolvedValue(undefined);
    const warnings: string[] = [];
    try {
      await expect(decodeCoredumpFile(
        { elfPath: '/dummy.elf', toolPath: 'fake-gdb' } as DecodeParams,
        '/dummy-coredump.elf',
        { onWarning: (warning) => warnings.push(warning) },
        false,
      )).rejects.toThrow('GDB core load returned no thread entries');
      expect(warnings).toContain('GDB core load returned no thread entries');
    } finally {
      sendSpy.mockRestore();
      handshakeSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('attempts enabled coredump repair before closing GDB and preserves the no-thread error', async () => {
    const calls: string[] = [];
    const handshakeSpy = vi.spyOn(GdbMiClient.prototype, 'drainHandshake').mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(GdbMiClient.prototype, 'sendCommand').mockImplementation(async (cmd: string) => {
      calls.push(`send:${cmd}`);
      return '^done,threads=[]\n';
    });
    const closeSpy = vi.spyOn(GdbMiClient.prototype, 'close').mockImplementation(async () => {
      calls.push('close');
    });

    try {
      await expect(decodeCoredumpFile(
        { elfPath: '/dummy.elf', toolPath: 'fake-gdb' } as DecodeParams,
        ELF_PATH,
        {},
        true,
      )).rejects.toThrow('GDB core load returned no thread entries');
      const threadInfoIndexes = calls.flatMap((call, index) => call === 'send:-thread-info' ? [index] : []);
      const firstCloseIndex = calls.indexOf('close');
      expect(threadInfoIndexes).toHaveLength(2);
      expect(threadInfoIndexes[1]).toBeLessThan(firstCloseIndex);
    } finally {
      sendSpy.mockRestore();
      handshakeSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('skips thread on thread-select failure and does not attribute previous thread frames', async () => {
    const handshakeSpy = vi.spyOn(GdbMiClient.prototype, 'drainHandshake').mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(GdbMiClient.prototype, 'sendCommand').mockImplementation(async (cmd: string) => {
      if (cmd === '-thread-info') {
        return '^done,threads=[{id="1",target-id="process 100"},{id="2",target-id="process 200"}],current-thread-id="1"\n';
      }
      if (cmd === '-thread-select 1') {
        return '^done\n';
      }
      if (cmd === '-thread-select 2') {
        return '^error,msg="Thread ID 2 not known."\n';
      }
      if (cmd === '-data-list-register-names') {
        return '^done,register-names=["pc","sp"]\n';
      }
      if (cmd === '-data-list-register-values x') {
        return '^done,register-values=[{number="0",value="0x40001000"}]\n';
      }
      if (cmd === '-stack-list-frames') {
        return '^done,stack=[frame={level="0",addr="0x40001000",func="app_main",file="main.c",line="10"}]\n';
      }
      if (cmd.startsWith('-stack-list-arguments')) {
        return '^done,stack-args=[frame={level="0",args=[{name="arg1",value="42"}]}]\n';
      }
      return '^done\n';
    });
    const closeSpy = vi.spyOn(GdbMiClient.prototype, 'close').mockResolvedValue(undefined);

    try {
      const results = await decodeCoredumpFile(
        { elfPath: '/dummy.elf', toolPath: 'fake-gdb' } as DecodeParams,
        '/dummy-coredump.elf',
        {},
        false,
      );

      // Thread 2 failed -thread-select so only Thread 1 should be returned
      expect(results).toHaveLength(1);
      expect(results[0].threadId).toBe('1');
      expect(results[0].TCB).toBe(100);
      expect(results[0].threadName).toBeUndefined();
      const frame0 = results[0].result.stacktraceLines[0] as ParsedGDBLine;
      expect(frame0.method).toBe('app_main');
    } finally {
      sendSpy.mockRestore();
      handshakeSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('recovers thread stack frames when stack-list-arguments command fails or GDB terminates', async () => {
    const handshakeSpy = vi.spyOn(GdbMiClient.prototype, 'drainHandshake').mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(GdbMiClient.prototype, 'sendCommand').mockImplementation(async (cmd: string) => {
      if (cmd === '-thread-info') {
        return '^done,threads=[{id="1",target-id="process 100"}],current-thread-id="1"\n';
      }
      if (cmd === '-thread-select 1') {
        return '^done\n';
      }
      if (cmd === '-data-list-register-names') {
        return '^done,register-names=["pc"]\n';
      }
      if (cmd === '-data-list-register-values x') {
        return '^done,register-values=[{number="0",value="0x40001000"}]\n';
      }
      if (cmd === '-stack-list-frames') {
        return '^done,stack=[frame={level="0",addr="0x40001000",func="recovered_func",file="crash.c",line="25"}]\n';
      }
      if (cmd.startsWith('-stack-list-arguments')) {
        throw new Error('GDB exited unexpectedly (code=1, signal=null)');
      }
      return '^done\n';
    });
    const closeSpy = vi.spyOn(GdbMiClient.prototype, 'close').mockResolvedValue(undefined);

    try {
      const results = await decodeCoredumpFile(
        { elfPath: '/dummy.elf', toolPath: 'fake-gdb' } as DecodeParams,
        '/dummy-coredump.elf',
        {},
        false,
      );

      // Stack frames were recovered even though stack-list-arguments failed with exception
      expect(results).toHaveLength(1);
      expect(results[0].threadId).toBe('1');
      expect(results[0].result.stacktraceLines).toHaveLength(1);
      const frame0 = results[0].result.stacktraceLines[0] as ParsedGDBLine;
      expect(frame0.method).toBe('recovered_func');
      expect(frame0.lineNumber).toBe('25');
      expect(frame0.args).toEqual([]);
    } finally {
      sendSpy.mockRestore();
      handshakeSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('extracts thread entries with non-standard target-id strings', async () => {
    const handshakeSpy = vi.spyOn(GdbMiClient.prototype, 'drainHandshake').mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(GdbMiClient.prototype, 'sendCommand').mockImplementation(async (cmd: string) => {
      if (cmd === '-thread-info') {
        return '^done,threads=[{id="1",target-id="Thread 0x3ffb0000",name="main"},{id="2",target-id="Remote target",name="worker"}],current-thread-id="1"\n';
      }
      if (cmd.startsWith('-thread-select')) {
        return '^done\n';
      }
      if (cmd === '-data-list-register-names') {
        return '^done,register-names=["pc"]\n';
      }
      if (cmd === '-data-list-register-values x') {
        return '^done,register-values=[{number="0",value="0x40001000"}]\n';
      }
      if (cmd === '-stack-list-frames') {
        return '^done,stack=[frame={level="0",addr="0x40001000",func="task_fn"}]\n';
      }
      if (cmd.startsWith('-stack-list-arguments')) {
        return '^done,stack-args=[]\n';
      }
      return '^done\n';
    });
    const closeSpy = vi.spyOn(GdbMiClient.prototype, 'close').mockResolvedValue(undefined);

    try {
      const results = await decodeCoredumpFile(
        { elfPath: '/dummy.elf', toolPath: 'fake-gdb' } as DecodeParams,
        '/dummy-coredump.elf',
        {},
        false,
      );

      // Both threads were extracted and decoded despite non-standard target-id
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.threadId)).toEqual(['1', '2']);
      expect(results.map((r) => r.threadName)).toEqual(['main', 'worker']);
    } finally {
      sendSpy.mockRestore();
      handshakeSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('reports thread skip, frame failure, and early termination via onWarning and result warning', async () => {
    const handshakeSpy = vi.spyOn(GdbMiClient.prototype, 'drainHandshake').mockResolvedValue(undefined);
    const sendSpy = vi.spyOn(GdbMiClient.prototype, 'sendCommand').mockImplementation(async (cmd: string) => {
      if (cmd === '-thread-info') {
        return '^done,threads=[{id="1",target-id="process 100"},{id="2",target-id="process 200"},{id="3",target-id="process 300"}],current-thread-id="1"\n';
      }
      if (cmd === '-thread-select 1') {
        return '^error,msg="Thread 1 unavailable"\n';
      }
      if (cmd === '-thread-select 2') {
        return '^done\n';
      }
      if (cmd === '-data-list-register-names') {
        return '^done,register-names=["pc"]\n';
      }
      if (cmd === '-data-list-register-values x') {
        return '^done,register-values=[{number="0",value="0x40001000"}]\n';
      }
      if (cmd === '-stack-list-frames') {
        return '^error,msg="Frame unwind error"\n';
      }
      if (cmd.startsWith('-stack-list-arguments')) {
        return '^done,stack-args=[]\n';
      }
      if (cmd === '-thread-select 3') {
        throw new Error('GDB crashed');
      }
      return '^done\n';
    });
    const closeSpy = vi.spyOn(GdbMiClient.prototype, 'close').mockResolvedValue(undefined);

    const warnings: string[] = [];
    try {
      const results = await decodeCoredumpFile(
        { elfPath: '/dummy.elf', toolPath: 'fake-gdb' } as DecodeParams,
        '/dummy-coredump.elf',
        { onWarning: (w) => warnings.push(w) },
        false,
      );

      // Thread 1 was skipped, Thread 2 succeeded with warning, Thread 3 failed and broke loop
      expect(results).toHaveLength(1);
      expect(results[0].threadId).toBe('2');
      expect(results[0].warning).toContain('Frame unwind error');
      expect(warnings.some((w) => w.includes('thread selection failed'))).toBe(true);
      expect(warnings.some((w) => w.includes('stack-list-frames failed'))).toBe(true);
      expect(warnings.some((w) => w.includes('decode failed or terminated early'))).toBe(true);
    } finally {
      sendSpy.mockRestore();
      handshakeSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });
});
