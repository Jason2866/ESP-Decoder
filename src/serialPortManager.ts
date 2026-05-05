import { SerialPort } from 'serialport';
import * as vscode from 'vscode';

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  friendlyName?: string;
}

export interface DisconnectInfo {
  /** True when the user explicitly requested the disconnect (UI button / command). */
  userInitiated: boolean;
  /** True when the disconnect was triggered by releasePort() for an upload. */
  suspended: boolean;
}

export class SerialPortManager extends vscode.Disposable {
  private port: SerialPort | null = null;
  private _selectedPath: string | undefined;
  private _baudRate: number;
  private _isConnected = false;
  private readonly log: vscode.OutputChannel;
  private readonly ownsLog: boolean;

  // Identity of the currently/last connected device — used to match the same
  // physical board when it re-enumerates (e.g. native USB-CDC after reset).
  private _connectedVendorId: string | undefined;
  private _connectedProductId: string | undefined;
  private _connectedSerialNumber: string | undefined;

  // Disconnect intent flags — read by listeners on the next 'connectionChange'
  // event to decide whether an unexpected close should trigger auto-reconnect.
  private _userInitiatedDisconnect = false;
  private _suppressErrorToasts = false;

  // Auto-reconnect polling state
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectDeadline = 0;

  private readonly _onData = new vscode.EventEmitter<Buffer>();
  readonly onData = this._onData.event;

  private readonly _onError = new vscode.EventEmitter<Error>();
  readonly onError = this._onError.event;

  private readonly _onConnectionChange = new vscode.EventEmitter<boolean>();
  readonly onConnectionChange = this._onConnectionChange.event;

  private readonly _onDisconnect = new vscode.EventEmitter<DisconnectInfo>();
  /** Fired immediately after a transition to disconnected, with intent info. */
  readonly onDisconnect = this._onDisconnect.event;

  // State for temporary port release (e.g., during pioarduino upload)
  private _suspendedPath: string | undefined;
  private _suspendedBaudRate: number | undefined;

  constructor(outputChannel?: vscode.OutputChannel) {
    super(() => this.dispose());
    this.ownsLog = !outputChannel;
    this.log = outputChannel || vscode.window.createOutputChannel('ESP Decoder');
    const config = vscode.workspace.getConfiguration('esp-decoder');
    this._baudRate = config.get<number>('defaultBaudRate', 115200);
  }

  get selectedPath(): string | undefined {
    return this._selectedPath;
  }

  get baudRate(): number {
    return this._baudRate;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  public filterPorts<T extends { path: string; manufacturer?: string }>(
    ports: T[]
  ): T[] {
    if (process.platform === 'darwin') {
      return ports.filter((port) => !/\.(Bluetooth|debug)/i.test(port.path));
    } else if (process.platform === 'linux') {
      return ports.filter((port) => !/\/(ttyS\d+|rfcomm)/.test(port.path));
    } else if (process.platform === 'win32') {
      return ports.filter(
        (port) => !/bluetooth/i.test(port.manufacturer || '')
      );
    }
    return ports;
  }

  async listPorts(): Promise<SerialPortInfo[]> {
    try {
      const ports = await SerialPort.list();
      const mappedPorts = ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        vendorId: p.vendorId,
        productId: p.productId,
        friendlyName: (p as unknown as Record<string, unknown>).friendlyName as string | undefined,
      }));
      return this.filterPorts(mappedPorts);
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to list serial ports: ${err instanceof Error ? err.message : err}`
      );
      return [];
    }
  }

  async selectPort(): Promise<string | undefined> {
    const ports = await this.listPorts();
    if (ports.length === 0) {
      vscode.window.showWarningMessage('No serial ports found.');
      return undefined;
    }

    const items = ports.map((p) => ({
      label: p.path,
      description: [p.manufacturer, p.serialNumber].filter(Boolean).join(' — '),
      detail: p.vendorId && p.productId ? `VID:${p.vendorId} PID:${p.productId}` : undefined,
      path: p.path,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select serial port',
      title: 'ESP Decoder: Serial Port Selection',
    });

    if (picked) {
      this._selectedPath = picked.path;
    }
    return picked?.path;
  }

  async selectBaudRate(): Promise<number | undefined> {
    const rates = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];
    const items = rates.map((r) => ({
      label: r.toString(),
      description: r === this._baudRate ? '(current)' : undefined,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Current: ${this._baudRate}`,
      title: 'ESP Decoder: Select Baud Rate',
    });

    if (picked) {
      this._baudRate = parseInt(picked.label, 10);
    }
    return picked ? parseInt(picked.label, 10) : undefined;
  }

  async connect(): Promise<boolean> {
    this.log.appendLine(`[ESP Decoder] connect() called, isConnected: ${this._isConnected}, path: ${this._selectedPath}`);
    if (this._isConnected) {
      await this.disconnect();
    }

    if (!this._selectedPath) {
      const selected = await this.selectPort();
      if (!selected) {
        this.log.appendLine('[ESP Decoder] No port selected, aborting connect');
        return false;
      }
    }

    // A successful or attempted connect cancels any in-flight auto-reconnect
    // loop; we are intentionally taking control of the port now.
    this.cancelReconnect();

    return new Promise<boolean>((resolve) => {
      this.log.appendLine(`[ESP Decoder] Creating SerialPort instance for ${this._selectedPath} @ ${this._baudRate}`);
      try {
        this.port = new SerialPort(
          {
            path: this._selectedPath!,
            baudRate: this._baudRate,
            autoOpen: false,
            hupcl: false,
          },
        );
      } catch (err) {
        this.log.appendLine(`[ESP Decoder] Failed to create SerialPort: ${err instanceof Error ? err.message : err}`);
        if (!this._suppressErrorToasts) {
          vscode.window.showErrorMessage(
            `Failed to create serial port: ${err instanceof Error ? err.message : err}`
          );
        }
        this.port = null;
        resolve(false);
        return;
      }

      this.port.on('error', (err: Error) => {
        this._onError.fire(err);
      });

      this.port.on('close', (disconnectError?: Error | null) => {
        if (disconnectError) {
          this._onError.fire(disconnectError);
        }
        this.port = null;
        if (this._isConnected) {
          this._isConnected = false;
          const info: DisconnectInfo = {
            userInitiated: this._userInitiatedDisconnect,
            suspended: this._suspendedPath !== undefined,
          };
          // Reset the intent flag so the next close (e.g. unexpected USB drop)
          // is correctly classified as not user-initiated.
          this._userInitiatedDisconnect = false;
          this._onConnectionChange.fire(false);
          this._onDisconnect.fire(info);
        }
      });

      this.port.open((err) => {
        if (err) {
          if (!this._suppressErrorToasts) {
            vscode.window.showErrorMessage(
              `Failed to open ${this._selectedPath}: ${err.message}`
            );
          }
          this.port = null;
          resolve(false);
          return;
        }
        // Register the data listener only after the port is open so the
        // stream's first _read() runs with a fully initialised handle.
        this.port!.on('data', (data: Buffer) => {
          this._onData.fire(data);
        });
        this._isConnected = true;
        // Capture device identity for VID/PID/serialNumber-matching reconnect.
        this.captureDeviceIdentity().catch(() => {
          /* best effort — identity is only used for auto-reconnect matching */
        });
        this._onConnectionChange.fire(true);
        resolve(true);
      });
    });
  }

  /** Look up and cache VID/PID/serialNumber for the currently connected port. */
  private async captureDeviceIdentity(): Promise<void> {
    if (!this._selectedPath) {
      return;
    }
    try {
      const ports = await SerialPort.list();
      const match = ports.find((p) => p.path === this._selectedPath);
      if (match) {
        this._connectedVendorId = match.vendorId;
        this._connectedProductId = match.productId;
        this._connectedSerialNumber = match.serialNumber;
        this.log.appendLine(
          `[ESP Decoder] Connected device identity: VID=${match.vendorId ?? '?'} PID=${match.productId ?? '?'} SN=${match.serialNumber ?? '?'}`
        );
      }
    } catch {
      /* ignore — identity capture is best-effort */
    }
  }

  async disconnect(): Promise<void> {
    // Cancel any pending auto-reconnect — an explicit disconnect always wins.
    this.cancelReconnect();
    this._userInitiatedDisconnect = true;
    return new Promise<void>((resolve, reject) => {
      if (!this.port || !this._isConnected) {
        this._isConnected = false;
        this._userInitiatedDisconnect = false;
        this._onConnectionChange.fire(false);
        this._onDisconnect.fire({ userInitiated: true, suspended: false });
        resolve();
        return;
      }

      this.port.close((err) => {
        if (err) {
          // Reset the intent flag on failure so we don't lie about the next close.
          this._userInitiatedDisconnect = false;
          reject(err);
        } else {
          // The 'close' event handler will set _isConnected and fire the events
          resolve();
        }
      });
    });
  }

  async sendData(data: string): Promise<void> {
    if (!this.port || !this._isConnected) {
      throw new Error('Serial port not connected');
    }
    return new Promise((resolve, reject) => {
      this.port!.write(data, (err) => {
        if (err) {
          reject(err);
        } else {
          this.port!.drain((drainErr) => {
            if (drainErr) {
              reject(drainErr);
            } else {
              resolve();
            }
          });
        }
      });
    });
  }

  /**
   * Temporarily release the serial port so another extension (e.g. pioarduino)
   * can use it for flashing. The current connection state is saved so that
   * {@link reacquirePort} can restore it afterwards.
   */
  async releasePort(): Promise<void> {
    if (!this._isConnected) {
      this._suspendedPath = undefined;
      this._suspendedBaudRate = undefined;
      return;
    }
    this._suspendedPath = this._selectedPath;
    this._suspendedBaudRate = this._baudRate;
    await this.disconnect();
  }

  /**
   * Re-open the serial port that was previously released via
   * {@link releasePort}. No-op if there was no suspended connection.
   */
  async reacquirePort(): Promise<void> {
    if (!this._suspendedPath) {
      return;
    }
    if (this._isConnected) {
      this._suspendedPath = undefined;
      this._suspendedBaudRate = undefined;
      return;
    }
    this._selectedPath = this._suspendedPath;
    this._baudRate = this._suspendedBaudRate ?? this._baudRate;
    // Only clear suspended state after a successful connect so that
    // callers (e.g. reacquireWithRetry) can retry on failure.
    const connected = await this.connect();
    if (!connected) {
      throw new Error(`Failed to reopen serial port ${this._selectedPath}`);
    }
    this._suspendedPath = undefined;
    this._suspendedBaudRate = undefined;
  }

  /**
   * Begin polling for the previously connected device to reappear, then
   * reconnect to it. The poll only matches a port whose VID/PID/serialNumber
   * exactly equal the values captured at the most recent successful connect,
   * so a different device plugged in afterwards is never auto-attached.
   *
   * Safe to call repeatedly — only one polling loop runs at a time.
   * Cancelled automatically by {@link connect}, {@link disconnect}, and
   * {@link dispose}.
   *
   * @param timeoutMs Total wall-clock budget for polling.
   * @param pollIntervalMs Delay between port-list polls.
   */
  startAutoReconnect(timeoutMs: number, pollIntervalMs = 500): void {
    if (this._reconnectTimer) {
      // Already running — don't stack timers.
      return;
    }
    if (this._isConnected) {
      return;
    }
    if (!this._connectedVendorId && !this._connectedProductId && !this._connectedSerialNumber) {
      this.log.appendLine('[ESP Decoder] auto-reconnect skipped: no device identity captured');
      return;
    }
    const targetVid = this._connectedVendorId;
    const targetPid = this._connectedProductId;
    const targetSn = this._connectedSerialNumber;
    const previousPath = this._selectedPath;
    this._reconnectDeadline = Date.now() + timeoutMs;
    this.log.appendLine(
      `[ESP Decoder] auto-reconnect armed: VID=${targetVid ?? '?'} PID=${targetPid ?? '?'} SN=${targetSn ?? '?'} timeout=${timeoutMs}ms`
    );

    const poll = async (): Promise<void> => {
      this._reconnectTimer = null;
      if (this._isConnected) {
        return;
      }
      if (Date.now() > this._reconnectDeadline) {
        this.log.appendLine('[ESP Decoder] auto-reconnect: timed out waiting for device');
        return;
      }
      let ports: SerialPortInfo[] = [];
      try {
        ports = await this.listPorts();
      } catch {
        ports = [];
      }
      const match = ports.find((p) =>
        portIdentityMatches(p, targetVid, targetPid, targetSn)
      );
      if (match) {
        this.log.appendLine(
          `[ESP Decoder] auto-reconnect: matched device at ${match.path} (was ${previousPath ?? '?'})`
        );
        this._selectedPath = match.path;
        this._suppressErrorToasts = true;
        try {
          const ok = await this.connect();
          if (!ok) {
            // Open failed (device may not be fully ready) — try again.
            this._reconnectTimer = setTimeout(() => { void poll(); }, pollIntervalMs);
          }
        } finally {
          this._suppressErrorToasts = false;
        }
        return;
      }
      this._reconnectTimer = setTimeout(() => { void poll(); }, pollIntervalMs);
    };

    // First poll runs after a short delay to give the OS time to enumerate.
    this._reconnectTimer = setTimeout(() => { void poll(); }, pollIntervalMs);
  }

  /** Cancel any in-flight auto-reconnect polling loop. */
  cancelReconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectDeadline = 0;
  }

  dispose(): void {
    this.cancelReconnect();
    if (this.port && this._isConnected) {
      this.port.close();
    }
    this._onData.dispose();
    this._onError.dispose();
    this._onConnectionChange.dispose();
    this._onDisconnect.dispose();
    if (this.ownsLog) {
      this.log.dispose();
    }
  }
}

/**
 * Returns true when `port` has the same VID, PID, and serialNumber as the
 * given target identity. At least one of the three target fields must be
 * defined, and every defined target field must match exactly. This avoids
 * matching a different device that happens to enumerate at the same path.
 */
function portIdentityMatches(
  port: SerialPortInfo,
  vendorId: string | undefined,
  productId: string | undefined,
  serialNumber: string | undefined
): boolean {
  const targets: Array<[string | undefined, string | undefined]> = [
    [vendorId, port.vendorId],
    [productId, port.productId],
    [serialNumber, port.serialNumber],
  ];
  let anyDefined = false;
  for (const [target, actual] of targets) {
    if (target === undefined) {
      continue;
    }
    anyDefined = true;
    if (actual === undefined) {
      return false;
    }
    if (target.toLowerCase() !== actual.toLowerCase()) {
      return false;
    }
  }
  return anyDefined;
}
