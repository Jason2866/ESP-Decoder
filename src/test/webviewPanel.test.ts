/**
 * Unit tests for EspDecoderWebviewPanel.
 *
 * Tests for PR #42 changes:
 * - File path resolution (resolveSourcePath)
 * - File opening with line and column support (openFile message handler)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// Mock vscode before importing webviewPanel
vi.mock('vscode', () => {
  class EventEmitter<T> {
    private _listeners: ((e: T) => void)[] = [];

    get event() {
      return (listener: (e: T) => void) => {
        this._listeners.push(listener);
        return {
          dispose: () => {
            this._listeners = this._listeners.filter((l) => l !== listener);
          },
        };
      };
    }

    fire(e: T) {
      this._listeners.forEach((l) => l(e));
    }

    dispose() {
      this._listeners = [];
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workspaceFolders: any = [];

  return {
    EventEmitter,
    Uri: {
      file: (p: string) => ({ fsPath: p }),
      parse: (p: string) => ({ fsPath: p }),
    },
    Range: class {
      constructor(
        public startLine: number,
        public startChar: number,
        public endLine: number,
        public endChar: number
      ) {}
      get start() {
        return { line: this.startLine, character: this.startChar };
      }
      get end() {
        return { line: this.endLine, character: this.endChar };
      }
    },
    workspace: {
      get workspaceFolders() {
        return workspaceFolders;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set workspaceFolders(value: any) {
        workspaceFolders.length = 0;
        workspaceFolders.push(...value);
      },
      openTextDocument: vi.fn(),
      findFiles: vi.fn(),
    },
    window: {
      createOutputChannel: () => ({
        appendLine: () => {},
        dispose: () => {},
      }),
      showTextDocument: vi.fn(),
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    },
    Disposable: class {
      dispose() {}
    },
    ConfigurationTarget: {
      Global: 1,
      Workspace: 2,
    },
  };
});

import { EspDecoderWebviewPanel } from '../webviewPanel.js';
import { SerialPortManager } from '../serialPortManager.js';

// Mock SerialPortManager
vi.mock('../serialPortManager.js', () => {
  return {
    SerialPortManager: class {
      onData = vi.fn(() => ({ dispose: vi.fn() }));
      onError = vi.fn(() => ({ dispose: vi.fn() }));
      onConnectionChange = vi.fn(() => ({ dispose: vi.fn() }));
      isConnected = false;
      selectedPath = undefined;
      baudRate = 115200;
      constructor() {}
    },
  };
});

const vscode = await import('vscode');

describe('EspDecoderWebviewPanel – PR #42 file opening', () => {
  let panel: EspDecoderWebviewPanel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockOpenTextDocument: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockShowTextDocument: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockShowErrorMessage: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockFindFiles: any;

  beforeEach(() => {
    // Reset mocks
    mockOpenTextDocument = vi.mocked(vscode.workspace.openTextDocument);
    mockShowTextDocument = vi.mocked(vscode.window.showTextDocument);
    mockShowErrorMessage = vi.mocked(vscode.window.showErrorMessage);
    mockFindFiles = vi.mocked(vscode.workspace.findFiles);

    mockOpenTextDocument.mockResolvedValue({
      uri: { fsPath: '/test/file.cpp' },
    });
    mockShowTextDocument.mockResolvedValue(undefined);
    mockShowErrorMessage.mockResolvedValue(undefined);
    mockFindFiles.mockResolvedValue([]);

    // Create panel instance
    const extensionUri = vscode.Uri.file('/test/extension');
    const serialManager = new SerialPortManager();
    panel = new EspDecoderWebviewPanel(extensionUri, serialManager);
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Reset workspace folders to empty array
    Object.defineProperty(vscode.workspace, 'workspaceFolders', {
      get: () => [],
      configurable: true,
    });
  });

  describe('resolveSourcePath', () => {
    it('returns absolute path as-is when file exists', async () => {
      const testDir = path.dirname(fileURLToPath(import.meta.url));
      const existingFile = path.join(testDir, 'crashDecoder.test.ts');

      // Access the private method via reflection
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolveSourcePath = (panel as any).resolveSourcePath.bind(panel);
      const result = await resolveSourcePath(existingFile);

      expect(result).toBe(existingFile.replace(/\\/g, '/'));
    });

    it('normalises backslashes to forward slashes', async () => {
      const testDir = path.dirname(fileURLToPath(import.meta.url));
      const existingFile = path.join(testDir, 'crashDecoder.test.ts').replace(/\//g, '\\');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolveSourcePath = (panel as any).resolveSourcePath.bind(panel);
      const result = await resolveSourcePath(existingFile);

      expect(result).toContain('/');
      expect(result).not.toContain('\\');
    });

    it('returns original path when absolute file does not exist', async () => {
      const nonExistent = '/nonexistent/path/file.cpp';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolveSourcePath = (panel as any).resolveSourcePath.bind(panel);
      const result = await resolveSourcePath(nonExistent);

      expect(result).toBe(nonExistent);
    });

    it('resolves relative path against workspace folder when file exists', async () => {
      const workspacePath = '/workspace';
      const relativePath = 'src/main.cpp';
      const fullPath = '/workspace/src/main.cpp';

      // Mock workspace folders
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        get: () => [
          { uri: vscode.Uri.file(workspacePath), name: 'workspace', index: 0 },
        ],
        configurable: true,
      });

      // Mock file exists check
      const originalAccess = fs.promises.access;
      fs.promises.access = vi.fn().mockImplementation((p) => {
        if (p === fullPath) return Promise.resolve();
        return Promise.reject(new Error('ENOENT'));
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolveSourcePath = (panel as any).resolveSourcePath.bind(panel);
      const result = await resolveSourcePath(relativePath);

      expect(result).toBe(fullPath);

      // Restore
      fs.promises.access = originalAccess;
    });

    it('searches workspace by basename when relative resolution fails', async () => {
      const workspacePath = '/workspace';
      const basename = 'main.cpp';
      const foundPath = '/workspace/src/main.cpp';

      // Mock workspace folders
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        get: () => [
          { uri: vscode.Uri.file(workspacePath), name: 'workspace', index: 0 },
        ],
        configurable: true,
      });

      // Mock findFiles to return a match
      mockFindFiles.mockResolvedValue([vscode.Uri.file(foundPath)]);

      // Mock file access to fail for relative path
      const originalAccess = fs.promises.access;
      fs.promises.access = vi.fn().mockRejectedValue(new Error('ENOENT'));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolveSourcePath = (panel as any).resolveSourcePath.bind(panel);
      const result = await resolveSourcePath('src/deep/nested/main.cpp');

      expect(result).toBe(foundPath);
      expect(mockFindFiles).toHaveBeenCalledWith(`**/${basename}`, '**/node_modules/**', 50);

      // Restore
      fs.promises.access = originalAccess;
      mockFindFiles.mockResolvedValue([]);
    });

    it('prefers exact suffix match over first match in workspace search', async () => {
      const workspacePath = '/workspace';
      const inputPath = 'src/main.cpp';
      const exactMatch = '/workspace/src/main.cpp';
      const otherMatch = '/workspace/other/src/main.cpp';

      // Mock workspace folders
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        get: () => [
          { uri: vscode.Uri.file(workspacePath), name: 'workspace', index: 0 },
        ],
        configurable: true,
      });

      // Mock findFiles to return multiple matches (exact match first to test logic)
      mockFindFiles.mockResolvedValue([
        vscode.Uri.file(exactMatch),
        vscode.Uri.file(otherMatch),
      ]);

      // Mock file access to fail for relative path
      const originalAccess = fs.promises.access;
      fs.promises.access = vi.fn().mockRejectedValue(new Error('ENOENT'));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolveSourcePath = (panel as any).resolveSourcePath.bind(panel);
      const result = await resolveSourcePath(inputPath);

      expect(result).toBe(exactMatch);

      // Restore
      fs.promises.access = originalAccess;
      mockFindFiles.mockResolvedValue([]);
    });

    it('returns original input when no workspace folders exist', async () => {
      const inputPath = 'src/main.cpp';

      // Ensure no workspace folders
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        get: () => [],
        configurable: true,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolveSourcePath = (panel as any).resolveSourcePath.bind(panel);
      const result = await resolveSourcePath(inputPath);

      expect(result).toBe(inputPath);
    });

    it('returns original input when workspace search finds no files', async () => {
      const workspacePath = '/workspace';
      const inputPath = 'src/main.cpp';

      // Mock workspace folders
      Object.defineProperty(vscode.workspace, 'workspaceFolders', {
        get: () => [
          { uri: vscode.Uri.file(workspacePath), name: 'workspace', index: 0 },
        ],
        configurable: true,
      });

      // Mock findFiles to return empty
      mockFindFiles.mockResolvedValue([]);

      // Mock file access to fail
      const originalAccess = fs.promises.access;
      fs.promises.access = vi.fn().mockRejectedValue(new Error('ENOENT'));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolveSourcePath = (panel as any).resolveSourcePath.bind(panel);
      const result = await resolveSourcePath(inputPath);

      expect(result).toBe(inputPath);

      // Restore
      fs.promises.access = originalAccess;
    });
  });

  describe('openFile message handler', () => {
    it('shows error message when file cannot be opened', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handleMessage = (panel as any).handleMessage.bind(panel);
      mockOpenTextDocument.mockRejectedValue(new Error('File not found'));

      await handleMessage({
        type: 'openFile',
        file: '/nonexistent/file.cpp',
        line: '10',
      });

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot open file')
      );
    });

    it('does nothing when file is missing from message', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handleMessage = (panel as any).handleMessage.bind(panel);
      await handleMessage({
        type: 'openFile',
        line: '10',
      });

      expect(mockOpenTextDocument).not.toHaveBeenCalled();
      expect(mockShowTextDocument).not.toHaveBeenCalled();
    });

    it('does nothing when line is missing from message', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handleMessage = (panel as any).handleMessage.bind(panel);
      await handleMessage({
        type: 'openFile',
        file: '/some/file.cpp',
      });

      expect(mockOpenTextDocument).not.toHaveBeenCalled();
      expect(mockShowTextDocument).not.toHaveBeenCalled();
    });
  });
});
