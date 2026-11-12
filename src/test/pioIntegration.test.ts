import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { getCorePythonCommandOutput } = vi.hoisted(() => ({
  getCorePythonCommandOutput: vi.fn(),
}));

vi.mock('vscode', () => ({}));

vi.mock('pioarduino-node-helpers', () => ({
  core: {
    getCoreDir: vi.fn(() => ''),
    getCorePythonCommandOutput,
  },
  project: {
    ProjectConfig: class {},
  },
}));

import { core as pioCore } from 'pioarduino-node-helpers';
import { findPioEnvironments } from '../pioIntegration.js';

describe('findPioEnvironments build directory resolution', () => {
  let workspace: string;
  const originalBuildDir = process.env.PLATFORMIO_BUILD_DIR;
  const originalWorkspaceDir = process.env.PLATFORMIO_WORKSPACE_DIR;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'esp-decoder-pio-'));
    delete process.env.PLATFORMIO_BUILD_DIR;
    delete process.env.PLATFORMIO_WORKSPACE_DIR;
    vi.resetAllMocks();
    vi.mocked(pioCore.getCoreDir).mockReturnValue('');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });

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

  it('uses PlatformIO to expand $PROJECT_HASH in workspace_dir', async () => {
    const resolvedBuildDir = path.join(workspace, '.pio', 'workspaces', 'platformio-hash', 'build');
    fs.writeFileSync(
      path.join(workspace, 'platformio.ini'),
      '[platformio]\nworkspace_dir = .pio/workspaces/$PROJECT_HASH\n\n' +
        '[env:demo]\nplatform = espressif32\nboard = esp32dev\n'
    );
    const elfPath = path.join(resolvedBuildDir, 'demo', 'firmware.elf');
    fs.mkdirSync(path.dirname(elfPath), { recursive: true });
    fs.writeFileSync(elfPath, '');

    vi.mocked(pioCore.getCorePythonCommandOutput).mockResolvedValue(JSON.stringify(resolvedBuildDir));

    const environments = await findPioEnvironments(workspace);

    expect(pioCore.getCorePythonCommandOutput).toHaveBeenCalledTimes(1);
    const [args, options] = vi.mocked(pioCore.getCorePythonCommandOutput).mock.calls[0];
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain('ProjectConfig()');
    expect(args[1]).toContain('config.get("platformio", "build_dir"');
    expect(options).toEqual({ projectDir: workspace });
    expect(environments).toContainEqual(expect.objectContaining({ name: 'demo', elfPath }));
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
