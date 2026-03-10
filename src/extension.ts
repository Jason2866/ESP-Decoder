import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SerialPortManager } from './serialPortManager';
import { EspDecoderWebviewPanel } from './webviewPanel';
import { findPioEnvironments, selectElfFile } from './pioIntegration';
import { findEspIdfBuilds } from './espIdfIntegration';

let serialManager: SerialPortManager;
let currentPanel: EspDecoderWebviewPanel | undefined;
let outputChannel: vscode.OutputChannel;

// Session state
let sessionConfig: {
  elfPath?: string;
  toolPath?: string;
  targetArch?: string;
  romElfPath?: string;
} = {};

// Tracks whether the user has manually picked an ELF file.
// When true, file-watcher auto-detection must not overwrite the selection.
let manualElfOverride = false;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('ESP Decoder');
  context.subscriptions.push(outputChannel);

  try {
    serialManager = new SerialPortManager();
  } catch (err) {
    outputChannel.appendLine(`FATAL: Failed to create SerialPortManager: ${err}`);
    vscode.window.showErrorMessage(`ESP Decoder: Failed to initialize serial port manager: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  context.subscriptions.push(serialManager);

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

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('esp-decoder.openMonitor', () => {
      currentPanel = EspDecoderWebviewPanel.createOrShow(
        context.extensionUri,
        serialManager,
        sessionConfig,
        outputChannel
      );
    })
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

      const result = await selectElfFile(workspaceFolder, currentPanel?.currentElfPath ?? sessionConfig.elfPath);
      if (result) {
        manualElfOverride = true;
        sessionConfig = {
          elfPath: result.elfPath,
          toolPath: result.toolPath || sessionConfig.toolPath,
          targetArch: result.targetArch || sessionConfig.targetArch,
          romElfPath: result.romElfPath || sessionConfig.romElfPath,
        };

        if (currentPanel) {
          currentPanel.updateConfig(sessionConfig);
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
      }
    }
  } catch {
    // Auto-detect not available
  }
}

function autoDetectFromPio(elfPath: string): void {
  if (manualElfOverride) {
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
          if (currentPanel) {
            currentPanel.updateConfig(sessionConfig);
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
  if (manualElfOverride) {
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
          if (currentPanel) {
            currentPanel.updateConfig(sessionConfig);
          }
        }
      })
      .catch(() => {
        // Ignore auto-detect failures.
      });
    return;
  }
}

function isEspIdfBuildElf(elfPath: string): boolean {
  if (!elfPath.includes('/build/') && !elfPath.includes('\\build\\')) {
    return false;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    return false;
  }

  const relative = path.relative(workspaceFolder, elfPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  if (!fs.existsSync(path.join(workspaceFolder, 'sdkconfig'))) {
    return false;
  }

  const lower = elfPath.toLowerCase();
  return lower.endsWith('.elf') && !lower.endsWith('/bootloader.elf') && !lower.endsWith('/partition-table.elf') && !lower.endsWith('\\bootloader.elf') && !lower.endsWith('\\partition-table.elf');
}

export function deactivate(): void {
  currentPanel?.dispose();
}
