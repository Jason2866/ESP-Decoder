import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CHIP_TARGET_MAP, ChipArch } from './chipTargets';

export interface EspIdfBuild {
  name: string;
  elfPath: string;
  toolPath?: string;
  targetArch?: string;
}

function parseIdfTarget(workspaceFolder: string): string | undefined {
  const sdkconfigPath = path.join(workspaceFolder, 'sdkconfig');
  if (!fs.existsSync(sdkconfigPath)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(sdkconfigPath, 'utf8');
    const match = content.match(/^CONFIG_IDF_TARGET\s*=\s*"?([a-zA-Z0-9_]+)"?/m);
    if (!match?.[1]) {
      return undefined;
    }
    return match[1].toLowerCase();
  } catch {
    return undefined;
  }
}

function readProjectName(workspaceFolder: string): string | undefined {
  const candidates = [
    path.join(workspaceFolder, 'CMakeLists.txt'),
    path.join(workspaceFolder, 'main', 'CMakeLists.txt'),
  ];

  for (const cmakePath of candidates) {
    if (!fs.existsSync(cmakePath)) {
      continue;
    }
    try {
      const content = fs.readFileSync(cmakePath, 'utf8');
      const match = content.match(/project\s*\(\s*([^)\s]+)\s*\)/i);
      if (match?.[1]) {
        return match[1].trim();
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}

function gatherToolRoots(): string[] {
  const roots: string[] = [];

  if (process.env.IDF_TOOLS_PATH) {
    roots.push(path.join(process.env.IDF_TOOLS_PATH, 'tools'));
  }

  roots.push(path.join(os.homedir(), '.espressif', 'tools'));

  return roots;
}

function findNewestVersionDir(parentDir: string): string | undefined {
  try {
    const dirs = fs
      .readdirSync(parentDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    if (dirs.length === 0) {
      return undefined;
    }
    return path.join(parentDir, dirs[0]);
  } catch {
    return undefined;
  }
}

/**
 * GDB binary name patterns per architecture family, mirroring how
 * esp-idf-panic-decoder resolves the toolchain prefix: only the arch family
 * matters, not the specific MCU.
 */
function gdbMatcher(arch: ChipArch): { names: string[]; pattern: RegExp } {
  const ext = process.platform === 'win32' ? '.exe' : '';
  if (arch === 'riscv') {
    return {
      names: [`riscv32-esp-elf-gdb${ext}`],
      pattern: /^riscv32-esp-elf-gdb(\.exe)?$/,
    };
  }
  return {
    names: [`xtensa-esp-elf-gdb${ext}`],
    pattern: /^xtensa-[a-z0-9]+-elf-gdb(\.exe)?$/,
  };
}

/**
 * Find a GDB binary in a list of directories. Preferred names are tried
 * first across all dirs, then any name matching the arch pattern.
 */
function findGdbInDirs(dirs: string[], names: string[], pattern: RegExp): string | undefined {
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  for (const dir of dirs) {
    try {
      const match = fs
        .readdirSync(dir)
        .filter((entry) => pattern.test(entry))
        .sort()[0];
      if (match) {
        return path.join(dir, match);
      }
    } catch {
      // dir missing or unreadable
    }
  }
  return undefined;
}

/**
 * Collect bin directories inside an ESP-IDF tool version directory.
 * Layouts vary: <ver>/bin/<tool>, <ver>/<tool>/bin/<tool>, or deeper nesting.
 */
function toolVersionBinDirs(versionDir: string): string[] {
  const dirs = [path.join(versionDir, 'bin')];
  try {
    for (const entry of fs.readdirSync(versionDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        dirs.push(path.join(versionDir, entry.name, 'bin'));
      }
    }
  } catch {
    // ignore
  }
  return dirs;
}

function findGdbFromIdfTools(arch: ChipArch, chipTarget: string | undefined): string | undefined {
  const { names, pattern } = gdbMatcher(arch);

  // 1. Search PATH
  const pathEnv = process.env.PATH;
  if (pathEnv) {
    const dirs = pathEnv.split(path.delimiter).filter(Boolean);
    const fromPath = findGdbInDirs(dirs, names, pattern);
    if (fromPath) {
      return fromPath;
    }
  }

  // 2. Search ESP-IDF tool directories (~/.espressif/tools, $IDF_TOOLS_PATH/tools)
  const toolPrefix = arch === 'riscv' ? 'riscv32-esp-elf' : 'xtensa-';
  // Prefer the tool dir matching the chip (esp32s3 -> xtensa-esp32s3-elf,
  // esp8266 -> xtensa-lx106-elf), then most specific match first.
  const chipHint = chipTarget === 'esp8266' ? 'lx106' : chipTarget;
  const scoreTool = (name: string): number => {
    if (!chipHint) {
      return 0;
    }
    return name.includes(`${chipHint}-`) || name.includes(`-${chipHint}`) ? 0 : 1;
  };

  for (const toolsRoot of gatherToolRoots()) {
    if (!fs.existsSync(toolsRoot)) {
      continue;
    }

    let toolDirs: string[];
    try {
      toolDirs = fs
        .readdirSync(toolsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith(toolPrefix))
        .map((d) => d.name)
        .sort((a, b) => scoreTool(a) - scoreTool(b) || a.localeCompare(b));
    } catch {
      continue;
    }

    for (const toolName of toolDirs) {
      const versionDir = findNewestVersionDir(path.join(toolsRoot, toolName));
      if (!versionDir) {
        continue;
      }
      const gdb = findGdbInDirs(toolVersionBinDirs(versionDir), names, pattern);
      if (gdb) {
        return gdb;
      }
    }
  }

  return undefined;
}

function findElfCandidates(buildDir: string, projectName?: string): string[] {
  if (!fs.existsSync(buildDir)) {
    return [];
  }

  const excluded = new Set(['bootloader.elf', 'partition-table.elf']);
  const candidates: string[] = [];

  try {
    const entries = fs.readdirSync(buildDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.elf')) {
        continue;
      }
      if (excluded.has(entry.name)) {
        continue;
      }
      candidates.push(path.join(buildDir, entry.name));
    }
  } catch {
    return [];
  }

  if (projectName) {
    const preferred = path.join(buildDir, `${projectName}.elf`);
    if (candidates.includes(preferred)) {
      return [preferred, ...candidates.filter((c) => c !== preferred)];
    }
  }

  return candidates;
}

/**
 * ESP-IDF's Xtensa targets are a closed set; any other esp32* IDF target is
 * RISC-V. Used when CHIP_TARGET_MAP has no entry for the sdkconfig target.
 */
const XTENSA_IDF_TARGETS = new Set(['esp32', 'esp32s2', 'esp32s3', 'esp8266']);

function idfTargetFamily(idfTarget: string | undefined): ChipArch | undefined {
  if (!idfTarget) {
    return undefined;
  }
  return CHIP_TARGET_MAP[idfTarget] ?? (XTENSA_IDF_TARGETS.has(idfTarget) ? 'xtensa' : 'riscv');
}

export async function findEspIdfBuilds(workspaceFolder: string): Promise<EspIdfBuild[]> {
  const buildDir = path.join(workspaceFolder, 'build');
  const projectName = readProjectName(workspaceFolder);
  const idfTarget = parseIdfTarget(workspaceFolder);
  const targetArch = idfTargetFamily(idfTarget);
  const toolPath = findGdbFromIdfTools(targetArch ?? 'xtensa', idfTarget);

  const elfCandidates = findElfCandidates(buildDir, projectName);
  return elfCandidates.map((elfPath, index) => ({
    name: index === 0 ? 'ESP-IDF (build)' : `ESP-IDF (build:${path.basename(elfPath, '.elf')})`,
    elfPath,
    toolPath,
    targetArch,
  }));
}
