import { spawn, type ChildProcess } from 'child_process';

/**
 * Result of resolving a single address via addr2line.
 */
export interface Addr2lineResult {
  address: string;
  function?: string;
  file?: string;
  line?: string;
}

/**
 * Regex matching addr2line address header lines
 * (same as pioarduino/filter_exception_decoder.py's _ADDR2LINE_HEADER_RE).
 */
const ADDR2LINE_HEADER_RE = /^0x[0-9a-fA-F]+$/;

/**
 * Regex to strip discriminator annotations from addr2line output.
 */
const DISCRIMINATOR_RE = /\s*\(discriminator \d+\)/;

/** Sentinel address appended to each batch to detect end-of-output. */
const SENTINEL_ADDR = '0x00000000';

/** Idle timeout in milliseconds — kill process after this period of inactivity. */
const IDLE_TIMEOUT_MS = 30_000;

interface QueueEntry {
  addresses: string[];
  resolve: (results: Addr2lineResult[]) => void;
  reject: (err: Error) => void;
  attempts: number;
}
const BATCH_TIMEOUT_MS = 15_000;
const MAX_BATCH_RETRIES = 1;

/**
 * Keeps an `addr2line` process running in interactive (stdin) mode and
 * serializes resolution requests through it. The process is automatically
 * restarted if it crashes and killed after an idle timeout.
 */
export class PersistentAddr2line {
  private readonly addr2linePath: string;
  private readonly elfPath: string;

  private proc: ChildProcess | null = null;
  private disposed = false;

  /** FIFO queue of pending batch requests. */
  private queue: QueueEntry[] = [];
  private processing = false;

  /** Accumulated stdout data for the current batch. */
  private stdoutBuffer = '';

  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(addr2linePath: string, elfPath: string) {
    this.addr2linePath = addr2linePath;
    this.elfPath = elfPath;
  }

  /**
   * Resolve a batch of addresses to function/file/line information.
   * Requests are serialized — concurrent calls are queued.
   */
  resolveBatch(addresses: string[]): Promise<Addr2lineResult[]> {
    if (this.disposed) {
      return Promise.reject(new Error('PersistentAddr2line has been disposed'));
    }
    return new Promise<Addr2lineResult[]>((resolve, reject) => {
      this.queue.push({ addresses, resolve, reject, attempts: 0 });
      this.drainQueue();
    });
  }

  /** Kill the child process and prevent future requests. */
  dispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
    this.killProcess();
    // Reject any pending requests
    for (const entry of this.queue) {
      entry.reject(new Error('PersistentAddr2line disposed'));
    }
    this.queue = [];
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private ensureProcess(): ChildProcess {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
      return this.proc;
    }
    this.proc = spawn(this.addr2linePath, ['-fiaC', '-e', this.elfPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.on('error', () => this.handleProcessExit());
    this.proc.on('exit', () => this.handleProcessExit());
    return this.proc;
  }

  private handleProcessExit(): void {
    this.proc = null;
    // If we were mid-batch, the data handler won't fire again.
    // Mark processing as false so drainQueue can restart with a new process.
    if (this.processing) {
      this.processing = false;
      // The current batch will be retried by drainQueue.
      const entry = this.queue[0];
      if (entry && ++entry.attempts > MAX_BATCH_RETRIES) {
        this.queue.shift();
        entry.reject(new Error('addr2line exited before completing the batch'));
      }
      this.drainQueue();
    }
  }

  private killProcess(): void {
    if (this.proc) {
      // Remove listeners to avoid re-entrant handleProcessExit during dispose
      this.proc.removeAllListeners();
      this.proc.stdout?.removeAllListeners();
      this.proc.kill();
      this.proc = null;
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.killProcess();
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private drainQueue(): void {
    if (this.processing || this.queue.length === 0 || this.disposed) {
      return;
    }
    this.processing = true;
    this.clearIdleTimer();

    const entry = this.queue[0];
    this.stdoutBuffer = '';

    const proc = this.ensureProcess();
    const stdout = proc.stdout!;

    const batchTimer = setTimeout(() => {
      stdout.removeListener('data', onData);
      this.killProcess();
      this.processing = false;
      this.queue.shift();
      entry.reject(new Error('addr2line batch timed out'));
      this.drainQueue();
    }, BATCH_TIMEOUT_MS);

    const onData = (chunk: Buffer): void => {
      this.stdoutBuffer += chunk.toString('utf-8');

      // Check if we've received the sentinel header
      if (this.hasSentinelHeader(this.stdoutBuffer)) {
        clearTimeout(batchTimer);
        stdout.removeListener('data', onData);
        this.processing = false;
        this.queue.shift();

        const results = this.parseOutput(this.stdoutBuffer, entry.addresses);
        entry.resolve(results);

        if (this.queue.length > 0) {
          this.drainQueue();
        } else {
          this.resetIdleTimer();
        }
      }
    };

    stdout.on('data', onData);

    // Write each address + sentinel, one per line
    const input = [...entry.addresses, SENTINEL_ADDR]
      .map(a => a + '\n')
      .join('');
    proc.stdin!.write(input);
  }

  /**
   * Check whether the sentinel address header has appeared in the output.
   * The sentinel header must be on its own line.
   */
  private hasSentinelHeader(output: string): boolean {
    const lines = output.split('\n');
    // The sentinel produces a header line and at least one body line.
    // We need the sentinel header AND at least one body line after it.
    let foundSentinelHeader = false;
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].trim();
      if (!foundSentinelHeader) {
        if (stripped === SENTINEL_ADDR) {
          foundSentinelHeader = true;
        }
      } else {
        // Need at least one non-empty line after sentinel header
        if (stripped.length > 0) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Parse addr2line output into results. Uses the same section-based parser
   * as the existing code in crashDecoder.ts.
   */
  private parseOutput(output: string, addresses: string[]): Addr2lineResult[] {
    const rawLines = output.split('\n');
    const sections: string[][] = [];
    let currentBody: string[] = [];

    for (const rawLine of rawLines) {
      const stripped = rawLine.trim();
      if (!stripped) { continue; }
      if (ADDR2LINE_HEADER_RE.test(stripped)) {
        sections.push(currentBody);
        currentBody = [];
      } else {
        currentBody.push(stripped);
      }
    }
    sections.push(currentBody);

    // First section (before first address header) is empty — skip it.
    // Last section belongs to the sentinel — exclude it.
    const bodySections = sections.slice(1, 1 + addresses.length);

    const results: Addr2lineResult[] = [];

    for (let i = 0; i < addresses.length; i++) {
      const originalAddr = addresses[i];

      if (i >= bodySections.length) {
        results.push({ address: originalAddr });
        continue;
      }

      const body = bodySections[i];
      let j = 0;
      let funcName: string | undefined;
      let file: string | undefined;
      let lineNum: string | undefined;

      while (j + 1 < body.length) {
        const func = body[j];
        const loc = DISCRIMINATOR_RE.test(body[j + 1])
          ? body[j + 1].replace(DISCRIMINATOR_RE, '')
          : body[j + 1];

        if (func === '??' && loc.startsWith('??:')) {
          j += 2;
          continue;
        }

        // Take the first resolved entry
        if (!funcName) {
          funcName = func;
          const colonIdx = loc.lastIndexOf(':');
          if (colonIdx > 0) {
            file = loc.substring(0, colonIdx);
            const ln = loc.substring(colonIdx + 1);
            lineNum = ln && ln !== '0' && ln !== '?' ? ln : undefined;
          }
        }
        j += 2;
      }

      results.push({
        address: originalAddr,
        function: funcName,
        file,
        line: lineNum,
      });
    }

    return results;
  }
}

/**
 * Pool of `PersistentAddr2line` instances keyed by addr2line+ELF path.
 * Each instance manages its own idle timeout.
 */
export class Addr2linePool {
  private readonly instances = new Map<string, PersistentAddr2line>();

  /** Get (or create) a persistent addr2line for the given tool + ELF pair. */
  get(addr2linePath: string, elfPath: string): PersistentAddr2line {
    const key = `${addr2linePath}::${elfPath}`;
    let instance = this.instances.get(key);
    if (!instance) {
      instance = new PersistentAddr2line(addr2linePath, elfPath);
      this.instances.set(key, instance);
    }
    return instance;
  }

  /** Dispose all cached instances and clear the pool. */
  disposeAll(): void {
    for (const instance of this.instances.values()) {
      instance.dispose();
    }
    this.instances.clear();
  }
}

/**
 * Convenience function: resolve a batch of addresses using a pooled persistent
 * addr2line process.
 */
export async function resolveAddressBatch(
  pool: Addr2linePool,
  addr2linePath: string,
  elfPath: string,
  addresses: string[],
): Promise<Addr2lineResult[]> {
  const instance = pool.get(addr2linePath, elfPath);
  return instance.resolveBatch(addresses);
}
