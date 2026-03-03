import * as vscode from 'vscode';
import { SerialPortManager } from './serialPortManager';
import { TrbrWebviewPanel } from './webviewPanel';
import { selectElfFile } from './pioIntegration';

let serialManager: SerialPortManager;
let currentPanel: TrbrWebviewPanel | undefined;

// Session state
let sessionConfig: {
  elfPath?: string;
  toolPath?: string;
  targetArch?: string;
} = {};

export function activate(context: vscode.ExtensionContext) {
  serialManager = new SerialPortManager();
  context.subscriptions.push(serialManager);

  // Status bar items
  const statusBarPort = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarPort.command = 'esp-decoder.selectPort';
  statusBarPort.text = '$(plug) ESP: No Port';
  statusBarPort.tooltip = 'Select serial port for ESP Decoder';
  statusBarPort.show();
  context.subscriptions.push(statusBarPort);

  const statusBarConnection = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99
  );
  statusBarConnection.command = 'trbr.connect';
  statusBarConnection.text = '$(circle-slash) Disconnected';
  statusBarConnection.tooltip = 'Connect/Disconnect serial port';
  statusBarConnection.show();
  context.subscriptions.push(statusBarConnection);

  // Update status bar on connection changes
  serialManager.onConnectionChange((connected) => {
    if (connected) {
      statusBarConnection.text = '$(check) Connected';
      statusBarConnection.command = 'esp-decoder.disconnect';
      statusBarPort.text = `$(plug) ${serialManager.selectedPath || 'ESP'}`;
    } else {
      statusBarConnection.text = '$(circle-slash) Disconnected';
      statusBarConnection.command = 'esp-decoder.connect';
    }
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('esp-decoder.openMonitor', () => {
      currentPanel = TrbrWebviewPanel.createOrShow(
        context.extensionUri,
        serialManager,
        sessionConfig
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('esp-decoder.selectPort', async () => {
      const port = await serialManager.selectPort();
      if (port) {
        statusBarPort.text = `$(plug) ${port}`;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('esp-decoder.selectBaudRate', async () => {
      await serialManager.selectBaudRate();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('esp-decoder.connect', async () => {
      const success = await serialManager.connect();
      if (success) {
        vscode.window.showInformationMessage(
          `Connected to ${serialManager.selectedPath} @ ${serialManager.baudRate}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('esp-decoder.disconnect', async () => {
      await serialManager.disconnect();
      vscode.window.showInformationMessage('Serial port disconnected');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('esp-decoder.selectElfFile', async () => {
      const workspaceFolder =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const result = await selectElfFile(workspaceFolder);
      if (result) {
        sessionConfig = {
          elfPath: result.elfPath,
          toolPath: result.toolPath || sessionConfig.toolPath,
          targetArch: result.targetArch || sessionConfig.targetArch,
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

  console.log('ESP Decoder extension activated');
}

/**
 * Auto-detect ELF from newest PlatformIO build.
 */
async function tryAutoDetectElf(): Promise<void> {
  if (sessionConfig.elfPath) {
    return; // Already configured
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
      };
    }
  } catch {
    // PlatformIO not available, no auto-detect
  }
}

function autoDetectFromPio(elfPath: string): void {
  sessionConfig.elfPath = elfPath;
  if (currentPanel) {
    currentPanel.updateConfig(sessionConfig);
  }
}

export function deactivate(): void {
  currentPanel?.dispose();
}
