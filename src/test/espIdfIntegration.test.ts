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
    touchFile(path.join(toolBinDir, 'xtensa-esp-elf-gdb'));

    process.env.PATH = toolBinDir;
    delete process.env.IDF_TOOLS_PATH;

    const builds = await findEspIdfBuilds(workspace);
    expect(builds.length).toBeGreaterThan(0);
    expect(builds[0].elfPath).toBe(path.join(workspace, 'build', 'app.elf'));
    expect(builds[0].toolPath).toBe(path.join(toolBinDir, 'xtensa-esp-elf-gdb'));
  });

  it('still uses riscv GDB when sdkconfig target is riscv-based', async () => {
    const workspace = makeTempDir('esp-decoder-idf-workspace-');
    const toolBinDir = makeTempDir('esp-decoder-idf-tools-');
    tempDirs.push(workspace, toolBinDir);

    touchFile(path.join(workspace, 'build', 'app.elf'));
    fs.writeFileSync(path.join(workspace, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32c6"\n');
    touchFile(path.join(toolBinDir, 'riscv32-esp-elf-gdb'));

    process.env.PATH = toolBinDir;
    delete process.env.IDF_TOOLS_PATH;

    const builds = await findEspIdfBuilds(workspace);
    expect(builds.length).toBeGreaterThan(0);
    expect(builds[0].targetArch).toBe('esp32c6');
    expect(builds[0].toolPath).toBe(path.join(toolBinDir, 'riscv32-esp-elf-gdb'));
  });
});
