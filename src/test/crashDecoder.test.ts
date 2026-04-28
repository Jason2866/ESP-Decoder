/**
 * Unit tests for ESP32-C6 crash detection and decoding.
 *
 * Fixtures:
 *   esp32c6_assert.txt  – real serial output captured from an ESP32-C6
 *                         that crashed with "assert failed: npl_freertos_event_init"
 *   firmware.elf        – the matching firmware ELF with debug symbols
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
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
import type { CrashEvent } from '../crashDecoder.js';
import { getPioPackagesDir } from '../pioIntegration.js';
import { registerSets } from '../vendor/trbr/decode/regs.js';
import { gdbRegsInfoRiscvIlp32 } from '../vendor/trbr/decode/riscvPanicParse.js';

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

describe('TrbrCrashCapturer – ESP8266 exception crash', () => {
  let capturer: TrbrCrashCapturer;

  beforeEach(() => {
    capturer = new TrbrCrashCapturer();
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
// Regression: ESP32 Guru Meditation captured via trbr native path
// ---------------------------------------------------------------------------

describe('TrbrCrashCapturer – ESP32 Guru Meditation (trbr native path)', () => {
  let capturer: TrbrCrashCapturer;

  beforeEach(() => {
    capturer = new TrbrCrashCapturer();
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

  it('detects the crash via trbr (not fallback)', () => {
    const event = feedCrashText(capturer, GURU_CRASH);
    expect(event).toBeDefined();
    // trbr-native events have numeric IDs (e.g. "000001"), not "fallback-..." prefixed
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

  it('extracts Exception 28 as LoadProhibited fault message', async () => {
    const event = makeEsp8266CrashEvent();
    const decoded = await decodeCrash(event, '/nonexistent/firmware.elf', '/nonexistent/gdb', 'xtensa');

    expect(decoded.toolsMissing).toBe(true);
    expect(decoded.faultInfo).toBeDefined();
    expect(decoded.faultInfo?.faultMessage).toContain('LoadProhibited');
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
    expect(decoded.faultInfo?.faultMessage).toContain('LoadProhibited');
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
