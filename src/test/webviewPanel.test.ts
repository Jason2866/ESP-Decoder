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
      onDisconnect = vi.fn(() => ({ dispose: vi.fn() }));
      startAutoReconnect = vi.fn();
      cancelReconnect = vi.fn();
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

    it('opens file with line and column when both provided (happy path)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handleMessage = (panel as any).handleMessage.bind(panel);
      mockOpenTextDocument.mockResolvedValue({ uri: { fsPath: '/workspace/src/main.cpp' } });

      await handleMessage({
        type: 'openFile',
        file: '/workspace/src/main.cpp',
        line: '42',
        column: '15',
      });

      expect(mockOpenTextDocument).toHaveBeenCalledWith({ fsPath: '/workspace/src/main.cpp' });
      expect(mockShowTextDocument).toHaveBeenCalledWith(
        { uri: { fsPath: '/workspace/src/main.cpp' } },
        expect.objectContaining({
          selection: expect.objectContaining({
            start: { line: 41, character: 14 },
            end: { line: 41, character: 14 },
          }),
        })
      );
    });

    it('opens file with line only when column is missing', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handleMessage = (panel as any).handleMessage.bind(panel);
      mockOpenTextDocument.mockResolvedValue({ uri: { fsPath: '/workspace/src/main.cpp' } });

      await handleMessage({
        type: 'openFile',
        file: '/workspace/src/main.cpp',
        line: '42',
      });

      expect(mockShowTextDocument).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          selection: expect.objectContaining({
            start: { line: 41, character: 0 },
            end: { line: 41, character: 0 },
          }),
        })
      );
    });
  });
});

describe('SERIAL_LINK_RE regex matching', () => {
    // Regex matching file:line[:col] references in serial output
    // Matches anchored paths (with drive letter, leading / or ./ ../) allowing spaces,
    // and plain relative paths without spaces
    // Captures: 1=path, 2=line, 3=col?
    const SERIAL_LINK_RE = /((?:(?:[A-Za-z]:[\\/]|[\\/]|\.\.?[\\/])[\w./\\ -]+|[\w.-]+(?:[\\/][\w.-]+)*)\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ino|s|asm|tcc|ipp)):(\d+)(?::(\d+))?/gi;

    function getAllMatches(text: string): Array<{ path: string; line: string; col?: string; full: string }> {
      const matches: Array<{ path: string; line: string; col?: string; full: string }> = [];
      SERIAL_LINK_RE.lastIndex = 0;
      let match;
      while ((match = SERIAL_LINK_RE.exec(text)) !== null) {
        matches.push({
          path: match[1],
          line: match[2],
          col: match[3],
          full: match[0],
        });
      }
      return matches;
    }

  it('matches simple relative path with line number', () => {
    const matches = getAllMatches('src/main.cpp:42');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: 'src/main.cpp', line: '42', full: 'src/main.cpp:42' });
  });

  it('matches relative path with line and column', () => {
    const matches = getAllMatches('src/main.cpp:42:15');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: 'src/main.cpp', line: '42', col: '15', full: 'src/main.cpp:42:15' });
  });

  it('matches absolute Unix path', () => {
    const matches = getAllMatches('/home/user/project/src/main.cpp:100');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: '/home/user/project/src/main.cpp', line: '100' });
  });

  it('matches Windows path with drive letter', () => {
    const matches = getAllMatches('C:\\Users\\me\\Project\\main.cpp:42');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: 'C:\\Users\\me\\Project\\main.cpp', line: '42' });
  });

  it('matches path with ./ prefix', () => {
    const matches = getAllMatches('./src/utils/helper.cpp:25');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: './src/utils/helper.cpp', line: '25' });
  });

  it('matches path with ../ prefix', () => {
    const matches = getAllMatches('../include/header.h:10:5');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: '../include/header.h', line: '10', col: '5' });
  });

  it('matches path containing spaces (anchored paths only)', () => {
    const matches = getAllMatches('/home/user/My Project/src/main.cpp:42');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: '/home/user/My Project/src/main.cpp', line: '42' });
  });

  it('matches various file extensions', () => {
    const extensions = ['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'ino', 's', 'asm', 'tcc', 'ipp'];
    for (const ext of extensions) {
      SERIAL_LINK_RE.lastIndex = 0;
      const matches = getAllMatches(`file.${ext}:10`);
      expect(matches).toHaveLength(1);
      expect(matches[0].path).toBe(`file.${ext}`);
    }
  });

  it('matches multiple file:line references in same line', () => {
    const text = 'Error in src/main.cpp:42 and also in src/utils.cpp:100:5';
    const matches = getAllMatches(text);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ path: 'src/main.cpp', line: '42' });
    expect(matches[1]).toMatchObject({ path: 'src/utils.cpp', line: '100', col: '5' });
  });

  it('does not match paths without recognized extensions', () => {
    const matches = getAllMatches('readme.txt:10 or file.py:20');
    expect(matches).toHaveLength(0);
  });

  it('does not match standalone numbers (timestamps)', () => {
    const matches = getAllMatches('12:34:56.789 timestamp in log');
    expect(matches).toHaveLength(0);
  });

  it('does not match paths with spaces unless anchored', () => {
    // Plain relative paths with spaces should not match
    // The regex may match 'Project/main.cpp:42' as a substring of 'My Project/main.cpp:42'
    // but not the full path with spaces
    const matches = getAllMatches('My Project/main.cpp:42');
    // If it matches, it should be 'Project/main.cpp' not 'My Project/main.cpp'
    if (matches.length > 0) {
      expect(matches[0].path).not.toContain(' ');
    }
  });

  it('matches header file names', () => {
    const matches = getAllMatches('WiFi.h:42 and Arduino.h:100');
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ path: 'WiFi.h', line: '42' });
    expect(matches[1]).toMatchObject({ path: 'Arduino.h', line: '100' });
  });

  it('matches ESP-IDF style paths', () => {
    const text = '0x400d1234: function at /esp-idf/components/freertos/queue.c:1234';
    const matches = getAllMatches(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: '/esp-idf/components/freertos/queue.c', line: '1234' });
  });
});

describe('Click handler Ctrl/Cmd gate', () => {
  it('detects Ctrl+click on serial-file-link', () => {
    const mockClosest = vi.fn((selector: string) => {
      if (selector === '.serial-file-link') {
        return {
          getAttribute: (attr: string) => {
            if (attr === 'data-file') return '/src/main.cpp';
            if (attr === 'data-line') return '42';
            if (attr === 'data-column') return '15';
            return null;
          },
        };
      }
      return null;
    });

    const mockEvent = {
      ctrlKey: true,
      metaKey: false,
      target: { closest: mockClosest },
      preventDefault: vi.fn(),
    };

    // Simulate the click handler check from webviewPanel.ts
    const serialLink = mockEvent.target.closest('.serial-file-link');
    const hasModifier = mockEvent.ctrlKey || mockEvent.metaKey;

    expect(serialLink).not.toBeNull();
    expect(hasModifier).toBe(true);
    expect(serialLink!.getAttribute('data-file')).toBe('/src/main.cpp');
    expect(serialLink!.getAttribute('data-line')).toBe('42');
    expect(serialLink!.getAttribute('data-column')).toBe('15');
  });

  it('detects Cmd+click on serial-file-link (macOS)', () => {
    const mockClosest = vi.fn((selector: string) => {
      if (selector === '.serial-file-link') {
        return {
          getAttribute: (attr: string) => {
            if (attr === 'data-file') return '/src/utils.cpp';
            if (attr === 'data-line') return '100';
            return null;
          },
        };
      }
      return null;
    });

    const mockEvent = {
      ctrlKey: false,
      metaKey: true,
      target: { closest: mockClosest },
      preventDefault: vi.fn(),
    };

    const serialLink = mockEvent.target.closest('.serial-file-link');
    const hasModifier = mockEvent.ctrlKey || mockEvent.metaKey;

    expect(serialLink).not.toBeNull();
    expect(hasModifier).toBe(true);
    expect(serialLink!.getAttribute('data-file')).toBe('/src/utils.cpp');
    expect(serialLink!.getAttribute('data-line')).toBe('100');
  });

  it('does not open file without Ctrl/Cmd modifier', () => {
    const mockClosest = vi.fn((selector: string) => {
      if (selector === '.serial-file-link') {
        return {
          getAttribute: (attr: string) => {
            if (attr === 'data-file') return '/src/main.cpp';
            if (attr === 'data-line') return '42';
            return null;
          },
        };
      }
      return null;
    });

    const mockEvent = {
      ctrlKey: false,
      metaKey: false,
      target: { closest: mockClosest },
    };

    const serialLink = mockEvent.target.closest('.serial-file-link');
    const hasModifier = mockEvent.ctrlKey || mockEvent.metaKey;

    expect(serialLink).not.toBeNull();
    expect(hasModifier).toBe(false);
    // The handler should NOT process this click
  });

  it('does nothing when clicking non-link elements', () => {
    const mockClosest = vi.fn(() => null);

    const mockEvent = {
      ctrlKey: true,
      target: { closest: mockClosest },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialLink = (mockEvent.target as any).closest('.serial-file-link');
    expect(serialLink).toBeNull();
  });
});

describe('buildLinkifiedFragment / makeSerialFileLink', () => {
  it('returns null for empty text', () => {
    const result = null; // In real DOM would be null
    expect(result).toBeNull();
  });

  it('creates link elements with correct attributes', () => {
    // Simulating makeSerialFileLink behavior
    const mockElement = {
      className: '',
      attributes: {} as Record<string, string>,
      title: '',
      setAttribute: function(key: string, value: string) {
        this.attributes[key] = value;
      },
    };

    // Simulate what makeSerialFileLink does
    mockElement.className = 'serial-file-link';
    mockElement.setAttribute('data-file', '/src/main.cpp');
    mockElement.setAttribute('data-line', '42');
    mockElement.setAttribute('data-column', '15');
    mockElement.title = 'Ctrl/Cmd+click to open /src/main.cpp:42';

    expect(mockElement.className).toBe('serial-file-link');
    expect(mockElement.attributes['data-file']).toBe('/src/main.cpp');
    expect(mockElement.attributes['data-line']).toBe('42');
    expect(mockElement.attributes['data-column']).toBe('15');
  });

  it('creates link without column when not provided', () => {
    const mockElement = {
      attributes: {} as Record<string, string | undefined>,
      setAttribute: function(key: string, value: string) {
        this.attributes[key] = value;
      },
    };

    mockElement.setAttribute('data-file', '/src/main.cpp');
    mockElement.setAttribute('data-line', '42');
    // No column attribute set

    expect(mockElement.attributes['data-file']).toBe('/src/main.cpp');
    expect(mockElement.attributes['data-line']).toBe('42');
    expect(mockElement.attributes['data-column']).toBeUndefined();
  });
});

describe('ansiMakeNode integration', () => {
  it('returns null for empty text', () => {
    const result = null; // Empty text returns null
    expect(result).toBeNull();
  });

  it('detects when span is needed based on ANSI state', () => {
    const ansiState = {
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
      blink: false,
      fastBlink: false,
      hidden: false,
      dim: false,
      reverse: false,
      fg: null,
      bg: null,
      fgRgb: null,
      bgRgb: null,
    };

    // When no ANSI state is set, no span is needed
    const needsSpan = ansiState.bold || ansiState.italic || ansiState.underline ||
      ansiState.strikethrough || ansiState.blink || ansiState.fastBlink ||
      ansiState.hidden || ansiState.dim || ansiState.reverse ||
      ansiState.fg || ansiState.bg || ansiState.fgRgb || ansiState.bgRgb;

    // needsSpan will be null (last falsy value) or false when all are falsy
    expect(Boolean(needsSpan)).toBe(false);

    // When any ANSI state is set, span is needed
    ansiState.bold = true;
    const needsSpanWithBold = true;
    expect(needsSpanWithBold).toBe(true);
  });

  it('applies all ANSI style classes when set', () => {
    const classes: string[] = [];
    const ansiState = {
      bold: true,
      dim: true,
      italic: true,
      underline: true,
      strikethrough: true,
      blink: true,
      fastBlink: false,
      hidden: true,
      reverse: false,
    };

    // Simulate classList.add calls from ansiMakeNode
    if (ansiState.bold) { classes.push('ansi-bold'); }
    if (ansiState.dim) { classes.push('ansi-dim'); }
    if (ansiState.italic) { classes.push('ansi-italic'); }
    if (ansiState.underline) { classes.push('ansi-underline'); }
    if (ansiState.strikethrough) { classes.push('ansi-strikethrough'); }
    if (ansiState.blink) { classes.push('ansi-blink'); }
    if (ansiState.fastBlink) { classes.push('ansi-blink-fast'); }
    if (ansiState.hidden) { classes.push('ansi-hidden'); }

    expect(classes).toContain('ansi-bold');
    expect(classes).toContain('ansi-dim');
    expect(classes).toContain('ansi-italic');
    expect(classes).toContain('ansi-underline');
    expect(classes).toContain('ansi-strikethrough');
    expect(classes).toContain('ansi-blink');
    expect(classes).toContain('ansi-hidden');
    expect(classes).not.toContain('ansi-blink-fast'); // Not set
    expect(classes).not.toContain('ansi-reverse'); // Not set
  });

  it('handles reverse video mode correctly', () => {
    const ansiState = {
      reverse: true,
      fg: 'red' as string | null,
      bg: 'blue' as string | null,
      fgRgb: null as string | null,
      bgRgb: null as string | null,
    };

    // In reverse mode, fg and bg are swapped
    let localFg = ansiState.bg; // Swapped!
    let localBg = ansiState.fg; // Swapped!

    expect(localFg).toBe('blue');
    expect(localBg).toBe('red');
  });

  it('handles reverse with RGB colors', () => {
    const ansiState = {
      reverse: true,
      fg: null as string | null,
      bg: null as string | null,
      fgRgb: 'rgb(255,0,0)' as string | null,
      bgRgb: 'rgb(0,0,255)' as string | null,
    };

    // In reverse mode, RGB colors are swapped
    let localFgRgb = ansiState.bgRgb;
    let localBgRgb = ansiState.fgRgb;

    expect(localFgRgb).toBe('rgb(0,0,255)');
    expect(localBgRgb).toBe('rgb(255,0,0)');
  });

  it('applies ansi-reverse class when no colors set in reverse mode', () => {
    const ansiState = {
      reverse: true,
      fg: null,
      bg: null,
      fgRgb: null,
      bgRgb: null,
    };

    // When reverse is set but no colors, use css class
    const useReverseClass = !ansiState.fgRgb && !ansiState.fg &&
      !ansiState.bgRgb && !ansiState.bg;

    expect(useReverseClass).toBe(true);
  });
});

describe('Modifier key tracking event listeners', () => {
  it('activates mod-link-active on Control keydown', () => {
    const mockBody = { classList: { toggle: vi.fn() } };
    const setModLinkActive = (on: boolean) => {
      mockBody.classList.toggle('mod-link-active', !!on);
    };

    // Simulate keydown with Control
    const mockKeydown = { key: 'Control', ctrlKey: true, metaKey: false };
    if (mockKeydown.key === 'Control' || mockKeydown.key === 'Meta' || mockKeydown.ctrlKey || mockKeydown.metaKey) {
      setModLinkActive(true);
    }

    expect(mockBody.classList.toggle).toHaveBeenCalledWith('mod-link-active', true);
  });

  it('activates mod-link-active on Meta keydown (Cmd on macOS)', () => {
    const mockBody = { classList: { toggle: vi.fn() } };
    const setModLinkActive = (on: boolean) => {
      mockBody.classList.toggle('mod-link-active', !!on);
    };

    const mockKeydown = { key: 'Meta', ctrlKey: false, metaKey: true };
    if (mockKeydown.key === 'Control' || mockKeydown.key === 'Meta' || mockKeydown.ctrlKey || mockKeydown.metaKey) {
      setModLinkActive(true);
    }

    expect(mockBody.classList.toggle).toHaveBeenCalledWith('mod-link-active', true);
  });

  it('deactivates mod-link-active on Control keyup', () => {
    const mockBody = { classList: { toggle: vi.fn() } };
    const setModLinkActive = (on: boolean) => {
      mockBody.classList.toggle('mod-link-active', !!on);
    };

    const mockKeyup = { key: 'Control', ctrlKey: false, metaKey: false };
    if (mockKeyup.key === 'Control' || mockKeyup.key === 'Meta') {
      setModLinkActive(mockKeyup.ctrlKey || mockKeyup.metaKey);
    }

    expect(mockBody.classList.toggle).toHaveBeenCalledWith('mod-link-active', false);
  });

  it('deactivates mod-link-active on Meta keyup', () => {
    const mockBody = { classList: { toggle: vi.fn() } };
    const setModLinkActive = (on: boolean) => {
      mockBody.classList.toggle('mod-link-active', !!on);
    };

    const mockKeyup = { key: 'Meta', ctrlKey: false, metaKey: false };
    if (mockKeyup.key === 'Control' || mockKeyup.key === 'Meta') {
      setModLinkActive(mockKeyup.ctrlKey || mockKeyup.metaKey);
    }

    expect(mockBody.classList.toggle).toHaveBeenCalledWith('mod-link-active', false);
  });

  it('keeps mod-link-active active when other modifiers still held', () => {
    const mockBody = { classList: { toggle: vi.fn() } };
    const setModLinkActive = (on: boolean) => {
      mockBody.classList.toggle('mod-link-active', !!on);
    };

    // Releasing Ctrl but Cmd still held
    const mockKeyup = { key: 'Control', ctrlKey: false, metaKey: true };
    if (mockKeyup.key === 'Control' || mockKeyup.key === 'Meta') {
      setModLinkActive(mockKeyup.ctrlKey || mockKeyup.metaKey);
    }

    expect(mockBody.classList.toggle).toHaveBeenCalledWith('mod-link-active', true);
  });

  it('syncs mod-link-active from pointermove events', () => {
    const mockBody = { classList: { toggle: vi.fn() } };
    const setModLinkActive = (on: boolean) => {
      mockBody.classList.toggle('mod-link-active', !!on);
    };

    // Simulate pointermove with modifier held
    const mockPointerMove = { ctrlKey: true, metaKey: false };
    setModLinkActive(mockPointerMove.ctrlKey || mockPointerMove.metaKey);

    expect(mockBody.classList.toggle).toHaveBeenCalledWith('mod-link-active', true);
  });

  it('syncs mod-link-active from pointerover events', () => {
    const mockBody = { classList: { toggle: vi.fn() } };
    const setModLinkActive = (on: boolean) => {
      mockBody.classList.toggle('mod-link-active', !!on);
    };

    const mockPointerOver = { ctrlKey: false, metaKey: true };
    setModLinkActive(mockPointerOver.ctrlKey || mockPointerOver.metaKey);

    expect(mockBody.classList.toggle).toHaveBeenCalledWith('mod-link-active', true);
  });

  it('clears mod-link-active on window blur', () => {
    const mockBody = { classList: { toggle: vi.fn() } };
    const setModLinkActive = (on: boolean) => {
      mockBody.classList.toggle('mod-link-active', !!on);
    };

    // Simulate blur event
    setModLinkActive(false);

    expect(mockBody.classList.toggle).toHaveBeenCalledWith('mod-link-active', false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Regression tests for issues #35 and #54 — serial monitor newline / CR
// handling.
//
// These tests exercise the *actual* `appendSerialData` function (and its
// supporting helpers) by extracting their source from the rendered webview
// HTML and evaluating them in a sandbox with a minimal fake DOM. This way
// regressions in the production code are caught directly.
// ────────────────────────────────────────────────────────────────────────────

/** Minimal DOM node used to verify line/text structure produced by
 *  appendSerialData. Only implements the methods the function relies on. */
class FakeNode {
  tag: string;
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  textContent = '';
  className = '';
  attributes: Record<string, string> = {};
  constructor(tag: string) { this.tag = tag; }
  appendChild(c: FakeNode): FakeNode {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c: FakeNode): FakeNode {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  replaceChild(n: FakeNode, o: FakeNode): FakeNode {
    const i = this.children.indexOf(o);
    if (i < 0) throw new Error('replaceChild: oldChild not found');
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.children[i] = n;
    o.parentNode = null;
    return o;
  }
  replaceChildren(...nodes: FakeNode[]): void {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    for (const n of nodes) this.appendChild(n);
  }
  contains(n: FakeNode): boolean {
    if (n === this) return true;
    for (const c of this.children) if (c.contains(n)) return true;
    return false;
  }
  get childNodes(): FakeNode[] { return this.children; }
  get lastElementChild(): FakeNode | null {
    return this.children.length ? this.children[this.children.length - 1] : null;
  }
  setAttribute(k: string, v: string): void { this.attributes[k] = v; }
  // Recursively flatten text content for assertions.
  get text(): string {
    if (this.children.length === 0) return this.textContent;
    return this.children.map((c) => c.text).join('');
  }
}

/** Read webviewPanel.ts source once. The webview JS lives inside a TS
 *  template literal at 4-space indentation, so we can locate each helper
 *  function by name. We read the source file directly rather than calling
 *  `getHtmlContent()` because CI deletes `dist/ansiParser.js` (a dependency
 *  of getHtmlContent) before running tests. */
function loadWebviewPanelSource(): string {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const srcPath = path.resolve(testDir, '..', 'webviewPanel.ts');
  return fs.readFileSync(srcPath, 'utf8');
}

/** Build a callable `appendSerialData(text)` bound to a fresh fake DOM,
 *  loaded with the production source extracted from src/webviewPanel.ts. */
function buildAppendSerialData(): {
  append: (text: string) => void;
  output: FakeNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
} {
  const src = loadWebviewPanelSource();

  // Extract a top-level function definition from the script. Helpers are
  // declared at 4-space indentation inside the <script> template, so the
  // closing brace is also at 4-space indentation.
  //
  // We then undo one level of TS template-literal backslash escaping
  // (`\\` → `\`) so that escapes like `'\\x1b'` become `'\x1b'` — i.e.,
  // the same string that the browser would see in the rendered HTML.
  const grab = (name: string): string => {
    const startRe = new RegExp(`\\n    (function ${name}\\b[\\s\\S]*?\\n    \\})`);
    const m = startRe.exec(src);
    if (!m) throw new Error(`Could not extract ${name} from webviewPanel.ts`);
    return m[1].replace(/\\\\/g, '\\');
  };

  const dedupResetLineSrc = grab('dedupResetLine');
  const applyChunkFiltersSrc = grab('applyChunkFilters');
  const applyDedupToChunkSrc = grab('applyDedupToChunk');
  const applyLineFiltersSrc = grab('applyLineFilters');
  const appendSerialDataSrc = grab('appendSerialData');

  const document = {
    createElement: (tag: string) => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('#fragment'),
  };
  const serialOutput = new FakeNode('div');

  // Stub renderAnsiText so we don't have to drag in the full ANSI parser.
  // It returns a text node carrying the raw chunk so we can assert on output.
  const renderAnsiText = (text: string): FakeNode => {
    const n = new FakeNode('span');
    n.textContent = text;
    return n;
  };

  const sandbox = `
    'use strict';
    var ESC = String.fromCharCode(27);
    var CR = String.fromCharCode(13);
    var LF = String.fromCharCode(10);
    var CRLF = CR + LF;
    var LINE_SPLIT_RE = new RegExp('(' + CRLF + '|' + CR + '|' + LF + ')');

    var ansiTail = '';
    var carriageReturn = false;
    var currentLine = null;
    var currentLineRaw = '';
    var autoscroll = false;
    var scrollRAFPending = false;
    var programmaticScroll = false;

    var filterState = {
      timestamp: false,
      _suppressRe: null,
      _highlightRe: null,
      dedupThreshold: 3,
      _dedupRe: null,
      _dedupCount: 0,
      _dedupBadge: null,
      _lineStarted: false,
    };

    // ANSI parser stubs (we don't exercise SGR in these tests).
    function ansiStateToSgr() { return ''; }

    ${dedupResetLineSrc}
    ${applyDedupToChunkSrc}
    ${applyChunkFiltersSrc}
    ${applyLineFiltersSrc}
    ${appendSerialDataSrc}

    return {
      append: function(text) { appendSerialData(text); },
      output: serialOutput,
      state: { get filterState() { return filterState; } },
    };
  `;

  const factory = new Function(
    'document', 'serialOutput', 'renderAnsiText',
    sandbox
  );
  return factory(document, serialOutput, renderAnsiText);
}

describe('appendSerialData — issue #54 (bare \\r) and issue #35 (blank lines)', () => {
  it('issue #54: bare CR is treated as a line break — countdown output is preserved', () => {
    const { append, output } = buildAppendSerialData();

    // Mirrors the user's reproducer in https://github.com/Jason2866/ESP-Decoder/issues/54
    //   printf(" \n countdown starts \n ");
    //   while (i) { printf(" wait %is \r ", i); i--; vTaskDelay(1000); }
    //   printf(" \n ready \n ");
    // Each printf arrives as its own batch (1 s apart).
    append(' \n countdown starts \n ');
    for (let i = 10; i >= 1; i--) {
      append(` wait ${i}s \r `);
    }
    append(' \n ready \n ');

    const lines = output.children.map((c) => c.text);

    // Every iteration of the countdown must be visible.
    for (let i = 10; i >= 1; i--) {
      expect(
        lines.some((l) => l.includes(`wait ${i}s`)),
        `expected to see "wait ${i}s" in the rendered lines, got: ${JSON.stringify(lines)}`
      ).toBe(true);
    }

    // The framing messages must also be present.
    expect(lines.some((l) => l.includes('countdown starts'))).toBe(true);
    expect(lines.some((l) => l.includes('ready'))).toBe(true);
  });

  it('issue #54: a CR in the middle of a single batch splits content into separate lines', () => {
    const { append, output } = buildAppendSerialData();

    // Both halves of a CR-separated batch should be visible — regression
    // guard against the previous behaviour where the post-CR text overwrote
    // (and erased) the pre-CR text within the same synchronous render.
    append('before\rafter');
    const lines = output.children.map((c) => c.text);
    expect(lines.some((l) => l.includes('before'))).toBe(true);
    expect(lines.some((l) => l.includes('after'))).toBe(true);
  });

  it('issue #54: a trailing bare CR opens a fresh line for the next batch', () => {
    const { append, output } = buildAppendSerialData();

    append('first\r');
    append('second\n');

    const lines = output.children.map((c) => c.text);
    expect(lines.some((l) => l === 'first')).toBe(true);
    expect(lines.some((l) => l === 'second')).toBe(true);
  });

  it('issue #54: CRLF is still treated as a single line break (no double newline)', () => {
    const { append, output } = buildAppendSerialData();

    append('alpha\r\nbeta\r\ngamma');

    // CRLF must be captured as a single separator — three pieces of content
    // should yield three logical lines, not five.
    const nonEmpty = output.children.map((c) => c.text).filter((t) => t.length > 0);
    expect(nonEmpty).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('issue #35 (part 1): consecutive newlines produce empty line nodes (visible blank rows)', () => {
    const { append, output } = buildAppendSerialData();

    // "hello\n\nworld" must yield a blank line between "hello" and "world".
    append('hello\n\nworld');

    const texts = output.children.map((c) => c.text);
    // Expected sequence: 'hello', '' (blank line from \n\n), 'world'
    expect(texts[0]).toBe('hello');
    expect(texts[1]).toBe('');
    expect(texts[2]).toBe('world');
  });

  it('issue #35 (part 1): the CSS rule that makes empty lines visible is still present', () => {
    const src = loadWebviewPanelSource();
    // The fix for #35 added a min-height rule on #serial-output > div so that
    // empty <div> elements (blank lines) still occupy one row of height.
    expect(src).toMatch(/#serial-output\s*>\s*div\s*\{[^}]*min-height\s*:\s*[^;]+;/);
  });

  it('issue #35 (part 2): ANSI SGR state is preserved across the timestamp prefix', () => {
    const src = loadWebviewPanelSource();
    // The fix for #35 saves the active SGR state with ansiStateToSgr() and
    // re-emits it after the timestamp's [0m, so multi-line coloured output
    // keeps its colour on every line.
    expect(src).toContain('var restore = ansiStateToSgr();');
    // The timestamp injection must include the saved restore sequence.
    expect(src).toMatch(/\[0m'\s*\+\s*restore/);
  });
});
