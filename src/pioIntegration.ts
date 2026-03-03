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
  // First, determine the target arch from platformio.ini board info
  let board: string | undefined;
  let platform: string | undefined;

  const platformIniPath = path.join(workspaceFolder, 'platformio.ini');
  if (fs.existsSync(platformIniPath)) {
    const iniContent = fs.readFileSync(platformIniPath, 'utf8');
    const envSection = extractEnvSection(iniContent, envName);
    if (envSection) {
      board = extractIniValue(envSection, 'board');
      platform = extractIniValue(envSection, 'platform');
    }
  }

  // Determine target arch from board JSON (MCU) or board/env name
  const targetArch = getChipTarget(board || envName, workspaceFolder);
  const isRiscV = isRiscVArch(targetArch);

  // Check idedata for the environment — but validate tool matches expected arch
  const ideDataPath = path.join(workspaceFolder, '.pio', 'build', envName, 'idedata.json');
  if (fs.existsSync(ideDataPath)) {
    try {
      const ideData = JSON.parse(fs.readFileSync(ideDataPath, 'utf8'));
      if (ideData.cc_path) {
        const toolDir = path.dirname(ideData.cc_path);
        const toolPath = findGdbInDir(toolDir);
        if (toolPath) {
          const toolIsRiscV = /riscv|risc-v/i.test(path.basename(toolPath));
          // Only use this tool if it matches the expected arch
          if (toolIsRiscV === isRiscV) {
            return { toolPath, targetArch };
          }
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

  // Find GDB tool in packages matching the target arch
  const toolPath = await findGdbFromPackages(packagesDir, targetArch);
  if (toolPath) {
    return { toolPath, targetArch };
  }

  return undefined;
}

/**
 * Get PlatformIO core directory (~/.platformio or ~/.pioarduino).
 */
function getPioCoreDir(): string | undefined {
  const homeDir = os.homedir();
  const candidates = [
    path.join(homeDir, '.platformio'),
    path.join(homeDir, '.pioarduino'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return undefined;
}

/**
 * Get PlatformIO packages directory.
 */
function getPioPackagesDir(): string | undefined {
  const coreDir = getPioCoreDir();
  if (!coreDir) {
    return undefined;
  }
  const packagesDir = path.join(coreDir, 'packages');
  return fs.existsSync(packagesDir) ? packagesDir : undefined;
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
 * Map of chip key → trbr target arch.
 * Keys are sorted longest-first during lookup so "esp32s3" isn't confused with "esp32".
 */
const CHIP_TARGET_MAP: Record<string, string> = {
  'esp32s3': 'xtensa',
  'esp32s2': 'xtensa',
  'esp32c2': 'esp32c2',
  'esp32c3': 'esp32c3',
  'esp32c5': 'esp32c3',  // no dedicated trbr target, closest match
  'esp32c6': 'esp32c6',
  'esp32h2': 'esp32h2',
  'esp32h4': 'esp32h4',
  'esp32p4': 'esp32p4',
  'esp8266': 'xtensa',
  'esp32':   'xtensa',
};

const RISCV_TARGETS = new Set(['esp32c2', 'esp32c3', 'esp32c5', 'esp32c6', 'esp32h2', 'esp32h4', 'esp32p4']);

/**
 * Determine the chip name (trbr target arch) from a board name by reading its
 * board JSON from PlatformIO's boards directories.
 *
 * Falls back to matching against the board/env name directly.
 * Longest chip keys are compared first so that "esp32s3" is not confused with "esp32".
 */
function getChipTarget(boardName: string | undefined, workspaceFolder?: string): string {
  const sortedKeys = Object.keys(CHIP_TARGET_MAP).sort((a, b) => b.length - a.length);

  // Try reading MCU from board JSON
  if (boardName) {
    const mcu = readBoardMcu(boardName, workspaceFolder);
    if (mcu) {
      const mcuNorm = mcu.toLowerCase().replace(/[-_]/g, '');
      for (const key of sortedKeys) {
        if (mcuNorm.includes(key)) {
          return CHIP_TARGET_MAP[key];
        }
      }
    }

    // Fallback: match against the board name itself
    const boardNorm = boardName.toLowerCase().replace(/[-_]/g, '');
    for (const key of sortedKeys) {
      if (boardNorm.includes(key)) {
        return CHIP_TARGET_MAP[key];
      }
    }
  }

  return 'xtensa'; // default to esp32 (xtensa)
}

/**
 * Read the build.mcu field from a PlatformIO board JSON file.
 * Searches project boards_dir, then PlatformIO core boards directory.
 */
function readBoardMcu(boardName: string, workspaceFolder?: string): string | undefined {
  const boardsDirs: string[] = [];

  // Project-local boards directory
  if (workspaceFolder) {
    boardsDirs.push(path.join(workspaceFolder, 'boards'));
  }

  // PlatformIO/pioarduino core boards directory
  const coreDir = getPioCoreDir();
  if (coreDir) {
    boardsDirs.push(path.join(coreDir, 'boards'));
    // Also check inside platforms for board definitions
    const platformsDir = path.join(coreDir, 'platforms');
    if (fs.existsSync(platformsDir)) {
      try {
        for (const plat of fs.readdirSync(platformsDir, { withFileTypes: true })) {
          if (plat.isDirectory()) {
            boardsDirs.push(path.join(platformsDir, plat.name, 'boards'));
          }
        }
      } catch {
        // ignore
      }
    }
  }

  for (const dir of boardsDirs) {
    const boardJson = path.join(dir, boardName + '.json');
    if (fs.existsSync(boardJson)) {
      try {
        const data = JSON.parse(fs.readFileSync(boardJson, 'utf8'));
        const mcu = data?.build?.mcu;
        if (typeof mcu === 'string' && mcu) {
          return mcu;
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  return undefined;
}

/**
 * Check if a trbr target arch is RISC-V.
 */
function isRiscVArch(targetArch: string): boolean {
  return RISCV_TARGETS.has(targetArch);
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
      const isRiscV = targetArch !== 'xtensa';
      const isToolchain =
        pkgName.includes('toolchain') &&
        (isRiscV
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
    title: 'ESP Decoder: Select ELF File',
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
