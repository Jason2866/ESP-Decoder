import { spawn } from 'node:child_process';
import { isParsedGDBLine, type AddrLine, type DecodeParams, type DecodeOptions, type Debug, type GDBLine, type ParsedGDBLine } from './types';
import { parseLines } from './gdbLineParse';
import { toHexString } from './panicParse';

const prompt = '(gdb)';
const notExecutableFormat = 'not in executable format';
const fileFormatNotRecognized = 'file format not recognized';
const noSuchFileOrDirectory = 'No such file or directory';

interface CommandQueueItem {
  cmd: string;
  resolve: (result: string) => void;
  reject: (reason: unknown) => void;
}

/** Long-lived interactive GDB session used to resolve addresses to source lines. */
class GDBSession {
  private readonly toolPath: string;
  private readonly elfPath: string;
  private error: Error | null = null;
  private didExecuteFirstCommand = false;
  private readonly gdb: ReturnType<typeof spawn>;
  private buffer = '';
  private readonly queue: CommandQueueItem[] = [];
  private current: { resolve: (r: string) => void; reject: (e: unknown) => void } | null = null;
  private startReject: ((err: Error) => void) | null = null;
  private startCleanup: (() => void) | null = null;

  constructor({ toolPath, elfPath }: Pick<DecodeParams, 'elfPath' | 'toolPath'>, options: DecodeOptions = {}) {
    this.toolPath = toolPath;
    this.elfPath = elfPath;
    this.gdb = spawn(toolPath, ['-nx', elfPath], {
      stdio: 'pipe',
      signal: options.signal,
    });
    this.gdb.stdout!.setEncoding('utf8');
    this.gdb.stderr!.setEncoding('utf8');
    this.gdb.stdout!.on('data', (chunk: string) => this.onData(chunk));
    this.gdb.stderr!.on('data', (chunk: string) => this.onData(chunk));
    this.gdb.on('error', (err) =>
      this.terminate(err instanceof Error ? err : new Error(String(err))),
    );
    this.gdb.stdin!.on('error', (err) =>
      this.terminate(err instanceof Error ? err : new Error(String(err))),
    );
    this.gdb.on('exit', (code, signal) => {
      if (!this.didExecuteFirstCommand) {
        // Exited (even cleanly) before the startup prompt — fail start().
        this.terminate(
          new Error(`GDB exited before startup completed (code=${code}, signal=${signal})`),
        );
        return;
      }
      // Any exit after startup — including SIGTERM — must fail pending and
      // queued commands instead of leaving exec() unsettled. An intentional
      // close() has no queued work, so terminate() is a no-op then.
      if (code !== 0 || signal !== null) {
        console.warn(`GDB exited (code=${code}, signal=${signal})`);
      }
      this.terminate(new Error(`GDB exited (code=${code}, signal=${signal})`));
    });
  }

  private terminate(err: Error): void {
    if (!this.error) {
      this.error = err;
    }
    this.startReject?.(this.error);
    this.startReject = null;
    this.startCleanup?.();
    this.startCleanup = null;
    if (this.current) {
      const { reject } = this.current;
      this.current = null;
      reject(this.error);
    }
    let item: CommandQueueItem | undefined;
    while ((item = this.queue.shift())) {
      item.reject(this.error);
    }
  }

  /**
   * Index of the '(gdb)' prompt that terminates the buffered response, or
   * -1. A valid prompt is followed by whitespace, sits at the end of the
   * buffer, and either starts a line or directly follows another prompt —
   * '(gdb)' inside source text (e.g. 'look for (gdb) here') fails the
   * predecessor check, so a transport chunk ending mid-line cannot fake a
   * prompt boundary. GDB separates consecutive prompts with spaces rather
   * than newlines ('(gdb) (gdb) '), which the chain alternative covers.
   */
  private promptBoundaryIndex(): number {
    let result = -1;
    const re = /\(gdb\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(this.buffer)) !== null) {
      const end = match.index + prompt.length;
      // The prompt must be trailed by whitespace and nothing else.
      if (!/^\s+$/.test(this.buffer.slice(end))) {
        continue;
      }
      const before = this.buffer.slice(0, match.index);
      if (/(?:^|[\r\n])[^\S\r\n]*$/.test(before) || /^(?:\(gdb\)[^\S\r\n]*)+$/.test(before)) {
        result = match.index;
      }
    }
    return result;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (!this.current) {
      return;
    }
    const idx = this.promptBoundaryIndex();
    if (idx === -1) {
      return;
    }
    const output = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + prompt.length);
    const { resolve } = this.current;
    this.current = null;
    resolve(output);
    this.processQueue();
  }

  private processQueue(): void {
    if (this.current) {
      return;
    }
    const item = this.queue.shift();
    if (!item) {
      return;
    }
    const { cmd, resolve, reject } = item;
    this.current = { resolve, reject };
    this.gdb.stdin!.write(cmd + '\n');
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Translate spawn errors (e.g. ENOENT) into the friendly startup error;
      // terminate() may reject through this path before onError runs.
      this.startReject = (err: Error) => {
        const errno = err as NodeJS.ErrnoException;
        reject(
          errno.code === 'ENOENT'
            ? new Error(`GDB tool not found at ${this.toolPath}`)
            : err,
        );
      };
      const cleanup = () => {
        this.startReject = null;
        this.startCleanup = null;
        this.gdb.off('error', onError);
        this.gdb.stdout!.off('data', onData);
        this.gdb.stderr!.off('data', onData);
      };
      this.startCleanup = cleanup;

      const onError = (error: Error & { code?: string }) => {
        let userError: Error = error;
        if (error.code === 'ENOENT') {
          userError = new Error(`GDB tool not found at ${this.toolPath}`);
        }
        cleanup();
        reject(userError);
      };

      const onData = () => {
        // ELF is not found
        if (!this.didExecuteFirstCommand && this.buffer.includes(noSuchFileOrDirectory)) {
          if (!this.error) {
            this.error = new Error(
              `The ELF file does not exist or is not readable: ${this.elfPath}`,
            );
            cleanup();
            reject(this.error);
          }
          return;
        }

        // Not an ELF
        if (
          !this.didExecuteFirstCommand &&
          (this.buffer.includes(notExecutableFormat) ||
            this.buffer.includes(fileFormatNotRecognized))
        ) {
          if (!this.error) {
            this.error = new Error(
              `The ELF file is not in executable format: ${this.elfPath}`,
            );
            cleanup();
            reject(this.error);
          }
          return;
        }

        const idx = this.promptBoundaryIndex();
        if (idx !== -1) {
          this.buffer = this.buffer.slice(idx + prompt.length);
          cleanup();
          resolve();
        }
      };
      // If the process already terminated, startReject was consumed by
      // terminate(); reject immediately instead of waiting for data.
      if (this.error) {
        cleanup();
        reject(this.error);
        return;
      }
      this.gdb.on('error', onError);
      this.gdb.stdout!.on('data', onData);
      this.gdb.stderr!.on('data', onData);
      // Process any data already buffered by the constructor's onData
      onData();
    });
  }

  async exec(cmd: string): Promise<string> {
    if (this.error) {
      this.close();
      return Promise.reject(this.error);
    }
    const result = await new Promise<string>((resolve, reject) => {
      this.queue.push({ cmd, resolve, reject });
      this.processQueue();
    });

    this.didExecuteFirstCommand = true;
    return result;
  }

  async close(): Promise<void> {
    // A failed spawn (ENOENT) leaves pid undefined and never emits 'exit' —
    // the bounded waits below would run their full timeout for a child
    // that never existed.
    if (
      this.gdb.pid === undefined ||
      this.gdb.exitCode !== null ||
      this.gdb.signalCode !== null
    ) {
      return;
    }
    this.gdb.stdin?.end();
    this.gdb.kill('SIGTERM');
    // killed only means the signal was sent — a wrapper may ignore SIGTERM,
    // so wait for the actual exit, escalate to SIGKILL, and bound the wait.
    if (!(await this.waitForExit(2000))) {
      this.gdb.kill('SIGKILL');
      await this.waitForExit(2000);
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.gdb.exitCode !== null || this.gdb.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.gdb.off('exit', onExit);
      };
      this.gdb.once('exit', onExit);
    });
  }
}

function buildAddr2LineAddrs(addrs: (number | AddrLine | undefined)[]): number[] {
  const dedupedAddrs = new Set<number>();
  for (const addr of addrs) {
    let addrNumber: number | undefined;
    if (typeof addr === 'object' && addr !== null) {
      const a = addr.addr;
      if (typeof a === 'string') {
        addrNumber = parseInt(a, 16);
      } else if (typeof a === 'number') {
        addrNumber = a;
      }
    } else if (typeof addr === 'number') {
      addrNumber = addr;
    }
    if (addrNumber !== undefined && !Number.isNaN(addrNumber) && !dedupedAddrs.has(addrNumber)) {
      dedupedAddrs.add(addrNumber);
    }
  }
  return Array.from(dedupedAddrs.values());
}

/**
 * Resolve addresses to source locations by driving GDB's `list`/`info line`
 * commands against the firmware ELF.
 */
export async function addr2line(
  params: Pick<DecodeParams, 'elfPath' | 'toolPath'>,
  addrs: (number | AddrLine | undefined)[],
  options: DecodeOptions = {},
): Promise<(AddrLine | undefined)[]> {
  const addresses = buildAddr2LineAddrs(addrs);
  if (!addresses.length) {
    throw new Error('No register addresses found to decode');
  }

  const results = new Map<number, AddrLine>();
  const session = new GDBSession(params, options);
  const debug: Debug | undefined = options.debug;

  try {
    await session.start();
    await session.exec('set pagination off');
    await session.exec('set listsize 1');
    for (const addr of addresses) {
      const hex = toHexString(addr);
      const listOutput = await session.exec(`list *${hex}`);
      let parsedLines = parseLines(listOutput, debug);
      let location = parsedLines.find(isParsedGDBLine);
      if (!location) {
        const lineOutput = await session.exec(`info line *${hex}`);
        parsedLines = parseLines(lineOutput, debug);
        location = parsedLines.find(isParsedGDBLine);
      }
      results.set(addr, {
        addr,
        location: location ?? { regAddr: hex, lineNumber: '??' },
      });
    }
  } finally {
    await session.close();
  }

  return addrs.map((addrOrLine) => {
    const addr = typeof addrOrLine === 'object' && addrOrLine !== null ? addrOrLine.addr : addrOrLine;
    if (addr === undefined) {
      return undefined;
    }
    const numeric = typeof addr === 'string' ? parseInt(addr, 16) : addr;
    return results.get(numeric);
  });
}

export type { GDBLine, ParsedGDBLine };
