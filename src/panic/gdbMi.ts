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

export interface GdbMiOptions {
  signal?: AbortSignal;
  debug?: (...args: unknown[]) => void;
}

/** Minimal GDB MI client for queueing commands and reading result records. */
export class GdbMiClient {
  private readonly cp: cp.ChildProcess;
  private readonly id: number;
  private readonly log: (...args: unknown[]) => void;
  private error: Error | undefined;
  private readonly commandQueue: QueuedCommand[] = [];
  private stdoutBuffer = '';
  private handshakeSettled = false;
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((err: Error) => void) | null = null;

  constructor(gdbPath: string, args: string[], options: GdbMiOptions = {}) {
    this.cp = cp.spawn(gdbPath, args, { stdio: 'pipe', signal: options.signal });
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

    this.cp.stdout!.setEncoding('utf8');
    this.cp.stderr!.setEncoding('utf8');
    this.cp.stdout!.on('data', (chunk: string) => this.onData(chunk));
    this.cp.stderr!.on('data', (chunk: string) => this.onData(chunk));
    this.cp.stdin!.on('error', (err) => this.fail(err instanceof Error ? err : new Error(String(err))));
    this.cp.on('error', (err) => this.fail(err));
    this.cp.on('exit', (code, signal) => {
      this.log('process exit', { code, signal });
      if (!this.cp.killed) {
        this.fail(new Error(`GDB exited unexpectedly (code=${code}, signal=${signal})`));
      }
    });
  }

  /** Record a terminal failure and reject all pending work exactly once. */
  private fail(err: Error): void {
    if (this.error) {
      return;
    }
    this.error = err;
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
      const executor: QueuedCommand = { resolve, reject, command, startedAt: Date.now() };
      this.commandQueue.push(executor);
      try {
        this.cp.stdin!.write(`${command}\n`);
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onData(chunk: string): void {
    if (this.error) {
      const error = this.error;
      this.commandQueue.forEach((executor) => executor.reject(error));
      this.commandQueue.length = 0;
    }

    this.stdoutBuffer += chunk;
    if (!/\(gdb\)\s*$/m.test(this.stdoutBuffer)) {
      return;
    }
    const output = this.stdoutBuffer;
    this.stdoutBuffer = '';

    // The startup banner ends at the first prompt; it is handshake output,
    // not a command result.
    if (!this.handshakeSettled) {
      this.handshakeSettled = true;
      const resolve = this.handshakeResolve;
      this.handshakeResolve = null;
      this.handshakeReject = null;
      this.log('handshake done', preview(output));
      resolve?.();
      return;
    }

    const executor = this.commandQueue.shift();
    if (executor) {
      const elapsed = Date.now() - executor.startedAt;
      this.log('recv', `${executor.command} (${elapsed}ms)`, preview(output));
      executor.resolve(output);
    } else {
      this.log('recv without queued command', preview(output));
    }
  }

  close(): void {
    this.log('close');
    this.cp.stdin?.end();
    this.cp.kill();
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

export function extractMiListContent(str: string, key: string): string | undefined {
  const keyPattern = `${key}=[`;
  const idx = str.indexOf(keyPattern);
  if (idx < 0) {
    return undefined;
  }
  const start = str.indexOf('[', idx);
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) {
        return str.substring(start + 1, i);
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
