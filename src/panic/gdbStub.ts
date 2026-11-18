import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Debug, PanicInfoWithStackData } from './types';

export class AbortError extends Error {
  readonly code = 'ABORT_ERR';
  constructor() {
    super('User abort');
    this.name = 'AbortError';
  }
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * GDB remote-serial-protocol stub, modeled on esp-idf-panic-decoder's
 * gdb_panic_server.py. Instead of opening a TCP listener, the panic state is
 * written to a temp JSON file and GDB spawns a small stdio server via
 * `target remote |<cmd>` — the remote protocol then travels over a private
 * pipe owned by the GDB process, so no other local process can attach.
 * The protocol implementation lives in gdbStubMain.js (plain JS, since the
 * spawned process runs node directly and cannot load TypeScript).
 */
export class GdbStubServer {
  private tempDir?: string;
  private abortHandler?: () => void;

  constructor(
    private readonly panicInfo: PanicInfoWithStackData,
    private readonly debug: Debug = () => {},
  ) {}

  /**
   * Prepare the stub and return the remote-spec argument for
   * `-target-select remote <remoteSpec>` (e.g. `|node stub.js info.json`).
   */
  async start(signal?: AbortSignal): Promise<{ remoteSpec: string }> {
    if (this.tempDir) {
      throw new Error('Server already started');
    }
    if (signal?.aborted) {
      throw new AbortError();
    }

    this.abortHandler = () => {
      this.debug('User abort');
      void this.close();
    };
    signal?.addEventListener('abort', this.abortHandler, { once: true });

    try {
      this.tempDir = await mkdtemp(path.join(tmpdir(), 'esp-decoder-gdbstub-'));
      const infoPath = path.join(this.tempDir, 'panic-info.json');
      // stackData is a Buffer; JSON.stringify encodes it as
      // { type: 'Buffer', data: [...] } which gdbStubMain.js revives.
      await writeFile(infoPath, JSON.stringify(this.panicInfo));

      const scriptPath = path.join(__dirname, 'gdbStubMain.js');
      const remoteSpec =
        process.platform === 'win32'
          ? await this.buildWindowsRemoteSpec(scriptPath, infoPath)
          : `|ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} ${shellQuote(infoPath)}`;
      this.debug('gdb stub remote spec', remoteSpec);
      return { remoteSpec };
    } catch (err) {
      signal?.removeEventListener('abort', this.abortHandler);
      this.abortHandler = undefined;
      await this.close();
      throw err;
    }
  }

  /**
   * On Windows `|cmd` goes through cmd.exe, which cannot parse the POSIX
   * `VAR=1 cmd` env prefix or single-quote escaping. Write a .cmd wrapper
   * that sets ELECTRON_RUN_AS_NODE (the VS Code binary is Electron) and
   * embeds the already-double-quoted paths.
   */
  private async buildWindowsRemoteSpec(scriptPath: string, infoPath: string): Promise<string> {
    const cmdPath = path.join(this.tempDir!, 'gdbstub.cmd');
    const q = (p: string) => `"${p.replace(/"/g, '""')}"`;
    const content = [
      '@echo off',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `${q(process.execPath)} ${q(scriptPath)} ${q(infoPath)}`,
      '',
    ].join('\r\n');
    await writeFile(cmdPath, content);
    return `|"${cmdPath}"`;
  }

  close(): void {
    const dir = this.tempDir;
    this.tempDir = undefined;
    if (dir) {
      // Best-effort cleanup; the stub process exits on stdin EOF anyway.
      void rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
