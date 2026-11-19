import cp from 'node:child_process';
import { AbortError } from './gdbStub';

let clientSeq = 0;

function createLogger(id: number, debug?: (...args: unknown[]) => void) {
  const prefix = `[panic-decoder][gdb-mi:${id}]`;
  const writer = debug ?? (process.env.PANIC_DECODER_DEBUG === 'true' ? console.log : undefined);
  return writer ? (...args: unknown[]) => writer(prefix, ...args) : () => {};
}

function preview(text: string, limit = 400): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`;
}

interface QueuedCommand {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  command: string;
  startedAt: number;
}

/** MI result records that settle a command response. */
const miResultRecordPattern = /^\d*\^(?:done|running|error|exit|connected)\b/m;

/**
 * Bound for draining buffered stdout after the child exits: an inherited
 * stdout handle can keep 'close' from firing, so unanswered commands are
 * rejected on this timer instead of waiting for the stream to end.
 */
const EXIT_DRAIN_TIMEOUT_MS = 1000;

/** Bound for each stage of close()'s SIGTERM → SIGKILL escalation. */
const SHUTDOWN_TIMEOUT_MS = 2000;

/** Resolve true once the child exits, false after the timeout. */
function waitForChildExit(child: cp.ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
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
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

export interface GdbMiOptions {
  signal?: AbortSignal;
  debug?: (...args: unknown[]) => void;
  /** Test hook: replace the child_process.spawn used to start GDB. */
  spawnProcess?: typeof cp.spawn;
}

/** Minimal GDB MI client for queueing commands and reading result records. */
export class GdbMiClient {
  private readonly cp: cp.ChildProcess;
  private readonly id: number;
  private readonly log: (...args: unknown[]) => void;
  private error: Error | undefined;
  private readonly commandQueue: QueuedCommand[] = [];
  /** True while a written command awaits its prompt-terminated response. */
  private commandInFlight = false;
  private stdoutBuffer = '';
  private handshakeSettled = false;
  /** Set on child 'exit': stops new command dispatch but lets buffered
   * stdout settle the in-flight command before 'close' rejects the rest. */
  private processExited = false;
  private exitError: Error | undefined;
  private exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
  private closePromise: Promise<void> | undefined;
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((err: Error) => void) | null = null;

  constructor(gdbPath: string, args: string[], options: GdbMiOptions = {}) {
    this.cp = (options.spawnProcess ?? cp.spawn)(gdbPath, args, {
      stdio: 'pipe',
      signal: options.signal,
    });
    this.id = ++clientSeq;
    this.log = createLogger(this.id, options.debug);
    this.log('spawn', gdbPath, args.join(' '));

    const onAbort = () => {
      this.fail(new AbortError());
    };
    options.signal?.addEventListener('abort', onAbort);
    if (options.signal?.aborted) {
      onAbort();
    }

    // Terminal handlers go in before the streams are touched: a failed
    // spawn must reject pending work through 'error', not throw on a
    // missing stdout.
    this.cp.on('error', (err) => this.fail(err));
    this.cp.stdin?.on('error', (err) => this.fail(err instanceof Error ? err : new Error(String(err))));
    if (this.cp.stdout) {
      this.cp.stdout.setEncoding('utf8');
      this.cp.stdout.on('data', (chunk: string) => this.onData(chunk));
    }
    if (this.cp.stderr) {
      this.cp.stderr.setEncoding('utf8');
      // stderr carries diagnostics, not MI records — keep it out of the
      // response buffer so a warning cannot corrupt a result record.
      this.cp.stderr.on('data', (chunk: string) => this.log('stderr', preview(chunk)));
    }
    this.cp.on('exit', (code, signal) => {
      this.log('process exit', { code, signal });
      if (this.cp.killed) {
        return;
      }
      // 'exit' can fire while the final stdout chunk (e.g. a terminal
      // '^exit' record) is still buffered. Stop dispatching new commands
      // but do NOT fail yet — drainResponses() keeps running on 'data' and
      // may still settle the in-flight command.
      this.processExited = true;
      this.exitError = new Error(`GDB exited unexpectedly (code=${code}, signal=${signal})`);
      if (!this.commandInFlight) {
        // No written command can still receive a response — queued work
        // was never dispatched and is unanswerable. Reject now instead of
        // waiting for 'close', which an inherited stdout handle could
        // delay indefinitely.
        this.fail(this.exitError);
        return;
      }
      // The in-flight command may still be settled by buffered stdout;
      // bound the wait so a missing 'close' cannot pend forever.
      this.exitDrainTimer = setTimeout(() => {
        this.exitDrainTimer = undefined;
        if (this.exitError) {
          this.fail(this.exitError);
        }
      }, EXIT_DRAIN_TIMEOUT_MS);
      this.exitDrainTimer.unref?.();
    });
    this.cp.on('close', () => {
      if (this.exitDrainTimer) {
        clearTimeout(this.exitDrainTimer);
        this.exitDrainTimer = undefined;
      }
      if (this.exitError) {
        this.fail(this.exitError);
      }
    });
  }

  /** Record a terminal failure and reject all pending work exactly once. */
  private fail(err: Error): void {
    if (this.error) {
      return;
    }
    this.error = err;
    this.commandInFlight = false;
    this.log('failure', err);
    if (!this.handshakeSettled && this.handshakeReject) {
      const reject = this.handshakeReject;
      this.handshakeSettled = true;
      this.handshakeResolve = null;
      this.handshakeReject = null;
      reject(err);
    }
    this.commandQueue.forEach((executor) => executor.reject(err));
    this.commandQueue.length = 0;
  }

  sendCommand(command: string): Promise<string> {
    if (this.error) {
      return Promise.reject(this.error);
    }
    this.log('send', command);
    return new Promise((resolve, reject) => {
      this.commandQueue.push({ resolve, reject, command, startedAt: Date.now() });
      this.pumpCommandQueue();
    });
  }

  /**
   * Write the next queued command only after the previous command's
   * response has settled, so each prompt-terminated output stays paired
   * with its command.
   */
  private pumpCommandQueue(): void {
    if (this.commandInFlight || this.error || this.processExited) {
      return;
    }
    const executor = this.commandQueue[0];
    if (!executor) {
      return;
    }
    this.commandInFlight = true;
    try {
      this.cp.stdin!.write(`${executor.command}\n`);
    } catch (err) {
      this.commandInFlight = false;
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onData(chunk: string): void {
    if (this.error) {
      const error = this.error;
      this.commandInFlight = false;
      this.commandQueue.forEach((executor) => executor.reject(error));
      this.commandQueue.length = 0;
    }

    this.stdoutBuffer += chunk;
    this.drainResponses();
  }

  /**
   * A command response ends at a '(gdb)' prompt on its own line; anything
   * after it stays buffered for the next response. Asynchronous records
   * ('*', '=', '+') are separated out so they are neither dropped nor
   * attributed to a command — they are logged and excluded from output.
   */
  private drainResponses(): void {
    for (;;) {
      const promptMatch = /(?:^|\n)\(gdb\)[^\S\n]*(?=\n|$)/.exec(this.stdoutBuffer);
      // '-gdb-exit' answers with a terminal ^exit record and no prompt —
      // the record itself delimits the response.
      const exitMatch = /(?:^|\n)\d*\^exit\b[^\n]*/.exec(this.stdoutBuffer);
      let end: number;
      let terminalExit = false;
      if (exitMatch && (!promptMatch || exitMatch.index <= promptMatch.index)) {
        end = exitMatch.index + exitMatch[0].length;
        terminalExit = true;
      } else if (promptMatch) {
        end = promptMatch.index + promptMatch[0].length;
      } else {
        return;
      }
      const raw = this.stdoutBuffer.slice(0, end);
      this.stdoutBuffer = this.stdoutBuffer.slice(end).replace(/^\n/, '');
      const { output, asyncRecords } = splitAsyncRecords(raw);
      for (const record of asyncRecords) {
        this.log('async record', preview(record));
      }

      // The startup banner ends at the first prompt; it is handshake output,
      // not a command result.
      if (!this.handshakeSettled) {
        this.handshakeSettled = true;
        const resolve = this.handshakeResolve;
        this.handshakeResolve = null;
        this.handshakeReject = null;
        this.log('handshake done', preview(output));
        resolve?.();
        continue;
      }

      if (terminalExit) {
        // A terminal ^exit record means GDB is gone: settle the in-flight
        // command only when it is the '-gdb-exit' it answers, reject every
        // other queued command without dispatching it, and fail the client
        // so nothing further is written to the dying process.
        const executor = this.commandQueue.shift();
        this.commandInFlight = false;
        if (executor) {
          const elapsed = Date.now() - executor.startedAt;
          this.log('recv', `${executor.command} (${elapsed}ms)`, preview(output));
          if (executor.command.includes('-gdb-exit')) {
            executor.resolve(output);
          } else {
            executor.reject(new Error('GDB exited before the command completed'));
          }
        }
        this.fail(this.exitError ?? new Error('GDB exited'));
        return;
      }

      const executor = this.commandQueue[0];
      if (executor && !miResultRecordPattern.test(output)) {
        // A prompt without a matching result record (async notification
        // output) does not settle the pending command — keep it queued
        // until its own ^done/^error/^running/^connected record arrives.
        this.log('prompt without MI result record', preview(output));
        continue;
      }
      this.commandQueue.shift();
      this.commandInFlight = false;
      if (executor) {
        const elapsed = Date.now() - executor.startedAt;
        this.log('recv', `${executor.command} (${elapsed}ms)`, preview(output));
        executor.resolve(output);
      } else {
        this.log('recv without queued command', preview(output));
      }
      this.pumpCommandQueue();
      // The child already exited: commands still queued were never
      // dispatched and can never be answered — reject them now rather
      // than waiting for stderr or the 'close' event.
      if (this.processExited && this.exitError && this.commandQueue.length > 0) {
        this.fail(this.exitError);
      }
    }
  }

  close(): Promise<void> {
    this.log('close');
    // Record the closed state so pending sendCommand() promises reject
    // (kill() alone leaves cp.killed set, which skips fail() on exit) and
    // later commands fail fast. fail() is idempotent.
    this.fail(new Error('GDB client closed'));
    this.cp.stdin?.end();
    // Repeated close() calls share one shutdown; an already-exited child
    // resolves immediately without touching pipes or signals.
    this.closePromise ??= this.shutdownChild();
    return this.closePromise;
  }

  /**
   * SIGTERM the child, wait for the actual exit (kill() only means the
   * signal was sent — a wrapper may ignore it), then escalate to SIGKILL
   * after a bounded timeout so no process or pipe is left behind.
   */
  private async shutdownChild(): Promise<void> {
    // A failed spawn has no PID and never emits 'exit' — don't run the
    // bounded waits for a child that never existed.
    if (this.cp.pid === undefined) {
      return;
    }
    if (this.cp.exitCode !== null || this.cp.signalCode !== null) {
      return;
    }
    this.cp.kill('SIGTERM');
    if (await waitForChildExit(this.cp, SHUTDOWN_TIMEOUT_MS)) {
      return;
    }
    this.cp.kill('SIGKILL');
    await waitForChildExit(this.cp, SHUTDOWN_TIMEOUT_MS);
  }

  async drainHandshake(): Promise<void> {
    this.log('handshake start');
    if (this.error) {
      return Promise.reject(this.error);
    }
    if (this.handshakeSettled) {
      return;
    }
    // Wait on the shared stdout buffer via onData(); attaching a second
    // 'data' listener would double-append chunks and race on the prompt.
    return new Promise((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = (err) => {
        this.handshakeResolve = null;
        this.handshakeReject = null;
        reject(err);
      };
    });
  }
}

/**
 * Split a raw MI response into command output and asynchronous records.
 * Records starting with '*', '=' or '+' at a line boundary are async
 * notifications, not part of the command's result output.
 */
function splitAsyncRecords(raw: string): { output: string; asyncRecords: string[] } {
  const kept: string[] = [];
  const asyncRecords: string[] = [];
  for (const line of raw.split('\n')) {
    if (/^[*=+]/.test(line)) {
      asyncRecords.push(line);
    } else {
      kept.push(line);
    }
  }
  return { output: kept.join('\n'), asyncRecords };
}

export function extractMiListContent(str: string, key: string): string | undefined {
  // Console text preceding the result record can echo the same 'key=['
  // shape (e.g. an empty list) — search only the '^...' result record.
  const resultLine = str.split('\n').find((line) => line.startsWith('^'));
  const scope = resultLine ?? str;
  const keyPattern = `${key}=[`;
  const idx = scope.indexOf(keyPattern);
  if (idx < 0) {
    return undefined;
  }
  const start = scope.indexOf('[', idx);
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inQuotes = false;
  let escape = false;
  for (let i = start; i < scope.length; i++) {
    const c = scope[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inQuotes && c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) {
      continue;
    }
    if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) {
        return scope.substring(start + 1, i);
      }
    }
  }
  return undefined;
}

function splitMiListItems(listContent: string): string[] {
  const items: string[] = [];
  let current = '';
  let depth = 0;
  let inQuotes = false;
  let escape = false;

  for (const char of listContent) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (inQuotes && char === '\\') {
      current += char;
      escape = true;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (!inQuotes) {
      if (char === '{' || char === '[') {
        depth++;
      } else if (char === '}' || char === ']') {
        depth = Math.max(0, depth - 1);
      } else if (char === ',' && depth === 0) {
        if (current.trim()) {
          items.push(current.trim());
        }
        current = '';
        continue;
      }
    }

    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }

  return items;
}

export function unescapeMiString(value: string): string {
  let result = '';
  // MI octal escapes (\ooo) encode raw bytes; consecutive ones may form a
  // multi-byte UTF-8 sequence, so they are buffered and decoded together.
  let pendingBytes: number[] = [];
  const flushBytes = () => {
    if (pendingBytes.length) {
      result += Buffer.from(pendingBytes).toString('utf8');
      pendingBytes = [];
    }
  };

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char !== '\\') {
      flushBytes();
      result += char;
      continue;
    }
    const next = value[i + 1];
    if (!next) {
      flushBytes();
      result += '\\';
      continue;
    }
    i++;
    if (next >= '0' && next <= '7') {
      // Octal escape: up to three octal digits encode a single byte.
      let octal = next;
      while (
        octal.length < 3 &&
        i + 1 < value.length &&
        value[i + 1] >= '0' &&
        value[i + 1] <= '7'
      ) {
        octal += value[++i];
      }
      pendingBytes.push(parseInt(octal, 8) & 0xff);
      continue;
    }
    flushBytes();
    switch (next) {
      case '\\':
        result += '\\';
        break;
      case '"':
        result += '"';
        break;
      case 'n':
        result += '\n';
        break;
      case 'r':
        result += '\r';
        break;
      case 't':
        result += '\t';
        break;
      default:
        result += next;
        break;
    }
  }
  flushBytes();
  return result;
}

function parseMiTuple(tupleContent: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of splitMiListItems(tupleContent)) {
    const idx = field.indexOf('=');
    if (idx === -1) {
      continue;
    }
    const key = field.slice(0, idx).trim();
    const rawValue = field.slice(idx + 1).trim();
    const value =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? unescapeMiString(rawValue.slice(1, -1))
        : rawValue;
    result[key] = value;
  }
  return result;
}

export function parseMiResultRecord(raw: string): Record<string, string> {
  const match = raw.match(/(?:^|\n)\d*\^done(?:,([^\r\n]*))?/);
  if (!match) {
    return {};
  }
  const content = (match[1] ?? '').trim();
  if (!content) {
    return {};
  }
  return parseMiTuple(content);
}

export function stripMiList(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

export function parseMiTupleList(
  listContent: string | undefined,
  tupleKey?: string,
): Record<string, string>[] {
  if (!listContent) {
    return [];
  }
  const items = splitMiListItems(listContent);
  const tuples: Record<string, string>[] = [];

  for (const item of items) {
    const trimmed = item.trim();
    let tupleBody: string | undefined;
    if (tupleKey) {
      const prefix = `${tupleKey}={`;
      if (!trimmed.startsWith(prefix) || !trimmed.endsWith('}')) {
        continue;
      }
      tupleBody = trimmed.slice(prefix.length, -1);
    } else {
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        continue;
      }
      tupleBody = trimmed.slice(1, -1);
    }
    tuples.push(parseMiTuple(tupleBody));
  }

  return tuples;
}
