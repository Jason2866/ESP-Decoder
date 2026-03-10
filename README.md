# ESP Crash Decoder — VS Code Extension

Decode ESP32 crash dumps directly from the serial port in VS Code.  
Powered by [TraceBreaker (trbr)](https://github.com/dankeboy36/trbr).  
Designed to work with [**pioarduino**](https://marketplace.visualstudio.com/items?itemName=pioarduino.pioarduino-ide).
Also supports [**Espressif IDF**](https://marketplace.visualstudio.com/items?itemName=espressif.esp-idf-extension).

## Features

- **Serial Monitor** — Connect to any serial port, view output in real-time
- **Automatic Crash Detection** — Detects Guru Meditation Errors, backtraces, panics, asserts
- **Crash Decoding** — Decodes stack traces using `addr2line`/GDB from espressif toolchains
- **PlatformIO Integration** — Auto-detects `firmware.elf` and toolchain from `.pio/build/`
- **ESP-IDF Integration** — Auto-detects app ELF and toolchain from `build/` and ESP-IDF tools
- **Click-to-Navigate** — Click on decoded file:line references to open source files
- **Register Display** — Shows CPU register values at the time of crash
- **Multi-Arch Support** — Xtensa (ESP32/S2/S3) and RISC-V (ESP32-C3/C6/H2)

## Quick Start

1. Open a pioarduino or ESP-IDF project in VS Code
2. Build your firmware (`pio run` or `idf.py build`)
3. Run command: **ESP Decoder: Open Serial Monitor & Crash Decoder**
4. Select serial port and connect
5. The ELF file is auto-detected from `.pio/build/` or `build/`
6. Crash dumps are automatically detected and decoded

## Commands

| Command | Description |
|---------|-------------|
| `ESP Decoder: Open Serial Monitor & Crash Decoder` | Open the main monitor panel |
| `ESP Decoder: Select Serial Port` | Choose which serial port to use |
| `ESP Decoder: Select Baud Rate` | Set the communication speed |
| `ESP Decoder: Connect Serial Port` | Connect to the selected port |
| `ESP Decoder: Disconnect Serial Port` | Disconnect the serial port |
| `ESP Decoder: Select ELF File` | Choose ELF file for decoding |
| `ESP Decoder: Clear Output` | Clear serial and crash data |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `esp-decoder.defaultBaudRate` | `115200` | Default baud rate |
| `esp-decoder.autoDetectElf` | `true` | Auto-detect ELF from PlatformIO and ESP-IDF builds |
| `esp-decoder.elfPath` | `""` | Manual ELF file path |
| `esp-decoder.toolPath` | `""` | Manual GDB/addr2line path |
| `esp-decoder.targetArch` | `auto` | Target architecture (`auto`, `xtensa`, `riscv32`) |
| `esp-decoder.serialMonitor.maxLines` | `5000` | Max lines in serial output |
| `esp-decoder.serialMonitor.autoscroll` | `true` | Auto-scroll on new data |

## How It Works

1. Serial data is received and displayed in the **Serial Monitor** tab
2. Incoming lines are analyzed for crash patterns (panic messages, backtraces, register dumps)
3. When a crash block is detected, it appears in the **Crash Events** tab
4. If an ELF file is configured, the crash is automatically decoded:
   - Backtrace addresses are resolved to function names and source locations
   - Stack memory is resolved to function names and source locations
   - Register values are extracted and displayed
   - Fault information (cause, core, address) is shown
5. Clicking on source file references opens the file at the correct line

## pioarduino Setup

The extension auto-detects:

- **ELF file**: `<workspace>/.pio/build/<env>/firmware.elf`
- **Toolchain**: From packages (`~/.platformio/packages/`)
- **Architecture**: From board configuration in `platformio.ini`

Make sure you have built your project at least once before connecting the monitor.

## ESP-IDF Setup

The extension auto-detects:

- **ELF file**: `<workspace>/build/<project>.elf`
- **Toolchain**: From `PATH` or ESP-IDF tools (`$IDF_TOOLS_PATH/tools`, `~/.espressif/tools`)
- **Architecture**: From `sdkconfig` (`CONFIG_IDF_TARGET`)

Make sure you have built your project at least once with `idf.py build` before connecting the monitor.

## Building the Extension

```bash
cd vscode-extension
npm install
npm run build
npm run package   # Creates .vsix file
```

## Installing

```bash
code --install-extension esp-decoder-0.1.0.vsix
```

Or install from the Extensions sidebar: "Install from VSIX..."

## Requirements

- VS Code 1.85+
- Node.js 18+ (for the `serialport` native module)
- pioarduino installed in the workspace
- A built firmware (`.elf` file)

## License

GPL-3.0 — same as trbr

## Copyright

Jason2866
