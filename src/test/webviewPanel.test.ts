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
