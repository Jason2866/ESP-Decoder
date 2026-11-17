import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findEspIdfBuilds } from '../espIdfIntegration.js';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function touchFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
}

describe('findEspIdfBuilds', () => {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const envRestore = {
    path: process.env.PATH,
    idfToolsPath: process.env.IDF_TOOLS_PATH,
  };

  const tempDirs: string[] = [];

  afterEach(() => {
    process.env.PATH = envRestore.path;

    if (envRestore.idfToolsPath === undefined) {
      delete process.env.IDF_TOOLS_PATH;
    } else {
      process.env.IDF_TOOLS_PATH = envRestore.idfToolsPath;
    }

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('defaults to xtensa GDB search when sdkconfig target is missing', async () => {
    const workspace = makeTempDir('esp-decoder-idf-workspace-');
    const toolBinDir = makeTempDir('esp-decoder-idf-tools-');
    tempDirs.push(workspace, toolBinDir);

    touchFile(path.join(workspace, 'build', 'app.elf'));
    touchFile(path.join(toolBinDir, `xtensa-esp-elf-gdb${exe}`));

    process.env.PATH = toolBinDir;
    delete process.env.IDF_TOOLS_PATH;

    const builds = await findEspIdfBuilds(workspace);
    expect(builds.length).toBeGreaterThan(0);
    expect(builds[0].elfPath).toBe(path.join(workspace, 'build', 'app.elf'));
    expect(builds[0].toolPath).toBe(path.join(toolBinDir, `xtensa-esp-elf-gdb${exe}`));
  });

  it('still uses riscv GDB when sdkconfig target is riscv-based', async () => {
    const workspace = makeTempDir('esp-decoder-idf-workspace-');
    const toolBinDir = makeTempDir('esp-decoder-idf-tools-');
    tempDirs.push(workspace, toolBinDir);

    touchFile(path.join(workspace, 'build', 'app.elf'));
    fs.writeFileSync(path.join(workspace, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32c6"\n');
    touchFile(path.join(toolBinDir, `riscv32-esp-elf-gdb${exe}`));

    process.env.PATH = toolBinDir;
    delete process.env.IDF_TOOLS_PATH;

    const builds = await findEspIdfBuilds(workspace);
    expect(builds.length).toBeGreaterThan(0);
    expect(builds[0].targetArch).toBe('riscv');
    expect(builds[0].toolPath).toBe(path.join(toolBinDir, `riscv32-esp-elf-gdb${exe}`));
  });

  it('falls back to the generic xtensa GDB on PATH for an Xtensa target', async () => {
    const workspace = makeTempDir('esp-decoder-idf-workspace-');
    const toolBinDir = makeTempDir('esp-decoder-idf-tools-');
    tempDirs.push(workspace, toolBinDir);

    touchFile(path.join(workspace, 'build', 'app.elf'));
    fs.writeFileSync(path.join(workspace, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32s3"\n');
    // Only the generic GDB is on PATH — no chip-specific xtensa-esp32s3-elf-gdb.
    touchFile(path.join(toolBinDir, `xtensa-esp-elf-gdb${exe}`));

    process.env.PATH = toolBinDir;
    delete process.env.IDF_TOOLS_PATH;

    const builds = await findEspIdfBuilds(workspace);
    expect(builds.length).toBeGreaterThan(0);
    expect(builds[0].targetArch).toBe('xtensa');
    expect(builds[0].toolPath).toBe(path.join(toolBinDir, `xtensa-esp-elf-gdb${exe}`));
  });

  it('prefers the chip-specific xtensa GDB on PATH over the generic one', async () => {
    const workspace = makeTempDir('esp-decoder-idf-workspace-');
    const toolBinDir = makeTempDir('esp-decoder-idf-tools-');
    tempDirs.push(workspace, toolBinDir);

    touchFile(path.join(workspace, 'build', 'app.elf'));
    fs.writeFileSync(path.join(workspace, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32s3"\n');
    touchFile(path.join(toolBinDir, `xtensa-esp-elf-gdb${exe}`));
    touchFile(path.join(toolBinDir, `xtensa-esp32s3-elf-gdb${exe}`));

    process.env.PATH = toolBinDir;
    delete process.env.IDF_TOOLS_PATH;

    const builds = await findEspIdfBuilds(workspace);
    expect(builds.length).toBeGreaterThan(0);
    expect(builds[0].toolPath).toBe(path.join(toolBinDir, `xtensa-esp32s3-elf-gdb${exe}`));
  });

  it('resolves esp32s31 sdkconfig target to riscv GDB', async () => {
    const workspace = makeTempDir('esp-decoder-idf-workspace-');
    const toolBinDir = makeTempDir('esp-decoder-idf-tools-');
    tempDirs.push(workspace, toolBinDir);

    touchFile(path.join(workspace, 'build', 'app.elf'));
    fs.writeFileSync(path.join(workspace, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32s31"\n');
    touchFile(path.join(toolBinDir, `riscv32-esp-elf-gdb${exe}`));

    process.env.PATH = toolBinDir;
    delete process.env.IDF_TOOLS_PATH;

    const builds = await findEspIdfBuilds(workspace);
    expect(builds.length).toBeGreaterThan(0);
    expect(builds[0].targetArch).toBe('riscv');
    expect(builds[0].toolPath).toBe(path.join(toolBinDir, `riscv32-esp-elf-gdb${exe}`));
  });

  it('prefers the chip-specific xtensa GDB inside an ESP-IDF tool directory', async () => {
    const workspace = makeTempDir('esp-decoder-idf-workspace-');
    const pathDir = makeTempDir('esp-decoder-idf-path-');
    const toolsRoot = makeTempDir('esp-decoder-idf-tools-root-');
    tempDirs.push(workspace, pathDir, toolsRoot);

    touchFile(path.join(workspace, 'build', 'app.elf'));
    fs.writeFileSync(path.join(workspace, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32s3"\n');

    const binDir = path.join(
      toolsRoot,
      'tools',
      'xtensa-esp32s3-elf',
      '1.0',
      'bin',
    );
    touchFile(path.join(binDir, `xtensa-esp32s3-elf-gdb${exe}`));
    touchFile(path.join(binDir, `xtensa-esp-elf-gdb${exe}`));

    // PATH must not shadow the tool-directory lookup.
    process.env.PATH = pathDir;
    process.env.IDF_TOOLS_PATH = toolsRoot;

    const builds = await findEspIdfBuilds(workspace);
    expect(builds.length).toBeGreaterThan(0);
    expect(builds[0].targetArch).toBe('xtensa');
    expect(builds[0].toolPath).toBe(path.join(binDir, `xtensa-esp32s3-elf-gdb${exe}`));
  });
});
