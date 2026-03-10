import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/**
 * Detected PlatformIO environment with ELF and tool paths.
 */
export interface PioEnvironment {
  name: string;
  elfPath: string;
  toolPath?: string;
  targetArch?: string;
  romElfPath?: string;
}

// ---------------------------------------------------------------------------
// PlatformIO INI parsing (ported from esp-exception-decoder)
// ---------------------------------------------------------------------------

type Sections = Record<string, Record<string, string>>;

/** Minimal INI parser for platformio.ini (handles multi-line values) */
function parsePlatformioIni(content: string): Sections {
  const sections: Sections = {};
  let currentSection: string | undefined;
  let lastKey: string | undefined;
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue;
    }
    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      sections[currentSection] = sections[currentSection] ?? {};
      lastKey = undefined;
      continue;
    }
    if (currentSection) {
      // Continuation line: starts with whitespace
      if (lastKey && /^\s/.test(rawLine) && !/^\S/.test(rawLine)) {
        sections[currentSection][lastKey] += '\n' + trimmed;
        continue;
      }
      const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();
        sections[currentSection][key] = value;
        lastKey = key;
      }
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// extra_configs handling
// ---------------------------------------------------------------------------

function mergeSections(target: Sections, source: Sections): void {
  for (const [sectionName, props] of Object.entries(source)) {
    if (!target[sectionName]) {
      target[sectionName] = {};
    }
    Object.assign(target[sectionName], props);
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${withWildcards}$`);
}

function isGlobPattern(value: string): boolean {
  return /[*?\[\]]/.test(value);
}

function resolveExtraConfigPaths(projectPath: string, rawEntries: string[]): string[] {
  const resolved: string[] = [];
  for (const entry of rawEntries) {
    if (!entry) {
      continue;
    }
    if (isGlobPattern(entry)) {
      const globDir = path.resolve(projectPath, path.dirname(entry));
      const globBase = path.basename(entry);
      const regex = globToRegex(globBase);
      try {
        const dirEntries = fs.readdirSync(globDir);
        for (const name of dirEntries.sort()) {
          if (regex.test(name)) {
            resolved.push(path.join(globDir, name));
          }
        }
      } catch {
        // ignore
      }
    } else {
      resolved.push(path.resolve(projectPath, entry));
    }
  }
  return resolved;
}

function parseExtraConfigsValue(value: string): string[] {
  return value
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function mergeExtraConfigs(projectPath: string, sections: Sections): void {
  const pioSection = sections['platformio'];
  if (!pioSection?.['extra_configs']) {
    return;
  }

  const rawEntries = parseExtraConfigsValue(pioSection['extra_configs']);
  const configPaths = resolveExtraConfigPaths(projectPath, rawEntries);

  for (const configPath of configPaths) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const extraSections = parsePlatformioIni(content);
      mergeSections(sections, extraSections);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// ${section.key} variable interpolation
// ---------------------------------------------------------------------------

const MAX_INTERPOLATION_DEPTH = 10;

function interpolateVariables(sections: Sections): void {
  const variablePattern = /\$\{([^}]+)\}/g;

  function resolve(value: string, depth: number, visited: Set<string>): string {
    if (depth > MAX_INTERPOLATION_DEPTH) {
      return value;
    }
    return value.replace(variablePattern, (match, ref: string) => {
      const dotIndex = ref.indexOf('.');
      if (dotIndex < 0) {
        return match;
      }
      const sectionName = ref.slice(0, dotIndex);
      const keyName = ref.slice(dotIndex + 1);
      const refKey = `${sectionName}.${keyName}`;
      if (visited.has(refKey)) {
        return match;
      }
      const section = sections[sectionName];
      if (!section || !(keyName in section)) {
        return match;
      }
      visited.add(refKey);
      return resolve(section[keyName], depth + 1, new Set(visited));
    });
  }

  for (const props of Object.values(sections)) {
    for (const [key, value] of Object.entries(props)) {
      if (value.includes('${')) {
        props[key] = resolve(value, 0, new Set());
      }
    }
  }
}

// ---------------------------------------------------------------------------
// extends handling
// ---------------------------------------------------------------------------

function resolveExtends(
  sectionName: string,
  sections: Sections,
  visited = new Set<string>()
): Record<string, string> {
  if (visited.has(sectionName)) {
    return {};
  }
  visited.add(sectionName);

  const section = sections[sectionName];
  if (!section) {
    return {};
  }

  let result: Record<string, string> = {};
  const extendsValue = section['extends'];
  if (extendsValue) {
    const parents = extendsValue.split(',').map((s) => s.trim());
    for (const parent of parents) {
      result = { ...result, ...resolveExtends(parent, sections, visited) };
    }
  }
  return { ...result, ...section };
}

// ---------------------------------------------------------------------------
// Environment parsing
// ---------------------------------------------------------------------------

interface ParsedEnv {
  name: string;
  board: string;
  platform: string;
}

function parseEnvironments(sections: Sections): ParsedEnv[] {
  const baseEnv = sections['env'] ?? {};
  const envs: ParsedEnv[] = [];
  let hasNamedEnvs = false;

  for (const [sectionName] of Object.entries(sections)) {
    if (!sectionName.startsWith('env:')) {
      continue;
    }
    hasNamedEnvs = true;
    const envName = sectionName.slice(4);
    const resolved = resolveExtends(sectionName, sections);
    const merged = { ...baseEnv, ...resolved };
    const platform = merged['platform'] ?? '';
    const board = merged['board'] ?? '';
    if (!board) {
      continue;
    }
    envs.push({ name: envName, platform, board });
  }

  if (!hasNamedEnvs && baseEnv['board']) {
    envs.push({
      name: 'default',
      platform: baseEnv['platform'] ?? '',
      board: baseEnv['board'],
    });
  }

  return envs;
}

// ---------------------------------------------------------------------------
// Full INI parsing pipeline: parse → extra_configs → interpolate → envs
// ---------------------------------------------------------------------------

function parsePioProject(workspaceFolder: string): ParsedEnv[] {
  const platformIniPath = path.join(workspaceFolder, 'platformio.ini');
  if (!fs.existsSync(platformIniPath)) {
    return [];
  }

  const content = fs.readFileSync(platformIniPath, 'utf8');
  const sections = parsePlatformioIni(content);
  mergeExtraConfigs(workspaceFolder, sections);
  interpolateVariables(sections);
  return parseEnvironments(sections);
}

// ---------------------------------------------------------------------------
// Chip / architecture detection
// ---------------------------------------------------------------------------

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
 * Get the raw chip name (e.g. "esp32c3") from a board.
 * Used for ROM ELF lookup. Sorted by key length descending so
 * "esp32s3" matches before "esp32".
 */
function getChipName(boardName: string | undefined, workspaceFolder?: string): string {
  const sortedKeys = Object.keys(CHIP_TARGET_MAP).sort((a, b) => b.length - a.length);

  if (boardName) {
    const mcu = readBoardMcu(boardName, workspaceFolder);
    if (mcu) {
      const mcuNorm = mcu.toLowerCase().replace(/[-_]/g, '');
      for (const key of sortedKeys) {
        if (mcuNorm.includes(key)) {
          return key;
        }
      }
    }
  }
  return 'esp32';
}

/**
 * Find ROM ELF file for a given chip from PlatformIO's tool-esp-rom-elfs package.
 * Mirrors filter_exception_decoder.py's find_rom_elf() logic.
 */
function findRomElf(packagesDir: string, chipName: string): string | undefined {
  const romElfsDir = path.join(packagesDir, 'tool-esp-rom-elfs');
  if (!fs.existsSync(romElfsDir)) {
    return undefined;
  }

  try {
    const entries = fs.readdirSync(romElfsDir);
    const patterns = [
      new RegExp(`^${chipName}_rev\\d+_rom\\.elf$`),
      new RegExp(`^${chipName}_rev\\d+\\.elf$`),
      new RegExp(`^${chipName}.*_rom\\.elf$`),
      new RegExp(`^${chipName}.*\\.elf$`),
    ];

    const matches: string[] = [];
    for (const pattern of patterns) {
      for (const entry of entries) {
        if (pattern.test(entry) && !matches.includes(entry)) {
          matches.push(entry);
        }
      }
    }

    if (matches.length === 0) {
      return undefined;
    }

    // Sort by revision number (lowest first for max compatibility)
    matches.sort((a, b) => {
      const revA = a.match(/_rev(\d+)/);
      const revB = b.match(/_rev(\d+)/);
      return (revA ? parseInt(revA[1]) : 1e9) - (revB ? parseInt(revB[1]) : 1e9);
    });

    return path.join(romElfsDir, matches[0]);
  } catch {
    return undefined;
  }
}

/**
 * Determine the chip name (trbr target arch) from a board name by reading its
 * board JSON from PlatformIO's boards directories.
 *
 * Longest chip keys are compared first so that "esp32s3" is not confused with "esp32".
 */
function getChipTarget(boardName: string | undefined, workspaceFolder?: string): string {
  const chipName = getChipName(boardName, workspaceFolder);
  return CHIP_TARGET_MAP[chipName] ?? 'xtensa';
}

function getPioCoreDir(): string | undefined {
  const homeDir = os.homedir();
  const candidates = [path.join(homeDir, '.platformio')];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return undefined;
}

export function getPioPackagesDir(): string | undefined {
  const coreDir = getPioCoreDir();
  if (!coreDir) {
    return undefined;
  }
  const packagesDir = path.join(coreDir, 'packages');
  return fs.existsSync(packagesDir) ? packagesDir : undefined;
}

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
 * Find GDB binary from PlatformIO tool packages.
 *
 * RISC-V: tool-riscv32-esp-elf-gdb/bin/riscv32-esp-elf-gdb
 * Xtensa: tool-xtensa-esp-elf-gdb/bin/xtensa-esp{32,32s2,32s3}-elf-gdb
 *         (chip-specific binaries inside the unified GDB package)
 */
function findGdbPackage(packagesDir: string, isRiscV: boolean, chipName?: string): string | undefined {
  const ext = process.platform === 'win32' ? '.exe' : '';

  if (isRiscV) {
    const gdbBin = path.join(packagesDir, 'tool-riscv32-esp-elf-gdb', 'bin', 'riscv32-esp-elf-gdb' + ext);
    if (fs.existsSync(gdbBin)) {
      return gdbBin;
    }
  } else {
    const gdbDir = path.join(packagesDir, 'tool-xtensa-esp-elf-gdb', 'bin');

    // Try chip-specific binary first (e.g. xtensa-esp32s3-elf-gdb)
    if (chipName) {
      const chipGdb = path.join(gdbDir, `xtensa-${chipName}-elf-gdb${ext}`);
      if (fs.existsSync(chipGdb)) {
        return chipGdb;
      }
    }

    // Fall back to common variants
    for (const chip of ['esp32', 'esp32s3', 'esp32s2']) {
      const gdbBin = path.join(gdbDir, `xtensa-${chip}-elf-gdb${ext}`);
      if (fs.existsSync(gdbBin)) {
        return gdbBin;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find PlatformIO build environments in the workspace.
 * Uses the full INI parser with extra_configs, extends, and variable
 * interpolation support.
 */
export async function findPioEnvironments(workspaceFolder: string): Promise<PioEnvironment[]> {
  const envs: PioEnvironment[] = [];
  const pioBuildDir = path.join(workspaceFolder, '.pio', 'build');

  if (!fs.existsSync(pioBuildDir)) {
    return envs;
  }

  // Parse all environments from platformio.ini (+ extra_configs)
  const parsedEnvs = parsePioProject(workspaceFolder);
  const parsedEnvMap = new Map(parsedEnvs.map((e) => [e.name, e]));

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

      // Use the parsed board info if available, otherwise fall back to env name
      const parsed = parsedEnvMap.get(envName);
      const board = parsed?.board;

      const chipName = getChipName(board || envName, workspaceFolder);
      const targetArch = CHIP_TARGET_MAP[chipName] ?? 'xtensa';
      const isRiscV = isRiscVArch(targetArch);

      const packagesDir = getPioPackagesDir();
      if (packagesDir) {
        const toolPath = findGdbPackage(packagesDir, isRiscV, chipName);
        if (toolPath) {
          env.toolPath = toolPath;
          env.targetArch = targetArch;
        }

        // Find ROM ELF for the chip (like filter_exception_decoder.py)
        const romElfPath = findRomElf(packagesDir, chipName);
        if (romElfPath) {
          env.romElfPath = romElfPath;
        }
      }

      envs.push(env);
    }
  }

  return envs;
}

/**
 * Let user select a PIO environment or manually pick an ELF.
 */
export async function selectElfFile(
  workspaceFolder: string | undefined,
  currentElfPath?: string
): Promise<{ elfPath: string; toolPath?: string; targetArch?: string; romElfPath?: string } | undefined> {
  const items: (vscode.QuickPickItem & {
    elfPath?: string;
    toolPath?: string;
    targetArch?: string;
    romElfPath?: string;
    action?: string;
  })[] = [];

  // Auto-detect from PlatformIO
  let currentMatchedByPio = false;
  if (workspaceFolder) {
    const envs = await findPioEnvironments(workspaceFolder);
    for (const env of envs) {
      const isCurrent = currentElfPath === env.elfPath;
      if (isCurrent) { currentMatchedByPio = true; }
      items.push({
        label: `$(folder) ${env.name}`,
        description: env.elfPath,
        detail: env.targetArch
          ? `Arch: ${env.targetArch}${env.toolPath ? ' | Tool: ' + path.basename(env.toolPath) : ''}${isCurrent ? ' ✓ active' : ''}`
          : isCurrent ? '✓ active' : undefined,
        elfPath: env.elfPath,
        toolPath: env.toolPath,
        targetArch: env.targetArch,
        romElfPath: env.romElfPath,
      });
    }
  }

  // If the current ELF was manually browsed (not from a PIO env), show it at the top
  if (currentElfPath && !currentMatchedByPio) {
    const name = path.basename(currentElfPath);
    items.unshift({
      label: `$(check) ${name}  (current)`,
      description: currentElfPath,
      detail: 'Currently active — manually selected',
      elfPath: currentElfPath,
    });
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
    romElfPath: (picked as any).romElfPath,
  };
}
