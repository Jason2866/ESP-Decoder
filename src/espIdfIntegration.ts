import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chipArch, detectElfArch, ChipArch } from './chipTargets';

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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  // Prefer the tool dir matching the chip (esp32s3 -> xtensa-esp32s3-elf,
  // esp8266 -> xtensa-lx106-elf), then most specific match first.
  const chipHint = chipTarget === 'esp8266' ? 'lx106' : chipTarget;

  // 1. Search PATH. For Xtensa, a chip-matching binary anywhere on PATH wins;
  //    the generic xtensa-esp-elf-gdb is kept as a PATH fallback before the
  //    ESP-IDF tool directories are searched.
  const pathEnv = process.env.PATH;
  const ext = process.platform === 'win32' ? '.exe' : '';
  const chipGdb =
    arch === 'xtensa' && chipHint
      ? {
          names: [`xtensa-${chipHint}-elf-gdb${ext}`],
          pattern: new RegExp(`^xtensa-${escapeRegExp(chipHint)}-.*-gdb(\\.exe)?$`),
        }
      : undefined;
  if (pathEnv) {
    const dirs = pathEnv.split(path.delimiter).filter(Boolean);
    let fromPath: string | undefined;
    if (chipGdb) {
      fromPath =
        findGdbInDirs(dirs, chipGdb.names, chipGdb.pattern) ??
        // Exact-name fallback only; the pattern must not match other chips.
        findGdbInDirs(dirs, [`xtensa-esp-elf-gdb${ext}`], /$^/);
    } else {
      fromPath = findGdbInDirs(dirs, names, pattern);
    }
    if (fromPath) {
      return fromPath;
    }
  }

  // 2. Search ESP-IDF tool directories (~/.espressif/tools, $IDF_TOOLS_PATH/tools)
  const toolPrefix = arch === 'riscv' ? 'riscv32-esp-elf' : 'xtensa-';
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
      const binDirs = toolVersionBinDirs(versionDir);
      const gdb = chipGdb
        ? findGdbInDirs(binDirs, chipGdb.names, chipGdb.pattern) ??
          findGdbInDirs(binDirs, names, pattern)
        : findGdbInDirs(binDirs, names, pattern);
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
 * Classify an IDF target into an arch family. chipArch() maps the four
 * Xtensa targets to 'xtensa' and everything else (all RISC-V chips, known or
 * not) to 'riscv'.
 */
function idfTargetFamily(idfTarget: string | undefined): ChipArch | undefined {
  return idfTarget ? chipArch(idfTarget) : undefined;
}

export async function findEspIdfBuilds(workspaceFolder: string): Promise<EspIdfBuild[]> {
  const buildDir = path.join(workspaceFolder, 'build');
  const projectName = readProjectName(workspaceFolder);
  const idfTarget = parseIdfTarget(workspaceFolder);
  const elfCandidates = findElfCandidates(buildDir, projectName);
  // sdkconfig is authoritative when present; otherwise EACH firmware ELF's
  // e_machine decides its own arch and debugger lookup — candidates in one
  // build dir can mix architectures.
  const configuredFamily = idfTargetFamily(idfTarget);
  const toolPathByArch = new Map<string, string | undefined>();
  const gdbForArch = (arch: ChipArch | undefined): string | undefined => {
    const key = arch ?? 'unknown';
    if (!toolPathByArch.has(key)) {
      // Only pass the sdkconfig chip hint when its family agrees with the
      // requested arch — a stale sdkconfig must not direct the lookup to
      // the wrong GDB family.  When arch is unknown the hint is harmless.
      const chipHint = !arch || idfTargetFamily(idfTarget) === arch ? idfTarget : undefined;
      // Unknown arch: try Xtensa first (legacy default), then RISC-V — a
      // RISC-V-only ESP-IDF tool install must not be missed.
      let found = findGdbFromIdfTools(arch ?? 'xtensa', chipHint);
      if (!found && arch === undefined) {
        found = findGdbFromIdfTools('riscv', chipHint);
      }
      toolPathByArch.set(key, found);
    }
    return toolPathByArch.get(key);
  };
  return elfCandidates.map((elfPath, index) => {
    // The ELF header is authoritative: probe each file first. Fall back to
    // sdkconfig only when the probe fails (e.g. empty placeholder file).
    const targetArch = detectElfArch(elfPath) ?? configuredFamily;
    return {
      name: index === 0 ? 'ESP-IDF (build)' : `ESP-IDF (build:${path.basename(elfPath, '.elf')})`,
      elfPath,
      toolPath: gdbForArch(targetArch),
      targetArch,
    };
  });
}
