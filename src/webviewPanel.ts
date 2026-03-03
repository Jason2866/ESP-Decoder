import * as vscode from 'vscode';
import { SerialPortManager } from './serialPortManager';
import { CrashDetector, CrashEvent, DecodedCrash, decodeCrash } from './crashDecoder';

interface SessionConfig {
  elfPath?: string;
  toolPath?: string;
  targetArch?: string;
}

export class TrbrWebviewPanel {
  public static readonly viewType = 'esp-decoder.monitorPanel';
  private static currentPanel: TrbrWebviewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly serialManager: SerialPortManager;
  private readonly crashDetector: CrashDetector;
  private readonly disposables: vscode.Disposable[] = [];

  private serialLines: string[] = [];
  private crashEvents: CrashEvent[] = [];
  private lineBuffer = '';
  private config: SessionConfig = {};

  public static createOrShow(
    extensionUri: vscode.Uri,
    serialManager: SerialPortManager,
    config?: SessionConfig
  ): TrbrWebviewPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (TrbrWebviewPanel.currentPanel) {
      TrbrWebviewPanel.currentPanel.panel.reveal(column);
      if (config) {
        TrbrWebviewPanel.currentPanel.config = {
          ...TrbrWebviewPanel.currentPanel.config,
          ...config,
        };
      }
      return TrbrWebviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      TrbrWebviewPanel.viewType,
      'ESP Decoder — Crash Monitor',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    TrbrWebviewPanel.currentPanel = new TrbrWebviewPanel(
      panel,
      extensionUri,
      serialManager,
      config
    );
    return TrbrWebviewPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    serialManager: SerialPortManager,
    config?: SessionConfig
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.serialManager = serialManager;
    this.crashDetector = new CrashDetector();
    this.config = config || {};

    this.panel.webview.html = this.getHtmlContent();

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    // Handle panel dispose
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Listen to serial data
    this.disposables.push(
      this.serialManager.onData((data) => {
        this.handleSerialData(data);
      })
    );

    // Listen to connection changes
    this.disposables.push(
      this.serialManager.onConnectionChange((connected) => {
        this.postMessage({
          type: 'connectionChanged',
          connected,
          port: this.serialManager.selectedPath,
          baudRate: this.serialManager.baudRate,
        });
      })
    );

    // Listen to crash events
    this.disposables.push(
      this.crashDetector.onCrashDetected(async (event) => {
        this.crashEvents.push(event);
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
              this.config.targetArch
            );
            event.decoded = decoded;
            this.postMessage({
              type: 'crashDecoded',
              eventId: event.id,
              decoded: this.serializeDecodedCrash(decoded),
            });
          } catch (err) {
            this.postMessage({
              type: 'crashDecodeError',
              eventId: event.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      })
    );

    // Send initial state
    this.sendInitialState();
  }

  private sendInitialState(): void {
    this.postMessage({
      type: 'initialState',
      connected: this.serialManager.isConnected,
      port: this.serialManager.selectedPath,
      baudRate: this.serialManager.baudRate,
      elfPath: this.config.elfPath,
      targetArch: this.config.targetArch,
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

  private handleSerialData(data: Buffer): void {
    const text = data.toString('utf8');

    // Feed raw text to webview
    this.postMessage({ type: 'serialData', data: text });

    // Process line by line for crash detection
    this.lineBuffer += text;
    const lines = this.lineBuffer.split(/\r?\n/);

    // Keep the last incomplete line in buffer
    this.lineBuffer = lines.pop() || '';

    const maxLines = vscode.workspace
      .getConfiguration('esp-decoder')
      .get<number>('serialMonitor.maxLines', 5000);

    for (const line of lines) {
      this.serialLines.push(line);
      this.crashDetector.pushLine(line);
    }

    // Trim serial lines
    while (this.serialLines.length > maxLines) {
      this.serialLines.shift();
    }
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'connect':
        await this.serialManager.connect();
        break;
      case 'disconnect':
        await this.serialManager.disconnect();
        break;
      case 'selectPort':
        await this.serialManager.selectPort();
        this.postMessage({
          type: 'portSelected',
          port: this.serialManager.selectedPath,
        });
        break;
      case 'selectBaudRate':
        await this.serialManager.selectBaudRate();
        this.postMessage({
          type: 'baudRateSelected',
          baudRate: this.serialManager.baudRate,
        });
        break;
      case 'selectElf':
        await vscode.commands.executeCommand('esp-decoder.selectElfFile');
        break;
      case 'sendData':
        if (message.data) {
          try {
            await this.serialManager.sendData(message.data + '\r\n');
          } catch (err) {
            vscode.window.showErrorMessage(
              `Failed to send: ${err instanceof Error ? err.message : err}`
            );
          }
        }
        break;
      case 'clear':
        this.serialLines = [];
        this.crashEvents = [];
        this.crashDetector.reset();
        break;
      case 'decodeCrash': {
        const event = this.crashEvents.find((e) => e.id === message.eventId);
        if (event && this.config.elfPath) {
          try {
            const decoded = await decodeCrash(
              event,
              this.config.elfPath,
              this.config.toolPath,
              this.config.targetArch
            );
            event.decoded = decoded;
            this.postMessage({
              type: 'crashDecoded',
              eventId: event.id,
              decoded: this.serializeDecodedCrash(decoded),
            });
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
          const uri = vscode.Uri.file(message.file);
          const line = parseInt(message.line, 10) - 1;
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, {
              selection: new vscode.Range(line, 0, line, 0),
              preview: true,
            });
          } catch {
            vscode.window.showErrorMessage(`Cannot open file: ${message.file}`);
          }
        }
        break;
      }
    }
  }

  private serializeCrashEvent(event: CrashEvent): any {
    return {
      id: event.id,
      kind: event.kind,
      rawText: event.rawText,
      timestamp: event.timestamp,
      lines: event.lines,
    };
  }

  private serializeDecodedCrash(decoded: DecodedCrash): any {
    return {
      faultInfo: decoded.faultInfo,
      stacktrace: decoded.stacktrace,
      regs: decoded.regs,
      allocInfo: decoded.allocInfo,
      rawOutput: decoded.rawOutput,
    };
  }

  private postMessage(message: any): void {
    this.panel.webview.postMessage(message);
  }

  public dispose(): void {
    TrbrWebviewPanel.currentPanel = undefined;
    this.crashDetector.dispose();
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
    }
  }

  private getHtmlContent(): string {
    const nonce = getNonce();

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

    /* Serial Monitor */
    #serial-output {
      flex: 1;
      overflow-y: auto;
      padding: 4px 8px;
      font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-all;
      background: var(--bg);
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
    </div>
    <div class="toolbar-separator"></div>
    <div class="toolbar-group">
      <button id="btn-elf" class="secondary" title="Select ELF file for decoding">ELF: —</button>
    </div>
    <div class="toolbar-separator"></div>
    <div class="toolbar-group">
      <button id="btn-clear" class="secondary" title="Clear all output">Clear</button>
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
  <div class="panel active" id="panel-serial">
    <div id="serial-output"></div>
    <div class="serial-input-row">
      <input type="text" id="serial-input" placeholder="Type command and press Enter..."
        autocomplete="off" spellcheck="false" />
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

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const serialOutput = document.getElementById('serial-output');
    const serialInput = document.getElementById('serial-input');
    const crashList = document.getElementById('crash-list');
    const noCrashes = document.getElementById('no-crashes');
    const crashCountBadge = document.getElementById('crash-count');

    let connected = false;
    let autoscroll = true;
    let crashCount = 0;

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Button handlers
    document.getElementById('btn-port').addEventListener('click', () => {
      vscode.postMessage({ type: 'selectPort' });
    });

    document.getElementById('btn-baud').addEventListener('click', () => {
      vscode.postMessage({ type: 'selectBaudRate' });
    });

    document.getElementById('btn-connect').addEventListener('click', () => {
      vscode.postMessage({ type: 'connect' });
    });

    document.getElementById('btn-disconnect').addEventListener('click', () => {
      vscode.postMessage({ type: 'disconnect' });
    });

    document.getElementById('btn-elf').addEventListener('click', () => {
      vscode.postMessage({ type: 'selectElf' });
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
      serialOutput.textContent = '';
      crashList.innerHTML = '';
      crashCount = 0;
      crashCountBadge.style.display = 'none';
      noCrashes.style.display = 'block';
      crashList.appendChild(noCrashes);
      vscode.postMessage({ type: 'clear' });
    });

    document.getElementById('btn-send').addEventListener('click', sendInput);
    serialInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendInput();
    });

    function sendInput() {
      const val = serialInput.value;
      if (val) {
        vscode.postMessage({ type: 'sendData', data: val });
        serialInput.value = '';
      }
    }

    // Auto-scroll detection
    serialOutput.addEventListener('scroll', () => {
      const el = serialOutput;
      autoscroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
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
      }
    });

    function appendSerialData(text) {
      const span = document.createElement('span');
      span.textContent = text;
      serialOutput.appendChild(span);

      // Trim if too many nodes
      while (serialOutput.childNodes.length > 10000) {
        serialOutput.removeChild(serialOutput.firstChild);
      }

      if (autoscroll) {
        serialOutput.scrollTop = serialOutput.scrollHeight;
      }
    }

    function updateConnectionState(isConnected, port, baudRate) {
      connected = isConnected;
      const dot = document.getElementById('status-dot');
      const text = document.getElementById('status-text');
      const btnConnect = document.getElementById('btn-connect');
      const btnDisconnect = document.getElementById('btn-disconnect');

      if (isConnected) {
        dot.className = 'status-indicator connected';
        text.textContent = 'Connected: ' + (port || '?') + ' @ ' + (baudRate || '?');
        btnConnect.disabled = true;
        btnDisconnect.disabled = false;
      } else {
        dot.className = 'status-indicator disconnected';
        text.textContent = 'Disconnected';
        btnConnect.disabled = false;
        btnDisconnect.disabled = true;
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
        const name = config.elfPath.split('/').pop().split('\\\\').pop();
        document.getElementById('btn-elf').textContent = 'ELF: ' + name;
        document.getElementById('btn-elf').title = config.elfPath;
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

      el.innerHTML = \`
        <div class="crash-header" onclick="toggleCrash('\${event.id}')">
          <div class="crash-title">
            <span class="crash-kind">\${escapeHtml(event.kind)}</span>
            <span>\${escapeHtml(event.id)}</span>
          </div>
          <span class="crash-time">\${time}</span>
        </div>
        <div class="crash-body">
          <div class="crash-section">
            <div class="crash-section-title">Raw Crash Output</div>
            <div class="raw-output">\${escapeHtml(event.rawText)}</div>
          </div>
          <div id="decode-section-\${event.id}">
            <div class="decode-status">Decoding...</div>
          </div>
        </div>
      \`;

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

      let html = '';

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
            const shortFile = frame.file.split('/').pop().split('\\\\').pop();
            html += '<td><span class="frame-file" onclick="openFile(\'' +
              escapeAttr(frame.file) + "', '" + escapeAttr(frame.line) +
              '\\')">' + escapeHtml(shortFile + ':' + frame.line) + '</span></td>';
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
        html += '<div class="crash-section">';
        html += '<div class="crash-section-title">Registers</div>';
        html += '<div class="registers-grid">';
        for (const [name, value] of Object.entries(decoded.regs)) {
          html += '<div class="reg-entry">';
          html += '<span class="reg-name">' + escapeHtml(name) + '</span>';
          html += '<span class="reg-value">0x' + Number(value).toString(16).padStart(8, '0') + '</span>';
          html += '</div>';
        }
        html += '</div></div>';
      }

      if (!html) {
        html = '<div class="decode-status">No decoded information available</div>';
      }

      section.innerHTML = html;
    }

    function updateCrashError(eventId, error) {
      const section = document.getElementById('decode-section-' + eventId);
      if (!section) return;
      section.innerHTML = '<div class="decode-error">Decode error: ' + escapeHtml(error) + '</div>';
    }

    function openFile(file, line) {
      vscode.postMessage({ type: 'openFile', file, line });
    }

    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = String(text);
      return div.innerHTML;
    }

    function escapeAttr(text) {
      if (!text) return '';
      return String(text).replace(/'/g, "\\\\'").replace(/"/g, '&quot;');
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
