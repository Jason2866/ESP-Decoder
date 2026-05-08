import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SerialPortManager } from './serialPortManager';
import { EspDecoderWebviewPanel, SessionConfig } from './webviewPanel';
import { findPioEnvironments, selectElfFile } from './pioIntegration';
import { findEspIdfBuilds } from './espIdfIntegration';

/** Shape of the public API exported by the pioarduino IDE extension. */
interface PioarduinoApi {
  onWillUpload: vscode.Event<{
    port: string | undefined;
    waitUntil(promise: Promise<void>): void;
  }>;
  onDidUpload: vscode.Event<{ port: string | undefined; exitCode: number }>;
}

let serialManager: SerialPortManager;
let viewProvider: EspDecoderWebviewPanel | undefined;
let outputChannel: vscode.OutputChannel;

// Session state
let sessionConfig: SessionConfig = {};

// Tracks whether the user has manually picked an ELF file.
// When true, file-watcher auto-detection must not overwrite the selection.
let manualElfOverride = false;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('ESP Decoder');
  context.subscriptions.push(outputChannel);

  try {
    serialManager = new SerialPortManager(outputChannel);
  } catch (err) {
    outputChannel.appendLine(`FATAL: Failed to create SerialPortManager: ${err}`);
    vscode.window.showErrorMessage(`ESP Decoder: Failed to initialize serial port manager: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  context.subscriptions.push(serialManager);

  // Subscribe to pioarduino upload lifecycle events so we automatically
  // release the serial port before flashing and reacquire it afterwards.
  subscribeToPioarduinoEvents(context, serialManager, outputChannel);

  // Status bar item - opens ESP Connect window
  const statusBarConnection = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarConnection.command = 'esp-decoder.openMonitor';
  statusBarConnection.text = '$(circle-slash) ESP Disconnected';
  statusBarConnection.tooltip = 'Open ESP Decoder Monitor';
  statusBarConnection.show();
  context.subscriptions.push(statusBarConnection);

  // Update status bar on connection changes
  serialManager.onConnectionChange((connected) => {
    if (connected) {
      statusBarConnection.text = `$(check) ESP Connected: ${serialManager.selectedPath || '?'}`;
    } else {
      statusBarConnection.text = '$(circle-slash) ESP Disconnected';
    }
  });

  // Register the webview view provider (panel appears in the bottom area)
  viewProvider = new EspDecoderWebviewPanel(
    context.extensionUri,
    serialManager,
    sessionConfig,
    outputChannel
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      EspDecoderWebviewPanel.viewType,
      viewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'esp-decoder.openMonitor',
      async (opts?: { port?: string; baudRate?: number; autoConnect?: boolean }) => {
        // Allow callers (e.g. pioarduino's "Monitor" task) to hand over the
        // already-selected serial port (and optionally baud rate) and request
        // an immediate connect, so the user does not have to pick the port
        // again inside ESP Decoder.
        // Capture the live values BEFORE applying any overrides, so we can
        // detect port- or baud-rate-only changes and force a reconnect.
        const prevPort = serialManager.selectedPath;
        const prevBaud = serialManager.baudRate;

        if (opts?.port) {
          serialManager.setPort(opts.port);
        }
        if (typeof opts?.baudRate === 'number') {
          serialManager.setBaudRate(opts.baudRate);
        }

        if (viewProvider) {
          const config = vscode.workspace.getConfiguration('esp-decoder');
          const monitorLocation = config.get<string>('monitorLocation', 'panel');

          if (monitorLocation === 'editor') {
            viewProvider.showAsEditor();
          } else {
            viewProvider.show();
          }
        }

        // Auto-connect when requested. Defaults to true if a port was passed
        // in, false otherwise (preserves the previous "just open the panel"
        // behaviour when called without arguments, e.g. from the status bar).
        const shouldAutoConnect =
          opts?.autoConnect ?? Boolean(opts?.port);
        if (shouldAutoConnect) {
          try {
            const portChanged =
              !!opts?.port && opts.port !== prevPort;
            const baudChanged =
              typeof opts?.baudRate === 'number' && opts.baudRate !== prevBaud;
            if (serialManager.isConnected && (portChanged || baudChanged)) {
              await serialManager.disconnect();
            }
            if (!serialManager.isConnected) {
              const ok = await serialManager.connect();
              if (ok) {
                vscode.window.showInformationMessage(
                  `ESP Decoder connected to ${serialManager.selectedPath} @ ${serialManager.baudRate}`
                );
              }
            }
          } catch (err) {
            vscode.window.showErrorMessage(
              `ESP Decoder auto-connect failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('esp-decoder.selectBaudRate', async () => {
      await serialManager.selectBaudRate();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('esp-decoder.connect', async () => {
      try {
        const success = await serialManager.connect();
        if (success) {
          vscode.window.showInformationMessage(
            `Connected to ${serialManager.selectedPath} @ ${serialManager.baudRate}`
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Connection failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('esp-decoder.disconnect', async () => {
      try {
        await serialManager.disconnect();
        vscode.window.showInformationMessage('Serial port disconnected');
      } catch (err) {
        vscode.window.showErrorMessage(
          `Disconnect failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('esp-decoder.selectElfFile', async () => {
      const workspaceFolder =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const result = await selectElfFile(workspaceFolder, viewProvider?.currentElfPath ?? sessionConfig.elfPath);
      if (result) {
        manualElfOverride = true;
        sessionConfig = {
          elfPath: result.elfPath,
          toolPath: result.toolPath || sessionConfig.toolPath,
          targetArch: result.targetArch || sessionConfig.targetArch,
          romElfPath: result.romElfPath || sessionConfig.romElfPath,
        };

        if (viewProvider) {
          viewProvider.updateConfig(sessionConfig);
        }

        const name = result.elfPath.split('/').pop()?.split('\\').pop();
        vscode.window.showInformationMessage(`ELF file selected: ${name}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('esp-decoder.clearOutput', () => {
      // This is handled by the webview
    })
  );

  // Auto-detect ELF on activation if configured
  const config = vscode.workspace.getConfiguration('esp-decoder');
  const manualElfPath = config.get<string>('elfPath', '');
  if (manualElfPath) {
    sessionConfig.elfPath = manualElfPath;
  }

  const manualToolPath = config.get<string>('toolPath', '');
  if (manualToolPath) {
    sessionConfig.toolPath = manualToolPath;
  }

  const targetArch = config.get<string>('targetArch', 'auto');
  if (targetArch !== 'auto') {
    sessionConfig.targetArch = targetArch;
  }

  // Watch for build events (PlatformIO + ESP-IDF)
  if (config.get<boolean>('autoDetectElf', true)) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/*.elf',
      false,
      false,
      true
    );

    watcher.onDidCreate((uri) => {
      if (isPlatformIoBuildElf(uri.fsPath)) {
        autoDetectFromPio(uri.fsPath);
      } else if (isEspIdfBuildElf(uri.fsPath)) {
        autoDetectFromEspIdf(uri.fsPath);
      }
    });

    watcher.onDidChange((uri) => {
      if (isPlatformIoBuildElf(uri.fsPath)) {
        autoDetectFromPio(uri.fsPath);
      } else if (isEspIdfBuildElf(uri.fsPath)) {
        autoDetectFromEspIdf(uri.fsPath);
      }
    });

    context.subscriptions.push(watcher);

    // Try auto-detect on activation
    tryAutoDetectElf();
  }

  // Re-sync webview when serial filter settings change.
  // Debounced to avoid multiple syncState() calls when saveFilters writes
  // several individual settings keys in quick succession.
  let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('esp-decoder.serialFilters') && viewProvider) {
        if (syncDebounceTimer !== null) { clearTimeout(syncDebounceTimer); }
        syncDebounceTimer = setTimeout(() => {
          syncDebounceTimer = null;
          viewProvider?.syncState();
        }, 50);
      }
    })
  );
}

function isPlatformIoBuildElf(elfPath: string): boolean {
  const normalized = path.normalize(elfPath);
  return normalized.includes(`${path.sep}.pio${path.sep}build${path.sep}`);
}

/**
 * Auto-detect ELF from newest PlatformIO or ESP-IDF build.
 */
async function tryAutoDetectElf(): Promise<void> {
  if (sessionConfig.elfPath || manualElfOverride) {
    return; // Already configured or user made a manual choice
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    return;
  }

  try {
    const envs = await findPioEnvironments(workspaceFolder);
    const idfBuilds = await findEspIdfBuilds(workspaceFolder);

    const candidates: Array<{ elfPath: string; toolPath?: string; targetArch?: string; romElfPath?: string }> = [
      ...envs,
      ...idfBuilds,
    ];

    if (candidates.length > 0) {
      let newest: { elfPath: string; toolPath?: string; targetArch?: string; romElfPath?: string } | undefined;
      let newestMtime = -1;
      for (const candidate of candidates) {
        try {
          const mtime = fs.statSync(candidate.elfPath).mtimeMs;
          if (mtime > newestMtime) {
            newest = candidate;
            newestMtime = mtime;
          }
        } catch {
          // ignore
        }
      }

      if (newest) {
        sessionConfig = {
          ...sessionConfig,
          elfPath: newest.elfPath,
          toolPath: sessionConfig.toolPath || newest.toolPath,
          targetArch: sessionConfig.targetArch || newest.targetArch,
          romElfPath: newest.romElfPath,
        };
        if (viewProvider) {
          viewProvider.updateConfig(sessionConfig);
        }
      }
    }
  } catch {
    // Auto-detect not available
  }
}

function autoDetectFromPio(elfPath: string): void {
  if (manualElfOverride || hasUserConfiguredSession()) {
    return; // User has manually selected an ELF — do not overwrite
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceFolder) {
    findPioEnvironments(workspaceFolder)
      .then((envs) => {
        const matched = envs.find((env) => env.elfPath === elfPath);
        if (matched) {
          sessionConfig = {
            ...sessionConfig,
            elfPath: matched.elfPath,
            toolPath: matched.toolPath,
            targetArch: matched.targetArch,
            romElfPath: matched.romElfPath,
          };
          if (viewProvider) {
            viewProvider.updateConfig(sessionConfig);
          }
        }
      })
      .catch(() => {
        // Ignore auto-detect failures.
      });
    return;
  }
}

function autoDetectFromEspIdf(elfPath: string): void {
  if (manualElfOverride || hasUserConfiguredSession()) {
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceFolder) {
    findEspIdfBuilds(workspaceFolder)
      .then((builds) => {
        const matched = builds.find((build) => build.elfPath === elfPath);
        if (matched) {
          sessionConfig = {
            ...sessionConfig,
            elfPath: matched.elfPath,
            toolPath: matched.toolPath,
            targetArch: matched.targetArch,
            romElfPath: undefined,
          };
          if (viewProvider) {
            viewProvider.updateConfig(sessionConfig);
          }
        }
      })
      .catch(() => {
        // Ignore auto-detect failures.
      });
    return;
  }
}

function hasUserConfiguredSession(): boolean {
  const config = vscode.workspace.getConfiguration('esp-decoder');
  return Boolean(config.get<string>('elfPath', ''))
    || Boolean(config.get<string>('toolPath', ''))
    || config.get<string>('targetArch', 'auto') !== 'auto';
}

function findEspIdfProjectRoot(elfPath: string, workspaceFolder: string): string | undefined {
  let currentDir = path.dirname(elfPath);
  const workspaceRoot = path.resolve(workspaceFolder);

  while (true) {
    const normalizedCurrent = path.resolve(currentDir);
    const relativeToWorkspace = path.relative(workspaceRoot, normalizedCurrent);
    if (relativeToWorkspace.startsWith('..') || path.isAbsolute(relativeToWorkspace)) {
      return undefined;
    }

    if (fs.existsSync(path.join(normalizedCurrent, 'sdkconfig'))) {
      return normalizedCurrent;
    }

    const parentDir = path.dirname(normalizedCurrent);
    if (parentDir === normalizedCurrent) {
      return undefined;
    }
    currentDir = parentDir;
  }
}

/**
 * Subscribe to pioarduino IDE upload lifecycle events.
 *
 * When pioarduino starts an upload (flash) we release the serial port so the
 * upload tool can access it.  Once the upload finishes we reconnect
 * automatically so monitoring can continue without user interaction.
 *
 * Optimisations over a naive approach:
 *  - waitUntil() barrier: pioarduino blocks the upload until we confirm the
 *    port has been released — no race condition.
 *  - Port-aware: we only release if ESP-Decoder is connected to the same port
 *    (or when pioarduino uses "Auto" which could resolve to any port).
 *  - Retry-based reacquire: instead of a fixed delay we try to reconnect
 *    immediately and retry with short back-off if the OS hasn't released the
 *    device yet.
 */
function subscribeToPioarduinoEvents(
  context: vscode.ExtensionContext,
  serial: SerialPortManager,
  log: vscode.OutputChannel,
): void {
  const pioExt = vscode.extensions.getExtension<PioarduinoApi>('pioarduino.pioarduino-ide');
  if (!pioExt) {
    log.appendLine('[ESP Decoder] pioarduino IDE extension not found — upload events unavailable');
    return;
  }

  const activate = pioExt.isActive
    ? Promise.resolve(pioExt.exports)
    : pioExt.activate();

  Promise.resolve(activate).then((api) => {
    if (!api?.onWillUpload || !api?.onDidUpload) {
      log.appendLine('[ESP Decoder] pioarduino IDE API does not expose upload events');
      return;
    }

    log.appendLine('[ESP Decoder] Subscribed to pioarduino upload lifecycle events');

    context.subscriptions.push(
      api.onWillUpload((event) => {
        const { port, waitUntil } = event;

        // Port-aware: only release when the upload targets the same port
        // (or "Auto"/undefined which could resolve to any port).
        // On macOS /dev/cu.* and /dev/tty.* refer to the same physical port.
        if (port && serial.selectedPath && !isSameSerialPort(port, serial.selectedPath)) {
          log.appendLine(
            `[ESP Decoder] onWillUpload: upload port (${port}) differs from monitored port (${serial.selectedPath}) — keeping connection`,
          );
          return;
        }

        log.appendLine(
          `[ESP Decoder] onWillUpload (port=${port ?? 'auto'}) — releasing serial port`,
        );

        // Tell pioarduino to wait until we have fully released the port.
        waitUntil(serial.releasePort());
      }),
    );

    context.subscriptions.push(
      api.onDidUpload(async ({ port, exitCode }) => {
        log.appendLine(
          `[ESP Decoder] onDidUpload (port=${port ?? 'auto'}, exitCode=${exitCode}) — reacquiring serial port`,
        );
        await reacquireWithRetry(serial, log);
      }),
    );
  }).catch((err) => {
    log.appendLine(`[ESP Decoder] Failed to subscribe to pioarduino events: ${err}`);
  });
}

/**
 * Try to reconnect to the serial port with a short back-off.
 * The OS may still hold the USB device for a moment after the upload tool exits.
 */
async function reacquireWithRetry(
  serial: SerialPortManager,
  log: vscode.OutputChannel,
  maxAttempts = 5,
  baseDelayMs = 300,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await serial.reacquirePort();
      log.appendLine(`[ESP Decoder] Serial port reacquired (attempt ${attempt})`);
      return;
    } catch {
      if (attempt === maxAttempts) {
        break;
      }
      const delay = baseDelayMs * attempt;
      log.appendLine(
        `[ESP Decoder] Reacquire attempt ${attempt}/${maxAttempts} failed — retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  log.appendLine('[ESP Decoder] Failed to reacquire serial port after all attempts');
}

/**
 * Compare two serial port paths accounting for macOS where /dev/cu.* and
 * /dev/tty.* refer to the same physical device.
 */
function isSameSerialPort(a: string, b: string): boolean {
  return normalizePortPath(a) === normalizePortPath(b);
}

function normalizePortPath(p: string): string {
  // macOS: /dev/cu.usbmodemXXX ↔ /dev/tty.usbmodemXXX
  // Lowercase for case-insensitive comparison (e.g. COM3 vs com3 on Windows).
  return p.replace(/^\/dev\/cu\./, '/dev/tty.').toLowerCase();
}

function isEspIdfBuildElf(elfPath: string): boolean {
  if (!elfPath.includes('/build/') && !elfPath.includes('\\build\\')) {
    return false;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    return false;
  }

  const projectRoot = findEspIdfProjectRoot(elfPath, workspaceFolder);
  if (!projectRoot) {
    return false;
  }

  const relative = path.relative(projectRoot, elfPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  const lower = elfPath.toLowerCase();
  return lower.endsWith('.elf') && !lower.endsWith('/bootloader.elf') && !lower.endsWith('/partition-table.elf') && !lower.endsWith('\\bootloader.elf') && !lower.endsWith('\\partition-table.elf');
}

export function deactivate(): void {
  viewProvider?.dispose();
}
