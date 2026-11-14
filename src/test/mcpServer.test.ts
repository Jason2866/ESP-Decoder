/**
 * Unit tests for the MCP server layer:
 * - serial-line cursor semantics on EspDecoderWebviewPanel (getSerialLines)
 * - MCP tool handlers via InMemoryTransport (full protocol, no HTTP)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock vscode before importing extension modules
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

  return {
    EventEmitter,
    Uri: {
      file: (p: string) => ({ fsPath: p }),
      parse: (p: string) => ({ fsPath: p }),
    },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({
        get: (key: string, def: unknown) =>
          key === 'serialMonitor.maxLines' ? mockMaxLines : def,
      }),
      openTextDocument: vi.fn(),
      findFiles: vi.fn(),
    },
    window: {
      createOutputChannel: () => ({
        appendLine: () => {},
        dispose: () => {},
      }),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    },
    Disposable: class {
      dispose() {}
    },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
  };
});

let mockMaxLines = 5000;

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EspDecoderWebviewPanel } from '../webviewPanel.js';
import { SerialPortManager } from '../serialPortManager.js';
import { buildMcpServer, McpServerDeps, MonitorDataSource } from '../mcpServer.js';
import type { CrashEvent } from '../crashDecoder.js';
import type { UploadResult } from '../mcpUpload.js';

const vscode = await import('vscode');

// ---------------------------------------------------------------------------
// Cursor semantics on EspDecoderWebviewPanel
// ---------------------------------------------------------------------------

function makePanel(): EspDecoderWebviewPanel {
  const emitter = () => () => ({ dispose: () => {} });
  const fakeSerial = {
    onData: emitter(),
    onError: emitter(),
    onConnectionChange: emitter(),
    onDisconnect: emitter(),
  } as unknown as SerialPortManager;
  return new EspDecoderWebviewPanel(vscode.Uri.file('/test'), fakeSerial);
}

function feedLines(panel: EspDecoderWebviewPanel, lines: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (panel as any).handleSerialData(Buffer.from(lines.join('\n') + '\n'));
}

describe('EspDecoderWebviewPanel.getSerialLines cursor semantics', () => {
  beforeEach(() => {
    mockMaxLines = 5000;
  });

  it('returns lines after a cursor and a monotonically increasing nextCursor', () => {
    const panel = makePanel();
    feedLines(panel, ['a', 'b', 'c']);

    const first = panel.getSerialLines(0, 2);
    expect(first.lines).toEqual(['a', 'b']);
    expect(first.nextCursor).toBe(2);
    expect(first.dropped).toBe(false);

    const second = panel.getSerialLines(first.nextCursor, 10);
    expect(second.lines).toEqual(['c']);
    expect(second.nextCursor).toBe(3);

    // Nothing new — empty result, cursor unchanged
    const third = panel.getSerialLines(second.nextCursor, 10);
    expect(third.lines).toEqual([]);
    expect(third.nextCursor).toBe(3);
  });

  it('flags dropped lines after the buffer is trimmed past the cursor', () => {
    mockMaxLines = 5;
    const panel = makePanel();
    feedLines(panel, ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8']);

    // Buffer holds last 5 lines (l4..l8); cursor 0 points before the buffer
    const result = panel.getSerialLines(0, 100);
    expect(result.dropped).toBe(true);
    expect(result.lines).toEqual(['l4', 'l5', 'l6', 'l7', 'l8']);
    expect(result.nextCursor).toBe(8);

    // A cursor inside the retained window is not dropped
    const tail = panel.getSerialLines(6, 100);
    expect(tail.dropped).toBe(false);
    expect(tail.lines).toEqual(['l7', 'l8']);
  });

  it('keeps cursors monotonic across a clear', async () => {
    const panel = makePanel();
    feedLines(panel, ['a', 'b']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (panel as any).handleMessage({ type: 'clear' });

    feedLines(panel, ['c']);
    const result = panel.getSerialLines(0, 10);
    expect(result.dropped).toBe(true); // a/b were discarded
    expect(result.lines).toEqual(['c']);
    expect(result.nextCursor).toBe(3);

    const next = panel.getSerialLines(result.nextCursor, 10);
    expect(next.lines).toEqual([]);
    expect(next.nextCursor).toBe(3);
  });

  it('clamps an out-of-range cursor to the buffer end', () => {
    const panel = makePanel();
    feedLines(panel, ['a']);
    const result = panel.getSerialLines(Number.MAX_SAFE_INTEGER, 10);
    expect(result.lines).toEqual([]);
    expect(result.nextCursor).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// MCP tool handlers (InMemoryTransport, full protocol)
// ---------------------------------------------------------------------------

interface FakeSerialState {
  ports: { path: string; manufacturer?: string }[];
  selectedPath?: string;
  baudRate: number;
  isConnected: boolean;
  connectResult: boolean;
}

function makeFakeSerial(state: FakeSerialState) {
  return {
    get selectedPath() {
      return state.selectedPath;
    },
    get baudRate() {
      return state.baudRate;
    },
    get isConnected() {
      return state.isConnected;
    },
    isReconnecting: false,
    listPorts: vi.fn(async () => state.ports),
    setPort: vi.fn((p: string) => {
      state.selectedPath = p;
      return true;
    }),
    setBaudRate: vi.fn((rate: number) => {
      if (!Number.isInteger(rate) || rate <= 0) {
        return false;
      }
      state.baudRate = rate;
      return true;
    }),
    connect: vi.fn(async () => {
      state.isConnected = state.connectResult;
      return state.connectResult;
    }),
    disconnect: vi.fn(async () => {
      state.isConnected = false;
    }),
    sendData: vi.fn(async () => {}),
    hardReset: vi.fn(async () => {}),
  } as unknown as SerialPortManager;
}

function makeDataSource(
  lines: string[] = [],
  crashes: CrashEvent[] = [],
  elfPath?: string
): MonitorDataSource {
  return {
    getSerialLines: (afterCursor: number, maxLines: number) => {
      const start = Math.min(Math.max(afterCursor, 0), lines.length);
      const slice = lines.slice(start, start + maxLines);
      return {
        lines: slice,
        nextCursor: start + slice.length,
        dropped: false,
      };
    },
    getCrashEvents: () => crashes,
    getSessionConfig: () => ({ elfPath }),
  };
}

async function connectClient(deps: McpServerDeps): Promise<Client> {
  const server = buildMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function makeDeps(overrides: Partial<McpServerDeps> = {}): McpServerDeps {
  return {
    serial: makeFakeSerial({
      ports: [{ path: '/dev/cu.usbserial-1' }],
      baudRate: 115200,
      isConnected: false,
      connectResult: true,
    }),
    data: makeDataSource(),
    getWorkspaceFolder: () => undefined,
    log: { appendLine: () => {} } as unknown as import('vscode').OutputChannel,
    runUpload: vi.fn(async () => ({
      success: true,
      exitCode: 0,
      durationMs: 1,
      outputTail: '',
    })) as McpServerDeps['runUpload'],
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content = (result.content as any[])[0];
  if (result.isError) {
    throw new Error(content.text);
  }
  return JSON.parse(content.text);
}

describe('MCP tools', () => {
  it('lists all 11 tools', async () => {
    const client = await connectClient(makeDeps());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'connect',
      'decode_crash',
      'disconnect',
      'get_status',
      'hard_reset',
      'list_crashes',
      'list_environments',
      'list_ports',
      'provision_wifi',
      'read_serial',
      'send_serial',
      'upload_firmware',
    ]);
  });

  it('list_ports returns the serial manager port list', async () => {
    const client = await connectClient(makeDeps());
    const result = await callTool(client, 'list_ports');
    expect(result.ports).toEqual([{ path: '/dev/cu.usbserial-1' }]);
  });

  it('connect with explicit port and baud rate', async () => {
    const deps = makeDeps();
    const client = await connectClient(deps);
    const result = await callTool(client, 'connect', {
      port: '/dev/cu.usbserial-1',
      baudRate: 921600,
    });
    expect(result).toEqual({
      connected: true,
      port: '/dev/cu.usbserial-1',
      baudRate: 921600,
    });
    expect(deps.serial.connect).toHaveBeenCalled();
  });

  it('connect auto-selects the single available port', async () => {
    const client = await connectClient(makeDeps());
    const result = await callTool(client, 'connect');
    expect(result.port).toBe('/dev/cu.usbserial-1');
  });

  it('connect with multiple ports and no selection lists candidates', async () => {
    const deps = makeDeps({
      serial: makeFakeSerial({
        ports: [{ path: '/dev/cu.a' }, { path: '/dev/cu.b' }],
        baudRate: 115200,
        isConnected: false,
        connectResult: true,
      }),
    });
    const client = await connectClient(deps);
    await expect(callTool(client, 'connect')).rejects.toThrow(/\/dev\/cu\.a.*\/dev\/cu\.b/);
  });

  it('connect reports failure when the port cannot be opened', async () => {
    const deps = makeDeps({
      serial: makeFakeSerial({
        ports: [{ path: '/dev/cu.a' }],
        baudRate: 115200,
        isConnected: false,
        connectResult: false,
      }),
    });
    const client = await connectClient(deps);
    await expect(callTool(client, 'connect', { port: '/dev/cu.a' })).rejects.toThrow(
      /Failed to connect/
    );
  });

  it('read_serial pages through the buffer and strips ANSI codes', async () => {
    const deps = makeDeps({
      data: makeDataSource(['\x1b[32mI (1) boot:\x1b[0m hello', 'plain line']),
    });
    const client = await connectClient(deps);

    const first = await callTool(client, 'read_serial', { max_lines: 1 });
    expect(first.lines).toEqual(['I (1) boot: hello']);
    expect(first.next_cursor).toBe(1);

    const second = await callTool(client, 'read_serial', { after_cursor: first.next_cursor });
    expect(second.lines).toEqual(['plain line']);
    expect(second.next_cursor).toBe(2);
  });

  it('get_status reports connection, config, and latest cursor', async () => {
    const deps = makeDeps({
      data: makeDataSource(['x', 'y'], [], '/fw/firmware.elf'),
    });
    const client = await connectClient(deps);
    const status = await callTool(client, 'get_status');
    expect(status).toMatchObject({
      connected: false,
      baudRate: 115200,
      elfPath: '/fw/firmware.elf',
      crashCount: 0,
      latestCursor: 2,
    });
  });

  it('list_crashes summarises events; decode_crash returns the cached decode', async () => {
    const crash: CrashEvent = {
      id: 'crash-1',
      kind: 'xtensa',
      lines: ['Guru Meditation Error: Core 0 panic'],
      rawText: 'Guru Meditation Error: Core 0 panic',
      timestamp: 123,
      decoded: {
        faultInfo: { coreId: 0, faultMessage: 'LoadProhibited' },
        stacktrace: [
          { address: '0x400d1234', function: 'app_main', file: 'main.c', line: '42' },
        ],
        rawOutput: '',
      },
    };
    const client = await connectClient(makeDeps({ data: makeDataSource([], [crash]) }));

    const { crashes } = await callTool(client, 'list_crashes');
    expect(crashes).toEqual([
      {
        id: 'crash-1',
        kind: 'xtensa',
        timestamp: 123,
        decoded: true,
        summary: 'LoadProhibited',
      },
    ]);

    const decoded = await callTool(client, 'decode_crash', { crash_id: 'crash-1' });
    expect(decoded.frames).toEqual([
      { address: '0x400d1234', function: 'app_main', file: 'main.c', line: '42' },
    ]);
  });

  it('decode_crash errors on unknown id and on missing ELF', async () => {
    const undecoded: CrashEvent = {
      id: 'crash-2',
      kind: 'riscv',
      lines: ['panic'],
      rawText: 'panic',
      timestamp: 1,
    };
    const client = await connectClient(makeDeps({ data: makeDataSource([], [undecoded]) }));

    await expect(callTool(client, 'decode_crash', { crash_id: 'nope' })).rejects.toThrow(
      /list_crashes/
    );
    await expect(callTool(client, 'decode_crash', { crash_id: 'crash-2' })).rejects.toThrow(
      /No ELF file configured/
    );
  });

  it('upload_firmware forwards the environment and returns the result', async () => {
    const uploadResult: UploadResult = {
      success: true,
      exitCode: 0,
      durationMs: 5000,
      outputTail: 'SUCCESS',
    };
    const runUpload = vi.fn(async () => uploadResult);
    const client = await connectClient(makeDeps({ runUpload }));

    const result = await callTool(client, 'upload_firmware', { environment: 'esp32dev' });
    expect(result).toEqual(uploadResult);
    expect(runUpload).toHaveBeenCalledWith('esp32dev');
  });

  it('list_environments errors without a workspace folder', async () => {
    const client = await connectClient(makeDeps());
    await expect(callTool(client, 'list_environments')).rejects.toThrow(/workspace/i);
  });
});
