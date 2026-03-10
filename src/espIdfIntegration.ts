import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface EspIdfBuild {
  name: string;
  elfPath: string;
  toolPath?: string;
  targetArch?: string;
}

const CHIP_TARGET_MAP: Record<string, string> = {
  esp32: 'xtensa',
  esp32s2: 'xtensa',
  esp32s3: 'xtensa',
  esp32c2: 'esp32c2',
  esp32c3: 'esp32c3',
  esp32c5: 'esp32c3',
  esp32c6: 'esp32c6',
  esp32h2: 'esp32h2',
  esp32h4: 'esp32h4',
  esp32p4: 'esp32p4',
};

const XTENSA_CHIPS = new Set(['esp32', 'esp32s2', 'esp32s3']);

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

function findExecutableInPath(names: string[]): string | undefined {
  const pathEnv = process.env.PATH;
  if (!pathEnv) {
    return undefined;
  }

  const ext = process.platform === 'win32' ? '.exe' : '';
  const dirs = pathEnv.split(path.delimiter);

  for (const dir of dirs) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(dir, name + ext);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
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

function findGdbFromIdfTools(chipTarget: string | undefined): string | undefined {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const isXtensa = chipTarget ? XTENSA_CHIPS.has(chipTarget) : false;

  const preferredNames = isXtensa
    ? ['xtensa-esp-elf-gdb', 'xtensa-esp32-elf-gdb', 'xtensa-esp32s2-elf-gdb', 'xtensa-esp32s3-elf-gdb']
    : ['riscv32-esp-elf-gdb'];

  const fromPath = findExecutableInPath(preferredNames);
  if (fromPath) {
    return fromPath;
  }

  const roots = gatherToolRoots();
  for (const toolsRoot of roots) {
    if (!fs.existsSync(toolsRoot)) {
      continue;
    }

    const toolPrefixes = isXtensa
      ? ['xtensa-esp-elf-gdb', 'xtensa-esp32-elf', 'xtensa-esp32s2-elf', 'xtensa-esp32s3-elf']
      : ['riscv32-esp-elf'];

    for (const prefix of toolPrefixes) {
      const toolDir = path.join(toolsRoot, prefix);
      if (!fs.existsSync(toolDir)) {
        continue;
      }

      const newestVersionDir = findNewestVersionDir(toolDir);
      if (!newestVersionDir) {
        continue;
      }

      for (const name of preferredNames) {
        const directBin = path.join(newestVersionDir, 'bin', `${name}${ext}`);
        if (fs.existsSync(directBin)) {
          return directBin;
        }

        const nestedBin = path.join(newestVersionDir, prefix, 'bin', `${name}${ext}`);
        if (fs.existsSync(nestedBin)) {
          return nestedBin;
        }
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

export async function findEspIdfBuilds(workspaceFolder: string): Promise<EspIdfBuild[]> {
  const buildDir = path.join(workspaceFolder, 'build');
  const projectName = readProjectName(workspaceFolder);
  const idfTarget = parseIdfTarget(workspaceFolder);
  const targetArch = idfTarget ? CHIP_TARGET_MAP[idfTarget] ?? (XTENSA_CHIPS.has(idfTarget) ? 'xtensa' : undefined) : undefined;
  const toolPath = findGdbFromIdfTools(idfTarget);

  const elfCandidates = findElfCandidates(buildDir, projectName);
  return elfCandidates.map((elfPath, index) => ({
    name: index === 0 ? 'ESP-IDF (build)' : `ESP-IDF (build:${path.basename(elfPath, '.elf')})`,
    elfPath,
    toolPath,
    targetArch,
  }));
}
