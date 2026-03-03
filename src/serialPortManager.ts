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

  private readonly _onData = new vscode.EventEmitter<Buffer>();
  readonly onData = this._onData.event;

  private readonly _onError = new vscode.EventEmitter<Error>();
  readonly onError = this._onError.event;

  private readonly _onConnectionChange = new vscode.EventEmitter<boolean>();
  readonly onConnectionChange = this._onConnectionChange.event;

  constructor() {
    super(() => this.dispose());
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

  async listPorts(): Promise<SerialPortInfo[]> {
    try {
      const ports = await SerialPort.list();
      return ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        vendorId: p.vendorId,
        productId: p.productId,
        friendlyName: p.friendlyName,
      }));
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
      title: 'TRBR: Serial Port Selection',
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
      title: 'TRBR: Select Baud Rate',
    });

    if (picked) {
      this._baudRate = parseInt(picked.label, 10);
    }
    return picked ? parseInt(picked.label, 10) : undefined;
  }

  async connect(): Promise<boolean> {
    if (this._isConnected) {
      await this.disconnect();
    }

    if (!this._selectedPath) {
      const selected = await this.selectPort();
      if (!selected) {
        return false;
      }
    }

    return new Promise<boolean>((resolve) => {
      this.port = new SerialPort(
        {
          path: this._selectedPath!,
          baudRate: this._baudRate,
          autoOpen: false,
        },
      );

      this.port.on('data', (data: Buffer) => {
        this._onData.fire(data);
      });

      this.port.on('error', (err: Error) => {
        this._onError.fire(err);
        vscode.window.showErrorMessage(`Serial port error: ${err.message}`);
      });

      this.port.on('close', () => {
        this._isConnected = false;
        this._onConnectionChange.fire(false);
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
        this._isConnected = true;
        this._onConnectionChange.fire(true);
        resolve(true);
      });
    });
  }

  async disconnect(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.port || !this._isConnected) {
        this._isConnected = false;
        this._onConnectionChange.fire(false);
        resolve();
        return;
      }

      this.port.close((err) => {
        if (err) {
          console.error('Error closing port:', err);
        }
        this.port = null;
        this._isConnected = false;
        this._onConnectionChange.fire(false);
        resolve();
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

  dispose(): void {
    if (this.port && this._isConnected) {
      this.port.close();
    }
    this._onData.dispose();
    this._onError.dispose();
    this._onConnectionChange.dispose();
  }
}
