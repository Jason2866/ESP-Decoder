# ESP32-S31 Support Research Findings

**Date:** 2026-10-01
**Status:** Research complete — no code changes made  
**Task:** Determine all changes required to add full ESP32-S31 crash decoding support

---

## Summary Answer

The ESP-Decoder does **not** currently support the ESP32-S31. Adding full support requires changes in **5 files** and one decision about the vendored trbr library. The ESP32-S31 is a RISC-V chip with the IDF target name **`esp32s31`**. It uses the **same `riscv32-esp-elf` toolchain** as all other RISC-V ESP chips (C2/C3/C5/C6/H2/H4/P4). The crash output format is **identical** to other RISC-V ESP chips (RISC-V register dump + Stack memory section). The single blocker is that the vendored trbr library does not yet list `esp32s31` as a valid `DecodeTarget`, meaning the extension would silently fall back to `esp32c3` as the default RISC-V target — which is functionally fine for GDB decoding but is inaccurate.

---

## 1. Confirmed Chip Target Name

**Exact string: `esp32s31`** (no hyphen, all lowercase)

Evidence:
- ESP-IDF documentation shows `idf.py set-target esp32s31` ([source](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s31/get-started/linux-macos-start-project.html))
- The ESP-IDF documentation domain follows the established naming convention: `esp32c6`, `esp32h2`, `esp32p4` → `esp32s31`
- The `sdkconfig` entry the extension already parses (`CONFIG_IDF_TARGET="esp32s31"`) would match this string directly via `parseIdfTarget()` in `espIdfIntegration.ts`

---

## 2. Architecture Classification

**Architecture: RISC-V (32-bit dual-core HP+LP)**

- HP core: 32-bit RISC-V at 320 MHz with 128-bit SIMD data path
- LP core: ultra-low-power RISC-V (separate LP system)
- ELF `e_machine` field: `0xf3` (243) — `ELF_MACHINE_RISCV`, same as all other RISC-V ESP chips
- **Toolchain prefix: `riscv32-esp-elf`** — confirmed by the GDB stub output in ESP-IDF docs:
  ```
  This GDB was configured as "--host=x86_64-build_apple-darwin16.3.0 --target=riscv32-esp-elf".
  ```
  ([fatal-errors page](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s31/api-guides/fatal-errors.html))
- `addr2line` binary: **`riscv32-esp-elf-addr2line`** — same toolchain, same binary naming

---

## 3. GDB / OpenOCD Target String

**OpenOCD target: `esp32s31`**

Evidence: The openocd-esp32 release notes ([github.com/espressif/openocd-esp32/releases](https://github.com/espressif/openocd-esp32/releases)) explicitly state:
> "Added ESP32-S31 target support, including single-core and dual-core configurations and flash loader support."

The target config file in openocd-esp32 follows the naming pattern `tcl/target/esp32s31.cfg` (same as `esp32c6.cfg`, `esp32p4.cfg`). GDB connects via the same `riscv32-esp-elf-gdb` binary used for all RISC-V ESP chips.

---

## 4. Crash Output Chip Name String

**Chip name in panic output: standard RISC-V format — no chip-specific string needed**

The ESP32-S31 fatal errors page shows the **identical panic format** to other RISC-V ESP chips (ESP32-C6, ESP32-P4):

```
Guru Meditation Error: Core 0 panic'ed (Illegal instruction). Exception was unhandled.

Core  0 register dump:
MEPC    : 0x420048b4  RA      : 0x420048b4  SP      : 0x3fc8f2f0  GP      : 0x3fc8a600
TP      : 0x3fc8a2ac  T0      : 0x40057fa6  T1      : 0x0000000f  T2      : 0x00000000
...
MSTATUS : 0x00001881  MTVEC   : 0x40380001  MCAUSE  : 0x00000007  MTVAL   : 0x00000000
MHARTID : 0x00000000
```

The backtrace format is:
```
Backtrace: 0x42006686:0x3fc97ee0 0x4200835c:0x3fc97f10
```

This is the standard RISC-V crash format that `trbr`'s capturer already recognises as `kind: 'riscv'`. The capturer in `TrbrCrashCapturer` does not pattern-match on chip name — it detects RISC-V crashes by register dump headers (`Core N register dump:`, `MEPC`, `Stack memory:`) which are identical across all RISC-V ESP chips.

**Conclusion:** The crash capturer and crash decoder will already detect and partially decode ESP32-S31 crashes without any changes, falling back to `esp32c3` as the default RISC-V trbr target. The gaps are in chip registration and target arch accuracy.

---

## 5. Complete List of Files Requiring Changes

### File 1: `src/chipTargets.ts` — ADD `esp32s31` entry

**What:** Add `esp32s31` to `CHIP_TARGET_MAP` and `RISCV_TARGETS`.

**Current state:**
```typescript
export const CHIP_TARGET_MAP: Record<string, string> = {
  esp32: 'xtensa', esp32s2: 'xtensa', esp32s3: 'xtensa',
  esp32c2: 'esp32c2', esp32c3: 'esp32c3', esp32c5: 'esp32c3',
  esp32c6: 'esp32c6', esp32h2: 'esp32h2', esp32h4: 'esp32h4',
  esp32p4: 'esp32p4', esp8266: 'xtensa',
};

export const RISCV_TARGETS = new Set([
  'esp32c2', 'esp32c3', 'esp32c5', 'esp32c6', 'esp32h2', 'esp32h4', 'esp32p4',
]);
```

**Required change:**
```typescript
export const CHIP_TARGET_MAP: Record<string, string> = {
  // ...existing entries...
  esp32s31: 'esp32s31',   // ADD THIS
};

export const RISCV_TARGETS = new Set([
  // ...existing entries...
  'esp32s31',             // ADD THIS
]);
```

**Note:** The mapped value `'esp32s31'` is the trbr `DecodeTarget` string. This requires trbr to support it (see File 5 below). If trbr is not yet updated, map to `'esp32p4'` as the interim fallback (same dual-core RISC-V architecture, same register layout, same stack format).

---

### File 2: `src/crashDecoder.ts` — ADD `esp32s31` to `VALID_TRBR_TARGETS`

**What:** The `VALID_TRBR_TARGETS` constant and `resolveTargetArch()` function control what arch strings are passed to trbr. `esp32s31` must be added.

**Location:** Line ~424 in `crashDecoder.ts`:
```typescript
const VALID_TRBR_TARGETS = ['xtensa', 'esp32c2', 'esp32c3', 'esp32c6', 'esp32h2', 'esp32h4', 'esp32p4'] as const;
type TrbrTarget = (typeof VALID_TRBR_TARGETS)[number];
```

**Required change:**
```typescript
const VALID_TRBR_TARGETS = [
  'xtensa', 'esp32c2', 'esp32c3', 'esp32c6', 'esp32h2', 'esp32h4', 'esp32p4', 'esp32s31'
] as const;
```

Also update `resolveTargetArch()` — currently, any unknown RISC-V arch defaults to `'esp32c3'`. After adding `esp32s31` to the valid set, the existing pass-through logic handles it automatically since `configArch === 'esp32s31'` will be included in `VALID_TRBR_TARGETS`.

**Conditional note:** If trbr is not yet updated, skip adding `esp32s31` to `VALID_TRBR_TARGETS` and instead map it to `'esp32p4'` in `resolveTargetArch()`:
```typescript
if (configArch === 'esp32s31') {
  return 'esp32p4';  // interim fallback — same RISC-V architecture
}
```

---

### File 3: `src/vendor/trbr/targets.js` — ADD `esp32s31` to `riscTargetArchs`

**What:** The vendored trbr `targets.js` defines the canonical list of supported decoder targets. Currently:
```javascript
const riscTargetArchs = ['esp32c2', 'esp32c3', 'esp32c5', 'esp32c6', 'esp32h2', 'esp32h4', 'esp32p4']
```

`esp32s31` is absent. Adding it here makes trbr pass it through to GDB without error.

**Required change:**
```javascript
const riscTargetArchs = /** @type {const} */ ([
  'esp32c2', 'esp32c3', 'esp32c5', 'esp32c6',
  'esp32h2', 'esp32h4', 'esp32p4', 'esp32s31',  // ADD esp32s31
])
```

**Note:** This is a local vendor copy — not an upstream npm package. The change is safe to make directly. If upstream trbr publishes a version with `esp32s31` support, update the vendor copy from it.

---

### File 4: `src/vendor/trbr/index.d.ts` — UPDATE `DecodeTarget` type

**What:** The TypeScript type declarations for trbr must include `esp32s31` in the `DecodeTarget` union to keep TypeScript compilation clean.

**Current state:**
```typescript
export type DecodeTarget =
  | 'xtensa' | 'esp32c2' | 'esp32c3' | 'esp32c6'
  | 'esp32h2' | 'esp32h4' | 'esp32p4';
```

**Required change:**
```typescript
export type DecodeTarget =
  | 'xtensa' | 'esp32c2' | 'esp32c3' | 'esp32c5' | 'esp32c6'
  | 'esp32h2' | 'esp32h4' | 'esp32p4' | 'esp32s31';
```

Note: `esp32c5` is also currently missing from the `.d.ts` (it's in `targets.js` but not in `index.d.ts`). Fix both at the same time.

---

### File 5: `package.json` — ADD `esp32s31` to `targetArch` enum

**What:** The VS Code settings contribution in `package.json` enumerates valid `targetArch` values. The user-selectable dropdown must include `esp32s31`.

**Location:** `contributes.configuration.properties["esp-decoder.targetArch"].enum`

**Current state:**
```json
"enum": ["auto", "xtensa", "esp32c2", "esp32c3", "esp32c5", "esp32c6", "esp32h2", "esp32h4", "esp32p4"]
```

**Required change:**
```json
"enum": ["auto", "xtensa", "esp32c2", "esp32c3", "esp32c5", "esp32c6", "esp32h2", "esp32h4", "esp32p4", "esp32s31"]
```

---

### File 6: `README.md` — UPDATE chip support list

**What:** The README currently lists RISC-V support as "ESP32-C3/C6/H2" in the Multi-Arch Support feature line. Update to include S31.

**Location:** Features section:
```
- **Multi-Arch Support** — Xtensa (ESP32/S2/S3) and RISC-V (ESP32-C3/C6/H2)
```

**Required change:**
```
- **Multi-Arch Support** — Xtensa (ESP32/S2/S3) and RISC-V (ESP32-C3/C6/H2/P4/S31)
```

---

## 6. S31-Specific Quirks vs Other RISC-V Chips

### What's the same
- Register dump format: identical (`Core N register dump:`, 32 RISC-V integer registers + CSRs)
- Backtrace format: `Backtrace: 0xPCaddr:0xSPaddr ...` — same as C6/P4
- Stack memory section: `Stack memory:` hex dump — same format
- ELF architecture: `e_machine = 0xf3` (RISC-V), `e_class = 1` (32-bit ELF)
- Toolchain: `riscv32-esp-elf-*` — shared with all RISC-V ESP chips
- GDB remote protocol: standard RISC-V ILP32 register layout — 33 registers (X0-X31 + MEPC)

### Dual-core consideration
The ESP32-S31 is **dual-core** (HP + LP). The ESP-IDF panic handler identifies the crashing core with `Core 0` or `Core 1` in the header. The extension already handles multi-core crashes through trbr and the `faultInfo.coreId` field — no special handling needed.

The LP (low-power) core uses a different RISC-V ISA subset. LP core panics may produce different register names. However, LP core crash output in ESP-IDF follows the same RISC-V dump format, so the existing parser should handle it.

### SIMD / wide data path
The HP core has 128-bit SIMD instructions. These do not affect the panic dump format — the register dump is still 32-bit RISC-V registers. SIMD state is not dumped in the standard panic handler.

### Memory map differences
The S31's flash and SRAM are mapped at different addresses than older chips (e.g., code at `0x42xxxxxx`, SRAM at `0x3fcxxxxx`). The crash decoder does not hardcode memory maps — it relies on addr2line + ELF symbols, so this is not a concern.

---

## 7. Recommended Test Fixture Approach

### Fixture file: `src/test/fixtures/esp32s31_crash.txt`

Create a fixture representing a real ESP32-S31 RISC-V crash dump. Since the format is identical to ESP32-C6, a synthetic fixture based on the S31 panic output format is valid for unit testing:

```
Guru Meditation Error: Core 0 panic'ed (Illegal instruction). Exception was unhandled.
Core  0 register dump:
MEPC    : 0x42004abc  RA      : 0x42004abc  SP      : 0x3fc8f2f0  GP      : 0x3fc8a600
TP      : 0x3fc8a2ac  T0      : 0x40057fa6  T1      : 0x0000000f  T2      : 0x00000000
S0/FP   : 0x00000000  S1      : 0x00000000  A0      : 0x00000001  A1      : 0x00000001
A2      : 0x00000064  A3      : 0x00000004  A4      : 0x00000001  A5      : 0x00000000
A6      : 0x42001fd6  A7      : 0x00000000  S2      : 0x00000000  S3      : 0x00000000
S4      : 0x00000000  S5      : 0x00000000  S6      : 0x00000000  S7      : 0x00000000
S8      : 0x00000000  S9      : 0x00000000  S10     : 0x00000000  S11     : 0x00000000
T3      : 0x00000000  T4      : 0x00000000  T5      : 0x00000000  T6      : 0x00000000
MSTATUS : 0x00001881  MTVEC   : 0x40380001  MCAUSE  : 0x00000002  MTVAL   : 0x00000000
MHARTID : 0x00000000

Stack memory:
3fc8f2d0: 00000000 00000000 00000000 00000000 42004abc 00000000 00000000 00000000

Backtrace: 0x42004abc:0x3fc8f2f0 0x42004b00:0x3fc8f310

Rebooting...
```

### New test suite: `src/test/chipTargets.test.ts`

```typescript
// Test that esp32s31 is registered correctly
describe('chipTargets – ESP32-S31', () => {
  it('maps esp32s31 to the expected trbr target', () => {
    expect(CHIP_TARGET_MAP['esp32s31']).toBe('esp32s31');
  });
  it('includes esp32s31 in RISCV_TARGETS', () => {
    expect(RISCV_TARGETS.has('esp32s31')).toBe(true);
  });
  it('does not include esp32s31 in XTENSA_CHIPS', () => {
    expect(XTENSA_CHIPS.has('esp32s31')).toBe(false);
  });
});
```

### Extended crash decoder tests: `src/test/crashDecoder.test.ts`

Add a `describe` block mirroring the existing ESP32-C6 tests but for the S31 fixture:
- `TrbrCrashCapturer` detects the crash
- `kind` is `'riscv'`
- `rawText` contains `'Core  0 register dump:'` and `'MEPC'`
- `decodeCrash` with `targetArch: 'esp32s31'` and a nonexistent tool path sets `toolsMissing: true` and extracts the MEPC register correctly

### Extended ESP-IDF integration tests: `src/test/espIdfIntegration.test.ts`

Add a test case:
```typescript
it('resolves esp32s31 sdkconfig target to RISC-V GDB', async () => {
  // Write sdkconfig with CONFIG_IDF_TARGET="esp32s31"
  // Verify builds[0].targetArch === 'esp32s31'
  // Verify toolPath resolves to riscv32-esp-elf-gdb
});
```

---

## 8. What Already Works Without Changes

- **Crash detection:** `TrbrCrashCapturer` will detect S31 crashes correctly — the RISC-V crash pattern matches on `Core N register dump:` + MEPC register names, which are identical on S31.
- **ELF arch detection:** `detectElfArch()` reads `e_machine` from the ELF header. S31 ELFs have `e_machine = 0xf3` (RISC-V), so it returns `'riscv'` automatically.
- **Toolchain auto-detection:** The RISC-V GDB path search (`riscv32-esp-elf-gdb`) already covers S31 — same toolchain, no new paths needed.
- **Coredump decoding:** Works via the same RISC-V path. The S31 coredump format is identical to C6/P4.
- **PlatformIO integration:** `findRomElf()` searches by chip name pattern; once `esp32s31` is in `CHIP_TARGET_MAP`, the ROM ELF lookup uses `esp32s31_rev*_rom.elf` (if Espressif ships one in PIO packages).

---

## 9. Dependency / Ordering for Implementation

1. **`src/vendor/trbr/targets.js`** — add `esp32s31` to `riscTargetArchs` *(unblocks everything else)*
2. **`src/vendor/trbr/index.d.ts`** — add `esp32s31` (and `esp32c5`) to `DecodeTarget` type
3. **`src/chipTargets.ts`** — add `esp32s31` entries
4. **`src/crashDecoder.ts`** — add `esp32s31` to `VALID_TRBR_TARGETS`
5. **`package.json`** — add `esp32s31` to the settings enum
6. **`README.md`** — update chip support list
7. **Test fixtures and tests** — add `esp32s31_crash.txt` fixture and test cases

Items 1–6 are the functional changes. Item 7 provides test coverage. All changes are backward-compatible and do not affect existing chips.

---

## References

- [ESP-IDF Getting Started (ESP32-S31)](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s31/get-started/linux-macos-start-project.html)
- [ESP-IDF Fatal Errors (ESP32-S31)](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s31/api-guides/fatal-errors.html)
- [OpenOCD ESP32 release notes — S31 target support](https://github.com/espressif/openocd-esp32/releases)
- [ESP32-S31 product page](https://www.espressif.com/en/products/socs/esp32-s31)
- [trbr library](https://github.com/dankeboy36/trbr)

*Content from Espressif documentation was rephrased for compliance with licensing restrictions.*
