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
  /** In-flight directory removal shared by repeated close() calls. */
  private cleanupPromise?: Promise<void>;
  /** Synchronous startup reservation: concurrent start() calls must not
   * both pass the tempDir check while mkdtemp is in flight. */
  private starting = false;
  private abortSignal?: AbortSignal;
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
    if (this.tempDir || this.starting) {
      throw new Error('Server already started');
    }
    if (signal?.aborted) {
      throw new AbortError();
    }
    this.starting = true;
    // The directory stays local until setup succeeds; this.tempDir is only
    // assigned on success so a failed start leaves no half-initialized
    // state and close() cannot delete a directory it does not own yet.
    let dir: string | undefined;

    // During setup, cancellation is only recorded — start() still owns the
    // temp directory and cleans it up itself before rejecting. Removing it
    // here would race the in-flight mkdtemp/writeFile and could delete the
    // directory while panic-info.json is still being written.
    let cancelled = false;
    const onSetupAbort = () => {
      cancelled = true;
      this.debug('User abort');
    };
    signal?.addEventListener('abort', onSetupAbort, { once: true });

    try {
      dir = await mkdtemp(path.join(tmpdir(), 'esp-decoder-gdbstub-'));
      const infoPath = path.join(dir, 'panic-info.json');
      // stackData is a Buffer; JSON.stringify encodes it as
      // { type: 'Buffer', data: [...] } which gdbStubMain.js revives.
      await writeFile(infoPath, JSON.stringify(this.panicInfo));

      // The abort listener may have fired during the async setup above;
      // do not hand out a remote spec for a cancelled decode.
      if (cancelled || signal?.aborted) {
        signal?.removeEventListener('abort', onSetupAbort);
        throw new AbortError();
      }

      const scriptPath = path.join(__dirname, 'gdbStubMain.js');
      const remoteSpec = this.buildRemoteSpec(scriptPath, infoPath);
      this.debug('gdb stub remote spec', remoteSpec);
      // Startup succeeded — publish the directory, then transfer cleanup
      // ownership to the abort handler. No await sits between the
      // cancellation check above and this swap, so an abort cannot slip
      // through unhandled. A new run also drops the previous run's
      // retained cleanup promise.
      this.cleanupPromise = undefined;
      this.tempDir = dir;
      signal?.removeEventListener('abort', onSetupAbort);
      this.abortSignal = signal;
      this.abortHandler = () => {
        this.debug('User abort');
        void this.close();
      };
      signal?.addEventListener('abort', this.abortHandler, { once: true });
      return { remoteSpec };
    } catch (err) {
      signal?.removeEventListener('abort', onSetupAbort);
      if (dir) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      this.abortHandler = undefined;
      this.abortSignal = undefined;
      throw err;
    } finally {
      this.starting = false;
    }
  }

  private buildRemoteSpec(scriptPath: string, infoPath: string): string {
    if (process.platform === 'win32') {
      // MinGW GDB runs `|cmd` via CreateProcess on the first token — it does
      // NOT invoke cmd.exe or a shell, so a .cmd wrapper or `VAR=1` prefix
      // cannot work. Launch cmd.exe directly (it is a real executable) and
      // let it set ELECTRON_RUN_AS_NODE (the VS Code binary is Electron)
      // before starting the Node-compatible stub binary.
      const comspec = process.env.ComSpec || 'cmd.exe';
      const q = (p: string) => `"${p.replace(/"/g, '')}"`;
      return `|${q(comspec)} /c set "ELECTRON_RUN_AS_NODE=1" && ${q(process.execPath)} ${q(scriptPath)} ${q(infoPath)}`;
    }
    return `|ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} ${shellQuote(infoPath)}`;
  }

  async close(): Promise<void> {
    // Repeated/concurrent calls await the same in-flight removal rather
    // than returning early while the directory is still being deleted.
    if (this.cleanupPromise) {
      await this.cleanupPromise;
      return;
    }
    const dir = this.tempDir;
    this.tempDir = undefined;
    // Detach the abort listener registered by THIS startup so a stale
    // signal cannot close a later run on the same server instance.
    if (this.abortHandler) {
      this.abortSignal?.removeEventListener('abort', this.abortHandler);
    }
    this.abortSignal = undefined;
    this.abortHandler = undefined;
    if (dir) {
      // Best-effort cleanup; the stub process exits on stdin EOF anyway.
      this.cleanupPromise = rm(dir, { recursive: true, force: true }).catch(() => {});
      await this.cleanupPromise;
    }
  }
}
