import net from 'node:net';
import type { Debug, PanicInfoWithStackData } from './types';
import { gdbRegsInfoRiscvIlp32 } from './panicParse';

export class AbortError extends Error {
  readonly code = 'ABORT_ERR';
  constructor() {
    super('User abort');
    this.name = 'AbortError';
  }
}

/**
 * Minimal GDB remote-serial-protocol server, modeled on esp-idf-panic-decoder's
 * gdb_panic_server.py: answers register ('g') and memory ('m') packets from
 * the parsed panic dump. Only stack RAM returns real data; all other memory
 * reads return 0x00 bytes (GDB resolves code/symbols from the ELF itself).
 */
export class GdbStubServer {
  private server?: net.Server;

  constructor(
    private readonly panicInfo: PanicInfoWithStackData,
    private readonly debug: Debug = () => {},
  ) {}

  async start(signal?: AbortSignal): Promise<net.AddressInfo> {
    if (this.server) {
      throw new Error('Server already started');
    }

    const server = net.createServer();
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const listeners: (() => void)[] = [];
      const cleanup = () => {
        for (const remove of listeners) {
          remove();
        }
      };

      const abortHandler = () => {
        this.debug('User abort');
        cleanup();
        this.close();
        reject(new AbortError());
      };

      const errorHandler = (err: Error) => {
        this.debug('Server error', err);
        cleanup();
        this.close();
        reject(err);
      };

      if (signal?.aborted) {
        abortHandler();
        return;
      }

      signal?.addEventListener('abort', abortHandler);
      listeners.push(() => signal?.removeEventListener('abort', abortHandler));

      server.on('error', errorHandler);
      listeners.push(() => server.removeListener('error', errorHandler));

      const listeningHandler = () => {
        cleanup();
        resolve();
      };
      server.on('listening', listeningHandler);
      listeners.push(() => server.removeListener('listening', listeningHandler));

      server.listen(0, '127.0.0.1');
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      this.close();
      throw new Error('Failed to start GDB stub server');
    }

    server.on('connection', (socket) => {
      socket.on('error', () => socket.destroy());
      let pending = '';
      socket.on('data', (data) => {
        pending = this.consumePackets(pending + data.toString(), socket);
      });
    });

    return address;
  }

  private consumePackets(pending: string, socket: net.Socket): string {
    while (pending.length > 0) {
      if (pending.startsWith('+')) {
        pending = pending.slice(1);
        continue;
      }

      if (pending.startsWith('-')) {
        this.debug(`Invalid command: ${pending}`);
        socket.write('-');
        socket.end();
        return '';
      }

      const packetStart = pending.indexOf('$');
      if (packetStart === -1) {
        this.debug(`Discarding non-packet data: ${JSON.stringify(pending)}`);
        return '';
      }
      if (packetStart > 0) {
        const ignored = pending.slice(0, packetStart);
        this.debug(`Discarding packet prefix: ${JSON.stringify(ignored)}`);
        pending = pending.slice(packetStart);
      }

      const checksumMark = pending.indexOf('#', 1);
      if (checksumMark === -1 || checksumMark + 2 >= pending.length) {
        return pending;
      }

      const packet = pending.slice(0, checksumMark + 3);
      pending = pending.slice(checksumMark + 3);
      this.debug(`Command: ${packet}`);
      this.handleCommand(packet, socket);
    }

    return pending;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
  }

  private handleCommand(buffer: string, socket: net.Socket): void {
    if (buffer.startsWith('+')) {
      buffer = buffer.slice(1); // ignore the leading '+'
    }

    const command = buffer.slice(1, -3); // ignore checksums
    // Acknowledge the command
    socket.write('+');
    this.debug(`Raw buffer (length ${buffer.length}): ${JSON.stringify(buffer)}`);
    this.debug(`Got command: ${command}`);
    if (command === '?') {
      // report sigtrap as the stop reason; the exact reason doesn't matter for backtracing
      this.debug('Responding with: T05');
      this.respond('T05', socket);
    } else if (command.startsWith('Hg') || command.startsWith('Hc')) {
      // Select thread command
      this.debug('Responding with: OK');
      this.respond('OK', socket);
    } else if (command === 'qfThreadInfo') {
      // Only one thread for now, can be extended to show one thread per core.
      this.debug('Responding with: m1');
      this.respond('m1', socket);
    } else if (command === 'qC') {
      this.debug('Responding with: QC1');
      this.respond('QC1', socket);
    } else if (command === 'g') {
      // Registers read
      this.respondRegs(socket);
    } else if (command.startsWith('m')) {
      // Memory read
      const [addr, size] = command
        .slice(1)
        .split(',')
        .map((v) => parseInt(v, 16));
      this.respondMem(addr, size, socket);
    } else if (command.startsWith('vKill') || command === 'k') {
      // Quit
      this.debug('Responding with: OK');
      this.respond('OK', socket);
      socket.end();
    } else {
      // Empty response required for any unknown command
      this.debug('Responding with: (empty)');
      this.respond('', socket);
    }
  }

  private respond(data: string, socket: net.Socket): void {
    const checksum = Buffer.from(data, 'ascii').reduce((sum, byte) => sum + byte, 0) & 0xff;
    const res = `$${data}#${checksum.toString(16).padStart(2, '0')}`;
    socket.write(res);
    this.debug(`Wrote: ${res}`);
  }

  private respondRegs(socket: net.Socket): void {
    let response = '';
    // https://github.com/espressif/esp-idf-monitor/blob/fae383ecf281655abaa5e65433f671e274316d10/esp_idf_monitor/gdb_panic_server.py#L242-L247
    // For each register name in the ILP32 list, emit the register value as
    // 4 little-endian bytes in hex.
    for (const regName of gdbRegsInfoRiscvIlp32) {
      const regVal = this.panicInfo.regs[regName] || 0;
      const regBytes = Buffer.alloc(4);
      // Register values are serialized as 32-bit words; truncate wider
      // values instead of letting writeUInt32LE throw out-of-range.
      regBytes.writeUInt32LE(regVal >>> 0);
      response += regBytes.toString('hex');
    }
    this.debug(
      `Register values: ${gdbRegsInfoRiscvIlp32
        .map((r) => `${r}=${this.panicInfo.regs[r] || 0}`)
        .join(', ')}`,
    );
    this.debug(`Register response: ${response}`);
    this.respond(response, socket);
  }

  private respondMem(startAddr: number, size: number, socket: net.Socket): void {
    const stackAddrMin = this.panicInfo.stackBaseAddr;
    const stackData = this.panicInfo.stackData;
    const stackLen = stackData.length;
    const stackAddrMax = stackAddrMin + stackLen;

    const inStack = (addr: number) => stackAddrMin <= addr && addr < stackAddrMax;

    let result = '';
    for (let addr = startAddr; addr < startAddr + size; addr++) {
      if (!inStack(addr)) {
        result += '00';
      } else {
        result += stackData[addr - stackAddrMin].toString(16).padStart(2, '0');
      }
    }

    this.debug(`Memory read request from 0x${startAddr.toString(16)} for ${size} bytes`);
    this.debug(`Responding with memory: ${result}`);
    this.respond(result, socket);
  }
}
