import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as vscode from 'vscode';
import { SerialPortManager } from './serialPortManager';
import { TrbrCrashCapturer, CrashEvent, DecodedCrash, decodeCrash, decodeCoredumpElf, decodeCoredumpBase64, containsBase64Coredump, CoredumpDecodedResult, Addr2linePool } from './crashDecoder';

export interface SessionConfig {
  elfPath?: string;
  toolPath?: string;
  targetArch?: string;
  romElfPath?: string;
}

export class EspDecoderWebviewPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'esp-decoder.monitorView';

  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private readonly extensionUri: vscode.Uri;
  private readonly serialManager: SerialPortManager;
  private readonly crashCapturer: TrbrCrashCapturer;
  private readonly addr2linePool: Addr2linePool;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly log: vscode.OutputChannel;

  private serialLines: string[] = [];
  private crashEvents: CrashEvent[] = [];
  private lineBuffer = '';
  private config: SessionConfig = {};

  // Batch serial data before posting to the webview to prevent message-queue flooding.
  // Without batching, a device sending data at 921600 baud can produce thousands of
  // postMessage() calls per second, saturating the IPC queue.  Even after the device
  // is disconnected the accumulated queue takes minutes to drain, causing the terminal
  // to keep printing long after the port is closed.
  private pendingSerialData = '';
  private serialFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SERIAL_FLUSH_INTERVAL_MS = 50;
  private readonly utf8Decoder = new StringDecoder('utf8');

  // Log2File state
  private logStream: import('fs').WriteStream | null = null;
  private logFilePath: string | null = null;
  private logFiltered = false;
  private logFilterConfig: { timestamp: boolean; suppressRe: RegExp | null; dedupRe: RegExp | null; dedupThreshold: number } | null = null;
  private logLineBuffer = '';
  private logDedupCount = 0;
  // Saved log session params so logging can be auto-resumed after port reacquire
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private logSuspendedParams: { filtered: boolean; filters: any } | null = null;

  constructor(
    extensionUri: vscode.Uri,
    serialManager: SerialPortManager,
    config?: SessionConfig,
    outputChannel?: vscode.OutputChannel
  ) {
    this.extensionUri = extensionUri;
    this.serialManager = serialManager;
    this.crashCapturer = new TrbrCrashCapturer();
    this.addr2linePool = new Addr2linePool();
    this.config = config || {};
    this.log = outputChannel || vscode.window.createOutputChannel('ESP Decoder');

    // Listen to serial data
    this.disposables.push(
      this.serialManager.onData((data) => {
        this.handleSerialData(data);
      })
    );

    // Listen to serial port errors
    this.disposables.push(
      this.serialManager.onError((err) => {
        this.log.appendLine(`[SerialError] ${err.message}`);
        this.postMessage({ type: 'error', message: err.message });
      })
    );

    // Listen to connection changes
    this.disposables.push(
      this.serialManager.onConnectionChange(async (connected) => {
        this.log.appendLine(`[ConnectionChange] connected=${connected}`);
        if (!connected) {
          this.cancelSerialFlush();
          // Suspend active log session: close the file but remember settings
          if (this.logStream) {
            this.logSuspendedParams = {
              filtered: this.logFiltered,
              filters: this.logFilterConfig ? {
                timestamp: this.logFilterConfig.timestamp,
                suppressPattern: this.logFilterConfig.suppressRe?.source ?? '',
                dedupPattern: this.logFilterConfig.dedupRe?.source ?? '',
                dedupThreshold: this.logFilterConfig.dedupThreshold,
              } : undefined,
            };
            this.stopLogToFile();
          }
        } else if (this.logSuspendedParams) {
          // Port reacquired — auto-start a new log file
          const params = this.logSuspendedParams;
          this.logSuspendedParams = null;
          await this.startLogToFile('', params.filtered, params.filters);
        }
        this.postMessage({
          type: 'connectionChanged',
          connected,
          port: this.serialManager.selectedPath,
          baudRate: this.serialManager.baudRate,
        });
      })
    );

    // Auto-reconnect on unexpected disconnects (e.g. native USB-CDC reset)
    this.disposables.push(
      this.serialManager.onDisconnect((info) => {
        this.logDebug(`[ESP Decoder] onDisconnect: userInitiated=${info.userInitiated} suspended=${info.suspended}`);
        if (info.userInitiated || info.suspended) {
          return;
        }
        const cfg = vscode.workspace.getConfiguration('esp-decoder');
        const enabled = cfg.get<boolean>('serialMonitor.autoReconnect', false);
        if (!enabled) {
          this.logDebug('[ESP Decoder] auto-reconnect disabled (esp-decoder.serialMonitor.autoReconnect=false) — not reconnecting');
          return;
        }
        const timeoutMs = cfg.get<number>('serialMonitor.autoReconnectTimeoutMs', 15000);
        this.log.appendLine(`[ESP Decoder] Unexpected disconnect — starting auto-reconnect (timeout ${timeoutMs}ms)`);
        this.serialManager.startAutoReconnect(timeoutMs);
      })
    );

    // Listen to crash events from trbr's capturer
    this.disposables.push(
      this.crashCapturer.onCrashDetected(async (event) => {
        this.crashEvents.push(event);
        this.log.appendLine(`[ESP Decoder] Crash detected: id=${event.id}, kind=${event.kind}, lines=${event.lines.length}`);
        this.postMessage({
          type: 'crashDetected',
          event: this.serializeCrashEvent(event),
        });

        // Auto-decode if configured
        if (this.config.elfPath) {
          try {
            const decoded = await decodeCrash(
              event,
              this.config.elfPath,
              this.config.toolPath,
              this.config.targetArch,
              this.log,
              this.config.romElfPath,
              this.addr2linePool
            );
            event.decoded = decoded;
            this.postMessage({
              type: 'crashDecoded',
              eventId: event.id,
              decoded: this.serializeDecodedCrash(decoded),
            });
            if (decoded.toolsMissing) {
              vscode.window.showWarningMessage(
                'GDB/addr2line tools not found for this architecture. Build the project for the target chip first so the toolchain gets installed, or configure the tool path manually in settings.'
              );
            }
          } catch (err) {
            this.log.appendLine(`[ESP Decoder] Decode error for ${event.id}: ${err instanceof Error ? err.message : String(err)}`);
            this.postMessage({
              type: 'crashDecodeError',
              eventId: event.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          this.log.appendLine('[ESP Decoder] Crash detected but no ELF file configured — cannot decode');
          this.postMessage({
            type: 'crashDecodeError',
            eventId: event.id,
            error: 'No ELF file configured. Use "ESP Decoder: Select ELF File" to select one.',
          });
        }
      })
    );
  }

  private wireWebview(webview: vscode.Webview): void {
    webview.html = this.getHtmlContent();
    webview.onDidReceiveMessage(
      (message) => {
        this.handleMessage(message).catch((err) => {
          this.log.appendLine(`[ERROR] message handler error: ${err}`);
          this.postMessage({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
          this.syncState();
        });
      },
      null,
      this.disposables
    );
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    this.wireWebview(webviewView.webview);

    webviewView.onDidDispose(() => {
      this.view = undefined;
    }, null, this.disposables);

    // Send initial state
    this.sendInitialState();
  }

  public show(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      vscode.commands.executeCommand('esp-decoder.monitorView.focus');
    }
  }

  /**
   * Open the monitor as an editor tab (legacy behavior).
   * Creates a new WebviewPanel if one doesn't exist.
   */
  public showAsEditor(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'esp-decoder.monitor',
      'ESP Crash Monitor',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri],
        retainContextWhenHidden: true,
      }
    );

    this.wireWebview(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    }, null, this.disposables);

    // Send initial state
    this.sendInitialState();
  }

  private sendInitialState(): void {
    this.syncState();
  }

  public syncState(): void {
    const cfg = vscode.workspace.getConfiguration('esp-decoder');
    this.postMessage({
      type: 'initialState',
      connected: this.serialManager.isConnected,
      port: this.serialManager.selectedPath,
      baudRate: this.serialManager.baudRate,
      elfPath: this.config.elfPath,
      targetArch: this.config.targetArch,
      serialFilters: {
        timestamp: cfg.get<boolean>('serialFilters.timestamp', false),
        suppressPattern: cfg.get<string>('serialFilters.suppressPattern', ''),
        highlightPattern: cfg.get<string>('serialFilters.highlightPattern', ''),
        dedupPattern: cfg.get<string>('serialFilters.dedupPattern', ''),
        dedupThreshold: cfg.get<number>('serialFilters.dedupThreshold', 3),
      },
    });
  }

  public updateConfig(config: Partial<SessionConfig>): void {
    this.config = { ...this.config, ...config };
    this.postMessage({
      type: 'configChanged',
      elfPath: this.config.elfPath,
      toolPath: this.config.toolPath,
      targetArch: this.config.targetArch,
    });
  }

  public get currentElfPath(): string | undefined {
    return this.config.elfPath;
  }

  /**
   * Push the current `terminal.integrated.fontSize` to the webview so the
   * serial output font updates live without rebuilding the HTML.
   */
  public updateTerminalFontSize(): void {
    this.postMessage({ type: 'fontSizeChanged', fontSize: this.getTerminalFontSize() });
  }

  private handleSerialData(data: Buffer): void {
    // Use StringDecoder to correctly handle multi-byte UTF-8 characters
    // (e.g. ▂▄▆█) that may be split across consecutive data chunks.
    const text = this.utf8Decoder.write(data);

    // Write to log file if logging is active
    if (this.logStream) {
      if (this.logFiltered && this.logFilterConfig) {
        this.writeFilteredLog(text);
      } else {
        this.logStream.write(text);
      }
    }

    // Buffer outgoing display data and flush in batches.  Posting every raw
    // chunk as a separate IPC message can produce thousands of messages per
    // second at high baud rates, saturating the webview message queue.
    this.pendingSerialData += text;
    if (this.serialFlushTimer === null) {
      this.serialFlushTimer = setTimeout(
        () => this.flushSerialData(),
        EspDecoderWebviewPanel.SERIAL_FLUSH_INTERVAL_MS
      );
    }

    // Feed raw bytes to trbr's capturer for crash detection.
    // trbr handles line decoding, crash framing (including Stack memory:
    // sections for RISC-V), and deduplication internally.
    this.crashCapturer.pushData(data);

    // Track lines for serial monitor display
    this.lineBuffer += text;
    const lines = this.lineBuffer.split(/\r?\n/);

    // Keep the last incomplete line in buffer
    this.lineBuffer = lines.pop() || '';

    const maxLines = vscode.workspace
      .getConfiguration('esp-decoder')
      .get<number>('serialMonitor.maxLines', 5000);

    for (const line of lines) {
      this.serialLines.push(line);
    }

    // Trim serial lines.  Reassigning to a slice is O(k) and avoids mutating
    // a large array in-place, which is clearer and avoids the risk of GC
    // pressure from holding stale references in the old tail.
    if (this.serialLines.length > maxLines) {
      this.serialLines = this.serialLines.slice(-maxLines);
    }
  }

  /** Send accumulated serial bytes to the webview in one IPC message. */
  private flushSerialData(): void {
    this.serialFlushTimer = null;
    if (this.pendingSerialData) {
      this.postMessage({ type: 'serialData', data: this.pendingSerialData });
      this.pendingSerialData = '';
    }
  }

  /**
   * Cancel the pending serial-data flush timer and discard buffered bytes.
   * Called on disconnect so that data accumulated in the buffer just before
   * the port closed is not forwarded to the webview.
   */
  private cancelSerialFlush(): void {
    if (this.serialFlushTimer !== null) {
      clearTimeout(this.serialFlushTimer);
      this.serialFlushTimer = null;
    }
    this.pendingSerialData = '';
    this.lineBuffer = '';
    // Flush any trailing incomplete bytes so the decoder starts clean on reconnect.
    this.utf8Decoder.end();
    // Flush any pending crash blocks so they are decoded even if the connection
    // drops before a natural terminator (Rebooting..., Backtrace:, etc.) is seen.
    this.crashCapturer.flush();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'connect': {
        this.log.appendLine(`[Connect] requested, selectedPath=${this.serialManager.selectedPath}, isConnected=${this.serialManager.isConnected}`);
        try {
          if (!this.serialManager.selectedPath) {
            const port = await this.serialManager.selectPort();
            if (!port) {
              this.log.appendLine('[Connect] No port selected, aborting');
              this.postMessage({
                type: 'error',
                message: 'No serial port selected. Please select a port first.',
              });
              this.syncState();
              break;
            }
            this.log.appendLine(`[Connect] Port selected: ${port}`);
            this.postMessage({ type: 'portSelected', port });
          }
          this.log.appendLine(`[Connect] Calling connect() for ${this.serialManager.selectedPath} @ ${this.serialManager.baudRate}`);
          const success = await this.serialManager.connect();
          this.log.appendLine(`[Connect] connect() returned ${success}`);
          if (!success) {
            this.postMessage({
              type: 'error',
              message: `Failed to connect to ${this.serialManager.selectedPath || 'unknown port'}.`,
            });
          }
        } catch (err) {
          this.log.appendLine(`[Connect] Exception: ${err instanceof Error ? err.message : String(err)}`);
          this.postMessage({
            type: 'error',
            message: `Connect error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        this.syncState();
        break;
      }
      case 'disconnect': {
        try {
          await this.serialManager.disconnect();
        } catch (err) {
          this.postMessage({
            type: 'error',
            message: `Disconnect error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        this.syncState();
        break;
      }
      case 'hardReset': {
        try {
          await this.serialManager.hardReset();
        } catch (err) {
          this.postMessage({
            type: 'error',
            message: `Reset error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        break;
      }
      case 'selectPort': {
        const port = await this.serialManager.selectPort();
        this.syncState();
        if (port) {
          this.postMessage({ type: 'portSelected', port });
        }
        break;
      }
      case 'selectBaudRate': {
        const rate = await this.serialManager.selectBaudRate();
        this.syncState();
        if (rate) {
          this.postMessage({ type: 'baudRateSelected', baudRate: rate });
        }
        break;
      }
      case 'selectElf':
        await vscode.commands.executeCommand('esp-decoder.selectElfFile');
        break;
      case 'sendData':
        if (message.data) {
          try {
            // Webview appends the user-selected line ending; send as-is.
            await this.serialManager.sendData(message.data);
          } catch (err) {
            vscode.window.showErrorMessage(
              `Failed to send: ${err instanceof Error ? err.message : err}`
            );
          }
        }
        break;
      case 'clear':
        this.cancelSerialFlush();
        this.serialLines = [];
        this.crashEvents = [];
        this.crashCapturer.reset();
        break;
      case 'saveFilters': {
        try {
          const cfg = vscode.workspace.getConfiguration('esp-decoder');
          await cfg.update('serialFilters.timestamp', message.timestamp, vscode.ConfigurationTarget.Global);
          await cfg.update('serialFilters.suppressPattern', message.suppressPattern, vscode.ConfigurationTarget.Global);
          await cfg.update('serialFilters.highlightPattern', message.highlightPattern, vscode.ConfigurationTarget.Global);
          await cfg.update('serialFilters.dedupPattern', message.dedupPattern, vscode.ConfigurationTarget.Global);
          await cfg.update('serialFilters.dedupThreshold', message.dedupThreshold, vscode.ConfigurationTarget.Global);
          this.postMessage({ type: 'filtersSaved', ok: true });
        } catch (err) {
          this.postMessage({
            type: 'filtersSaved',
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case 'decodeCrash': {
        const event = this.crashEvents.find((e) => e.id === message.eventId);
        if (event && this.config.elfPath) {
          try {
            const decoded = await decodeCrash(
              event,
              this.config.elfPath,
              this.config.toolPath,
              this.config.targetArch,
              this.log,
              this.config.romElfPath,
              this.addr2linePool
            );
            event.decoded = decoded;
            this.postMessage({
              type: 'crashDecoded',
              eventId: event.id,
              decoded: this.serializeDecodedCrash(decoded),
            });
            if (decoded.toolsMissing) {
              vscode.window.showWarningMessage(
                'GDB/addr2line tools not found for this architecture. Build the project for the target chip first so the toolchain gets installed, or configure the tool path manually in settings.'
              );
            }
          } catch (err) {
            this.postMessage({
              type: 'crashDecodeError',
              eventId: event.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else if (!this.config.elfPath) {
          vscode.window.showWarningMessage(
            'No ELF file configured. Please select an ELF file first.'
          );
        }
        break;
      }
      case 'openFile': {
        if (message.file && message.line) {
          const filePath = await this.resolveSourcePath(String(message.file));
          const line = parseInt(message.line, 10) - 1;
          const col = message.column ? parseInt(message.column, 10) - 1 : 0;
          try {
            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, {
              selection: new vscode.Range(line, col, line, col),
              preview: true,
            });
          } catch {
            vscode.window.showErrorMessage(`Cannot open file: ${message.file}`);
          }
        }
        break;
      }
      case 'decodePastedCrash': {
        if (typeof message.text === 'string' && message.text.trim()) {
          // Check if pasted text contains a base64-encoded coredump
          if (containsBase64Coredump(message.text)) {
            await this.handlePastedBase64Coredump(message.text);
          } else {
            // Reset capturer so pasted data is treated as a fresh crash block
            this.crashCapturer.reset();
            // Feed the text through the crash capturer as if it came from serial.
            // The existing onCrashDetected listener handles detection + decoding.
            const data = Buffer.from(message.text + '\n');
            this.crashCapturer.pushData(data);
            // Flush immediately to finalize the crash block since pasted data
            // is a one-shot (unlike streaming serial data).
            this.crashCapturer.flush();
          }
        }
        break;
      }
      case 'decodeCoredumpFile': {
        await this.handleDecodeCoredumpFile();
        break;
      }
      case 'startLog': {
        await this.startLogToFile(
          typeof message.filename === 'string' ? message.filename : '',
          !!message.filtered,
          message.filters,
        );
        break;
      }
      case 'stopLog': {
        this.logSuspendedParams = null;
        this.stopLogToFile();
        break;
      }
    }
  }

  /**
   * Start logging serial data to a file.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async startLogToFile(customFilename: string, filtered?: boolean, filters?: any): Promise<void> {
    if (this.logStream) {
      this.stopLogToFile();
    }

    // Set up filtered logging
    this.logFiltered = !!filtered;
    this.logLineBuffer = '';
    this.logDedupCount = 0;
    if (filtered && filters) {
      let suppressRe: RegExp | null = null;
      let dedupRe: RegExp | null = null;
      try { suppressRe = filters.suppressPattern ? new RegExp(filters.suppressPattern) : null; } catch { /* invalid regex ignored */ }
      try { dedupRe = filters.dedupPattern ? new RegExp(filters.dedupPattern, 'g') : null; } catch { /* invalid regex ignored */ }
      this.logFilterConfig = {
        timestamp: !!filters.timestamp,
        suppressRe,
        dedupRe,
        dedupThreshold: (typeof filters.dedupThreshold === 'number' && filters.dedupThreshold >= 1) ? filters.dedupThreshold : 3,
      };
    } else {
      this.logFilterConfig = null;
    }

    const logDir = await this.resolveLogDirectory();
    if (!logDir) {
      this.postMessage({ type: 'logFailed' });
      return;
    }

    // Build filename: use custom name or generate default "serial-YYYYMMDD_HHMMSS.log"
    let filename: string;
    if (customFilename) {
      // Sanitise to prevent path traversal
      filename = path.basename(customFilename);
    } else {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
      const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      filename = `serial-${dateStr}_${timeStr}.log`;
    }

    this.logFilePath = path.join(logDir, filename);
    const stream = fs.createWriteStream(this.logFilePath, { flags: 'a', encoding: 'utf8' });
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', (err) => reject(err));
    }).then(() => {
      this.logStream = stream;
      this.log.appendLine(`[ESP Decoder] Log2File started: ${this.logFilePath}`);
      vscode.window.showInformationMessage(`Logging to ${this.logFilePath}`);
      this.postMessage({ type: 'logStarted' });
    }).catch((err) => {
      stream.destroy();
      this.logFilePath = null;
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[ESP Decoder] Log2File failed to open: ${msg}`);
      vscode.window.showErrorMessage(`Failed to start logging: ${msg}`);
      this.postMessage({ type: 'logFailed' });
    });
  }

  /**
   * Resolve a file path emitted by the serial monitor (or crash output) to an
   * absolute path that can be opened. Tries, in order:
   *   1. Use the path as-is when it is already absolute and exists.
   *   2. Resolve it against each open workspace folder.
   *   3. Search the workspace for a file whose suffix matches the input.
   *   4. Fall back to a basename search.
   * Returns the original path when no match is found so the existing error
   * handling can show a user-visible message.
   */
  private async resolveSourcePath(input: string): Promise<string> {
    const normalised = input.replace(/\\/g, '/');
    if (path.isAbsolute(normalised)) {
      try {
        await fs.promises.access(normalised);
        return normalised;
      } catch { /* fall through to search */ }
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const candidate = path.join(folder.uri.fsPath, normalised);
      try {
        await fs.promises.access(candidate);
        return candidate;
      } catch { /* try next */ }
    }
    // Search workspace for a file ending with the relative path or basename.
    if (folders.length > 0) {
      const basename = path.basename(normalised);
      try {
        const found = await vscode.workspace.findFiles(`**/${basename}`, '**/node_modules/**', 50);
        if (found.length > 0) {
          const exact = found.find((u) => u.fsPath.replace(/\\/g, '/').endsWith(normalised));
          if (exact) { return exact.fsPath; }
          // No exact suffix match — fall back to the first hit so that
          // openTextDocument has something to try (and surfaces a clear
          // error if it really is the wrong file) instead of guaranteeing
          // failure by returning the raw, likely-relative input.
          return found[0].fsPath;
        }
      } catch { /* ignore */ }
    }
    return input;
  }

  private async resolveLogDirectory(): Promise<string | null> {
    const cfg = vscode.workspace.getConfiguration('esp-decoder');
    const configuredDir = cfg.get<string>('logDirectory', 'logs').trim() || 'logs';
    const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const resolvedDir = path.isAbsolute(configuredDir)
      ? configuredDir
      : path.join(workspaceDir ?? os.homedir(), configuredDir);

    try {
      await fs.promises.mkdir(resolvedDir, { recursive: true });
      return resolvedDir;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[ESP Decoder] Failed to create log directory ${resolvedDir}: ${msg}`);
      vscode.window.showErrorMessage(`Failed to create log directory: ${resolvedDir} (${msg})`);
      return null;
    }
  }

  /**
   * Stop logging serial data to file.
   */
  /**
   * Write serial text through server-side filters before writing to log file.
   * Processes text line-by-line: applies suppress, timestamp, and dedup.
   */
  private writeFilteredLog(text: string): void {
    if (!this.logStream || !this.logFilterConfig) { return; }

    this.logLineBuffer += text;
    const parts = this.logLineBuffer.split(/\r\n|[\r\n]/);
    // Keep the last (possibly incomplete) segment in the buffer
    this.logLineBuffer = parts.pop() || '';

    for (const rawLine of parts) {
      this.finalizeLogLine(rawLine);
    }
  }

  /**
   * Process a single complete raw line through suppress, dedup, and timestamp
   * filters and write the result to the log stream.
   */
  private finalizeLogLine(rawLine: string): void {
    if (!this.logStream || !this.logFilterConfig) { return; }
    const cfg = this.logFilterConfig;

    // Suppress filter
    if (cfg.suppressRe && cfg.suppressRe.test(rawLine)) {
      this.logDedupCount = 0;
      return;
    }

    let line = rawLine;

    // Dedup filter
    if (cfg.dedupRe) {
      cfg.dedupRe.lastIndex = 0;
      let result = '';
      let lastIdx = 0;
      let m: RegExpExecArray | null;
      let lineDedup = 0;
      while ((m = cfg.dedupRe.exec(line)) !== null) {
        result += line.slice(lastIdx, m.index);
        this.logDedupCount++;
        lineDedup++;
        if (this.logDedupCount <= cfg.dedupThreshold) {
          result += m[0];
        }
        lastIdx = m.index + m[0].length;
      }
      result += line.slice(lastIdx);
      if (this.logDedupCount > cfg.dedupThreshold && lineDedup > 0) {
        result += ` [x${this.logDedupCount}]`;
      }
      line = result;
    }

    // Reset dedup count per line (matching webview behavior)
    this.logDedupCount = 0;

    // Timestamp filter
    if (cfg.timestamp) {
      const now = new Date();
      const ts = now.toISOString().slice(11, 23);
      line = `[${ts}] ${line}`;
    }

    this.logStream.write(line + '\n');
  }

  private stopLogToFile(): void {
    if (this.logStream) {
      // Flush remaining line buffer through filters
      if (this.logFiltered && this.logLineBuffer) {
        const remaining = this.logLineBuffer.split(/\r\n|[\r\n]/);
        this.logLineBuffer = '';
        for (const seg of remaining) {
          this.finalizeLogLine(seg);
        }
      }
      this.logStream.end();
      this.logStream = null;
      this.logFiltered = false;
      this.logFilterConfig = null;
      this.logDedupCount = 0;
      this.log.appendLine(`[ESP Decoder] Log2File stopped: ${this.logFilePath}`);
      if (this.logFilePath) {
        vscode.window.showInformationMessage(`Log saved: ${this.logFilePath}`);
      }
      this.logFilePath = null;
      this.postMessage({ type: 'logStopped' });
    }
  }

  /**
   * Show a file picker to select a coredump ELF file, then decode it
   * using trbr's coredump mode.
   */
  private async handleDecodeCoredumpFile(): Promise<void> {
    if (!this.config.elfPath) {
      vscode.window.showWarningMessage(
        'No firmware ELF file configured. Please select an ELF file first.'
      );
      return;
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'Coredump Files': ['bin', 'b64'],
        'All Files': ['*'],
      },
      title: 'Select ESP Coredump File (bin or b64)',
    });

    if (!uris || uris.length === 0) {
      return;
    }

    const coredumpPath = uris[0].fsPath;
    this.log.appendLine(`[ESP Decoder] Decoding coredump: ${coredumpPath}`);

    // Create a synthetic crash event for the coredump
    const eventId = `coredump-${Date.now()}`;
    const event: CrashEvent = {
      id: eventId,
      kind: 'unknown',
      lines: [`Coredump ELF: ${coredumpPath}`],
      rawText: `Coredump ELF file: ${coredumpPath}`,
      timestamp: Date.now(),
    };
    this.crashEvents.push(event);

    this.postMessage({
      type: 'crashDetected',
      event: {
        ...this.serializeCrashEvent(event),
        isCoredump: true,
      },
    });

    try {
      const result = await decodeCoredumpElf(
        coredumpPath,
        this.config.elfPath,
        this.config.toolPath,
        this.config.targetArch,
        this.log,
      );

      this.postMessage({
        type: 'coredumpDecoded',
        eventId,
        result: this.serializeCoredumpResult(result),
      });
      if (result.toolsMissing) {
        vscode.window.showWarningMessage(
          'GDB/addr2line tools not found for this architecture. Build the project for the target chip first so the toolchain gets installed, or configure the tool path manually in settings.'
        );
      }
    } catch (err) {
      this.log.appendLine(
        `[ESP Decoder] Coredump decode error: ${err instanceof Error ? err.message : String(err)}`
      );
      this.postMessage({
        type: 'crashDecodeError',
        eventId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle pasted text containing a base64-encoded coredump.
   */
  private async handlePastedBase64Coredump(text: string): Promise<void> {
    if (!this.config.elfPath) {
      vscode.window.showWarningMessage(
        'No firmware ELF file configured. Please select an ELF file first.'
      );
      return;
    }

    const eventId = `coredump-b64-${Date.now()}`;
    const event: CrashEvent = {
      id: eventId,
      kind: 'unknown',
      lines: ['Pasted base64 coredump'],
      rawText: text,
      timestamp: Date.now(),
    };
    this.crashEvents.push(event);

    this.postMessage({
      type: 'crashDetected',
      event: {
        ...this.serializeCrashEvent(event),
        isCoredump: true,
      },
    });

    try {
      const result = await decodeCoredumpBase64(
        text,
        this.config.elfPath,
        this.config.toolPath,
        this.config.targetArch,
        this.log,
      );

      this.postMessage({
        type: 'coredumpDecoded',
        eventId,
        result: this.serializeCoredumpResult(result),
      });
      if (result.toolsMissing) {
        vscode.window.showWarningMessage(
          'GDB/addr2line tools not found for this architecture. Build the project for the target chip first so the toolchain gets installed, or configure the tool path manually in settings.'
        );
      }
    } catch (err) {
      this.log.appendLine(
        `[ESP Decoder] Base64 coredump decode error: ${err instanceof Error ? err.message : String(err)}`
      );
      this.postMessage({
        type: 'crashDecodeError',
        eventId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private serializeCrashEvent(event: CrashEvent): any {
    return {
      id: event.id,
      kind: event.kind,
      rawText: event.rawText,
      timestamp: event.timestamp,
      lines: event.lines,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private serializeDecodedCrash(decoded: DecodedCrash): any {
    return {
      faultInfo: decoded.faultInfo,
      stacktrace: decoded.stacktrace,
      regs: decoded.regs,
      regAnnotations: decoded.regAnnotations,
      allocInfo: decoded.allocInfo,
      rawOutput: decoded.rawOutput,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private serializeCoredumpResult(result: CoredumpDecodedResult): any {
    return {
      threads: result.threads.map(t => ({
        threadId: t.threadId,
        threadName: t.threadName,
        isCurrent: t.isCurrent,
        decoded: this.serializeDecodedCrash(t.decoded),
      })),
      rawOutput: result.rawOutput,
    };
  }

  /**
   * Append a diagnostic line to the output channel only when
   * `esp-decoder.debugLogging` is enabled. Use for verbose internal-state
   * messages that are noise during normal use but useful for troubleshooting.
   */
  private logDebug(message: string): void {
    if (vscode.workspace.getConfiguration('esp-decoder').get<boolean>('debugLogging', false)) {
      this.log.appendLine(message);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private postMessage(message: any): void {
    if (this.view) {
      this.view.webview.postMessage(message);
    }
    if (this.panel) {
      this.panel.webview.postMessage(message);
    }
  }

  public dispose(): void {
    this.logSuspendedParams = null;
    this.stopLogToFile();
    this.cancelSerialFlush();
    this.crashCapturer.dispose();
    this.addr2linePool.disposeAll();
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }

  /**
   * Read the serial-output font size from the user's VS Code settings.
   * Uses `terminal.integrated.fontSize` (falling back to 13px when unset or
   * when set to VS Code's "0 = use editor default" sentinel).
   */
  private getTerminalFontSize(): number {
    return vscode.workspace
      .getConfiguration('terminal')
      .get<number>('integrated.fontSize') || 13;
  }

  private getHtmlContent(): string {
    const nonce = getNonce();
    const ansiParserJs = fs.readFileSync(
      path.join(this.extensionUri.fsPath, 'dist', 'ansiParser.js'), 'utf8'
    );
    const terminalFontSize = this.getTerminalFontSize();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>ESP Decoder — Crash Monitor</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, #444);
      --header-bg: var(--vscode-sideBarSectionHeader-background, #252526);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground);
      --btn-secondary-fg: var(--vscode-button-secondaryForeground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, #444);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --error-fg: var(--vscode-errorForeground, #f44);
      --warning-fg: var(--vscode-editorWarning-foreground, #fa4);
      --success-fg: var(--vscode-terminal-ansiGreen, #4a4);
      --link-fg: var(--vscode-textLink-foreground, #3794ff);
      --serial-font-size: ${terminalFontSize}px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 0;
      margin: 0;
    }

    /* Toolbar */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--header-bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      flex-wrap: wrap;
    }

    .toolbar-group {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .toolbar-separator {
      width: 1px;
      height: 20px;
      background: var(--border);
      margin: 0 4px;
    }

    button {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
      border-radius: 2px;
      white-space: nowrap;
    }
    button:hover { background: var(--btn-hover); }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    button.secondary {
      background: var(--btn-secondary-bg);
      color: var(--btn-secondary-fg);
    }

    .status-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .status-indicator.connected { background: var(--success-fg); }
    .status-indicator.disconnected { background: var(--error-fg); }

    .status-text {
      font-size: 11px;
      opacity: 0.8;
    }

    .config-label {
      font-size: 11px;
      opacity: 0.7;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Main content area */
    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Tab bar */
    .tab-bar {
      display: flex;
      background: var(--header-bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .tab {
      padding: 6px 16px;
      cursor: pointer;
      font-size: 12px;
      border-bottom: 2px solid transparent;
      opacity: 0.7;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tab:hover { opacity: 1; }
    .tab.active {
      opacity: 1;
      border-bottom-color: var(--btn-bg);
    }

    .tab-badge {
      background: var(--badge-bg);
      color: var(--badge-fg);
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 8px;
      min-width: 16px;
      text-align: center;
    }

    /* Panels */
    .panel {
      flex: 1;
      overflow: hidden;
      display: none;
    }
    .panel.active { display: flex; flex-direction: column; }

    /* Scroll-to-bottom button */
    #btn-scroll-bottom {
      position: absolute;
      bottom: 56px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 10;
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 20px;
      padding: 6px 16px;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.4;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      display: none;
      white-space: nowrap;
      transition: background 0.15s, box-shadow 0.15s;
    }
    #btn-scroll-bottom:hover { background: var(--btn-hover); box-shadow: 0 4px 12px rgba(0,0,0,0.5); }

    /* Serial Monitor */
    #serial-output {
      flex: 1;
      min-width: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 4px 8px;
      font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
      font-size: var(--serial-font-size, 13px);
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-all;
      overflow-wrap: break-word;
      background: var(--bg);
    }
    /* Each serial line is rendered as a <div>; ensure empty lines (e.g. blank
       lines from "\n\n" in device output) still occupy one row of height
       instead of collapsing to zero. */
    #serial-output > div {
      min-height: 1.4em;
      overflow-wrap: break-word;
    }

    .serial-input-row {
      display: flex;
      gap: 4px;
      padding: 4px 8px;
      background: var(--header-bg);
      border-top: 1px solid var(--border);
      flex-shrink: 0;
    }

    .serial-input-row input {
      flex: 1;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      padding: 3px 6px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      outline: none;
    }

    .serial-input-row select {
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      padding: 2px 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      outline: none;
      cursor: pointer;
    }

    /* Filter toolbar */
    .filter-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      background: var(--header-bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      flex-wrap: wrap;
      font-size: 11px;
    }
    .filter-toolbar label {
      display: flex;
      align-items: center;
      gap: 3px;
      cursor: pointer;
      white-space: nowrap;
      opacity: 0.85;
    }
    .filter-toolbar label:hover { opacity: 1; }
    .filter-toolbar input[type="checkbox"] { cursor: pointer; }
    .filter-toolbar .filter-sep {
      width: 1px;
      height: 14px;
      background: var(--border);
      flex-shrink: 0;
    }
    .filter-toolbar input[type="text"] {
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      padding: 1px 5px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      outline: none;
      width: 140px;
      border-radius: 2px;
    }
    .filter-toolbar input[type="text"].filter-error {
      border-color: var(--error-fg);
    }
    .filter-toolbar .filter-label { opacity: 0.6; }
    button.feedback-saved {
      background: var(--vscode-testing-iconPassed, #28a745) !important;
      color: var(--vscode-button-foreground);
      transition: background 0.2s ease;
    }
    button.feedback-error {
      background: var(--error-fg, #d73a49) !important;
      color: var(--vscode-button-foreground);
      transition: background 0.2s ease;
    }
    .filter-toolbar button.log-active {
      background: var(--success-fg);
      color: #000;
    }
    .filter-toolbar button.log-active:hover {
      opacity: 0.85;
    }
    .dedup-badge {
      font-size: 10px;
      opacity: 0.6;
      margin-left: 5px;
      background: var(--border);
      padding: 0 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    /* Crash Events Panel */
    .crash-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
    }

    .crash-event {
      border: 1px solid var(--border);
      border-radius: 4px;
      margin: 4px;
      overflow: hidden;
    }

    .crash-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 10px;
      background: var(--header-bg);
      cursor: pointer;
      user-select: none;
    }

    .crash-header:hover {
      opacity: 0.9;
    }

    .crash-title {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .crash-kind {
      font-size: 10px;
      font-weight: bold;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--badge-bg);
      color: var(--badge-fg);
    }

    .crash-time {
      font-size: 11px;
      opacity: 0.7;
    }

    .crash-body {
      display: none;
      padding: 8px 10px;
      border-top: 1px solid var(--border);
    }

    .crash-event.expanded .crash-body {
      display: block;
    }

    .crash-section {
      margin-bottom: 8px;
    }

    .crash-section-title {
      font-weight: bold;
      font-size: 12px;
      margin-bottom: 4px;
      color: var(--btn-bg);
    }

    /* Fault info box */
    .fault-info {
      background: rgba(255, 70, 70, 0.1);
      border: 1px solid rgba(255, 70, 70, 0.3);
      border-radius: 4px;
      padding: 6px 10px;
      margin-bottom: 8px;
    }

    .fault-message {
      color: var(--error-fg);
      font-weight: bold;
    }

    /* Stack trace table */
    .stacktrace-table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }

    .stacktrace-table th {
      text-align: left;
      padding: 3px 8px;
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      opacity: 0.7;
    }

    .stacktrace-table td {
      padding: 2px 8px;
      border-bottom: 1px solid rgba(128, 128, 128, 0.15);
    }

    .stacktrace-table tr:hover td {
      background: rgba(128, 128, 128, 0.1);
    }

    .frame-num {
      opacity: 0.5;
      width: 30px;
    }

    .frame-addr {
      color: var(--warning-fg);
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .frame-func {
      color: var(--link-fg);
    }

    .frame-file {
      cursor: pointer;
      color: var(--link-fg);
      text-decoration: underline;
    }
    .frame-file:hover {
      opacity: 0.8;
    }

    /* Inline file:line links inside serial output. Underlined only when
       hovered while Ctrl/Cmd is held (mod-link-active). */
    .serial-file-link {
      text-decoration: none;
      cursor: text;
    }
    body.mod-link-active .serial-file-link {
      cursor: pointer;
    }
    body.mod-link-active .serial-file-link:hover {
      text-decoration: underline;
      text-decoration-color: var(--link-fg);
    }

    /* Register grid */
    .registers-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 2px 12px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }

    .reg-entry {
      display: flex;
      justify-content: space-between;
      padding: 1px 4px;
    }

    .reg-name {
      opacity: 0.7;
      min-width: 60px;
    }

    .reg-value {
      color: var(--warning-fg);
    }

    /* Annotated registers (full-width layout) */
    .registers-annotated {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }

    .reg-entry-annotated {
      display: flex;
      gap: 8px;
      padding: 1px 4px;
      align-items: baseline;
    }

    .reg-entry-annotated .reg-name {
      flex-shrink: 0;
      min-width: 60px;
    }

    .reg-entry-annotated .reg-value {
      flex-shrink: 0;
    }

    .reg-annotation {
      color: var(--link-fg);
      opacity: 0.85;
      font-size: 11px;
    }

    /* Raw crash output */
    .raw-output {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
      padding: 6px;
      background: rgba(0, 0, 0, 0.15);
      border-radius: 4px;
      max-height: 200px;
      overflow-y: auto;
    }

    .no-events {
      padding: 40px;
      text-align: center;
      opacity: 0.5;
    }

    /* ANSI colour support for serial output */
    .ansi-bold { font-weight: bold; }
    .ansi-dim { opacity: 0.5; }
    .ansi-italic { font-style: italic; }
    .ansi-underline { text-decoration: underline; }
    .ansi-strikethrough { text-decoration: line-through; }
    .ansi-underline.ansi-strikethrough { text-decoration: underline line-through; }
    .ansi-blink { animation: ansi-blink 1s step-end infinite; }
    .ansi-blink-fast { animation: ansi-blink 0.5s step-end infinite; }
    .ansi-hidden { visibility: hidden; }
    .ansi-reverse { background: var(--fg); color: var(--bg); }
    @keyframes ansi-blink { 50% { opacity: 0; } }
    .ansi-fg-black   { color: rgb(128,128,128); }
    .ansi-fg-red     { color: rgb(255,  0,  0); }
    .ansi-fg-green   { color: rgb(  0,255,  0); }
    .ansi-fg-yellow  { color: rgb(255,255,  0); }
    .ansi-fg-blue    { color: rgb( 99,153,255); }
    .ansi-fg-magenta { color: rgb(255,  0,255); }
    .ansi-fg-cyan    { color: rgb(  0,255,255); }
    .ansi-fg-white   { color: rgb(192,192,192); }
    .ansi-bg-black   { background-color: rgb(  0,  0,  0); }
    .ansi-bg-red     { background-color: rgb(255,  0,  0); }
    .ansi-bg-green   { background-color: rgb(  0,255,  0); }
    .ansi-bg-yellow  { background-color: rgb(255,255,  0); }
    .ansi-bg-blue    { background-color: rgb(  0,  0,255); }
    .ansi-bg-magenta { background-color: rgb(255,  0,255); }
    .ansi-bg-cyan    { background-color: rgb(  0,255,255); }
    .ansi-bg-white   { background-color: rgb(255,255,255); }

    .decode-status {
      font-size: 11px;
      font-style: italic;
      opacity: 0.7;
      padding: 4px 0;
    }

    .decode-error {
      color: var(--error-fg);
      font-size: 11px;
      padding: 4px 0;
    }

    /* Paste-crash modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 200;
    }
    .modal-overlay.hidden { display: none; }
    .modal-box {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      width: 90%;
      max-width: 720px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .modal-title {
      font-weight: bold;
      font-size: 14px;
    }
    .modal-hint {
      font-size: 11px;
      opacity: 0.65;
    }
    .modal-box textarea {
      width: 100%;
      height: 280px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      padding: 6px 8px;
      font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
      font-size: 12px;
      resize: vertical;
      outline: none;
    }
    .modal-buttons {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  </style>
</head>
<body>
  <!-- Toolbar -->
  <div class="toolbar">
    <div class="toolbar-group">
      <span class="status-indicator disconnected" id="status-dot"></span>
      <span class="status-text" id="status-text">Disconnected</span>
    </div>
    <div class="toolbar-separator"></div>
    <div class="toolbar-group">
      <button id="btn-port" class="secondary" title="Select serial port">Port: —</button>
      <button id="btn-baud" class="secondary" title="Select baud rate">115200</button>
    </div>
    <div class="toolbar-separator"></div>
    <div class="toolbar-group">
      <button id="btn-connect" title="Connect to serial port">Connect</button>
      <button id="btn-disconnect" title="Disconnect from serial port" disabled>Disconnect</button>
      <button id="btn-reset" class="secondary" title="Hard-reset the chip (toggles RTS/EN, same as esptool reset_chip hard-reset)" disabled>Reset</button>
    </div>
    <div class="toolbar-separator"></div>
    <div class="toolbar-group">
      <button id="btn-elf" class="secondary" title="Select ELF file for decoding">ELF: —</button>
    </div>
    <div class="toolbar-separator"></div>
    <div class="toolbar-group">
      <button id="btn-clear" class="secondary" title="Clear all output">Clear</button>
    </div>
    <div class="toolbar-separator"></div>
    <div class="toolbar-group">
      <button id="btn-paste-crash" class="secondary" title="Paste or load a crash log for offline decoding">Decode Log</button>
    </div>
  </div>

  <!-- Tab Bar -->
  <div class="tab-bar">
    <div class="tab active" data-tab="serial">
      Serial Monitor
    </div>
    <div class="tab" data-tab="crashes">
      Crash Events
      <span class="tab-badge" id="crash-count" style="display:none">0</span>
    </div>
  </div>

  <!-- Serial Monitor Panel -->
  <div class="panel active" id="panel-serial" style="position:relative">
    <!-- Filter toolbar -->
    <div class="filter-toolbar" id="filter-toolbar">
      <span class="filter-label">Filters:</span>
      <label title="Prepend HH:MM:SS.mmm timestamp to each line">
        <input type="checkbox" id="filter-timestamp"> Timestamp
      </label>
      <div class="filter-sep"></div>
      <label title="Hide lines matching this regex">
        <span class="filter-label">Suppress:</span>
      </label>
      <input type="text" id="filter-suppress" placeholder="regex…" title="Hide lines matching this regex (e.g. ^\s*$)">
      <div class="filter-sep"></div>
      <label title="Highlight matches of this regex">
        <span class="filter-label">Highlight:</span>
      </label>
      <input type="text" id="filter-highlight" placeholder="regex…" title="Highlight matches of this regex">
      <div class="filter-sep"></div>
      <label title="Collapse repeated characters/strings matching this regex after N occurrences">
        <span class="filter-label">Dedup:</span>
      </label>
      <input type="text" id="filter-dedup-pattern" placeholder="regex…" title="Regex for repeated chars to collapse (e.g. \\.)" style="width:80px">
      <label title="Collapse after this many occurrences">after</label>
      <input type="text" id="filter-dedup-threshold" placeholder="3" title="Collapse after N occurrences" style="width:36px">
      <div class="filter-sep"></div>
      <button id="filter-save" class="secondary" title="Save current filter settings to VS Code settings" style="font-size:11px;padding:1px 7px">Save</button>
      <div class="filter-sep"></div>
      <label title="Apply Suppress, Timestamp and Dedup filters to the log file">
        <input type="checkbox" id="filter-log-filtered"> Filtered
      </label>
      <button id="filter-log2file" class="secondary" title="Start/stop logging serial output to a file" style="font-size:11px;padding:1px 7px">Log2File</button>
      <input type="text" id="filter-log-filename" placeholder="serial-YYYYMMDD_HHMMSS.log" title="Override default log filename" style="width:200px">
    </div>
    <div id="serial-output"></div>
    <button id="btn-scroll-bottom" title="Scroll to bottom">&#8595; Scroll to bottom</button>
    <div class="serial-input-row">
      <input type="text" id="serial-input" placeholder="Type command and press Enter..."
        autocomplete="off" spellcheck="false" />
      <select id="line-ending" title="Line ending appended when sending">
        <option value="crlf">CRLF (\\r\\n)</option>
        <option value="lf">LF (\\n)</option>
        <option value="cr">CR (\\r)</option>
        <option value="none">None</option>
      </select>
      <button id="btn-send">Send</button>
    </div>
  </div>

  <!-- Crash Events Panel -->
  <div class="panel" id="panel-crashes">
    <div class="crash-list" id="crash-list">
      <div class="no-events" id="no-crashes">
        No crash events detected yet.<br>
        Connect to a serial port and wait for crash output.
      </div>
    </div>
  </div>

  <!-- Paste Crash Log Modal -->
  <div class="modal-overlay hidden" id="paste-modal">
    <div class="modal-box">
      <div class="modal-title">Decode Crash Log</div>
      <div class="modal-hint">Paste the full serial output containing the crash dump (including base64-encoded coredumps), or load an ESP coredump file. The decoded result will appear in the Crash Events tab.</div>
      <textarea id="paste-textarea" placeholder="Paste crash log here..." spellcheck="false" autocomplete="off"></textarea>
      <div class="modal-buttons">
        <button class="secondary" id="btn-coredump-file" title="Load an ESP coredump file (bin or base64)">Load Coredump…</button>
        <span style="flex:1"></span>
        <button class="secondary" id="btn-paste-cancel">Cancel</button>
        <button id="btn-paste-decode">Decode</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    ${ansiParserJs}
    const vscode = acquireVsCodeApi();
    const serialOutput = document.getElementById('serial-output');
    const serialInput = document.getElementById('serial-input');
    const crashList = document.getElementById('crash-list');
    const noCrashes = document.getElementById('no-crashes');
    const crashCountBadge = document.getElementById('crash-count');
    const btnScrollBottom = document.getElementById('btn-scroll-bottom');

    let connected = false;
    let autoscroll = true;
    let crashCount = 0;
    // Guards against scheduling multiple requestAnimationFrame callbacks for scrolling.
    let scrollRAFPending = false;
    // Prevents programmatic scrollTop assignments from being misread as user
    // scroll events and accidentally disabling autoscroll (race at high baud rates).
    let programmaticScroll = false;

    // ── Serial filter state ──────────────────────────────────────────────────
    const filterState = {
      timestamp: false,
      suppressPattern: '',
      highlightPattern: '',
      _suppressRe: null,
      _highlightRe: null,
      dedupPattern: '',
      dedupThreshold: 3,
      _dedupRe: null,
      // runtime dedup state (per-line, reset on newline)
      _dedupCount: 0,
      _dedupBadge: null,   // <span class="dedup-badge"> in current DOM line
      _lineStarted: false, // whether timestamp has been prepended for this line
    };

    function filterSetSuppressPattern(pat) {
      filterState.suppressPattern = pat;
      try { filterState._suppressRe = pat ? new RegExp(pat) : null; }
      catch (_) { filterState._suppressRe = null; }
    }

    function filterSetHighlightPattern(pat) {
      filterState.highlightPattern = pat;
      try { filterState._highlightRe = pat ? new RegExp(pat, 'g') : null; }
      catch (_) { filterState._highlightRe = null; }
    }

    function filterSetDedupPattern(pat) {
      filterState.dedupPattern = pat;
      try { filterState._dedupRe = pat ? new RegExp(pat, 'g') : null; }
      catch (_) { filterState._dedupRe = null; }
    }

    // Reset dedup state when a new line starts.
    function dedupResetLine() {
      filterState._dedupCount = 0;
      filterState._dedupBadge = null;
      filterState._lineStarted = false;
    }

    // Apply per-chunk filters (highlight, dedup). Timestamp is prepended once
    // on the first non-empty chunk of each line.
    function applyChunkFilters(chunk) {
      if (chunk === '') { return chunk; }
      // Apply dedup first on raw device payload before adding ANSI sequences.
      var out = applyDedupToChunk(chunk);
      // Prepend timestamp once at the start of the line.
      if (filterState.timestamp && !filterState._lineStarted) {
        var now = new Date();
        var ts = now.toISOString().slice(11, 23);
        // Save the current SGR state, render the timestamp dim, then restore
        // the previous SGR state so multi-line coloured output (e.g. an
        // ESP_LOGI message containing embedded newlines) keeps its colour
        // on every line instead of being reset by the timestamp's [0m.
        var restore = ansiStateToSgr();
        out = ESC + '[0m' + ESC + '[2m[' + ts + ']' + ESC + '[0m' + restore + ' ' + out;
        filterState._lineStarted = true;
      } else if (out !== '') {
        filterState._lineStarted = true;
      }
      // Apply highlight.
      if (filterState._highlightRe) {
        filterState._highlightRe.lastIndex = 0;
        out = out.replace(filterState._highlightRe, function(m) {
          return ESC + '[7m' + m + ESC + '[27m';
        });
      }
      return out;
    }

    // Apply dedup to a text chunk before rendering. Returns the filtered text.
    // Matches beyond threshold are dropped; the badge on currentLine is updated.
    function applyDedupToChunk(chunk) {
      if (!filterState._dedupRe || filterState.dedupThreshold < 1) { return chunk; }
      filterState._dedupRe.lastIndex = 0;
      var threshold = filterState.dedupThreshold;
      var result = '';
      var lastIndex = 0;
      var match;
      while ((match = filterState._dedupRe.exec(chunk)) !== null) {
        // Append text before this match unchanged.
        result += chunk.slice(lastIndex, match.index);
        filterState._dedupCount++;
        if (filterState._dedupCount <= threshold) {
          result += match[0];
        }
        // Update or create the badge on the current DOM line.
        if (filterState._dedupCount > threshold) {
          if (!filterState._dedupBadge) {
            filterState._dedupBadge = document.createElement('span');
            filterState._dedupBadge.className = 'dedup-badge';
            if (currentLine) { currentLine.appendChild(filterState._dedupBadge); }
          }
          filterState._dedupBadge.textContent = String.fromCharCode(215) + filterState._dedupCount;
        }
        lastIndex = match.index + match[0].length;
      }
      result += chunk.slice(lastIndex);
      return result;
    }

    var ESC = String.fromCharCode(27);

    // Returns null if the line should be suppressed, otherwise the raw line unchanged.
    // Timestamp and highlight are applied per-chunk in applyChunkFilters instead.
    function applyLineFilters(line) {
      if (filterState._suppressRe && filterState._suppressRe.test(line)) { return null; }
      return line;
    }
    // ────────────────────────────────────────────────────────────────────────

    // ANSI colour state for the serial terminal
    const ansiState = AnsiParser.createAnsiState();
    // Holds a trailing incomplete CSI sequence from the previous data chunk
    let ansiTail = '';
    let carriageReturn = false;
    let currentLine = null;
    let currentLineRaw = ''; // raw text accumulator for the current line (for filters)
    var CR = String.fromCharCode(13);
    var LF = String.fromCharCode(10);
    var CRLF = CR + LF;
    const LINE_SPLIT_RE = new RegExp('(' + CRLF + '|' + CR + '|' + LF + ')');

    // ANSI logic is compiled from src/ansiParser.ts (injected above as AnsiParser)
    var ANSI_256 = AnsiParser.ANSI_256;
    function resetAnsiState() { AnsiParser.resetAnsiState(ansiState); }
    function ansiStateToSgr() { return AnsiParser.ansiStateToSgr(ansiState); }
    function ansiApplyCodes(codes) { AnsiParser.ansiApplyCodes(ansiState, codes); }

    // Match file:line[:col] references in serial output. The path must end in
    // a recognised source-file extension (case-insensitive) so we don't mis-fire
    // on numeric tokens like timestamps. Captures: 1=path, 2=line, 3=col?.
    //
    // Two path forms are accepted:
    //   * Anchored (drive letter "C:\", leading "/" / "\", or "./" / "../"):
    //     allows whitespace inside the path so that e.g.
    //     "C:\\Users\\me\\My Project\\main.cpp:42" is matched.
    //   * Plain relative path without spaces (e.g. "src/main.cpp", "WiFi.h"):
    //     forbids whitespace to avoid swallowing surrounding log text.
    var SERIAL_LINK_RE = /((?:(?:[A-Za-z]:[\\\\/]|[\\\\/]|\\.\\.?[\\\\/])[\\w./\\\\ -]+|[\\w.-]+(?:[\\\\/][\\w.-]+)*)\\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ino|s|asm|tcc|ipp)):(\\d+)(?::(\\d+))?/gi;

    function makeSerialFileLink(file, line, col) {
      var span = document.createElement('span');
      span.className = 'serial-file-link';
      span.setAttribute('data-file', file);
      span.setAttribute('data-line', line);
      if (col) { span.setAttribute('data-column', col); }
      span.title = 'Ctrl/Cmd+click to open ' + file + ':' + line;
      return span;
    }

    // Build a fragment from text, wrapping any file:line matches in
    // clickable serial-file-link spans. Returns null when text is empty.
    function buildLinkifiedFragment(text) {
      if (text === '') return null;
      SERIAL_LINK_RE.lastIndex = 0;
      var hasMatch = SERIAL_LINK_RE.test(text);
      if (!hasMatch) { return document.createTextNode(text); }
      var frag = document.createDocumentFragment();
      var lastIndex = 0;
      var match;
      SERIAL_LINK_RE.lastIndex = 0;
      while ((match = SERIAL_LINK_RE.exec(text)) !== null) {
        if (match.index > lastIndex) {
          frag.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
        }
        var link = makeSerialFileLink(match[1], match[2], match[3]);
        link.appendChild(document.createTextNode(match[0]));
        frag.appendChild(link);
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < text.length) {
        frag.appendChild(document.createTextNode(text.substring(lastIndex)));
      }
      return frag;
    }

    function ansiMakeNode(text) {
      if (text === '') return null;
      const needsSpan = ansiState.bold || ansiState.italic || ansiState.underline ||
                        ansiState.strikethrough || ansiState.blink || ansiState.fastBlink ||
                        ansiState.hidden || ansiState.dim || ansiState.reverse ||
                        ansiState.fg || ansiState.bg || ansiState.fgRgb || ansiState.bgRgb;
      var content = buildLinkifiedFragment(text);
      if (!needsSpan) return content;
      const s = document.createElement('span');
      if (ansiState.bold)          s.classList.add('ansi-bold');
      if (ansiState.dim)           s.classList.add('ansi-dim');
      if (ansiState.italic)        s.classList.add('ansi-italic');
      if (ansiState.underline)     s.classList.add('ansi-underline');
      if (ansiState.strikethrough) s.classList.add('ansi-strikethrough');
      if (ansiState.blink)         s.classList.add('ansi-blink');
      if (ansiState.fastBlink)     s.classList.add('ansi-blink-fast');
      if (ansiState.hidden)        s.classList.add('ansi-hidden');
      var localFgRgb = ansiState.fgRgb, localBgRgb = ansiState.bgRgb;
      var localFg = ansiState.fg, localBg = ansiState.bg;
      if (ansiState.reverse) {
        localFgRgb = ansiState.bgRgb; localBgRgb = ansiState.fgRgb;
        localFg = ansiState.bg; localBg = ansiState.fg;
        if (!localFgRgb && !localFg && !localBgRgb && !localBg) {
          s.classList.add('ansi-reverse');
        }
      }
      if (localFgRgb)         s.style.color = localFgRgb;
      else if (localFg)       s.classList.add('ansi-fg-' + localFg);
      if (localBgRgb)         s.style.backgroundColor = localBgRgb;
      else if (localBg)       s.classList.add('ansi-bg-' + localBg);
      s.appendChild(content);
      return s;
    }

    function updateScrollButton() {
      btnScrollBottom.style.display = autoscroll ? 'none' : 'block';
    }
    updateScrollButton();

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Event delegation for dynamic elements (crash headers, file links)
    document.addEventListener('click', function(e) {
      var target = e.target;
      // Crash header click - toggle expand
      var header = target.closest('.crash-header');
      if (header) {
        var crashId = header.getAttribute('data-crash-id');
        if (crashId) { toggleCrash(crashId); }
        return;
      }
      // File link click - open in editor
      var fileLink = target.closest('.frame-file');
      if (fileLink) {
        var file = fileLink.getAttribute('data-file');
        var line = fileLink.getAttribute('data-line');
        if (file && line) { openFile(file, line); }
        return;
      }
      // Serial file:line link - require Ctrl/Cmd+click (matches PIO monitor UX
      // and avoids stealing plain clicks used for text selection).
      var serialLink = target.closest('.serial-file-link');
      if (serialLink && (e.ctrlKey || e.metaKey)) {
        var sFile = serialLink.getAttribute('data-file');
        var sLine = serialLink.getAttribute('data-line');
        var sCol = serialLink.getAttribute('data-column');
        if (sFile && sLine) {
          e.preventDefault();
          vscode.postMessage({ type: 'openFile', file: sFile, line: sLine, column: sCol || undefined });
        }
        return;
      }
    });

    // Show pointer cursor on serial-file-link only while Ctrl/Cmd is held so
    // plain mouse interaction (text selection) feels normal. Keydown/keyup
    // alone is not enough: if the modifier was held *before* the webview gained
    // focus, no keydown ever fires inside the iframe. Pointer events carry a
    // current ctrlKey/metaKey snapshot, so we sync the class from those too.
    function setModLinkActive(on) {
      document.body.classList.toggle('mod-link-active', !!on);
    }
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Control' || e.key === 'Meta' || e.ctrlKey || e.metaKey) {
        setModLinkActive(true);
      }
    });
    document.addEventListener('keyup', function(e) {
      if (e.key === 'Control' || e.key === 'Meta') {
        setModLinkActive(e.ctrlKey || e.metaKey);
      }
    });
    document.addEventListener('pointermove', function(e) {
      setModLinkActive(e.ctrlKey || e.metaKey);
    });
    document.addEventListener('pointerover', function(e) {
      setModLinkActive(e.ctrlKey || e.metaKey);
    });
    document.addEventListener('pointerout', function(e) {
      // Keep class while still inside the document; only clear once pointer
      // leaves the document entirely.
      if (!e.relatedTarget) { setModLinkActive(false); }
    });
    document.addEventListener('pointerleave', function() {
      setModLinkActive(false);
    });
    window.addEventListener('blur', function() {
      setModLinkActive(false);
    });

    // Button handlers
    document.getElementById('btn-port').addEventListener('click', () => {
      vscode.postMessage({ type: 'selectPort' });
    });

    document.getElementById('btn-baud').addEventListener('click', () => {
      vscode.postMessage({ type: 'selectBaudRate' });
    });

    document.getElementById('btn-connect').addEventListener('click', () => {
      document.getElementById('btn-connect').textContent = 'Connecting...';
      document.getElementById('btn-connect').disabled = true;
      vscode.postMessage({ type: 'connect' });
    });

    document.getElementById('btn-disconnect').addEventListener('click', () => {
      vscode.postMessage({ type: 'disconnect' });
    });

    document.getElementById('btn-reset').addEventListener('click', () => {
      const btn = document.getElementById('btn-reset');
      vscode.postMessage({ type: 'hardReset' });
      const originalText = btn.textContent;
      btn.classList.add('feedback-saved');
      btn.textContent = 'Reset \u2713';
      setTimeout(function() {
        btn.classList.remove('feedback-saved');
        btn.textContent = originalText;
      }, 600);
    });

    document.getElementById('btn-elf').addEventListener('click', () => {
      vscode.postMessage({ type: 'selectElf' });
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
      serialOutput.textContent = '';
      // Reset ANSI colour state so stale styles don't bleed into the next run
      resetAnsiState();
      ansiTail = '';
      carriageReturn = false;
      currentLine = null;
      currentLineRaw = '';
      dedupResetLine();
      crashList.innerHTML = '';
      crashCount = 0;
      crashCountBadge.style.display = 'none';
      noCrashes.style.display = 'block';
      crashList.appendChild(noCrashes);
      vscode.postMessage({ type: 'clear' });
    });

    // ── Filter toolbar listeners ─────────────────────────────────────────────
    document.getElementById('filter-timestamp').addEventListener('change', function() {
      filterState.timestamp = this.checked;
    });

    document.getElementById('filter-suppress').addEventListener('input', function() {
      filterSetSuppressPattern(this.value);
      this.classList.toggle('filter-error',
        this.value !== '' && filterState._suppressRe === null);
    });

    document.getElementById('filter-highlight').addEventListener('input', function() {
      filterSetHighlightPattern(this.value);
      this.classList.toggle('filter-error',
        this.value !== '' && filterState._highlightRe === null);
    });

    document.getElementById('filter-dedup-pattern').addEventListener('input', function() {
      filterSetDedupPattern(this.value);
      this.classList.toggle('filter-error',
        this.value !== '' && filterState._dedupRe === null);
    });

    document.getElementById('filter-dedup-threshold').addEventListener('input', function() {
      var v = parseInt(this.value, 10);
      filterState.dedupThreshold = (isNaN(v) || v < 1) ? 3 : v;
    });

    var filterSaveBtn = document.getElementById('filter-save');
    var filterSaveOriginalLabel = filterSaveBtn.textContent;
    var filterSaveFeedbackTimer = null;
    var filterSaveTimeout = null;
    function showFilterSaveFeedback(ok, errorText) {
      if (filterSaveTimeout) {
        clearTimeout(filterSaveTimeout);
        filterSaveTimeout = null;
      }
      if (filterSaveFeedbackTimer) {
        clearTimeout(filterSaveFeedbackTimer);
        filterSaveFeedbackTimer = null;
      }
      filterSaveBtn.classList.remove('feedback-saved', 'feedback-error');
      if (ok) {
        filterSaveBtn.classList.add('feedback-saved');
        filterSaveBtn.textContent = 'Saved \u2713';
      } else {
        filterSaveBtn.classList.add('feedback-error');
        filterSaveBtn.textContent = 'Failed';
        if (errorText) { filterSaveBtn.title = 'Save failed: ' + errorText; }
      }
      filterSaveFeedbackTimer = setTimeout(function() {
        filterSaveBtn.classList.remove('feedback-saved', 'feedback-error');
        filterSaveBtn.textContent = filterSaveOriginalLabel;
        filterSaveBtn.title = 'Save current filter settings to VS Code settings';
        filterSaveBtn.disabled = false;
        filterSaveFeedbackTimer = null;
      }, 1500);
    }
    filterSaveBtn.addEventListener('click', () => {
      filterSaveBtn.disabled = true;
      if (filterSaveTimeout) {
        clearTimeout(filterSaveTimeout);
      }
      filterSaveTimeout = setTimeout(function() {
        filterSaveTimeout = null;
        showFilterSaveFeedback(false, 'No response from extension');
      }, 5000);
      vscode.postMessage({
        type: 'saveFilters',
        timestamp: filterState.timestamp,
        suppressPattern: filterState.suppressPattern,
        highlightPattern: filterState.highlightPattern,
        dedupPattern: filterState.dedupPattern,
        dedupThreshold: filterState.dedupThreshold,
      });
    });

    // ── Log2File ──────────────────────────────────────────────────────────
    var logActive = false;
    var btnLog = document.getElementById('filter-log2file');
    var logFilenameInput = document.getElementById('filter-log-filename');
    var logFilteredCheckbox = document.getElementById('filter-log-filtered');

    btnLog.addEventListener('click', function() {
      if (logActive) {
        vscode.postMessage({ type: 'stopLog' });
      } else {
        var customName = logFilenameInput.value.trim();
        var useFilters = logFilteredCheckbox.checked;
        var msg = { type: 'startLog', filename: customName || '', filtered: useFilters };
        if (useFilters) {
          msg.filters = {
            timestamp: filterState.timestamp,
            suppressPattern: filterState.suppressPattern,
            dedupPattern: filterState.dedupPattern,
            dedupThreshold: filterState.dedupThreshold,
          };
        }
        vscode.postMessage(msg);
      }
    });
    // ────────────────────────────────────────────────────────────────────────

    // Paste / decode crash log modal
    document.getElementById('btn-paste-crash').addEventListener('click', () => {
      document.getElementById('paste-modal').classList.remove('hidden');
      document.getElementById('paste-textarea').focus();
    });

    document.getElementById('btn-paste-cancel').addEventListener('click', () => {
      document.getElementById('paste-modal').classList.add('hidden');
    });

    document.getElementById('btn-coredump-file').addEventListener('click', () => {
      document.getElementById('paste-modal').classList.add('hidden');
      // Switch to crashes tab so the user sees the result
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelector('[data-tab="crashes"]').classList.add('active');
      document.getElementById('panel-crashes').classList.add('active');
      vscode.postMessage({ type: 'decodeCoredumpFile' });
    });

    document.getElementById('btn-paste-decode').addEventListener('click', () => {
      const text = document.getElementById('paste-textarea').value.trim();
      if (!text) return;
      document.getElementById('paste-modal').classList.add('hidden');
      document.getElementById('paste-textarea').value = '';
      // Switch to crashes tab so the user sees the result
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelector('[data-tab="crashes"]').classList.add('active');
      document.getElementById('panel-crashes').classList.add('active');
      vscode.postMessage({ type: 'decodePastedCrash', text });
    });

    // Close modal when clicking outside the box
    document.getElementById('paste-modal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('paste-modal')) {
        document.getElementById('paste-modal').classList.add('hidden');
      }
    });

    // Command history
    let commandHistory = [];
    let historyIndex = -1;
    let currentInput = '';

    document.getElementById('btn-send').addEventListener('click', sendInput);
    serialInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendInput();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateHistory('up');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateHistory('down');
      }
    });

    // Exit history navigation only when user actually edits input text
    serialInput.addEventListener('input', () => {
      if (historyIndex !== -1) {
        historyIndex = -1;
      }
    });

    // Line-ending selector: remember choice across reloads
    const lineEndingSelect = document.getElementById('line-ending');
    const LINE_ENDINGS = { crlf: '\\r\\n', lf: '\\n', cr: '\\r', none: '' };
    try {
      const saved = localStorage.getItem('esp-decoder.lineEnding');
      if (saved && Object.prototype.hasOwnProperty.call(LINE_ENDINGS, saved)) {
        lineEndingSelect.value = saved;
      }
    } catch (_) { /* localStorage may be unavailable */ }
    lineEndingSelect.addEventListener('change', () => {
      try { localStorage.setItem('esp-decoder.lineEnding', lineEndingSelect.value); } catch (_) {}
    });

    function sendInput() {
      const val = serialInput.value;
      if (val) {
        // Add to history (avoid consecutive duplicates)
        if (commandHistory.length === 0 || commandHistory[commandHistory.length - 1] !== val) {
          commandHistory.push(val);
          // Limit history size to 100 commands
          if (commandHistory.length > 100) {
            commandHistory.shift();
          }
        }
        const ending = LINE_ENDINGS[lineEndingSelect.value] ?? '\\r\\n';
        vscode.postMessage({ type: 'sendData', data: val + ending });
        serialInput.value = '';
        historyIndex = -1;
        currentInput = '';
      }
    }

    function navigateHistory(direction) {
      if (commandHistory.length === 0) return;

      // Save current input when starting to navigate
      if (historyIndex === -1) {
        currentInput = serialInput.value;
      }

      if (direction === 'up') {
        if (historyIndex === -1) {
          // Start from the most recent command
          historyIndex = commandHistory.length - 1;
        } else if (historyIndex > 0) {
          // Move to older command
          historyIndex--;
        }
        serialInput.value = commandHistory[historyIndex];
      } else if (direction === 'down') {
        if (historyIndex === -1) {
          // Already at current input, do nothing
          return;
        } else if (historyIndex < commandHistory.length - 1) {
          // Move to newer command
          historyIndex++;
          serialInput.value = commandHistory[historyIndex];
        } else {
          // Return to current input
          historyIndex = -1;
          serialInput.value = currentInput;
        }
      }

      // Move cursor to end of input
      serialInput.setSelectionRange(serialInput.value.length, serialInput.value.length);
    }

    // Auto-scroll detection
    serialOutput.addEventListener('scroll', () => {
      // Ignore scroll events fired by our own scrollTop assignments so they
      // cannot flip autoscroll off when new data arrives between the RAF
      // assignment and the resulting scroll event (race at high baud rates).
      if (programmaticScroll) {
        programmaticScroll = false;
        return;
      }
      const el = serialOutput;
      autoscroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
      updateScrollButton();
    });

    // Scroll-to-bottom button
    btnScrollBottom.addEventListener('click', () => {
      autoscroll = true;
      updateScrollButton();
      programmaticScroll = true;
      serialOutput.scrollTop = serialOutput.scrollHeight;
    });

    // Message handler
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'serialData':
          appendSerialData(msg.data);
          break;
        case 'connectionChanged':
          updateConnectionState(msg.connected, msg.port, msg.baudRate);
          break;
        case 'portSelected':
          if (msg.port) {
            document.getElementById('btn-port').textContent = 'Port: ' + msg.port;
          }
          break;
        case 'baudRateSelected':
          if (msg.baudRate) {
            document.getElementById('btn-baud').textContent = msg.baudRate;
          }
          break;
        case 'crashDetected':
          addCrashEvent(msg.event);
          break;
        case 'crashDecoded':
          updateCrashDecoded(msg.eventId, msg.decoded);
          break;
        case 'coredumpDecoded':
          updateCoredumpDecoded(msg.eventId, msg.result);
          break;
        case 'crashDecodeError':
          updateCrashError(msg.eventId, msg.error);
          break;
        case 'configChanged':
          updateConfigDisplay(msg);
          break;
        case 'initialState':
          updateConnectionState(msg.connected, msg.port, msg.baudRate);
          updateConfigDisplay(msg);
          break;
        case 'logStarted':
          logActive = true;
          btnLog.classList.add('log-active');
          btnLog.textContent = 'Stop Log';
          break;
        case 'logFailed':
          logActive = false;
          btnLog.classList.remove('log-active');
          btnLog.textContent = 'Log2File';
          break;
        case 'logStopped':
          logActive = false;
          btnLog.classList.remove('log-active');
          btnLog.textContent = 'Log2File';
          break;
        case 'error':
          appendError(msg.message);
          break;
        case 'filtersSaved':
          showFilterSaveFeedback(msg.ok !== false, msg.error);
          break;
        case 'fontSizeChanged':
          document.documentElement.style.setProperty('--serial-font-size', msg.fontSize + 'px');
          break;
      }
    });

    function appendError(text) {
      const span = document.createElement('span');
      span.style.color = 'var(--error-fg)';
      span.textContent = '[ERROR] ' + text + '\\n';
      serialOutput.appendChild(span);
      if (autoscroll && !scrollRAFPending) {
        scrollRAFPending = true;
        requestAnimationFrame(() => {
          scrollRAFPending = false;
          if (autoscroll) {
            programmaticScroll = true;
            serialOutput.scrollTop = serialOutput.scrollHeight;
          }
        });
      }
    }

    function renderAnsiText(text) {
      var re = /\\x1b\\[(.*?)([@-~])/g;
      var fragment = document.createDocumentFragment();
      var i = 0;
      re.lastIndex = 0;
      var match;
      while ((match = re.exec(text)) !== null) {
        var node = ansiMakeNode(text.substring(i, match.index));
        if (node) { fragment.appendChild(node); }
        i = match.index + match[0].length;
        if (match[2] === 'm') {
          var codes = match[1] === '' ? [0] : match[1].split(';').map(function(c) { return parseInt(c, 10) || 0; });
          ansiApplyCodes(codes);
        }
      }
      var tail = ansiMakeNode(text.substring(i));
      if (tail) { fragment.appendChild(tail); }
      return fragment;
    }

    function appendSerialData(text) {
      text = ansiTail + text;
      ansiTail = '';

      // Split into alternating [content, separator, content, separator, ...]
      // LINE_SPLIT_RE has a capturing group so separators are included in the array.
      var parts = text.split(LINE_SPLIT_RE);

      // Ensure there is a currentLine wrapper to accumulate spans into.
      if (!currentLine) {
        currentLine = document.createElement('div');
        serialOutput.appendChild(currentLine);
      }

      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];

        // Odd indices are the captured separators (CRLF, CR, or LF).
        if (p % 2 === 1) {
          if (part === CR) {
            carriageReturn = true;
          } else {
            // LF or CRLF — run suppress filter; timestamp/highlight are already
            // applied per-chunk during rendering so the DOM is up to date.
            var filtered = applyLineFilters(currentLineRaw);
            if (filtered === null) {
              // Suppress filter matched — remove the line from DOM.
              if (currentLine && currentLine.parentNode === serialOutput) {
                serialOutput.removeChild(currentLine);
              }
            }
            // Otherwise leave currentLine DOM intact (dedup badge preserved).
            currentLineRaw = '';
            carriageReturn = false;
            dedupResetLine();
            currentLine = document.createElement('div');
            serialOutput.appendChild(currentLine);
          }
          continue;
        }

        // Even indices are content chunks.
        if (part === '') { continue; }

        // Trailing-ANSI detection: only treat a trailing \x1b as incomplete if
        // it doesn't form a complete CSI/escape sequence on its own.
        var renderText = part;
        if (p === parts.length - 1) {
          var lastEscape = part.lastIndexOf('\x1b');
          if (lastEscape !== -1) {
            var candidate = part.substring(lastEscape);
            var completeEscape = new RegExp('^\\x1b(?:\\[[0-9;?]*[\\x20-\\x2f]*[\\x40-\\x7e]|[^\\[][^\\x00-\\x1f]?)').test(candidate);
            if (!completeEscape) {
              ansiTail = candidate;
              renderText = part.substring(0, lastEscape);
            }
          }
        }

        if (carriageReturn && currentLine) {
          var newLine = document.createElement('div');
          serialOutput.replaceChild(newLine, currentLine);
          currentLine = newLine;
          currentLineRaw = '';
          dedupResetLine();
          carriageReturn = false;
        }
        var dedupedText = applyChunkFilters(renderText);
        currentLineRaw += renderText;
        if (dedupedText) { currentLine.appendChild(renderAnsiText(dedupedText)); }
      }

      var excess = serialOutput.childNodes.length - 10000;
      if (excess > 0) {
        var keep = Array.from(serialOutput.childNodes).slice(excess);
        serialOutput.replaceChildren.apply(serialOutput, keep);
        // Reset currentLine if it was removed during trimming
        if (currentLine && !serialOutput.contains(currentLine)) {
          currentLine = serialOutput.lastElementChild || null;
          currentLineRaw = '';
          dedupResetLine();
        }
      }

      if (autoscroll && !scrollRAFPending) {
        scrollRAFPending = true;
        requestAnimationFrame(function() {
          scrollRAFPending = false;
          if (autoscroll) {
            programmaticScroll = true;
            serialOutput.scrollTop = serialOutput.scrollHeight;
          }
        });
      }
    }

    function updateConnectionState(isConnected, port, baudRate) {
      connected = isConnected;
      const dot = document.getElementById('status-dot');
      const text = document.getElementById('status-text');
      const btnConnect = document.getElementById('btn-connect');
      const btnDisconnect = document.getElementById('btn-disconnect');
      const btnReset = document.getElementById('btn-reset');

      if (isConnected) {
        dot.className = 'status-indicator connected';
        text.textContent = 'Connected: ' + (port || '?') + ' @ ' + (baudRate || '?');
        btnConnect.textContent = 'Connect';
        btnConnect.disabled = true;
        btnDisconnect.disabled = false;
        btnReset.disabled = false;
      } else {
        dot.className = 'status-indicator disconnected';
        text.textContent = 'Disconnected';
        btnConnect.textContent = 'Connect';
        btnConnect.disabled = false;
        btnDisconnect.disabled = true;
        btnReset.disabled = true;
      }

      if (port) {
        document.getElementById('btn-port').textContent = 'Port: ' + port;
      }
      if (baudRate) {
        document.getElementById('btn-baud').textContent = baudRate;
      }
    }

    function updateConfigDisplay(config) {
      if (config.elfPath) {
        var parts = config.elfPath.split('/');
        var name = parts[parts.length - 1];
        document.getElementById('btn-elf').textContent = 'ELF: ' + name;
        document.getElementById('btn-elf').title = config.elfPath;
      }
      if (config.serialFilters) {
        applyFilterSettings(config.serialFilters);
      }
    }

    function applyFilterSettings(f) {
      var cbTs = document.getElementById('filter-timestamp');
      var inSuppress = document.getElementById('filter-suppress');
      var inHighlight = document.getElementById('filter-highlight');
      var inDedupPat = document.getElementById('filter-dedup-pattern');
      var inDedupThr = document.getElementById('filter-dedup-threshold');
      if (f.timestamp !== undefined) {
        filterState.timestamp = !!f.timestamp;
        cbTs.checked = filterState.timestamp;
      }
      if (f.suppressPattern !== undefined) {
        inSuppress.value = f.suppressPattern;
        filterSetSuppressPattern(f.suppressPattern);
        inSuppress.classList.toggle('filter-error',
          f.suppressPattern !== '' && filterState._suppressRe === null);
      }
      if (f.highlightPattern !== undefined) {
        inHighlight.value = f.highlightPattern;
        filterSetHighlightPattern(f.highlightPattern);
        inHighlight.classList.toggle('filter-error',
          f.highlightPattern !== '' && filterState._highlightRe === null);
      }
      if (f.dedupPattern !== undefined) {
        inDedupPat.value = f.dedupPattern;
        filterSetDedupPattern(f.dedupPattern);
        inDedupPat.classList.toggle('filter-error',
          f.dedupPattern !== '' && filterState._dedupRe === null);
      }
      if (f.dedupThreshold !== undefined) {
        filterState.dedupThreshold = f.dedupThreshold || 3;
        inDedupThr.value = filterState.dedupThreshold;
      }
    }

    function addCrashEvent(event) {
      if (noCrashes.parentElement === crashList) {
        noCrashes.style.display = 'none';
      }

      crashCount++;
      crashCountBadge.textContent = crashCount;
      crashCountBadge.style.display = 'inline';

      const el = document.createElement('div');
      el.className = 'crash-event';
      el.id = 'crash-' + event.id;

      const time = new Date(event.timestamp).toLocaleTimeString();
      const kindLabel = event.isCoredump ? 'coredump' : escapeHtml(event.kind);

      el.innerHTML = 
        '<div class="crash-header" data-crash-id="' + event.id + '">' +
          '<div class="crash-title">' +
            '<span class="crash-kind">' + kindLabel + '</span>' +
            '<span>' + escapeHtml(event.id) + '</span>' +
          '</div>' +
          '<span class="crash-time">' + time + '</span>' +
        '</div>' +
        '<div class="crash-body">' +
          '<div class="crash-section">' +
            '<div class="crash-section-title">Raw Crash Output</div>' +
            '<div class="raw-output">' + escapeHtml(event.rawText) + '</div>' +
          '</div>' +
          '<div id="decode-section-' + event.id + '">' +
            '<div class="decode-status">Decoding...</div>' +
          '</div>' +
        '</div>';

      // Use event delegation for crash header clicks
      el.querySelector('.crash-header').addEventListener('click', function() {
        toggleCrash(event.id);
      });

      crashList.insertBefore(el, crashList.firstChild);

      // Flash the crash tab
      const crashTab = document.querySelector('[data-tab="crashes"]');
      crashTab.style.color = 'var(--error-fg)';
      setTimeout(() => { crashTab.style.color = ''; }, 2000);
    }

    function toggleCrash(id) {
      const el = document.getElementById('crash-' + id);
      el.classList.toggle('expanded');
    }

    function updateCrashDecoded(eventId, decoded) {
      const section = document.getElementById('decode-section-' + eventId);
      if (!section) return;

      // Auto-expand the crash event when decoded data arrives
      const crashEl = document.getElementById('crash-' + eventId);
      if (crashEl && !crashEl.classList.contains('expanded')) {
        crashEl.classList.add('expanded');
      }

      var html = renderDecodedCrashHtml(decoded);

      if (!html) {
        html = '<div class="decode-status">No decoded information available</div>';
      }

      section.innerHTML = html;
    }

    function updateCoredumpDecoded(eventId, result) {
      const section = document.getElementById('decode-section-' + eventId);
      if (!section) return;

      // Auto-expand
      const crashEl = document.getElementById('crash-' + eventId);
      if (crashEl && !crashEl.classList.contains('expanded')) {
        crashEl.classList.add('expanded');
      }

      var html = '';
      if (result.threads && result.threads.length > 0) {
        result.threads.forEach(function(thread) {
          var threadLabel = escapeHtml(thread.threadName || ('Thread ' + thread.threadId));
          var currentTag = thread.isCurrent ? ' <span style="color:var(--error-fg);font-weight:bold">(crashed)</span>' : '';
          html += '<div class="crash-section" style="border:1px solid var(--border);border-radius:4px;padding:8px;margin-bottom:8px">';
          html += '<div class="crash-section-title" style="font-size:13px">' + threadLabel + currentTag + '</div>';
          html += renderDecodedCrashHtml(thread.decoded);
          html += '</div>';
        });
      }

      // Show raw trbr output at the bottom
      if (result.rawOutput) {
        html += '<div class="crash-section">';
        html += '<div class="crash-section-title">Decoded Output</div>';
        html += '<div class="raw-output">' + linkifyPaths(result.rawOutput) + '</div>';
        html += '</div>';
      }

      if (!html) {
        html = '<div class="decode-status">No decoded information available</div>';
      }

      section.innerHTML = html;
    }

    function renderDecodedCrashHtml(decoded) {
      var html = '';

      // Fault info
      if (decoded.faultInfo) {
        html += '<div class="fault-info">';
        if (decoded.faultInfo.faultMessage) {
          html += '<div class="fault-message">' + escapeHtml(decoded.faultInfo.faultMessage) + '</div>';
        }
        if (decoded.faultInfo.coreId !== undefined) {
          html += '<div>Core: ' + decoded.faultInfo.coreId + '</div>';
        }
        if (decoded.faultInfo.programCounter) {
          html += '<div>PC: <span class="frame-addr">' + escapeHtml(decoded.faultInfo.programCounter) + '</span></div>';
        }
        if (decoded.faultInfo.faultAddr) {
          html += '<div>Fault Address: <span class="frame-addr">' + escapeHtml(decoded.faultInfo.faultAddr) + '</span></div>';
        }
        if (decoded.faultInfo.faultCode !== undefined) {
          html += '<div>Fault Code: ' + decoded.faultInfo.faultCode + '</div>';
        }
        html += '</div>';
      }

      // Stack trace
      if (decoded.stacktrace && decoded.stacktrace.length > 0) {
        html += '<div class="crash-section">';
        html += '<div class="crash-section-title">Stack Trace</div>';
        html += '<table class="stacktrace-table"><thead><tr>';
        html += '<th>#</th><th>Address</th><th>Function</th><th>Location</th>';
        html += '</tr></thead><tbody>';

        decoded.stacktrace.forEach((frame, i) => {
          html += '<tr>';
          html += '<td class="frame-num">' + i + '</td>';
          html += '<td class="frame-addr">' + escapeHtml(frame.address) + '</td>';
          html += '<td class="frame-func">' + escapeHtml(frame.function || '??') + '</td>';

          if (frame.file && frame.line) {
            const shortFile = frame.file.split('/').pop();
            html += '<td><span class="frame-file" data-file="' +
              escapeHtml(frame.file) + '" data-line="' + escapeHtml(frame.line) +
              '">' + escapeHtml(shortFile + ':' + frame.line) + '</span></td>';
          } else if (frame.file) {
            html += '<td>' + escapeHtml(frame.file) + '</td>';
          } else {
            html += '<td>—</td>';
          }

          html += '</tr>';
        });

        html += '</tbody></table></div>';
      }

      // Registers
      if (decoded.regs && Object.keys(decoded.regs).length > 0) {
        var hasAnnotations = decoded.regAnnotations && Object.keys(decoded.regAnnotations).length > 0;
        html += '<div class="crash-section">';
        html += '<div class="crash-section-title">Registers</div>';

        if (hasAnnotations) {
          // Full-width layout with source annotations (like filter_exception_decoder.py)
          html += '<div class="registers-annotated">';
          for (const [name, value] of Object.entries(decoded.regs)) {
            var annotation = decoded.regAnnotations ? decoded.regAnnotations[name] : null;
            html += '<div class="reg-entry-annotated">';
            html += '<span class="reg-name">' + escapeHtml(name) + '</span>';
            html += '<span class="reg-value">0x' + Number(value).toString(16).padStart(8, '0') + '</span>';
            if (annotation) {
              html += '<span class="reg-annotation">' + formatAnnotation(annotation) + '</span>';
            }
            html += '</div>';
          }
          html += '</div>';
        } else {
          // Compact grid when no annotations available
          html += '<div class="registers-grid">';
          for (const [name, value] of Object.entries(decoded.regs)) {
            html += '<div class="reg-entry">';
            html += '<span class="reg-name">' + escapeHtml(name) + '</span>';
            html += '<span class="reg-value">0x' + Number(value).toString(16).padStart(8, '0') + '</span>';
            html += '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
      }

      // Show raw decoded output from trbr
      if (decoded.rawOutput) {
        html += '<div class="crash-section">';
        html += '<div class="crash-section-title">Decoded Output</div>';
        html += '<div class="raw-output">' + linkifyPaths(decoded.rawOutput) + '</div>';
        html += '</div>';
      }

      return html;
    }

    function updateCrashError(eventId, error) {
      const section = document.getElementById('decode-section-' + eventId);
      if (!section) return;

      // Auto-expand so user sees the error
      const crashEl = document.getElementById('crash-' + eventId);
      if (crashEl && !crashEl.classList.contains('expanded')) {
        crashEl.classList.add('expanded');
      }

      section.innerHTML = '<div class="decode-error">Decode error: ' + escapeHtml(error) + '</div>';
    }

    function openFile(file, line) {
      vscode.postMessage({ type: 'openFile', file, line });
    }

    function linkifyPaths(text) {
      // Run the regex against the raw (unescaped) text so that captured file
      // paths used in data-file attributes are not corrupted by HTML entities.
      var result = '';
      var lastIndex = 0;
      var re = /(\\/[\\w.\\-\\/]+\\.\\w+):(\\d+)/g;
      var m;
      while ((m = re.exec(text)) !== null) {
        result += escapeHtml(text.slice(lastIndex, m.index));
        var file = m[1];
        var line = m[2];
        var shortFile = file.split('/').pop();
        result += '<span class="frame-file" data-file="' +
          escapeAttr(file) + '" data-line="' + escapeAttr(line) +
          '">' + escapeHtml(shortFile + ':' + line) + '</span>';
        lastIndex = re.lastIndex;
      }
      result += escapeHtml(text.slice(lastIndex));
      return result;
    }

    function formatAnnotation(annotation) {
      // Parse "func_name at /path/to/file.c:123" into clickable link
      var match = annotation.match(/^(.+?)\\s+at\\s+(.+?):(\\d+)$/);
      if (match) {
        var func = match[1];
        var file = match[2];
        var line = match[3];
        var shortFile = file.split('/').pop();
        return escapeHtml(func) + ' at <span class="frame-file" data-file="' +
          escapeAttr(file) + '" data-line="' + escapeAttr(line) +
          '">' + escapeHtml(shortFile + ':' + line) + '</span>';
      }
      return escapeHtml(annotation);
    }

    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = String(text);
      return div.innerHTML;
    }

    function escapeAttr(text) {
      if (!text) return '';
      return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
