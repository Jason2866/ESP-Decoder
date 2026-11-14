---
name: esp-decoder-mcp
description: Drive an ESP32/ESP8266 board through the ESP Decoder MCP server — serial monitor, hard reset, crash backtrace decoding, and firmware upload. Use when debugging ESP32/ESP8266 firmware over serial, when the user mentions a crash/panic/Guru Meditation Error/backtrace on an Espressif chip, or asks to watch the serial log, reset the board, or flash firmware via the esp-decoder MCP tools.
---

# ESP Decoder MCP

Drives a live ESP32x/ESP8266 board via the `esp-decoder` MCP server (VS Code
extension). The serial port, log buffer, and crash state are shared with the
extension's webview — the user sees everything you do.

If the tools are missing: the user must set `"esp-decoder.mcp.enabled": true`
in VS Code, then use **ESP Decoder: Copy MCP Server URL** to get the configured
endpoint for `claude mcp add --transport http esp-decoder <copied-url>`.

## Quick start

```text
get_status                       # already connected? ELF configured?
connect {port: "/dev/cu.usbmodem101"}   # or omit port if only one board
read_serial {after_cursor: 0}    # returns lines + next_cursor
```

## Tailing the log

`read_serial` is cursor-based polling, not streaming:

1. First call: `after_cursor: 0` (oldest buffered line).
2. Every later call: pass the previous response's `next_cursor`.
3. Empty `lines` = nothing new yet — wait a moment and poll again.
4. `dropped: true` = buffer trimmed past your cursor; lines were lost at high
   output rates. Resync from the returned lines, don't retry the old cursor.

To capture a boot log: note `next_cursor`, call `hard_reset`, wait ~2-3 s,
then `read_serial` from that cursor.

## Crash → backtrace

Crashes (panics, Guru Meditation Errors, asserts, watchdog resets) are
detected automatically from the serial stream — you never parse them yourself.

1. After a suspected crash, check `list_crashes` (or `get_status.crashCount`).
2. `decode_crash {crash_id}` → fault info + frames with function/file/line.
3. `toolsMissing: true` in the result means GDB/addr2line weren't found —
   addresses are unresolved; ask the user to build the project or check the
   toolchain.
4. "No ELF file configured" error → build the project first (ELF is
   auto-detected from `.pio/build/` or `build/`), or have the user run
   *ESP Decoder: Select ELF File*.

## Fix & reflash loop

After editing firmware source:

1. `upload_firmware {environment: "esp32dev"}` — omit `environment` when the
   project has exactly one; on an "ambiguous" error call `list_environments`.
   Environment discovery requires a built ELF, so environments without one
   are omitted; build a missing environment before selecting it. The serial
   port is released and a reconnect is attempted after upload; the build runs
   as a visible VS Code task (can take minutes).
2. On `success: false`, read `outputTail` for the compiler/flasher error.
3. Check `get_status.connected`. If it is false, call `connect` before reading
   serial output; a successful upload does not guarantee that the monitor
   reconnected.
4. Once connected, call `get_status` and save `latestCursor`, then call
   `hard_reset` and read with `read_serial {after_cursor: latestCursor}`.
   Confirm the new boot log (reset reason, app version), then watch for the
   original crash to be gone.

## Cautions

- `upload_firmware`, `hard_reset`, and `send_serial` act on real hardware.
- Don't `disconnect` unless asked — the user's webview monitor shares the
  connection.
- One upload at a time; the tool rejects concurrent uploads.
