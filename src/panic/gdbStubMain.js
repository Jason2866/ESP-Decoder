'use strict';

// GDB remote-serial-protocol stub served over stdio, spawned by GDB via
// `target remote |<cmd>` (see gdbStub.ts). Plain JS on purpose: the spawned
// process runs `process.execPath` (node/ELECTRON_RUN_AS_NODE) directly, so it
// cannot import TypeScript sources. Keep the register order in sync with
// gdbRegsInfoRiscvIlp32 in panicParse.ts — it is the 'g' packet layout.

const RISCV_REGS_ILP32 = [
  'X0', 'RA', 'SP', 'GP', 'TP', 'T0', 'T1', 'T2',
  'S0/FP', 'S1', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5',
  'A6', 'A7', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7',
  'S8', 'S9', 'S10', 'S11', 'T3', 'T4', 'T5', 'T6',
  'MEPC',
];

const MAX_MEM_READ_SIZE = 0x10000;

function loadPanicInfo(path) {
  const raw = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
  // Buffer survives JSON as { type: 'Buffer', data: [...] }
  const sd = raw.stackData;
  const stackData = Buffer.isBuffer(sd)
    ? sd
    : Buffer.from(Array.isArray(sd) ? sd : sd && sd.data ? sd.data : []);
  return { ...raw, stackData };
}

class Stub {
  constructor(panicInfo) {
    this.panicInfo = panicInfo;
    this.pending = '';
    this.out = '';
  }

  push(data) {
    this.pending += data;
    while (this.pending.length > 0) {
      if (this.pending.startsWith('+')) {
        this.pending = this.pending.slice(1);
        continue;
      }
      if (this.pending.startsWith('-')) {
        // NAK from GDB: nothing sensible to do; drop the pending bytes.
        this.out += '-';
        this.pending = '';
        return;
      }
      const packetStart = this.pending.indexOf('$');
      if (packetStart === -1) {
        this.pending = '';
        return;
      }
      if (packetStart > 0) {
        this.pending = this.pending.slice(packetStart);
      }
      const checksumMark = this.pending.indexOf('#', 1);
      if (checksumMark === -1 || checksumMark + 2 >= this.pending.length) {
        return;
      }
      const packet = this.pending.slice(0, checksumMark + 3);
      this.pending = this.pending.slice(checksumMark + 3);
      this.handleCommand(packet);
    }
  }

  flush() {
    if (this.out) {
      process.stdout.write(this.out);
      this.out = '';
    }
  }

  respond(data) {
    const checksum = Buffer.from(data, 'ascii').reduce((sum, b) => sum + b, 0) & 0xff;
    this.out += `$${data}#${checksum.toString(16).padStart(2, '0')}`;
  }

  handleCommand(buffer) {
    if (buffer.startsWith('+')) {
      buffer = buffer.slice(1);
    }
    const command = buffer.slice(1, -3); // strip '$' and '#cs'
    this.out += '+'; // acknowledge the command

    if (command === '?') {
      this.respond('T05');
    } else if (command.startsWith('Hg') || command.startsWith('Hc')) {
      this.respond('OK');
    } else if (command === 'qfThreadInfo') {
      this.respond('m1');
    } else if (command === 'qC') {
      this.respond('QC1');
    } else if (command === 'g') {
      this.respondRegs();
    } else if (command.startsWith('m')) {
      this.handleMemRead(command);
    } else if (command.startsWith('vKill') || command === 'k') {
      this.respond('OK');
      this.flush();
      process.exit(0);
    } else {
      // Empty response required for any unknown command.
      this.respond('');
    }
    this.flush();
  }

  respondRegs() {
    let response = '';
    const regs = this.panicInfo.regs || {};
    for (const regName of RISCV_REGS_ILP32) {
      const value = regs[regName];
      if (value === undefined && regName !== 'X0') {
        // Eight 'x' characters mark an unavailable 32-bit register; a captured
        // zero (and X0, hardwired to zero) still encodes as 8 zero hex chars.
        response += 'xxxxxxxx';
        continue;
      }
      const regBytes = Buffer.alloc(4);
      regBytes.writeUInt32LE((value || 0) >>> 0);
      response += regBytes.toString('hex');
    }
    this.respond(response);
  }

  handleMemRead(command) {
    const parts = command.slice(1).split(',');
    const addr = parseInt(parts[0], 16);
    const size = parseInt(parts[1], 16);
    const addrValid = Number.isInteger(addr) && addr >= 0 && addr <= 0xffffffff;
    const sizeValid = Number.isInteger(size) && size >= 0 && size <= MAX_MEM_READ_SIZE;
    if (!addrValid || !sizeValid || addr + size > 0x100000000) {
      this.respond('E01');
      return;
    }
    this.respondMem(addr, size);
  }

  respondMem(startAddr, size) {
    const stackAddrMin = this.panicInfo.stackBaseAddr || 0;
    const stackData = this.panicInfo.stackData || Buffer.alloc(0);
    const stackAddrMax = stackAddrMin + stackData.length;
    const inStack = (addr) => stackAddrMin <= addr && addr < stackAddrMax;

    // A range that partially overlaps the captured stack would report the
    // uncaptured tail as zero bytes — GDB would read phantom zeros for a
    // saved register or argument. Reject it instead; reads fully outside
    // the capture keep the zero-fill model, fully inside return real bytes.
    if (stackData.length > 0) {
      const rangeEnd = startAddr + size;
      const overlaps = startAddr < stackAddrMax && rangeEnd > stackAddrMin;
      const fullyInside = startAddr >= stackAddrMin && rangeEnd <= stackAddrMax;
      if (overlaps && !fullyInside) {
        this.respond('E01');
        return;
      }
    }

    let result = '';
    for (let offset = 0; offset < size; offset++) {
      const addr = startAddr + offset;
      result += inStack(addr)
        ? stackData[addr - stackAddrMin].toString(16).padStart(2, '0')
        : '00';
    }
    this.respond(result);
  }
}

function main() {
  const infoPath = process.argv[2];
  if (!infoPath) {
    process.stderr.write('usage: gdbStubMain.js <panic-info.json>\n');
    process.exit(2);
  }
  let panicInfo;
  try {
    panicInfo = loadPanicInfo(infoPath);
  } catch (err) {
    process.stderr.write(`failed to load panic info: ${err}\n`);
    process.exit(2);
  }
  const stub = new Stub(panicInfo);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    stub.push(data);
  });
  process.stdin.on('end', () => process.exit(0));
}
if (require.main === module) {
  main();
}

module.exports = { Stub, loadPanicInfo };
