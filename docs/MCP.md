# MCP Server — AI Agent Integration

## Goal

Let an AI coding agent (Claude Code, or any MCP client) drive the full embedded
debug loop that a human normally performs in the ESP Decoder UI:

1. **Connect** to the board's serial port (or release it for flashing)
2. **Watch the log** while the webview keeps displaying the same stream
3. **Detect a crash** and get the decoded backtrace (function / file / line)
4. **Fix & reflash** — upload new firmware and verify the boot log

The serial port is exclusive, so the MCP server runs *in-process* inside the
extension host and shares the live serial connection, line buffer, and crash
state with the webview. Agent and human see the same session.

## Status

| Area | State |
|---|---|
| Transport (streamable HTTP, localhost, stateless) | ✅ implemented |
| Serial tools (connect/disconnect/read/send/reset/status) | ✅ verified on ESP32-C6 hardware |
| Crash tools (list_crashes/decode_crash) | ✅ implemented, unit-tested (full protocol); hardware crash test pending |
| upload_firmware (PlatformIO / ESP-IDF as VS Code task) | ✅ implemented; hardware flash test pending |
| Authentication | none — endpoint is bound to 127.0.0.1 and **off by default** |

## Installation

1. Enable the server (User or Workspace settings):

   ```jsonc
   {
     "esp-decoder.mcp.enabled": true,
     "esp-decoder.mcp.port": 37373   // default; override per-workspace for multiple windows
   }
   ```

   The server starts immediately (and on every extension activation). The
   *ESP Decoder* output channel logs the URL. `ESP Decoder: Copy MCP Server
   URL` copies it to the clipboard.

2. Register with Claude Code:

   ```sh
   claude mcp add --transport http esp-decoder http://127.0.0.1:37373/mcp
   ```

   Any other MCP client works the same way — the endpoint speaks the
   streamable HTTP transport (POST, stateless JSON responses).

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `list_ports` | — | available serial ports (Bluetooth filtered out) |
| `connect` | `port?`, `baudRate?` | connects; auto-selects when exactly one port exists |
| `disconnect` | — | closes the port |
| `get_status` | — | connection, port, baud, ELF path, arch, crash count, latest log cursor |
| `read_serial` | `after_cursor?`, `max_lines?` (≤1000) | new lines + `next_cursor` + `dropped` flag, ANSI stripped |
| `send_serial` | `data`, `append_newline?` | sends text to the device |
| `hard_reset` | — | reboots the board via RTS toggle |
| `list_crashes` | — | detected crash events (panics, Guru Meditation, asserts) with summaries |
| `decode_crash` | `crash_id` | resolved backtrace (function/file/line), registers, fault info |
| `upload_firmware` | `environment?` | builds & flashes via `pio run -t upload` / `idf.py flash`; exit code + output tail |
| `list_environments` | — | detected PlatformIO environments and ESP-IDF builds |

## Usage patterns

**Tail the log** — `read_serial` is cursor-based. Start at `after_cursor: 0`
(oldest buffered line), then pass back `next_cursor` from each response.
`dropped: true` means the ring buffer (default 5000 lines) was trimmed past
your cursor and lines were lost.

```text
read_serial {after_cursor: 0}      → {lines: [...], next_cursor: 56}
read_serial {after_cursor: 56}     → {lines: [], next_cursor: 56}   # nothing new
```

**Crash → backtrace** — crashes are detected automatically from the serial
stream (no agent action needed). Poll `get_status.crashCount` or
`list_crashes`, then `decode_crash` with the event id. Decoding needs an ELF:
auto-detected from `.pio/build/` or `build/`, or set via
`ESP Decoder: Select ELF File`.

**Reflash** — `upload_firmware` releases the serial port, runs the upload as a
visible VS Code task, then reconnects the monitor. With multiple PlatformIO
environments, pass `environment` (see `list_environments`).

## Security

- Bound to `127.0.0.1` only; DNS-rebinding protection on.
- No authentication: any local process can call the endpoint. That is why
  `esp-decoder.mcp.enabled` defaults to `false` — enable it only on machines
  where local processes are trusted.
- `upload_firmware` and `send_serial` act on real hardware; agents should
  treat them as destructive.

## Agent skill

A ready-made Claude Code skill describing the debug-loop workflow lives in
[`skills/esp-decoder-mcp/`](../skills/esp-decoder-mcp/SKILL.md). Install it with:

```sh
cp -r skills/esp-decoder-mcp ~/.claude/skills/     # user-wide
# or  .claude/skills/ inside a project
```
