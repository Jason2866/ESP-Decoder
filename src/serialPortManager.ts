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

export class SerialPortManager extends vscode.Disposable {
  private port: SerialPort | null = null;
  private _selectedPath: string | undefined;
  private _baudRate: number;
  private _isConnected = false;
  private readonly log: vscode.OutputChannel;
  private readonly ownsLog: boolean;

  private readonly _onData = new vscode.EventEmitter<Buffer>();
  readonly onData = this._onData.event;

  private readonly _onError = new vscode.EventEmitter<Error>();
  readonly onError = this._onError.event;

  private readonly _onConnectionChange = new vscode.EventEmitter<boolean>();
  readonly onConnectionChange = this._onConnectionChange.event;

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
        vscode.window.showErrorMessage(
          `Failed to create serial port: ${err instanceof Error ? err.message : err}`
        );
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
          this._onConnectionChange.fire(false);
        }
      });

      this.port.open((err) => {
        if (err) {
          vscode.window.showErrorMessage(
            `Failed to open ${this._selectedPath}: ${err.message}`
          );
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
        this._onConnectionChange.fire(true);
        resolve(true);
      });
    });
  }

  async disconnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.port || !this._isConnected) {
        this._isConnected = false;
        this._onConnectionChange.fire(false);
        resolve();
        return;
      }

      this.port.close((err) => {
        if (err) {
          reject(err);
        } else {
          // The 'close' event handler will set _isConnected and fire the event
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

  dispose(): void {
    if (this.port && this._isConnected) {
      this.port.close();
    }
    this._onData.dispose();
    this._onError.dispose();
    this._onConnectionChange.dispose();
    if (this.ownsLog) {
      this.log.dispose();
    }
  }
}
