import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { core as pioCore } from 'pioarduino-node-helpers';
import { findPioEnvironments } from './pioIntegration';
import { findEspIdfBuilds } from './espIdfIntegration';
import { SerialPortManager } from './serialPortManager';

export interface UploadResult {
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Last ~8 KB of combined stdout/stderr from the upload tool. */
  outputTail: string;
}

const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const TAIL_LIMIT_BYTES = 8 * 1024;

/** Task definition type — must match the `taskDefinitions` contribution. */
export const MCP_UPLOAD_TASK_TYPE = 'espDecoderMcpUpload';

let uploadInFlight = false;

/** Resolve the pio executable from the pioarduino penv, falling back to PATH. */
function findPioBinary(): string {
  try {
    const binDir = pioCore.getEnvBinDir();
    const candidate = path.join(binDir, process.platform === 'win32' ? 'pio.exe' : 'pio');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // fall through to PATH lookup
  }
  return 'pio';
}

/**
 * Resolve the upload command for the workspace: PlatformIO if platformio.ini
 * environments exist, otherwise ESP-IDF (idf.py flash).
 */
async function resolveUploadCommand(
  workspaceFolder: string,
  environment: string | undefined,
  uploadPort: string | undefined
): Promise<{ command: string; args: string[]; label: string }> {
  const pioEnvs = await findPioEnvironments(workspaceFolder);
  if (pioEnvs.length > 0) {
    let env = environment;
    if (!env) {
      if (pioEnvs.length === 1) {
        env = pioEnvs[0].name;
      } else {
        throw new Error(
          `Multiple PlatformIO environments found — specify one of: ${pioEnvs.map((e) => e.name).join(', ')}`
        );
      }
    } else if (!pioEnvs.some((e) => e.name === env)) {
      throw new Error(
        `Unknown PlatformIO environment '${env}' — available: ${pioEnvs.map((e) => e.name).join(', ')}`
      );
    }
    const args = ['run', '-e', env, '-t', 'upload'];
    if (uploadPort) {
      args.push('--upload-port', uploadPort);
    }
    return { command: findPioBinary(), args, label: `pio upload (${env})` };
  }

  const idfBuilds = await findEspIdfBuilds(workspaceFolder);
  if (idfBuilds.length > 0) {
    // idf.py must be on PATH (exported IDF environment).
    const args = ['flash'];
    if (uploadPort) {
      args.push('-p', uploadPort);
    }
    return { command: 'idf.py', args, label: 'idf.py flash' };
  }

  throw new Error(
    'No PlatformIO environments or ESP-IDF builds found in the workspace — build the project first'
  );
}

/**
 * Run the upload tool as a VS Code task whose Pseudoterminal wraps our own
 * child process: output is visible in the terminal UI *and* captured for the
 * tool result (a plain ShellExecution exposes no output programmatically).
 */
function executeUploadTask(
  command: string,
  args: string[],
  cwd: string,
  label: string
): Promise<{ exitCode: number | null; outputTail: string }> {
  return new Promise((resolve, reject) => {
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number>();
    let child: ChildProcess | undefined;
    let tail = '';
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const settle = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      closeEmitter.fire(exitCode ?? 1);
      resolve({ exitCode, outputTail: tail });
    };

    const appendOutput = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // Pseudoterminals require CRLF line endings.
      writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
      tail = (tail + text).slice(-TAIL_LIMIT_BYTES);
    };

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,
      open: () => {
        writeEmitter.fire(`${command} ${args.join(' ')}\r\n`);
        try {
          child = spawn(command, args, { cwd });
        } catch (err) {
          settled = true;
          reject(err);
          closeEmitter.fire(1);
          return;
        }
        child.stdout?.on('data', appendOutput);
        child.stderr?.on('data', appendOutput);
        child.on('error', (err) => {
          if (!settled) {
            settled = true;
            closeEmitter.fire(1);
            reject(err);
          }
        });
        child.on('close', (code) => settle(code));
        timeoutTimer = setTimeout(() => {
          tail += '\n[ESP Decoder] Upload timed out — killing process';
          child?.kill();
          settle(null);
        }, UPLOAD_TIMEOUT_MS);
      },
      close: () => {
        // Terminal closed by the user — kill the child; 'close' settles.
        child?.kill();
      },
    };

    const task = new vscode.Task(
      { type: MCP_UPLOAD_TASK_TYPE },
      vscode.TaskScope.Workspace,
      label,
      'ESP Decoder',
      new vscode.CustomExecution(async () => pty)
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      clear: true,
    };

    vscode.tasks.executeTask(task).then(undefined, (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/**
 * Upload firmware via PlatformIO or ESP-IDF, releasing the serial port for
 * the duration and reacquiring it afterwards (same flow as pioarduino's
 * onWillUpload/onDidUpload integration).
 */
export async function runUpload(
  serial: SerialPortManager,
  workspaceFolder: string,
  environment: string | undefined,
  log: vscode.OutputChannel
): Promise<UploadResult> {
  if (uploadInFlight) {
    throw new Error('An upload is already in progress');
  }
  const { command, args, label } = await resolveUploadCommand(
    workspaceFolder,
    environment,
    serial.selectedPath
  );

  uploadInFlight = true;
  const start = Date.now();
  try {
    log.appendLine(`[ESP Decoder] MCP upload: releasing serial port for ${label}`);
    await serial.releasePort();
    const { exitCode, outputTail } = await executeUploadTask(
      command,
      args,
      workspaceFolder,
      label
    );
    return {
      success: exitCode === 0,
      exitCode,
      durationMs: Date.now() - start,
      outputTail,
    };
  } finally {
    uploadInFlight = false;
    await reacquireWithRetry(serial, log);
  }
}

/**
 * Reconnect with a short back-off — the OS may still hold the USB device for
 * a moment after the upload tool exits (mirrors extension.ts).
 */
async function reacquireWithRetry(
  serial: SerialPortManager,
  log: vscode.OutputChannel,
  maxAttempts = 5,
  baseDelayMs = 300
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await serial.reacquirePort();
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        log.appendLine(`[ESP Decoder] MCP upload: failed to reacquire port: ${err}`);
        return;
      }
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
    }
  }
}
