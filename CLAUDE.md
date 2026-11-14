# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

VS Code extension (`esp-decoder`) that decodes ESP32/ESP8266 crash dumps from a serial port. Provides a webview-based serial monitor with automatic crash detection and backtrace decoding via espressif toolchain `addr2line`/GDB.

## Commands

```bash
npm run build          # production bundle via esbuild → dist/
npm run watch          # esbuild watch mode (dev)
npm run lint           # eslint src
npm test               # vitest run (all tests)
npx vitest run src/test/crashDecoder.test.ts          # single test file
npx vitest run -t "test name"                         # single test by name
npm run package        # build .vsix via vsce
```

- Tests run in Node (no VS Code host); each test file mocks the `vscode` module with `vi.mock('vscode', ...)` before importing the unit under test.
- Several decode tests `skipIf` when espressif toolchains (xtensa GDB/addr2line) or fixtures aren't present locally — they pass trivially on machines without toolchains. Test timeout is 60s because GDB decode is slow.
- Test fixtures (ELF binaries, crash logs, base64 coredump) live in `src/test/fixtures/`.

## Build architecture

`esbuild.js` produces **two bundles**:
1. `src/extension.ts` → `dist/extension.js` (CJS, Node platform; `vscode`, `serialport`, `@serialport/bindings-cpp` external)
2. `src/ansiParser.ts` → `dist/ansiParser.js` (IIFE, browser, global `AnsiParser`) — same source used in both the extension host and the webview ("single source of truth" for ANSI parsing)

`serialport` native bindings are overridden to `@jason2866/serialport-bindings-cpp` (see `overrides` in package.json).

## Code architecture

- `extension.ts` — activation entry. Wires commands, status bar, session config (ELF/tool/arch), file watchers for ELF auto-detection, and subscribes to the pioarduino IDE extension's public API (`onWillUpload`/`onDidUpload`) to release/reacquire the serial port around firmware uploads. `manualElfOverride` guards user-picked ELF from being clobbered by auto-detection.
- `serialPortManager.ts` — owns the `SerialPort`; tracks device identity (VID/PID/serialNumber) to auto-reconnect to the same physical board after USB-CDC re-enumeration (ESP32-S2/S3/C3 reset).
- `webviewPanel.ts` — the monitor UI (`EspDecoderWebviewPanel`, dual-mode: panel webview view or editor tab). The entire webview HTML/CSS/JS is an inline template string in `getHtmlContent()`. Handles line buffering, serial filters, click-to-navigate to source, and routes lines to the crash capturer.
- `crashDecoder.ts` — crash detection/decoding orchestration, including base64 coredump decoding via `esp-coredump`/GDB. Wraps the vendored **trbr** library.
- `src/vendor/trbr/` — vendored plain-JS (ESM, `@ts-check`) decode engine: crash capturer state machine (`capturer/`), Xtensa & RISC-V panic parsers, GDB/MI and addr2line backends (`decode/`). Treat as vendored code — keep diffs against upstream minimal.
- `addr2lineResolver.ts` — `Addr2linePool`: long-lived addr2line child processes with batch + sentinel-address protocol and idle-timeout kill.
- `pioIntegration.ts` / `espIdfIntegration.ts` — ELF + toolchain auto-detection from `.pio/build/` (parses `platformio.ini`, uses `pioarduino-node-helpers`) and ESP-IDF `build/` (parses `sdkconfig`, CMakeLists).
- `chipTargets.ts` — chip → GDB target/arch mapping shared by both integrations.
- `mcpServer.ts` / `mcpUpload.ts` — opt-in MCP server (`esp-decoder.mcp.enabled`, streamable HTTP on `127.0.0.1:<mcp.port>/mcp`, stateless per-POST transport) exposing serial/crash/upload tools to AI agents. Reads the panel's buffers via the narrow `MonitorDataSource` interface; uploads run as a `CustomExecution` VS Code task bracketed by `releasePort()`/`reacquirePort()`.

## Conventions

- TypeScript strict, `Node16` modules for the extension; tests use their own `src/test/tsconfig.json` (Bundler resolution, vitest globals).
- `docs/serial-filters.md` documents the serial filter toolbar; update it when changing filter behavior or `esp-decoder.serialFilters.*` settings.
- New user-facing settings/commands must be declared in `package.json` `contributes` and mirrored in README tables.
