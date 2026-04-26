# Changelog

## [0.22.1] - 2026-04-26

### Fixed
- **Serial Monitor — blank lines** — Empty lines in device output (e.g. consecutive `\n\n`) are now rendered as visible blank rows instead of collapsing to zero height (#35).
- **Serial Monitor — ANSI color with Timestamp** — When the `Timestamp` filter is enabled, multi-line coloured output (e.g. an `ESP_LOGI` message containing embedded newlines) now keeps its colour on every line. Previously the timestamp's `\x1b[0m` reset wiped the active SGR state, causing all but the first line to render uncoloured (#35).

## [0.22.0] - 2026-04-21

### Added
- **Enhanced ANSI color output rendering:** — The viewer now supports extended color formats including 256-color palette selections and full true RGB color sequences.

### Fixed
- **ANSI color** — Wrong blink for ANSI escape code `\033[38;5;xxxm`

## [0.21.2] - 2026-04-18

### Fixed
- **Windows ARM64** — Fixed bug `Writing to COM port (GetOverlappedResult): Invalid handle` caused from `serialport/bindings-cpp` (`npm:@jason2866/serialport-bindings-cpp`).

## [0.21.1] - 2026-04-18

### Fixed
- **Linux ARM64** — Fixed bug in build proccess of `serialport/bindings-cpp` (`npm:@jason2866/serialport-bindings-cpp@^13.0.4`).

## [0.21.0] - 2026-04-16

### Added

- **ESP8266 crash decode support** — full crash detection and decoding for ESP8266 `Exception (N):` crashes with `>>>stack>>>` / `<<<stack<<<` stack dumps.
  - Exception cause lookup (e.g. Exception 28 → LoadProhibited).
  - Register parsing for ESP8266 format (`epc1=`, `excvaddr=`, `depc=`).
  - Heuristic stack address extraction from ESP8266 hex dump lines.
  - Fast-path addr2line resolution for stack addresses (same pattern as Xtensa Backtrace).
  - Fallback-based crash detection — works around trbr framer limitations (case-sensitive `detectKind`, missing `>>>stack>>>` flush guard).

## [0.20.1] - 2026-04-16

### Fixed
- **Windows ARM64** — port could not be opened. Fixed by using a patched fork of `serialport/bindings-cpp` (`npm:@jason2866/serialport-bindings-cpp@^13.0.2`).

## [0.20.0] - 2026-04-14

### Added

- **Serial monitor filter toolbar** — a new filter toolbar lets you transform, suppress, and annotate incoming serial output in real time. All filter settings are persisted via the **Save** button to VS Code settings (`esp-decoder.serialFilters.*`).
  - **Timestamp filter** — prepends a dimmed `[HH:MM:SS.mmm]` timestamp to every line.
  - **Suppress filter** — hides lines matching a user-defined regex.
  - **Highlight filter** — wraps regex matches in ANSI inverse-video styling to make them visually stand out.
  - **Dedup filter** — collapses repeated regex matches within a single line after a configurable threshold, showing a live `×N` counter badge instead.
  - **Log2File** — writes incoming serial data to a timestamped log file on disk, with optional filtered mode that applies Suppress, Timestamp, and Dedup filters before writing. Automatically closes and reopens log files across pioarduino upload cycles.

## [0.12.0] - 2026-04-09

### Added

- **Automatic serial port handoff with pioarduino IDE** — ESP Decoder now subscribes to the `onWillUpload` / `onDidUpload` events exported by the pioarduino IDE extension. When pioarduino starts a flash operation, ESP Decoder automatically releases the serial port so the upload tool can access it, then reconnects immediately afterwards without any user interaction.
  - Port release uses a `waitUntil()` barrier: pioarduino blocks the upload until ESP Decoder confirms the port is fully closed — no race conditions.
  - Port-aware release: only releases the connection when the upload targets the same physical device (handles macOS `/dev/cu.*` ↔ `/dev/tty.*` aliases and Windows case-insensitive COM port names).
  - Retry-based reacquire: reconnects immediately after upload completion with exponential back-off (up to 5 attempts) instead of a fixed delay.
  - Serial port close errors now propagate correctly so a failed release aborts the upload rather than proceeding with the port still open.

## [0.11.3] - 2026-04-06

### Added

- **Monitor location setting** — users can now choose between opening the ESP Crash Monitor in the bottom panel (default, introduced in v0.11.0) or as an editor tab (legacy behavior). Configure via `esp-decoder.monitorLocation` setting.

## [0.11.2] - 2026-04-05

### Added

- **Command history in serial monitor** — use Up/Down arrow keys to navigate through previously sent commands. History stores up to 100 commands and avoids consecutive duplicates.

## [0.11.1] - 2026-03-28

### Changed

- **Tool missing warning** — ESP Decoder shows now a warning when needed GDB/addr2line tools are not found.
- **Improved PlatformIO .elf detection** — Enhanced search for compiled .elf files to support non-standard PlatformIO setups, including custom build directories, multiple .elf files per environment, and custom-named firmware files.
- **Better error classification** — Improved detection of tool-missing errors to avoid false positives from decode failures, malformed ELF files, or other non-tool-related issues.

### Maintenance

- **Security updates** — Updated esbuild to 0.27.4 and vitest to 4.1.2.
- **Code quality** — Refactored path expansion logic in PlatformIO integration to eliminate code duplication and improve maintainability.

## [0.11.0] - 2026-03-27

### Changed

- **Monitor moved to bottom panel** — the ESP Crash Monitor now opens as a webview view in the bottom panel area (next to Terminal, Output, etc.) instead of an editor tab. The view is registered under its own "ESP Decoder" panel container and can be freely rearranged by the user.

## [0.10.2] - 2026-03-25

### Fixed
- **PlatformIO project-local `core_dir` support** — when `platformio.ini` specifies a `core_dir` under `[platformio]`, packages, board definitions, and tools are now resolved from that directory instead of the global PlatformIO core. Path semantics supported: relative paths (resolved against the workspace folder), leading `~` (expanded to the home directory), and `${sysenv.VAR}` tokens (substituted from environment variables).

## [0.10.1] - 2026-03-25

### Fixed
- **Corrupted multi-byte UTF-8 characters in serial monitor** — signal-strength bar characters (`▂▄▆█`) and other multi-byte Unicode characters are no longer replaced with `�` when they are split across consecutive serial-port data chunks. The serial data handler now uses Node.js `StringDecoder` which buffers incomplete byte sequences until the next chunk completes them.

## [0.10.0] - 2026-03-25

### Added
- **ANSI color support in serial monitor** — the terminal now renders ANSI SGR escape sequences (bold, italic, underline, strikethrough, 8 standard foreground/background colors) instead of displaying raw escape characters. Modeled after the esp32tool implementation.


## [0.9.1] - 2026-03-20

### Fixed
- **PlatformIO core directory detection** — use `getCoreDir()` from `pioarduino-node-helpers` instead of hardcoded `os.homedir()`, correctly handling `PLATFORMIO_CORE_DIR` env var and Windows edge cases.


## [0.9.0] - 2026-03-11

### Added
- **coredump decode** supported format `*.bin` and `*.b64`

## [0.8.0] - 2026-03-10

### Added
- **Native IDF support** contributed by [h2zero](https://github.com/h2zero)

## [0.7.0] - 2026-03-10

### Bug fixes

## [0.6.0] - 2026-03-09

### Added
- **Scroll-to-bottom button** in the serial monitor — a prominent button now appears when the output is not scrolled to the bottom, allowing quick navigation to the latest output.
- **Upload artifact step** in the CI build job — the compiled `.vsix` extension package is now stored as a downloadable artifact on every successful build.
- **Restored publish job** in the GitHub Actions workflow with corrected `needs` dependency and permissions.

### Changed / Improved
- **Increased decoding speed** — overall crash decoding performance has been improved.

### Fixed
- **Serial monitor slowdown at high baud rates** — serial data is now batched in 50 ms intervals before being sent to the webview, preventing IPC message queue flooding that caused the UI to become unresponsive.
- **Post-disconnect message flooding** — pending flush is cancelled and the buffer is discarded on disconnect, stopping queued messages from draining for minutes after the device is unplugged.
- **Autoscroll layout reflows** — autoscroll now uses `requestAnimationFrame` instead of synchronous DOM updates to avoid forced layout reflows on every incoming message.
- **Line-buffer trimming performance** — replaced repeated `Array.shift()` (O(n²)) with `Array.slice(-maxLines)` and `replaceChildren()` for a single-DOM-operation trim.
- **Autoscroll re-enable on manual scroll** — autoscroll is correctly re-enabled when the user manually scrolls back to the bottom of the output.
- **Autoscroll race condition** — programmatic `scrollTop` updates are now guarded with a `programmaticScroll` flag so that scroll events triggered by the extension itself do not incorrectly disable autoscroll.
