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
      this.handshakeReject(err);
      this.handshakeSettled = true;
      this.handshakeReject = null;
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
    if (/\(gdb\)\s*$/m.test(this.stdoutBuffer)) {
      const output = this.stdoutBuffer;
      this.stdoutBuffer = '';
      const executor = this.commandQueue.shift();
      if (executor) {
        const elapsed = Date.now() - executor.startedAt;
        this.log('recv', `${executor.command} (${elapsed}ms)`, preview(output));
      } else {
        this.log('recv without queued command', preview(output));
      }
      executor?.resolve(output);
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
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const onData = (chunk: string) => {
        if (this.error) {
          this.cp.stdout!.off('data', onData);
          this.log('handshake error', this.error);
          reject(this.error);
          this.handshakeSettled = true;
          this.handshakeReject = null;
          return;
        }
        this.stdoutBuffer += chunk;
        if (/\(gdb\)\s*$/m.test(this.stdoutBuffer)) {
          this.cp.stdout!.off('data', onData);
          this.stdoutBuffer = '';
          this.handshakeSettled = true;
          this.handshakeReject = null;
          this.log('handshake done', `${Date.now() - startedAt}ms`);
          resolve();
        }
      };
      this.handshakeReject = (err) => {
        this.cp.stdout!.off('data', onData);
        reject(err);
      };
      this.cp.stdout!.on('data', onData);
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
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char !== '\\') {
      result += char;
      continue;
    }
    const next = value[i + 1];
    if (!next) {
      result += '\\';
      continue;
    }
    i++;
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
