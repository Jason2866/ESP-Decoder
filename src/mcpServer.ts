import * as http from 'node:http';
import * as vscode from 'vscode';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SerialPortManager } from './serialPortManager';
import { decodeCrash, CrashEvent } from './crashDecoder';
import { findPioEnvironments } from './pioIntegration';
import { findEspIdfBuilds } from './espIdfIntegration';
import { withImprovSession } from './improvWiFi';
import type { SessionConfig } from './webviewPanel';
import type { UploadResult } from './mcpUpload';

/**
 * Narrow view of EspDecoderWebviewPanel — the MCP layer reads the same
 * buffers the webview displays, without depending on the panel class.
 */
export interface MonitorDataSource {
  getSerialLines(
    afterCursor: number,
    maxLines: number
  ): { lines: string[]; nextCursor: number; dropped: boolean };
  getCrashEvents(): readonly CrashEvent[];
  getSessionConfig(): SessionConfig;
}

export interface McpServerDeps {
  serial: SerialPortManager;
  data: MonitorDataSource;
  getWorkspaceFolder(): string | undefined;
  log: vscode.OutputChannel;
  runUpload(environment?: string): Promise<UploadResult>;
}

const READ_SERIAL_DEFAULT_LINES = 200;
const READ_SERIAL_MAX_LINES = 1000;

/** Strip ANSI escape sequences (CSI and OSC) so the LLM sees plain text. */
function stripAnsi(line: string): string {
  return line.replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, '');
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function crashSummary(event: CrashEvent): string {
  return (
    event.decoded?.faultInfo?.faultMessage ??
    event.lines.find((l) => l.trim().length > 0)?.trim() ??
    '(no text)'
  );
}

/** Build a fresh MCP server wired to the live extension state. */
export function buildMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: 'esp-decoder', version: '0.1.0' });
  const { serial, data } = deps;

  server.registerTool(
    'list_ports',
    {
      description:
        'List available serial ports (Bluetooth/system ports filtered out).',
      annotations: { readOnlyHint: true },
    },
    async () => jsonResult({ ports: await serial.listPorts(true) })
  );

  server.registerTool(
    'connect',
    {
      description:
        'Connect to a serial port. If port is omitted, uses the currently selected port or the single available port. Serial output then flows into the monitor buffer (read with read_serial).',
      inputSchema: {
        port: z.string().optional().describe('Serial port path, e.g. /dev/cu.usbserial-0001'),
        baudRate: z.number().int().positive().optional().describe('Baud rate (default: current setting, typically 115200)'),
      },
    },
    async ({ port, baudRate }) => {
      if (port) {
        if (!serial.setPort(port)) {
          throw new Error(`Invalid port path: '${port}'`);
        }
      } else if (!serial.selectedPath) {
        const ports = await serial.listPorts(true);
        if (ports.length === 1) {
          serial.setPort(ports[0].path);
        } else if (ports.length === 0) {
          throw new Error('No serial ports found — is the board plugged in?');
        } else {
          throw new Error(
            `No port selected — specify one of: ${ports.map((p) => p.path).join(', ')}`
          );
        }
      }
      if (baudRate !== undefined && !serial.setBaudRate(baudRate)) {
        throw new Error(`Invalid baud rate: ${baudRate}`);
      }
      const connected = await serial.connect();
      if (!connected) {
        throw new Error(
          `Failed to connect to ${serial.selectedPath} @ ${serial.baudRate} — check that no other program holds the port`
        );
      }
      return jsonResult({
        connected,
        port: serial.selectedPath,
        baudRate: serial.baudRate,
      });
    }
  );

  server.registerTool(
    'disconnect',
    { description: 'Disconnect the serial port.' },
    async () => {
      await serial.disconnect();
      return jsonResult({ connected: false });
    }
  );

  server.registerTool(
    'get_status',
    {
      description:
        'Get monitor status: connection state, port, baud rate, configured ELF/architecture, crash count, and the latest serial log cursor.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const config = data.getSessionConfig();
      return jsonResult({
        connected: serial.isConnected,
        port: serial.selectedPath,
        baudRate: serial.baudRate,
        isReconnecting: serial.isReconnecting,
        elfPath: config.elfPath,
        targetArch: config.targetArch,
        crashCount: data.getCrashEvents().length,
        latestCursor: data.getSerialLines(Number.MAX_SAFE_INTEGER, 0).nextCursor,
      });
    }
  );

  server.registerTool(
    'read_serial',
    {
      description:
        'Read serial monitor lines after a cursor position. Returns next_cursor for the following call — poll repeatedly to tail the log. dropped=true means the buffer was trimmed past your cursor (lines were lost).',
      inputSchema: {
        after_cursor: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Absolute line cursor from a previous call (0 = oldest buffered line)'),
        max_lines: z
          .number()
          .int()
          .min(1)
          .max(READ_SERIAL_MAX_LINES)
          .default(READ_SERIAL_DEFAULT_LINES),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ after_cursor, max_lines }) => {
      const { lines, nextCursor, dropped } = data.getSerialLines(after_cursor, max_lines);
      return jsonResult({
        lines: lines.map(stripAnsi),
        next_cursor: nextCursor,
        dropped,
      });
    }
  );

  server.registerTool(
    'send_serial',
    {
      description: 'Send text to the connected device over serial.',
      inputSchema: {
        data: z.string().describe('Text to send'),
        append_newline: z.boolean().default(true),
      },
    },
    async ({ data: text, append_newline }) => {
      await serial.sendData(append_newline ? `${text}\n` : text);
      return jsonResult({ sent: true });
    }
  );

  server.registerTool(
    'hard_reset',
    {
      description: 'Hard-reset the connected board by toggling the RTS line.',
      annotations: { destructiveHint: true },
    },
    async () => {
      await serial.hardReset();
      return jsonResult({ reset: true });
    }
  );

  server.registerTool(
    'provision_wifi',
    {
      description:
        'Provision WiFi credentials to the connected board over the Improv serial protocol. Requires firmware that implements Improv serial. Pauses the serial monitor for the duration.',
      inputSchema: {
        ssid: z.string().describe('WiFi network name'),
        password: z.string().default('').describe('WiFi password (empty for open networks)'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ ssid, password }) => {
      const timeoutMs = vscode.workspace
        .getConfiguration('esp-decoder')
        .get<number>('improv.timeout', 30000);
      const { nextUrl } = await withImprovSession(serial, timeoutMs, (engine) =>
        engine.provision(ssid, password)
      );
      return jsonResult({ provisioned: true, nextUrl });
    }
  );

  server.registerTool(
    'list_crashes',
    {
      description:
        'List crash events detected in the serial stream (panics, Guru Meditation Errors, asserts). Use decode_crash to get the resolved backtrace.',
      annotations: { readOnlyHint: true },
    },
    async () =>
      jsonResult({
        crashes: data.getCrashEvents().map((e) => ({
          id: e.id,
          kind: e.kind,
          timestamp: e.timestamp,
          decoded: e.decoded !== undefined,
          summary: crashSummary(e),
        })),
      })
  );

  server.registerTool(
    'decode_crash',
    {
      description:
        'Decode a detected crash: resolve backtrace addresses to function/file/line using the configured ELF and toolchain. Returns cached result if already decoded.',
      inputSchema: {
        crash_id: z.string().describe('Crash id from list_crashes'),
      },
    },
    async ({ crash_id }) => {
      const event = data.getCrashEvents().find((e) => e.id === crash_id);
      if (!event) {
        throw new Error(`No crash with id '${crash_id}' — call list_crashes for valid ids`);
      }
      if (!event.decoded) {
        const config = data.getSessionConfig();
        if (!config.elfPath) {
          throw new Error(
            'No ELF file configured — build the project (so it can be auto-detected) or run "ESP Decoder: Select ELF File"'
          );
        }
        event.decoded = await decodeCrash(
          event,
          config.elfPath,
          config.toolPath,
          config.targetArch,
          deps.log,
          config.romElfPath
        );
      }
      const d = event.decoded;
      return jsonResult({
        faultInfo: d.faultInfo,
        frames: d.stacktrace,
        regAnnotations: d.regAnnotations,
        allocInfo: d.allocInfo,
        toolsMissing: d.toolsMissing,
        rawOutput: d.rawOutput,
      });
    }
  );

  server.registerTool(
    'upload_firmware',
    {
      description:
        'Build & flash firmware to the board via PlatformIO (pio run -t upload) or ESP-IDF (idf.py flash), run as a visible VS Code task. The serial port is released during the upload and reconnected afterwards.',
      inputSchema: {
        environment: z
          .string()
          .optional()
          .describe('PlatformIO environment name (required when the project defines several — see list_environments)'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ environment }) => jsonResult(await deps.runUpload(environment))
  );

  server.registerTool(
    'list_environments',
    {
      description:
        'List detected PlatformIO environments and ESP-IDF builds in the workspace (name, ELF path, target architecture).',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const folder = deps.getWorkspaceFolder();
      if (!folder) {
        throw new Error('No workspace folder open');
      }
      const [pio, idf] = await Promise.all([
        findPioEnvironments(folder),
        findEspIdfBuilds(folder),
      ]);
      return jsonResult({ pio, idf });
    }
  );

  return server;
}

/**
 * Streamable-HTTP MCP endpoint at http://127.0.0.1:<port>/mcp.
 * Stateless mode: a fresh McpServer + transport per POST (tools are thin
 * wrappers over long-lived extension singletons, so this is cheap).
 */
export class EspDecoderMcpHttpServer implements vscode.Disposable {
  private httpServer: http.Server | undefined;
  private port = 0;

  constructor(private readonly deps: McpServerDeps) {}

  get url(): string | undefined {
    return this.httpServer ? `http://127.0.0.1:${this.port}/mcp` : undefined;
  }

  async start(port: number): Promise<void> {
    if (this.httpServer) {
      return;
    }
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res, port);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.port = port;
    this.httpServer = server;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    port: number
  ): Promise<void> {
    const path = req.url?.split('?')[0];
    if (path !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res
        .writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' })
        .end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed' },
            id: null,
          })
        );
      return;
    }
    try {
      const mcpServer = buildMcpServer(this.deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [
          '127.0.0.1',
          'localhost',
          `127.0.0.1:${port}`,
          `localhost:${port}`,
        ],
      });
      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      this.deps.log.appendLine(`[ESP Decoder] MCP request failed: ${err}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          })
        );
      }
    }
  }

  dispose(): void {
    this.httpServer?.close();
    this.httpServer = undefined;
  }
}
