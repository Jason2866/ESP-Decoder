/**
 * Unit tests for SerialPortManager.filterPorts regex filtering.
 *
 * Covers platform-specific filtering for darwin (macOS), linux, and win32
 * to prevent regressions in Bluetooth/internal port exclusion.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SerialPortManager } from '../serialPortManager.js';

// Mock vscode before importing SerialPortManager
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

  return {
    EventEmitter,
    window: {
      createOutputChannel: () => ({
        appendLine: () => {},
        dispose: () => {},
      }),
    },
    workspace: {
      getConfiguration: () => ({
        get: () => 115200,
      }),
    },
    Disposable: class {
      dispose() {}
    },
  };
});

interface PortEntry {
  path: string;
  manufacturer?: string;
}

interface FilterPortsTestCase {
  name: string;
  platform: 'darwin' | 'linux' | 'win32';
  input: PortEntry[];
  expectedKeptPaths: string[];
  expectedFilteredPaths: string[];
}

describe('SerialPortManager.filterPorts', () => {
  let manager: SerialPortManager;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    manager = new SerialPortManager();
  });

  afterEach(() => {
    // Restore original platform
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    } else {
      // If there was no original descriptor, delete the mock
      // @ts-expect-error: platform is read-only
      delete process.platform;
    }
  });

  function setPlatform(platform: 'darwin' | 'linux' | 'win32') {
    Object.defineProperty(process, 'platform', {
      value: platform,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  const testCases: FilterPortsTestCase[] = [
    // Darwin (macOS) tests
    {
      name: 'filterPorts filters out .Bluetooth paths on darwin',
      platform: 'darwin',
      input: [
        { path: '/dev/tty.usbserial-1234' },
        { path: '/dev/tty.Bluetooth-Incoming-Port' },
        { path: '/dev/tty.usbmodem-5678' },
      ],
      expectedKeptPaths: ['/dev/tty.usbserial-1234', '/dev/tty.usbmodem-5678'],
      expectedFilteredPaths: ['/dev/tty.Bluetooth-Incoming-Port'],
    },
    {
      name: 'filterPorts filters out .debug paths on darwin (case insensitive)',
      platform: 'darwin',
      input: [
        { path: '/dev/tty.debug-xyz' },
        { path: '/dev/tty.DEBUG-ABC' },
        { path: '/dev/tty.usbserial-1234' },
      ],
      expectedKeptPaths: ['/dev/tty.usbserial-1234'],
      expectedFilteredPaths: ['/dev/tty.debug-xyz', '/dev/tty.DEBUG-ABC'],
    },
    {
      name: 'filterPorts handles mixed Bluetooth and debug on darwin',
      platform: 'darwin',
      input: [
        { path: '/dev/tty.Bluetooth-Keyboard' },
        { path: '/dev/tty.debug-console' },
        { path: '/dev/tty.usbserial-FTDI123' },
        { path: '/dev/cu.usbserial-FTDI123' },
      ],
      expectedKeptPaths: ['/dev/tty.usbserial-FTDI123', '/dev/cu.usbserial-FTDI123'],
      expectedFilteredPaths: ['/dev/tty.Bluetooth-Keyboard', '/dev/tty.debug-console'],
    },

    // Linux tests
    {
      name: 'filterPorts filters out /ttyS0 on linux',
      platform: 'linux',
      input: [
        { path: '/dev/ttyUSB0' },
        { path: '/dev/ttyS0' },
        { path: '/dev/ttyACM0' },
      ],
      expectedKeptPaths: ['/dev/ttyUSB0', '/dev/ttyACM0'],
      expectedFilteredPaths: ['/dev/ttyS0'],
    },
    {
      name: 'filterPorts filters out all /ttyS* ports on linux',
      platform: 'linux',
      input: [
        { path: '/dev/ttyS0' },
        { path: '/dev/ttyS1' },
        { path: '/dev/ttyS99' },
        { path: '/dev/ttyUSB0' },
      ],
      expectedKeptPaths: ['/dev/ttyUSB0'],
      expectedFilteredPaths: ['/dev/ttyS0', '/dev/ttyS1', '/dev/ttyS99'],
    },
    {
      name: 'filterPorts filters out /rfcomm ports on linux',
      platform: 'linux',
      input: [
        { path: '/dev/rfcomm0' },
        { path: '/dev/rfcomm1' },
        { path: '/dev/rfcomm99' },
        { path: '/dev/ttyUSB0' },
      ],
      expectedKeptPaths: ['/dev/ttyUSB0'],
      expectedFilteredPaths: ['/dev/rfcomm0', '/dev/rfcomm1', '/dev/rfcomm99'],
    },
    {
      name: 'filterPorts handles mixed ttyS and rfcomm on linux',
      platform: 'linux',
      input: [
        { path: '/dev/rfcomm0' },
        { path: '/dev/ttyS0' },
        { path: '/dev/ttyS5' },
        { path: '/dev/ttyUSB0' },
        { path: '/dev/ttyACM0' },
      ],
      expectedKeptPaths: ['/dev/ttyUSB0', '/dev/ttyACM0'],
      expectedFilteredPaths: ['/dev/rfcomm0', '/dev/ttyS0', '/dev/ttyS5'],
    },

    // Win32 tests
    {
      name: 'filterPorts filters out Bluetooth manufacturer on win32',
      platform: 'win32',
      input: [
        { path: 'COM3', manufacturer: 'Silicon Labs' },
        { path: 'COM4', manufacturer: 'Microsoft Bluetooth' },
        { path: 'COM5', manufacturer: 'FTDI' },
      ],
      expectedKeptPaths: ['COM3', 'COM5'],
      expectedFilteredPaths: ['COM4'],
    },
    {
      name: 'filterPorts filters out bluetooth (lowercase) manufacturer on win32',
      platform: 'win32',
      input: [
        { path: 'COM1', manufacturer: 'Generic bluetooth adapter' },
        { path: 'COM2', manufacturer: 'Bluetooth Serial' },
        { path: 'COM3', manufacturer: 'Prolific' },
      ],
      expectedKeptPaths: ['COM3'],
      expectedFilteredPaths: ['COM1', 'COM2'],
    },
    {
      name: 'filterPorts handles empty/undefined manufacturer on win32',
      platform: 'win32',
      input: [
        { path: 'COM1', manufacturer: undefined },
        { path: 'COM2', manufacturer: '' },
        { path: 'COM3', manufacturer: 'Unknown' },
        { path: 'COM4', manufacturer: 'Bluetooth' },
      ],
      expectedKeptPaths: ['COM1', 'COM2', 'COM3'],
      expectedFilteredPaths: ['COM4'],
    },
    {
      name: 'filterPorts keeps all ports on win32 when no Bluetooth',
      platform: 'win32',
      input: [
        { path: 'COM1', manufacturer: 'Silicon Labs' },
        { path: 'COM2', manufacturer: 'FTDI' },
        { path: 'COM3', manufacturer: 'Prolific' },
      ],
      expectedKeptPaths: ['COM1', 'COM2', 'COM3'],
      expectedFilteredPaths: [],
    },

    // Edge cases - empty arrays
    {
      name: 'filterPorts returns empty array when given empty array (darwin)',
      platform: 'darwin',
      input: [],
      expectedKeptPaths: [],
      expectedFilteredPaths: [],
    },
    {
      name: 'filterPorts returns empty array when given empty array (linux)',
      platform: 'linux',
      input: [],
      expectedKeptPaths: [],
      expectedFilteredPaths: [],
    },
    {
      name: 'filterPorts returns empty array when given empty array (win32)',
      platform: 'win32',
      input: [],
      expectedKeptPaths: [],
      expectedFilteredPaths: [],
    },

    // Edge cases - all filtered
    {
      name: 'filterPorts returns empty array when all ports filtered (darwin)',
      platform: 'darwin',
      input: [
        { path: '/dev/tty.Bluetooth-1' },
        { path: '/dev/tty.debug-2' },
      ],
      expectedKeptPaths: [],
      expectedFilteredPaths: ['/dev/tty.Bluetooth-1', '/dev/tty.debug-2'],
    },
    {
      name: 'filterPorts returns empty array when all ports filtered (linux)',
      platform: 'linux',
      input: [
        { path: '/dev/ttyS0' },
        { path: '/dev/rfcomm0' },
      ],
      expectedKeptPaths: [],
      expectedFilteredPaths: ['/dev/ttyS0', '/dev/rfcomm0'],
    },
    {
      name: 'filterPorts returns empty array when all ports filtered (win32)',
      platform: 'win32',
      input: [
        { path: 'COM1', manufacturer: 'Bluetooth 1' },
        { path: 'COM2', manufacturer: 'Bluetooth 2' },
      ],
      expectedKeptPaths: [],
      expectedFilteredPaths: ['COM1', 'COM2'],
    },
  ];

  testCases.forEach((testCase) => {
    it(testCase.name, () => {
      setPlatform(testCase.platform);
      const result = manager.filterPorts(testCase.input);

      const resultPaths = result.map((p) => p.path);

      expect(resultPaths).toEqual(testCase.expectedKeptPaths);

      // Verify filtered paths are NOT in the result
      for (const filteredPath of testCase.expectedFilteredPaths) {
        expect(resultPaths).not.toContain(filteredPath);
      }
    });
  });

  describe('filterPorts handles unknown platform gracefully', () => {
    it('returns all ports unfiltered for unknown platform', () => {
      Object.defineProperty(process, 'platform', {
        value: 'freebsd',
        writable: true,
        enumerable: true,
        configurable: true,
      });

      const input: PortEntry[] = [
        { path: '/dev/cuaU0' },
        { path: '/dev/cuaU1' },
      ];

      const result = manager.filterPorts(input);
      expect(result).toEqual(input);
    });
  });
});
