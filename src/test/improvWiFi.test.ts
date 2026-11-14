/**
 * Unit tests for the Improv-WiFi serial protocol engine.
 *
 * The engine is transport-agnostic and vscode-free, so a fake device is
 * simulated by inspecting the bytes the engine writes and feeding crafted
 * response frames back via engine.feed().
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ImprovEngine,
  ImprovType,
  ImprovState,
  ImprovError,
  ImprovRPCCommand,
  encodePacket,
  encodeRPC,
  IMPROV_HEADER,
  IMPROV_VERSION,
  withImprovSession,
} from '../improvWiFi';

// --- helpers to build device->host frames the way firmware would ----------

function checksum(bytes: number[]): number {
  let s = 0;
  for (const b of bytes) {
    s += b;
  }
  return s & 0xff;
}

/** Build a raw frame for the given type/payload (device-side encoder). */
function frame(type: ImprovType, payload: number[]): Buffer {
  const body = [...IMPROV_HEADER, IMPROV_VERSION, type, payload.length, ...payload];
  return Buffer.from([...body, checksum(body), 0x0a]);
}

/**
 * Frame WITHOUT a trailing newline — exactly what the Arduino ImprovWiFi
 * library emits (sendResponse() ends at the checksum). The newline is optional
 * per spec and the parser must not require it.
 */
function frameNoNewline(type: ImprovType, payload: number[]): Buffer {
  const body = [...IMPROV_HEADER, IMPROV_VERSION, type, payload.length, ...payload];
  return Buffer.from([...body, checksum(body)]);
}

/** Encode a list of strings as length-prefixed blob (for RPC results). */
function strings(...items: string[]): number[] {
  const blob: number[] = [];
  for (const s of items) {
    const b = Array.from(Buffer.from(s, 'utf-8'));
    blob.push(b.length, ...b);
  }
  return blob;
}

/** RPC result payload: [command, blobLength, ...blob]. */
function rpcResult(command: ImprovRPCCommand, ...items: string[]): number[] {
  const blob = strings(...items);
  return [command, blob.length, ...blob];
}

// --- encode / checksum ----------------------------------------------------

describe('encodePacket', () => {
  it('frames header, version, type, length, payload, checksum, newline', () => {
    const pkt = encodePacket(ImprovType.RPCCommand, [0x02, 0x00]);
    expect(Array.from(pkt.subarray(0, 6))).toEqual(IMPROV_HEADER);
    expect(pkt[6]).toBe(IMPROV_VERSION);
    expect(pkt[7]).toBe(ImprovType.RPCCommand);
    expect(pkt[8]).toBe(2); // payload length
    expect(pkt[pkt.length - 1]).toBe(0x0a);
    // checksum is sum of every byte before it
    const expected = checksum(Array.from(pkt.subarray(0, pkt.length - 2)));
    expect(pkt[pkt.length - 2]).toBe(expected);
  });

  it('encodeRPC prefixes command and data length', () => {
    const pkt = encodeRPC(ImprovRPCCommand.RequestCurrentState, []);
    // payload = [command, dataLength]
    expect(pkt[9]).toBe(ImprovRPCCommand.RequestCurrentState);
    expect(pkt[10]).toBe(0);
  });
});

// --- requestInfo ----------------------------------------------------------

describe('ImprovEngine.requestInfo', () => {
  it('decodes the four info strings', async () => {
    const engine = new ImprovEngine(async (data) => {
      // device replies with a device-information RPC result
      engine.feed(
        frame(
          ImprovType.RPCResult,
          rpcResult(ImprovRPCCommand.RequestDeviceInformation, 'MyFirmware', '1.2.3', 'ESP32', 'living-room'),
        ),
      );
      void data;
    }, 1000);

    const info = await engine.requestInfo();
    expect(info).toEqual({
      firmware: 'MyFirmware',
      version: '1.2.3',
      chipFamily: 'ESP32',
      name: 'living-room',
    });
  });
});

// --- scan: multi-response assembly ---------------------------------------

describe('ImprovEngine.scan', () => {
  it('collects networks until the terminating empty result, sorted by rssi desc', async () => {
    const engine = new ImprovEngine(async () => {
      engine.feed(frame(ImprovType.RPCResult, rpcResult(ImprovRPCCommand.RequestScannedWifiNetworks, 'NetA', '-70', 'YES')));
      engine.feed(frame(ImprovType.RPCResult, rpcResult(ImprovRPCCommand.RequestScannedWifiNetworks, 'NetB', '-40', 'NO')));
      // terminating empty result (blobLength 0)
      engine.feed(frame(ImprovType.RPCResult, [ImprovRPCCommand.RequestScannedWifiNetworks, 0]));
    }, 1000);

    const nets = await engine.scan();
    expect(nets).toEqual([
      { ssid: 'NetB', rssi: -40, secured: false },
      { ssid: 'NetA', rssi: -70, secured: true },
    ]);
  });
});

// --- provision: success + error ------------------------------------------

describe('ImprovEngine.provision', () => {
  it('resolves with next-url(s) on success', async () => {
    const engine = new ImprovEngine(async () => {
      engine.feed(frame(ImprovType.CurrentState, [ImprovState.Provisioning]));
      engine.feed(frame(ImprovType.RPCResult, rpcResult(ImprovRPCCommand.SendWifiSettings, 'http://192.168.1.50')));
    }, 1000);

    const res = await engine.provision('home', 'secret');
    expect(res.nextUrl).toEqual(['http://192.168.1.50']);
  });

  it('rejects when the device reports an error state', async () => {
    const engine = new ImprovEngine(async () => {
      engine.feed(frame(ImprovType.ErrorState, [ImprovError.UnableToConnect]));
    }, 1000);

    await expect(engine.provision('home', 'wrongpw')).rejects.toThrow(/UnableToConnect|error/i);
  });

  it('sends credentials length-prefixed in the RPC payload', async () => {
    const writes: Buffer[] = [];
    const engine = new ImprovEngine(async (data) => {
      writes.push(data);
      engine.feed(frame(ImprovType.RPCResult, rpcResult(ImprovRPCCommand.SendWifiSettings)));
    }, 1000);

    await engine.provision('ab', 'xyz');
    const sent = writes[0];
    // payload: [cmd, dataLen, ssidLen, 'a','b', pwLen, 'x','y','z']
    expect(sent[9]).toBe(ImprovRPCCommand.SendWifiSettings);
    const dataLen = sent[10];
    const payload = Array.from(sent.subarray(11, 11 + dataLen));
    expect(payload).toEqual([2, 0x61, 0x62, 3, 0x78, 0x79, 0x7a]);
  });
});

// --- parser robustness ----------------------------------------------------

describe('frame parser', () => {
  it('tolerates interleaved log noise and split chunks', async () => {
    const engine = new ImprovEngine(async () => {
      const f = frame(ImprovType.RPCResult, rpcResult(ImprovRPCCommand.RequestDeviceInformation, 'fw', 'v', 'chip', 'n'));
      // prepend log noise, then split the frame across two feeds
      engine.feed(Buffer.concat([Buffer.from('I (123) boot: some log line\n'), f.subarray(0, 5)]));
      engine.feed(f.subarray(5));
    }, 1000);

    const info = await engine.requestInfo();
    expect(info.firmware).toBe('fw');
  });

  it('decodes a frame with no trailing newline (Arduino ImprovWiFi lib)', async () => {
    const engine = new ImprovEngine(async () => {
      engine.feed(
        frameNoNewline(
          ImprovType.RPCResult,
          rpcResult(ImprovRPCCommand.RequestDeviceInformation, 'fw', 'v', 'chip', 'name'),
        ),
      );
    }, 1000);

    const info = await engine.requestInfo();
    expect(info).toEqual({ firmware: 'fw', version: 'v', chipFamily: 'chip', name: 'name' });
  });

  it('ignores a frame with a bad checksum', async () => {
    vi.useFakeTimers();
    const engine = new ImprovEngine(async () => {
      const f = frame(ImprovType.RPCResult, rpcResult(ImprovRPCCommand.RequestDeviceInformation, 'fw', 'v', 'c', 'n'));
      f[f.length - 2] = (f[f.length - 2] + 1) & 0xff; // corrupt checksum
      engine.feed(f);
    }, 5000);

    const p = engine.requestInfo();
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    vi.useRealTimers();
  });
});

// --- timeout --------------------------------------------------------------

describe('command timeout', () => {
  it('rejects when no response arrives', async () => {
    vi.useFakeTimers();
    const engine = new ImprovEngine(async () => {
      /* device says nothing */
    }, 2000);
    const p = engine.requestInfo();
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    vi.useRealTimers();
  });
});

// --- withImprovSession ----------------------------------------------------

describe('withImprovSession', () => {
  it('installs and always clears the RX interceptor', async () => {
    let interceptor: ((d: Buffer) => void) | null = null;
    const transport = {
      isConnected: true,
      writeBytes: vi.fn(async (data: Buffer) => {
        // echo a device-info reply back through the interceptor
        interceptor?.(
          frame(ImprovType.RPCResult, rpcResult(ImprovRPCCommand.RequestDeviceInformation, 'fw', 'v', 'c', 'n')),
        );
        void data;
      }),
      setRxInterceptor: vi.fn((fn: ((d: Buffer) => void) | null) => {
        interceptor = fn;
      }),
    };

    const info = await withImprovSession(transport, 1000, (engine) => engine.requestInfo());
    expect(info.firmware).toBe('fw');
    // interceptor installed once and cleared with null at the end
    expect(transport.setRxInterceptor).toHaveBeenLastCalledWith(null);
  });

  it('clears the interceptor even when the body throws', async () => {
    const transport = {
      isConnected: true,
      writeBytes: vi.fn(async () => {}),
      setRxInterceptor: vi.fn(),
    };
    await expect(
      withImprovSession(transport, 1000, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(transport.setRxInterceptor).toHaveBeenLastCalledWith(null);
  });

  it('throws if the transport is not connected', async () => {
    const transport = {
      isConnected: false,
      writeBytes: vi.fn(),
      setRxInterceptor: vi.fn(),
    };
    await expect(withImprovSession(transport, 1000, async () => 'x')).rejects.toThrow(/not connected/i);
    expect(transport.setRxInterceptor).not.toHaveBeenCalled();
  });
});
