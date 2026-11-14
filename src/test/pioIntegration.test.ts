import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { getCorePythonCommandOutput, getCorePythonExe, loadCoreState, stageParams } = vi.hoisted(() => ({
  getCorePythonCommandOutput: vi.fn(),
  getCorePythonExe: vi.fn(),
  loadCoreState: vi.fn(),
  stageParams: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue: unknown) => defaultValue })),
  },
}));

vi.mock('pioarduino-node-helpers', () => ({
  core: {
    getCoreDir: vi.fn(() => ''),
    getCorePythonExe,
    getCorePythonCommandOutput,
  },
  installer: {
    pioarduinoCoreStage: class {
      constructor(_stateStorage: object, _onStatusChange: () => void, params: object) {
        stageParams(params);
      }

      loadCoreState() {
        return loadCoreState();
      }
    },
  },
  project: {
    ProjectConfig: class {},
  },
}));

import { core as pioCore } from 'pioarduino-node-helpers';
import { findPioEnvironments, getPioBuildDir } from '../pioIntegration.js';

describe('findPioEnvironments build directory resolution', () => {
  let workspace: string;
  const originalBuildDir = process.env.PLATFORMIO_BUILD_DIR;
  const originalWorkspaceDir = process.env.PLATFORMIO_WORKSPACE_DIR;
  const tempDirs: string[] = [];

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'esp-decoder-pio-'));
    tempDirs.push(workspace);
    delete process.env.PLATFORMIO_BUILD_DIR;
    delete process.env.PLATFORMIO_WORKSPACE_DIR;
    vi.resetAllMocks();
    vi.mocked(pioCore.getCoreDir).mockReturnValue('');
    vi.mocked(pioCore.getCorePythonExe).mockRejectedValue(new Error('pioarduino Core is not installed'));
    loadCoreState.mockImplementation(async () => {
      vi.mocked(pioCore.getCorePythonExe).mockResolvedValue('/mock/pio/python');
      return true;
    });
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    if (originalBuildDir === undefined) {
      delete process.env.PLATFORMIO_BUILD_DIR;
    } else {
      process.env.PLATFORMIO_BUILD_DIR = originalBuildDir;
    }

    if (originalWorkspaceDir === undefined) {
      delete process.env.PLATFORMIO_WORKSPACE_DIR;
    } else {
      process.env.PLATFORMIO_WORKSPACE_DIR = originalWorkspaceDir;
    }
  });

  it('initializes the helper and asks PlatformIO to resolve the workspace environment variable', async () => {
    const externalWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'esp-decoder-pio-workspace-'));
    tempDirs.push(externalWorkspace);
    process.env.PLATFORMIO_WORKSPACE_DIR = path.join(externalWorkspace, '$PROJECT_HASH');
    const resolvedBuildDir = path.join(externalWorkspace, 'actual-platformio-hash', 'build');
    fs.writeFileSync(
      path.join(workspace, 'platformio.ini'),
      '[env:demo]\nplatform = espressif32\nboard = esp32dev\n'
    );
    const elfPath = path.join(resolvedBuildDir, 'demo', 'firmware.elf');
    fs.mkdirSync(path.dirname(elfPath), { recursive: true });
    fs.writeFileSync(elfPath, '');

    vi.mocked(pioCore.getCorePythonCommandOutput).mockResolvedValue(JSON.stringify(resolvedBuildDir));

    const environments = await findPioEnvironments(workspace);

    expect(loadCoreState).toHaveBeenCalledTimes(1);
    expect(stageParams).toHaveBeenCalledWith({
      useBuiltinPIOCore: false,
      disableAutoUpdates: true,
      pythonPrompt: { STATUS_TRY_AGAIN: 0 },
    });
    expect(pioCore.getCorePythonCommandOutput).toHaveBeenCalledTimes(1);
    const [args, options] = vi.mocked(pioCore.getCorePythonCommandOutput).mock.calls[0];
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain('ProjectConfig()');
    expect(args[1]).toContain('config.get("platformio", "build_dir")');
    expect(args[1]).not.toContain('default=None');
    expect(options).toEqual({ projectDir: workspace });
    expect(environments).toContainEqual(expect.objectContaining({ environmentName: 'demo', name: 'demo', elfPath }));
  });

  it('does not guess .pio/build if PlatformIO cannot resolve a hash path', async () => {
    process.env.PLATFORMIO_WORKSPACE_DIR = path.join(workspace, '$PROJECT_HASH');
    fs.writeFileSync(path.join(workspace, 'platformio.ini'), '[env:demo]\nboard = esp32dev\n');
    vi.mocked(pioCore.getCorePythonCommandOutput).mockRejectedValue(new Error('PIO Core unavailable'));

    const environments = await findPioEnvironments(workspace);

    expect(environments).toEqual([]);
    expect(pioCore.getCorePythonCommandOutput).toHaveBeenCalledTimes(1);
  });

  it('uses PlatformIO Core to resolve a braced workspace hash placeholder', async () => {
    process.env.PLATFORMIO_WORKSPACE_DIR = path.join(workspace, '${PROJECT_HASH}');
    const resolvedBuildDir = path.join(workspace, 'resolved-hash', 'build');
    fs.writeFileSync(path.join(workspace, 'platformio.ini'), '[env:demo]\nboard = esp32dev\n');
    const elfPath = path.join(resolvedBuildDir, 'demo', 'firmware.elf');
    fs.mkdirSync(path.dirname(elfPath), { recursive: true });
    fs.writeFileSync(elfPath, '');
    vi.mocked(pioCore.getCorePythonCommandOutput).mockResolvedValue(JSON.stringify(resolvedBuildDir));

    const environments = await findPioEnvironments(workspace);

    expect(pioCore.getCorePythonCommandOutput).toHaveBeenCalledTimes(1);
    expect(environments).toContainEqual(expect.objectContaining({ name: 'demo', elfPath }));
  });

  it('does not require PlatformIO Core for a configured absolute build directory', async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esp-decoder-pio-build-'));
    tempDirs.push(buildDir);
    process.env.PLATFORMIO_WORKSPACE_DIR = path.join(workspace, '${PROJECT_HASH}');
    fs.writeFileSync(
      path.join(workspace, 'platformio.ini'),
      `[platformio]\nbuild_dir = ${buildDir}\n\n[env:demo]\nboard = esp32dev\n`
    );
    const elfPath = path.join(buildDir, 'demo', 'firmware.elf');
    fs.mkdirSync(path.dirname(elfPath), { recursive: true });
    fs.writeFileSync(elfPath, '');

    const environments = await findPioEnvironments(workspace);

    expect(pioCore.getCorePythonCommandOutput).not.toHaveBeenCalled();
    expect(environments).toContainEqual(expect.objectContaining({ name: 'demo', elfPath }));
  });

  it('resolves PROJECT_DIR in an overridden workspace before resolving dependent build_dir options', async () => {
    process.env.PLATFORMIO_WORKSPACE_DIR = '${PROJECT_DIR}/.pio';
    fs.writeFileSync(
      path.join(workspace, 'platformio.ini'),
      '[platformio]\nworkspace_dir = configured-workspace\nbuild_dir = ${platformio.workspace_dir}/build\n\n[env:demo]\nboard = esp32dev\n'
    );
    const resolvedBuildDir = path.join(workspace, '.pio', 'build');
    const elfPath = path.join(resolvedBuildDir, 'demo', 'firmware.elf');
    fs.mkdirSync(path.dirname(elfPath), { recursive: true });
    fs.writeFileSync(elfPath, '');

    const environments = await findPioEnvironments(workspace);

    expect(await getPioBuildDir(workspace)).toBe(resolvedBuildDir);
    expect(environments).toContainEqual(expect.objectContaining({ name: 'demo', elfPath }));
    expect(pioCore.getCorePythonCommandOutput).not.toHaveBeenCalled();
  });

  it('continues to discover ELFs in the default .pio/build directory', async () => {
    fs.writeFileSync(
      path.join(workspace, 'platformio.ini'),
      '[env:demo]\nplatform = espressif32\nboard = esp32dev\n'
    );
    const elfPath = path.join(workspace, '.pio', 'build', 'demo', 'firmware.elf');
    fs.mkdirSync(path.dirname(elfPath), { recursive: true });
    fs.writeFileSync(elfPath, '');

    const environments = await findPioEnvironments(workspace);

    expect(pioCore.getCorePythonCommandOutput).not.toHaveBeenCalled();
    expect(environments).toContainEqual(expect.objectContaining({ name: 'demo', elfPath }));
  });
});
