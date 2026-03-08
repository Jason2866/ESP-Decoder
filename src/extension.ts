import * as vscode from 'vscode';
import { SerialPortManager } from './serialPortManager';
import { EspDecoderWebviewPanel } from './webviewPanel';
import { selectElfFile } from './pioIntegration';

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

  // Watch for PlatformIO build events (when firmware.elf changes)
  if (config.get<boolean>('autoDetectElf', true)) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/firmware.elf',
      false,
      false,
      true
    );

    watcher.onDidCreate((uri) => {
      if (uri.fsPath.includes('.pio')) {
        autoDetectFromPio(uri.fsPath);
      }
    });

    watcher.onDidChange((uri) => {
      if (uri.fsPath.includes('.pio')) {
        autoDetectFromPio(uri.fsPath);
      }
    });

    context.subscriptions.push(watcher);

    // Try auto-detect on activation
    tryAutoDetectElf();
  }
}

/**
 * Auto-detect ELF from newest PlatformIO build.
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
    const { findPioEnvironments } = await import('./pioIntegration');
    const envs = await findPioEnvironments(workspaceFolder);
    if (envs.length === 1) {
      // Only one env, auto-select
      sessionConfig = {
        elfPath: envs[0].elfPath,
        toolPath: envs[0].toolPath,
        targetArch: envs[0].targetArch,
        romElfPath: envs[0].romElfPath,
      };
    } else if (envs.length > 1) {
      // Multiple envs, pick the newest one
      let newest = envs[0];
      for (const env of envs) {
        try {
          const fs = await import('fs');
          const stat = fs.statSync(env.elfPath);
          const newestStat = fs.statSync(newest.elfPath);
          if (stat.mtimeMs > newestStat.mtimeMs) {
            newest = env;
          }
        } catch {
          // ignore
        }
      }
      sessionConfig = {
        elfPath: newest.elfPath,
        toolPath: newest.toolPath,
        targetArch: newest.targetArch,
        romElfPath: newest.romElfPath,
      };
    }
  } catch {
    // PlatformIO not available, no auto-detect
  }
}

function autoDetectFromPio(elfPath: string): void {
  if (manualElfOverride) {
    return; // User has manually selected an ELF — do not overwrite
  }
  sessionConfig.elfPath = elfPath;
  if (currentPanel) {
    currentPanel.updateConfig(sessionConfig);
  }
}

export function deactivate(): void {
  currentPanel?.dispose();
}
