import { SerialPort } from 'serialport';
import * as vscode from 'vscode';
import { getUse1200BpsTouch } from './pioIntegration';

type ResetMethod = 'auto' | '1200-baud-touch' | 'rts-en';

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

type PortEnumerationResult =
  | { success: true; ports: SerialPortInfo[] }
  | { success: false; error: unknown };

interface PortIdentity {
  vendorId: string | undefined;
  productId: string | undefined;
  serialNumber: string | undefined;
}

interface ResetReconnectContext {
  identity: PortIdentity;
  pathsBeforeReset: Set<string>;
  fallbackPath: string;
}

export class SerialPortManager extends vscode.Disposable {
  private port: SerialPort | null = null;
  private _selectedPath: string | undefined;
  private _baudRate: number;
  private _isConnected = false;
  private readonly log: vscode.OutputChannel;
  private readonly ownsLog: boolean;

  // Connection gating to prevent race conditions
  private _connectPromise: Promise<boolean> | null = null;
  private _connectGeneration = 0; // Incremented on each connect attempt

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
  // True from the moment startAutoReconnect() arms a reconnect window until
  // either a stable connection is established, the deadline elapses, or the
  // user/dispose explicitly cancels it. Used to:
  //   1. preserve the original deadline across multiple unstable reset cycles
  //      (the user may need to press the reset button several times);
  //   2. silently swallow benign read/close errors (ENXIO/EIO/...) that the OS
  //      reports while a native USB-CDC device is re-enumerating.
  private _isReconnecting = false;
  // Set after each successful (re)connect during a reconnect window. If the
  // port stays open for STABILITY_MS without closing, the reconnect window
  // ends. If the port closes first, the timer is cancelled and the existing
  // deadline continues to apply to the next attempt.
  private _stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STABILITY_MS = 1500;

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
  private _pioEnvironment: string | undefined;

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

  /**
   * Programmatically set the serial port path (used by external integrations,
   * e.g. pioarduino's "Monitor" task that hands the configured upload/monitor
   * port over to ESP Decoder so the user does not have to pick it again).
   */
  setPort(path: string): boolean {
    const trimmed = typeof path === 'string' ? path.trim() : '';
    if (!trimmed) {
      return false;
    }
    this._selectedPath = trimmed;
    return true;
  }

  /** Programmatically set the baud rate. Only positive integers are accepted. */
  setBaudRate(rate: number): boolean {
    if (!Number.isInteger(rate) || rate <= 0) {
      return false;
    }
    this._baudRate = rate;
    return true;
  }

  /** Associate the connected port with the PlatformIO environment that owns it. */
  setPlatformIOEnvironment(environment?: string): void {
    this._pioEnvironment = environment?.trim() || undefined;
  }

  /** True while an auto-reconnect window is active. */
  get isReconnecting(): boolean {
    return this._isReconnecting;
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

  async listPorts(suppressToasts = false): Promise<SerialPortInfo[]> {
    const result = await this.enumeratePorts();
    if (result.success) {
      return result.ports;
    }

    const err = result.error;
    // Background callers (auto-reconnect poll, identity capture) pass
    // suppressToasts=true so a transient enumeration failure does not flood
    // the user with modal error messages mid-reset cycle.
    if (!suppressToasts) {
      vscode.window.showErrorMessage(
        `Failed to list serial ports: ${err instanceof Error ? err.message : err}`
      );
    } else {
      this.log.appendLine(
        `[ESP Decoder] listPorts failed (suppressed): ${err instanceof Error ? err.message : err}`
      );
    }
    return [];
  }

  private async enumeratePorts(): Promise<PortEnumerationResult> {
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
      return { success: true, ports: this.filterPorts(mappedPorts) };
    } catch (err) {
      return { success: false, error: err };
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
    const CUSTOM_LABEL = 'Custom…';
    const items: { label: string; description?: string; custom?: boolean }[] =
      rates.map((r) => ({
        label: r.toString(),
        description: r === this._baudRate ? '(current)' : undefined,
      }));
    // If the current rate isn't one of the presets, mark it as current in the
    // custom entry so the user can see at a glance what's active.
    const currentIsCustom = !rates.includes(this._baudRate);
    items.push({
      label: CUSTOM_LABEL,
      description: currentIsCustom ? `(current: ${this._baudRate})` : 'Enter a custom baud rate',
      custom: true,
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Current: ${this._baudRate}`,
      title: 'ESP Decoder: Select Baud Rate',
    });

    if (!picked) {
      return undefined;
    }

    if (picked.custom) {
      const entered = await vscode.window.showInputBox({
        title: 'ESP Decoder: Custom Baud Rate',
        prompt: 'Enter a custom baud rate (positive integer, e.g. 250000)',
        value: this._baudRate.toString(),
        validateInput: (value) => {
          const trimmed = value.trim();
          if (!trimmed) {
            return 'Baud rate is required';
          }
          if (!/^\d+$/.test(trimmed)) {
            return 'Baud rate must be a positive integer';
          }
          const n = parseInt(trimmed, 10);
          if (!Number.isInteger(n) || n <= 0) {
            return 'Baud rate must be a positive integer';
          }
          return undefined;
        },
      });
      if (!entered) {
        return undefined;
      }
      const rate = parseInt(entered.trim(), 10);
      this._baudRate = rate;
      return rate;
    }

    this._baudRate = parseInt(picked.label, 10);
    return this._baudRate;
  }

  async connect(): Promise<boolean> {
    // Gate connection initiation - if a connection is already in progress, wait for it.
    // The promise is created and stored BEFORE any await so concurrent callers joining
    // after this point will always find it and share the same attempt.
    if (this._connectPromise) {
      this.log.appendLine('[ESP Decoder] Connection already in progress, waiting for existing connection to complete');
      return this._connectPromise;
    }

    let resolveAttempt!: (value: boolean) => void;
    const connectionPromise = new Promise<boolean>((resolve) => {
      resolveAttempt = resolve;
    });
    this._connectPromise = connectionPromise;

    const finishAttempt = (result: boolean) => {
      // Only clear the shared promise if it still belongs to this attempt.
      if (this._connectPromise === connectionPromise) {
        this._connectPromise = null;
      }
      resolveAttempt(result);
    };

    // Run the actual connection logic; any concurrent caller that arrives
    // after the assignment above will simply await connectionPromise.
    void this.connectInternal(connectionPromise, finishAttempt).catch((err) => {
      this.log.appendLine(`[ESP Decoder] connectInternal rejected unexpectedly: ${err instanceof Error ? err.message : err}`);
      finishAttempt(false);
    });
    return connectionPromise;
  }

  private async connectInternal(
    connectionPromise: Promise<boolean>,
    finishAttempt: (result: boolean) => void,
  ): Promise<void> {
    this.log.appendLine(`[ESP Decoder] connect() called, isConnected: ${this._isConnected}, path: ${this._selectedPath}`);

    // Snapshot the generation at the start of this attempt so we can detect
    // if a newer attempt (or a user-initiated disconnect) has superseded us
    // across the awaits below.
    var startGeneration = this._connectGeneration;

    if (this._isConnected) {
      const disconnecting = this.disconnect();
      // disconnect() bumps the generation synchronously; absorb our own bump.
      startGeneration = this._connectGeneration;
      await disconnecting;
      if (this._connectGeneration !== startGeneration) {
        this.log.appendLine('[ESP Decoder] connectInternal: superseded after disconnect, aborting');
        finishAttempt(false);
        return;
      }
    }

    if (!this._selectedPath) {
      const selected = await this.selectPort();
      if (!selected) {
        this.log.appendLine('[ESP Decoder] No port selected, aborting connect');
        finishAttempt(false);
        return;
      }
      if (this._connectGeneration !== startGeneration) {
        this.log.appendLine('[ESP Decoder] connectInternal: superseded after selectPort, aborting');
        finishAttempt(false);
        return;
      }
    }

    // Clear any pending poll timer — we are taking control of the port now.
    // Note: we deliberately do NOT clear `_isReconnecting` here, because this
    // method is itself called from the reconnect poll, and we want the window
    // (and its deadline) to survive until either a stable connection forms or
    // the user cancels. cancelReconnect() handles full teardown when needed.
    this.clearReconnectTimer();

    // Increment generation for this connection attempt
    this._connectGeneration++;
    const attemptGeneration = this._connectGeneration;

    const abandonPortIfStale = (portInstance: SerialPort) => {
      // Don't clear this.port if it belongs to a newer attempt.
      if (this.port === portInstance) {
        this.port = null;
      }
      try {
        if (portInstance.isOpen) {
          portInstance.close(() => { /* abandoned attempt */ });
        }
      } catch {
        /* ignore close errors on invalidated ports */
      }
    };

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
      finishAttempt(false);
      return;
    }

    const portInstance = this.port;

    portInstance.on('error', (err: Error) => {
      // Only process callbacks from the current port instance
      if (this.port !== portInstance) {
        this.log.appendLine('[ESP Decoder] Ignoring error callback from stale port instance');
        return;
      }
      if (this.shouldSuppressTransient(err)) {
        this.log.appendLine(`[ESP Decoder] suppressed transient error (auto-reconnect): ${err.message}`);
        return;
      }
      this._onError.fire(err);
    });

    portInstance.on('close', (disconnectError?: Error | null) => {
      // Only process callbacks from the current port instance
      if (this.port !== portInstance) {
        this.log.appendLine('[ESP Decoder] Ignoring close callback from stale port instance');
        return;
      }
      // Cancel any pending stability check — connection didn't last.
      this.clearStabilityTimer();
      if (disconnectError) {
        if (this.shouldSuppressTransient(disconnectError)) {
          this.log.appendLine(`[ESP Decoder] suppressed transient close error (auto-reconnect): ${disconnectError.message}`);
        } else {
          this._onError.fire(disconnectError);
        }
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

    portInstance.open((err) => {
      if (this.port !== portInstance || this._connectGeneration !== attemptGeneration) {
        this.log.appendLine('[ESP Decoder] Ignoring open callback from stale connection attempt');
        abandonPortIfStale(portInstance);
        finishAttempt(false);
        return;
      }
      if (err) {
        // During an active reconnect window, treat open failures as part of
        // the polling cycle — don't toast, don't fire the error event.
        if (this._isReconnecting) {
          this.log.appendLine(`[ESP Decoder] auto-reconnect: open failed, will retry: ${err.message}`);
        } else if (!this._suppressErrorToasts) {
          vscode.window.showErrorMessage(
            `Failed to open ${this._selectedPath}: ${err.message}`
          );
        }
        this.port = null;
        finishAttempt(false);
        return;
      }
      // Register the data listener only after the port is open so the
      // stream's first _read() runs with a fully initialised handle.
      portInstance.on('data', (data: Buffer) => {
        // Only process callbacks from the current port instance
        if (this.port !== portInstance) {
          return;
        }
        this._onData.fire(data);
      });
      // Capture device identity BEFORE firing connection-change / resolving,
      // so that an immediate reset (within a few hundred ms of connect)
      // still finds VID/PID/SN populated when startAutoReconnect runs.
      // This is awaited but typically completes in <100 ms.
      void this.captureDeviceIdentity()
        .catch(() => { /* best effort — identity used only for reconnect matching */ })
        .then(() => {
          if (this.port !== portInstance || this._connectGeneration !== attemptGeneration) {
            this.log.appendLine('[ESP Decoder] Ignoring delayed callback from stale connection attempt');
            abandonPortIfStale(portInstance);
            finishAttempt(false);
            return;
          }
          this._isConnected = true;
          // If this open happened inside a reconnect window, arm the
          // stability timer. The window only ends if the port stays open
          // for STABILITY_MS without a close.
          if (this._isReconnecting) {
            this.clearStabilityTimer();
            this._stabilityTimer = setTimeout(() => {
              this._stabilityTimer = null;
              if (this._isConnected) {
                this._isReconnecting = false;
                this._reconnectDeadline = 0;
                this.log.appendLine('[ESP Decoder] auto-reconnect: connection stable');
              }
            }, SerialPortManager.STABILITY_MS);
          }
          this._onConnectionChange.fire(true);
          finishAttempt(true);
        });
    });
  }

  private clearStabilityTimer(): void {
    if (this._stabilityTimer) {
      clearTimeout(this._stabilityTimer);
      this._stabilityTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * True if a transient I/O error (ENXIO/EIO/etc.) should be swallowed instead
   * of surfaced to the user. Suppression applies whenever the auto-reconnect
   * setting is enabled, even for the very first error of a reset cycle —
   * before {@link startAutoReconnect} has been called — so the user never sees
   * a stray "ENXIO: no such device" toast for a reset they expect to recover.
   */
  private shouldSuppressTransient(err: Error): boolean {
    if (!isTransientReconnectError(err)) {
      return false;
    }
    if (this._isReconnecting) {
      return true;
    }
    return this.isAutoReconnectEnabled();
  }

  /** Read the current auto-reconnect setting from the workspace config. */
  private isAutoReconnectEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('esp-decoder')
      .get<boolean>('serialMonitor.autoReconnect', false);
  }

  /** Look up and cache VID/PID/serialNumber for the currently connected port. */
  private async captureDeviceIdentity(): Promise<void> {
    if (!this._selectedPath) {
      return;
    }
    try {
      // Background lookup — never raise toasts on enumeration failure.
      const ports = await this.listPorts(/* suppressToasts */ true);
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

    // Bump the generation so connectInternal detects it has been superseded.
    // Do NOT null _connectPromise here — concurrent connect() callers must
    // still be able to join or observe the in-flight attempt settling.
    this._connectGeneration++;

    return new Promise<void>((resolve, reject) => {
      if (!this.port || !this._isConnected) {
        this._isConnected = false;
        this._userInitiatedDisconnect = false;
        this._onConnectionChange.fire(false);
        this._onDisconnect.fire({ userInitiated: true, suspended: false });
        resolve();
        return;
      }

      const portInstance = this.port;
      portInstance.close((err) => {
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

  /**
   * Attempt PlatformIO's 1200-baud reset touch, then return to the application
   * monitor. A port disappearance only indicates re-enumeration; it does not
   * identify the USB stack. USB-UART bridges that stay present use RTS/EN.
   */
  async hardReset(): Promise<void> {
    if (!this.port || !this._isConnected) {
      throw new Error('Serial port not connected');
    }
    const path = this._selectedPath;
    if (!path) {
      throw new Error('No serial port selected');
    }

    const resetMethod = vscode.workspace
      .getConfiguration('esp-decoder')
      .get<ResetMethod>('serialMonitor.resetMethod', 'auto');
    let use1200BpsTouch = resetMethod === '1200-baud-touch';
    if (resetMethod === 'auto') {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const configuredEnvironment = vscode.workspace
        .getConfiguration('esp-decoder')
        .get<string>('serialMonitor.platformioEnvironment', '')
        .trim();
      const environment = this._pioEnvironment ?? (configuredEnvironment || undefined);
      const boardSetting = workspaceFolder
        ? await getUse1200BpsTouch(workspaceFolder, environment)
        : undefined;
      use1200BpsTouch = boardSetting === true;
      if (boardSetting === undefined) {
        this.log.appendLine(
          '[ESP Decoder] PlatformIO 1200-baud-touch setting is unknown; using RTS/EN reset',
        );
      }
    }

    if (!use1200BpsTouch) {
      if (!this._isConnected && !(await this.connect())) {
        throw new Error(`Failed to reopen serial port ${this._selectedPath ?? path}`);
      }
      await this.pulseResetSignals();
      return;
    }

    const originalIdentity: PortIdentity = {
      vendorId: this._connectedVendorId,
      productId: this._connectedProductId,
      serialNumber: this._connectedSerialNumber,
    };

    // PlatformIO's use_1200bps_touch action opens the CDC port at 1200 baud,
    // then closes it. Arduino-ESP32 TinyUSB firmware may restart into its
    // bootloader in response. Release the monitor handle before opening the
    // temporary connection, especially on Windows.
    await this.disconnect();
    const beforeTouch = await this.enumeratePorts();
    const portsBeforeTouch = beforeTouch.success ? beforeTouch.ports : [];
    const wasEnumerated = beforeTouch.success
      && portsBeforeTouch.some((candidate) => candidate.path === path);
    const disappearance = this.waitForPortDisappearance(path, wasEnumerated, 2000);
    try {
      await this.touchSerialPortAt1200(path);
    } catch (err) {
      this.log.appendLine(
        `[ESP Decoder] 1200-baud touch failed: ${err instanceof Error ? err.message : err}`
      );
    }

    const disappeared = await disappearance;
    if (disappeared) {
      this.log.appendLine('[ESP Decoder] Port disappeared after 1200-baud touch; waiting for re-enumeration');
      const timeoutMs = vscode.workspace
        .getConfiguration('esp-decoder')
        .get<number>('serialMonitor.autoReconnectTimeoutMs', 15000);
      const firstResetContext: ResetReconnectContext = {
        identity: originalIdentity,
        pathsBeforeReset: new Set(portsBeforeTouch.map((candidate) => candidate.path)),
        fallbackPath: path,
      };
      await this.reconnectAndWait(timeoutMs, firstResetContext);

      // The 1200-baud touch can leave Arduino-ESP32 in its bootloader. Pulse
      // reset on the re-enumerated port to start the application, then wait
      // for its port and reconnect using the original identity or a unique
      // port that appeared during this reset cycle.
      const bootloaderPath = this._selectedPath;
      if (!bootloaderPath) {
        throw new Error('No re-enumerated serial port selected after 1200-baud touch');
      }
      const beforeApplicationReset = await this.enumeratePorts();
      const bootloaderPorts = beforeApplicationReset.success
        ? beforeApplicationReset.ports
        : [];
      const applicationDisappearance = this.waitForPortDisappearance(
        bootloaderPath,
        beforeApplicationReset.success
          && bootloaderPorts.some((candidate) => candidate.path === bootloaderPath),
        2000,
      );
      let resetError: unknown;
      try {
        await this.pulseResetSignals();
      } catch (err) {
        resetError = err;
        this.log.appendLine(
          `[ESP Decoder] Reset signal ended with an error during re-enumeration: ${err instanceof Error ? err.message : err}`
        );
      }
      if (!(await applicationDisappearance)) {
        if (resetError instanceof Error) {
          throw resetError;
        }
        throw new Error('The re-enumerated port did not disappear after reset; application mode could not be confirmed');
      }

      if (this._isConnected) {
        try {
          await this.disconnect();
        } catch (err) {
          this.log.appendLine(
            `[ESP Decoder] Port close after reset was already in progress: ${err instanceof Error ? err.message : err}`
          );
        }
      }
      const applicationResetContext: ResetReconnectContext = {
        identity: originalIdentity,
        pathsBeforeReset: new Set(bootloaderPorts.map((candidate) => candidate.path)),
        fallbackPath: bootloaderPath,
      };
      await this.reconnectAndWait(timeoutMs, applicationResetContext);
      return;
    }

    // A USB-UART bridge generally ignores the 1200-baud touch. Re-open the
    // monitor and use the standard RTS/EN reset sequence in that case.
    if (!this._isConnected && !(await this.connect())) {
      throw new Error(`Failed to reopen serial port ${this._selectedPath ?? path}`);
    }
    await this.pulseResetSignals();
  }

  private async pulseResetSignals(): Promise<void> {
    const port = this.port;
    if (!port || !this._isConnected || !port.isOpen) {
      throw new Error('Serial port not connected');
    }
    // Always pass BOTH dtr and rts: node-serialport's set() resets every
    // unspecified flag to its default (dtr: true, rts: true). Letting dtr
    // default to true would assert IO0 LOW via the auto-reset circuit and
    // send the chip into download mode instead of resetting it.
    const setSignals = (dtr: boolean, rts: boolean): Promise<void> =>
      new Promise((resolve, reject) => {
        port.set({ dtr, rts }, (err) => (err ? reject(err) : resolve()));
      });
    this.log.appendLine('[ESP Decoder] hard-reset: RTS=1 DTR=0 (EN low, IO0 high)');
    await setSignals(false, true);
    await new Promise<void>((r) => setTimeout(r, 100));
    this.log.appendLine('[ESP Decoder] hard-reset: RTS=0 DTR=0 (EN high, IO0 high)');
    await setSignals(false, false);
  }

  private async touchSerialPortAt1200(path: string): Promise<void> {
    const touchPort = new SerialPort({
      path,
      baudRate: 1200,
      autoOpen: false,
    });
    touchPort.on('error', (err: Error) => {
      this.log.appendLine(`[ESP Decoder] 1200-baud touch port error: ${err.message}`);
    });

    await new Promise<void>((resolve, reject) => {
      touchPort.open((err) => (err ? reject(err) : resolve()));
    });
    try {
      // PlatformIO deasserts DTR during the touch so opening the port does not
      // inadvertently assert the ESP download-mode strap.
      await new Promise<void>((resolve, reject) => {
        touchPort.set({ dtr: false }, (err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } finally {
      if (touchPort.isOpen) {
        await new Promise<void>((resolve, reject) => {
          touchPort.close((err) => (err ? reject(err) : resolve()));
        });
      }
    }
    // Give the USB stack time to process the disconnect and begin enumerating
    // the bootloader or application port, as PlatformIO does after its touch.
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }

  private async waitForPortDisappearance(
    path: string,
    wasEnumerated: boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!wasEnumerated) {
      return false;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.enumeratePorts();
      if (result.success && !result.ports.some((candidate) => candidate.path === path)) {
        return true;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  private async reconnectAndWait(
    timeoutMs: number,
    resetContext?: ResetReconnectContext,
  ): Promise<void> {
    const boundedTimeout = Math.max(1000, timeoutMs);
    let subscription: vscode.Disposable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connected = new Promise<void>((resolve, reject) => {
      subscription = this.onConnectionChange((isConnected) => {
        if (isConnected) {
          resolve();
        }
      });
      timer = setTimeout(
        () => reject(new Error('Timed out waiting for the serial port to re-enumerate')),
        boundedTimeout + 1000,
      );
    });
    try {
      // This explicit reset flow reconnects regardless of the optional setting
      // that controls background reconnect after unexpected disconnects.
      this.startAutoReconnect(boundedTimeout, 250, resetContext);
      if (!this._isReconnecting) {
        throw new Error('Cannot reconnect: no device identity or unique reset port was captured');
      }
      await connected;
    } finally {
      subscription?.dispose();
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async sendData(data: string): Promise<void> {
    if (!this.port || !this._isConnected) {
      throw new Error('Serial port not connected');
    }
    // Use latin1 encoding so every character is transmitted as its 8-bit
    // code-point value. The default UTF-8 encoding expands chars > 0x7F into
    // two-byte sequences, causing high-ASCII bytes to arrive garbled on the device.
    return new Promise((resolve, reject) => {
      this.port!.write(Buffer.from(data, 'latin1'), (err) => {
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
    // Clear any pending connection before disconnecting
    this._connectPromise = null;
    this._connectGeneration++;
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
   * The explicit 1200-baud reset path may supply a context that permits the
   * original path or one unique newly enumerated path when bootloader USB
   * descriptors differ from the application descriptors.
   *
   * Safe to call repeatedly — only one polling loop runs at a time.
   * Cancelled automatically by {@link connect}, {@link disconnect}, and
   * {@link dispose}.
   *
   * @param timeoutMs Total wall-clock budget for polling.
   * @param pollIntervalMs Delay between port-list polls.
   */
  startAutoReconnect(
    timeoutMs: number,
    pollIntervalMs = 500,
    resetContext?: ResetReconnectContext,
  ): void {
    if (this._isConnected && !this._stabilityTimer) {
      // Already stably connected — nothing to do.
      return;
    }
    const targetIdentity = resetContext?.identity ?? {
      vendorId: this._connectedVendorId,
      productId: this._connectedProductId,
      serialNumber: this._connectedSerialNumber,
    };
    if (
      !targetIdentity.vendorId
      && !targetIdentity.productId
      && !targetIdentity.serialNumber
      && !resetContext
    ) {
      this.log.appendLine('[ESP Decoder] auto-reconnect skipped: no device identity captured');
      this._isReconnecting = false;
      return;
    }
    // Continue the existing window if one is already in progress; otherwise
    // arm a fresh window with the supplied timeout.
    const continuingExisting = this._isReconnecting && Date.now() < this._reconnectDeadline;
    if (!continuingExisting) {
      this._reconnectDeadline = Date.now() + timeoutMs;
      this._isReconnecting = true;
      this.log.appendLine(
        `[ESP Decoder] auto-reconnect armed: VID=${targetIdentity.vendorId ?? '?'} PID=${targetIdentity.productId ?? '?'} SN=${targetIdentity.serialNumber ?? '?'} timeout=${timeoutMs}ms`
      );
    }
    if (this._reconnectTimer) {
      // A poll is already scheduled — don't stack timers.
      return;
    }

    const targetVid = targetIdentity.vendorId;
    const targetPid = targetIdentity.productId;
    const targetSn = targetIdentity.serialNumber;
    const previousPath = resetContext?.fallbackPath ?? this._selectedPath;

    const poll = async (): Promise<void> => {
      this._reconnectTimer = null;
      if (this._isConnected) {
        return;
      }
      if (!this._isReconnecting) {
        // Cancelled externally.
        return;
      }
      if (Date.now() > this._reconnectDeadline) {
        this.log.appendLine('[ESP Decoder] auto-reconnect: timed out waiting for device');
        this._isReconnecting = false;
        this._reconnectDeadline = 0;
        // Surface the failure so the user knows reconnection gave up rather
        // than silently never coming back.
        vscode.window.showWarningMessage(
          `ESP Decoder: auto-reconnect timed out — device with VID=${targetVid ?? '?'} PID=${targetPid ?? '?'} did not reappear.`
        );
        return;
      }
      let ports: SerialPortInfo[] = [];
      try {
        ports = await this.listPorts(/* suppressToasts */ true);
      } catch {
        ports = [];
      }
      // Re-check the reconnect guard after the await: cancelReconnect() or
      // disconnect() may have run while we were enumerating ports, in which
      // case we must not mutate _selectedPath / _suppressErrorToasts or call
      // connect() — that would silently undo the user's cancel.
      if (!this._isReconnecting || this._isConnected) {
        return;
      }
      let match = ports.find((p) =>
        portIdentityMatches(p, targetVid, targetPid, targetSn)
      );
      if (!match && resetContext) {
        // A 1200-baud touch can switch between application and bootloader USB
        // descriptors. During this explicit reset only, accept the original
        // path or one unambiguous newly enumerated path as the same board.
        match = ports.find((p) => p.path === resetContext.fallbackPath);
        if (!match) {
          const newlyEnumerated = ports.filter(
            (p) => !resetContext.pathsBeforeReset.has(p.path)
          );
          if (newlyEnumerated.length === 1) {
            match = newlyEnumerated[0];
          }
        }
      }
      if (match) {
        this.log.appendLine(
          `[ESP Decoder] auto-reconnect: matched device at ${match.path} (was ${previousPath ?? '?'})`
        );
        this._selectedPath = match.path;
        this._suppressErrorToasts = true;
        try {
          const ok = await this.connect();
          if (!ok && this._isReconnecting) {
            // Open failed (device may still be re-enumerating) — try again.
            this._reconnectTimer = setTimeout(() => { void poll(); }, pollIntervalMs);
          }
        } finally {
          this._suppressErrorToasts = false;
        }
        return;
      }
      if (this._isReconnecting) {
        this._reconnectTimer = setTimeout(() => { void poll(); }, pollIntervalMs);
      }
    };

    // First poll runs after a short delay to give the OS time to enumerate.
    this._reconnectTimer = setTimeout(() => { void poll(); }, pollIntervalMs);
  }

  /**
   * Fully cancel the auto-reconnect window: stop polling, drop the deadline,
   * and clear any pending stability check. Called by user-initiated disconnect
   * and by dispose(). The reconnect poll itself uses {@link clearReconnectTimer}
   * (which preserves `_isReconnecting`) so a successful open inside the poll
   * does not abort the surrounding reconnect window.
   */
  cancelReconnect(): void {
    this.clearReconnectTimer();
    this.clearStabilityTimer();
    this._reconnectDeadline = 0;
    this._isReconnecting = false;
  }

  dispose(): void {
    this.cancelReconnect();
    this._connectPromise = null;
    this._connectGeneration++;
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
 * Recognises errors that the OS commonly emits while a USB-CDC device is
 * re-enumerating (boot/reset of ESP32-S2/S3/C3, ESP32-P4, etc.) or while the
 * user is hunting for the right CDC/JTAG port by repeatedly pressing reset.
 * These are not actionable for the user during an active reconnect window;
 * they're swallowed so the monitor stays quiet until either a stable
 * connection forms or the reconnect deadline expires.
 */
export function isTransientReconnectError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  // POSIX: ENXIO (no such device), EIO (input/output error), ENOENT,
  // EBADF (bad file descriptor), ENODEV (no such device), EAGAIN.
  // macOS: "device not configured".
  // Windows: "operation aborted", "the device does not recognize the command",
  // "the i/o operation has been aborted", "cannot find the file specified".
  //
  // NOTE: "access denied" is intentionally NOT suppressed. On Windows it
  // typically means another process is holding the port (bootloader tool,
  // Zadig, another serial monitor) — that is actionable for the user, and
  // silently swallowing it during a reconnect window would hide the real
  // reason reconnection never succeeds.
  return /\b(enxio|eio|enoent|ebadf|enodev|eagain|eacces)\b/.test(msg)
    || msg.includes('no such device')
    || msg.includes('device not configured')
    || msg.includes('operation aborted')
    || msg.includes('i/o operation has been aborted')
    || msg.includes('does not recognize the command')
    || msg.includes('cannot find the file specified')
    || msg.includes('device disconnected');
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
