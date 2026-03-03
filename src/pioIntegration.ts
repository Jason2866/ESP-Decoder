import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as childProcess from 'child_process';

/**
 * Detected PlatformIO environment with ELF and tool paths.
 */
export interface PioEnvironment {
  name: string;
  elfPath: string;
  toolPath?: string;
  targetArch?: string;
}

/**
 * Find PlatformIO build environments in the workspace.
 */
export async function findPioEnvironments(workspaceFolder: string): Promise<PioEnvironment[]> {
  const envs: PioEnvironment[] = [];
  const pioBuildDir = path.join(workspaceFolder, '.pio', 'build');

  if (!fs.existsSync(pioBuildDir)) {
    return envs;
  }

  const entries = fs.readdirSync(pioBuildDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const envName = entry.name;
    const elfPath = path.join(pioBuildDir, envName, 'firmware.elf');

    if (fs.existsSync(elfPath)) {
      const env: PioEnvironment = {
        name: envName,
        elfPath,
      };

      // Try to detect arch and tool path from the environment
      const detected = await detectToolFromPioEnv(workspaceFolder, envName);
      if (detected) {
        env.toolPath = detected.toolPath;
        env.targetArch = detected.targetArch;
      }

      envs.push(env);
    }
  }

  return envs;
}

interface DetectedTool {
  toolPath: string;
  targetArch: string;
}

/**
 * Try to detect tool path and architecture from PlatformIO environment.
 */
async function detectToolFromPioEnv(
  workspaceFolder: string,
  envName: string
): Promise<DetectedTool | undefined> {
  // Check idedata for the environment
  const ideDataPath = path.join(workspaceFolder, '.pio', 'build', envName, 'idedata.json');
  if (fs.existsSync(ideDataPath)) {
    try {
      const ideData = JSON.parse(fs.readFileSync(ideDataPath, 'utf8'));
      if (ideData.cc_path) {
        const toolDir = path.dirname(ideData.cc_path);
        const toolPath = findGdbInDir(toolDir);
        if (toolPath) {
          const arch = detectArchFromToolPath(toolPath);
          return { toolPath, targetArch: arch };
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  // Fallback: scan PlatformIO packages for GDB tools
  const packagesDir = getPioPackagesDir();
  if (!packagesDir || !fs.existsSync(packagesDir)) {
    return undefined;
  }

  // Try to determine the platform from platformio.ini
  const platformIniPath = path.join(workspaceFolder, 'platformio.ini');
  if (!fs.existsSync(platformIniPath)) {
    return undefined;
  }

  const iniContent = fs.readFileSync(platformIniPath, 'utf8');
  const envSection = extractEnvSection(iniContent, envName);
  if (!envSection) {
    return undefined;
  }

  const framework = extractIniValue(envSection, 'framework');
  const board = extractIniValue(envSection, 'board');
  const platform = extractIniValue(envSection, 'platform');

  // Determine arch from board/platform
  const isRiscV = isRiscVBoard(board, platform);
  const targetArch = isRiscV ? 'riscv32' : 'xtensa';

  // Find GDB tool in packages
  const toolPath = await findGdbFromPackages(packagesDir, targetArch);
  if (toolPath) {
    return { toolPath, targetArch };
  }

  return undefined;
}

/**
 * Get PlatformIO packages directory.
 */
function getPioPackagesDir(): string | undefined {
  const homeDir = os.homedir();
  const candidates = [
    path.join(homeDir, '.platformio', 'packages'),
    path.join(homeDir, '.pioarduino', 'packages'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return undefined;
}

/**
 * Extract a section for a specific environment from platformio.ini
 */
function extractEnvSection(iniContent: string, envName: string): string | undefined {
  const sectionRegex = new RegExp(`\\[env:${escapeRegex(envName)}\\]([\\s\\S]*?)(?=\\[|$)`);
  const match = iniContent.match(sectionRegex);
  return match?.[1];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract a value from an INI section.
 */
function extractIniValue(section: string, key: string): string | undefined {
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm');
  const match = section.match(regex);
  return match?.[1]?.trim();
}

/**
 * Determine if a board is RISC-V based.
 */
function isRiscVBoard(board?: string, platform?: string): boolean {
  if (!board) {
    return false;
  }
  const riscvBoards = [
    'esp32c3',
    'esp32c6',
    'esp32h2',
    'esp32c2',
    'esp32c5',
    'esp32p4',
  ];
  const boardLower = board.toLowerCase();
  return riscvBoards.some((rb) => boardLower.includes(rb));
}

/**
 * Find GDB executable in a directory.
 */
function findGdbInDir(dir: string): string | undefined {
  if (!fs.existsSync(dir)) {
    return undefined;
  }

  try {
    const files = fs.readdirSync(dir);
    const gdbFile = files.find(
      (f) => f.includes('gdb') && !f.endsWith('.py') && !f.endsWith('.txt')
    );
    if (gdbFile) {
      return path.join(dir, gdbFile);
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Detect architecture from tool path name.
 */
function detectArchFromToolPath(toolPath: string): string {
  const name = path.basename(toolPath).toLowerCase();
  if (name.includes('riscv') || name.includes('risc-v')) {
    return 'riscv32';
  }
  return 'xtensa';
}

/**
 * Find GDB tool from PlatformIO packages directory.
 */
async function findGdbFromPackages(
  packagesDir: string,
  targetArch: string
): Promise<string | undefined> {
  try {
    const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const pkgName = entry.name.toLowerCase();
      const isToolchain =
        pkgName.includes('toolchain') &&
        (targetArch === 'riscv32'
          ? pkgName.includes('riscv') || pkgName.includes('risc-v')
          : pkgName.includes('xtensa') || pkgName.includes('esp'));

      if (!isToolchain) {
        continue;
      }

      const binDir = path.join(packagesDir, entry.name, 'bin');
      const toolPath = findGdbInDir(binDir);
      if (toolPath) {
        return toolPath;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Let user select a PIO environment or manually pick an ELF.
 */
export async function selectElfFile(
  workspaceFolder: string | undefined
): Promise<{ elfPath: string; toolPath?: string; targetArch?: string } | undefined> {
  const items: (vscode.QuickPickItem & {
    elfPath?: string;
    toolPath?: string;
    targetArch?: string;
    action?: string;
  })[] = [];

  // Auto-detect from PlatformIO
  if (workspaceFolder) {
    const envs = await findPioEnvironments(workspaceFolder);
    for (const env of envs) {
      items.push({
        label: `$(folder) ${env.name}`,
        description: env.elfPath,
        detail: env.targetArch
          ? `Arch: ${env.targetArch}${env.toolPath ? ' | Tool: ' + path.basename(env.toolPath) : ''}`
          : undefined,
        elfPath: env.elfPath,
        toolPath: env.toolPath,
        targetArch: env.targetArch,
      });
    }
  }

  // Manual selection option
  items.push({
    label: '$(file) Browse for ELF file...',
    description: 'Select ELF file manually',
    action: 'browse',
  });

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select PlatformIO environment or ELF file',
    title: 'TRBR: Select ELF File',
  });

  if (!picked) {
    return undefined;
  }

  if ((picked as any).action === 'browse') {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'ELF Files': ['elf'], 'All Files': ['*'] },
      title: 'Select ELF File',
    });
    if (uris && uris.length > 0) {
      return { elfPath: uris[0].fsPath };
    }
    return undefined;
  }

  return {
    elfPath: (picked as any).elfPath,
    toolPath: (picked as any).toolPath,
    targetArch: (picked as any).targetArch,
  };
}
