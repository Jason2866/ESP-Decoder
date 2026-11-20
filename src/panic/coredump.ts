import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GdbMiClient, extractMiListContent, unescapeMiString } from './gdbMi';
import { toHexString } from './panicParse';
import type {
  CoredumpDecodeResult,
  DecodeOptions,
  DecodeParams,
  DecodeResult,
  FrameArg,
  ThreadDecodeResult,
} from './types';

/**
 * Coredump decoding via GDB/MI: load the coredump ELF alongside the firmware
 * ELF, enumerate threads, and extract registers + backtraces per thread.
 */

async function tryRawElfFallback(
  params: DecodeParams,
  raw: Buffer,
  options: DecodeOptions,
): Promise<CoredumpDecodeResult | undefined> {
  const expectedMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  const offset = raw.indexOf(expectedMagic);
  if (offset !== -1) {
    // Estimate the total ELF size using program headers
    const e_phoff = raw.readUInt32LE(offset + 28);
    const e_phentsize = raw.readUInt16LE(offset + 42);
    const e_phnum = raw.readUInt16LE(offset + 44);
    const maxEnd = (() => {
      let max = 0;
      for (let i = 0; i < e_phnum; i++) {
        const entryOffset = offset + e_phoff + i * e_phentsize;
        const p_offset = raw.readUInt32LE(entryOffset + 4);
        const p_filesz = raw.readUInt32LE(entryOffset + 16);
        const end = p_offset + p_filesz;
        if (end > max) {
          max = end;
        }
      }
      return max;
    })();
    const elfTotalSize = maxEnd;
    if (raw.length >= offset + elfTotalSize) {
      const elfBuffer = raw.subarray(offset, offset + elfTotalSize);
      const tmpDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'panic-decoder-'));
      const extractedElfPath = path.join(tmpDirPath, 'extracted.elf');
      try {
        await fs.writeFile(extractedElfPath, elfBuffer);
        return await decodeCoredumpFile(params, extractedElfPath, options, false);
      } finally {
        await fs
          .rm(tmpDirPath, { recursive: true, force: true, maxRetries: 3 })
          .catch((err) => console.warn('Failed to clean up temp dir:', err));
      }
    }
  }
  return undefined;
}

function parseRegisters(regsRaw: string): Record<string, string> {
  const result: Record<string, string> = {};

  // Try MI-style first: match optional frame-prefix then register-values
  const miMatch = regsRaw.match(
    /(?:frame=\{[^}]*\},)?register-values=\[([^\]]*)\]/,
  );
  if (miMatch) {
    const inner = miMatch[1];
    const regex = /\{number="(\d+)",value="(0x[a-fA-F0-9]+)"\}/g;
    for (const m of inner.matchAll(regex)) {
      result[m[1]] = m[2];
    }
    return result;
  }

  // Try "info registers" style as fallback
  const lines = regsRaw.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^~?"?(\w+)\s+(0x[a-fA-F0-9]+)\b/);
    if (match) {
      const [, name, value] = match;
      result[name] = value;
    }
  }

  return result;
}

/**
 * Split MI tuple content on top-level commas, ignoring commas inside quoted
 * strings (e.g. func="worker(int, int)").
 */
function splitMiFields(content: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let escape = false;
  for (const ch of content) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (inQuotes && ch === '\\') {
      current += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) {
    fields.push(current);
  }
  return fields;
}

/** Parse a `key="value"` (or `key=value`) MI field, unescaping quoted strings. */
function parseMiField(field: string): [string, string] | undefined {
  const idx = field.indexOf('=');
  if (idx === -1) {
    return undefined;
  }
  const key = field.slice(0, idx).trim();
  let value = field.slice(idx + 1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = unescapeMiString(value.slice(1, -1));
  }
  return [key, value];
}

/** Matches `{...}` MI tuples, allowing quoted strings to contain braces. */
const MI_TUPLE_RE = /\{((?:\\.|[^{}"\\]|"(?:\\.|[^"\\])*")*)\}/g;

/**
 * Split `-stack-list-arguments` frame content on `}, frame={` boundaries,
 * ignoring delimiters inside quoted MI strings (e.g. args containing
 * `"}, frame={"` as data).
 */
function splitFrameArgEntries(content: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inQuotes = false;
  let escape = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inQuotes && ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes || ch !== '}') {
      continue;
    }
    const boundary = /^},\s*frame=\{/.exec(content.slice(i));
    if (!boundary) {
      continue;
    }
    parts.push(content.slice(start, i) + '}');
    // Next part begins at 'frame={' (the delimiter's tail).
    start = i + boundary[0].length - 'frame={'.length;
  }
  if (start < content.length) {
    parts.push(content.slice(start));
  }
  return parts;
}

/** Returns the `^error` result record from MI output, if present. */
function miErrorRecord(output: string): string | undefined {
  return output.match(/(?:^|\n)\^error[^\n]*/)?.[0].trim();
}

function parseBacktrace(raw: string): Record<string, string>[] {
  const entries: Record<string, string>[] = [];
  const frameRe = /frame=\{((?:\\.|[^{}"\\]|"(?:\\.|[^"\\])*")*)\}/g;
  for (const match of raw.matchAll(frameRe)) {
    /** @type {Record<string, string>} */
    const obj: Record<string, string> = {};
    for (const field of splitMiFields(match[1])) {
      const kv = parseMiField(field);
      if (kv) {
        obj[kv[0]] = kv[1];
      }
    }
    entries.push(obj);
  }
  return entries;
}

export async function decodeCoredumpFile(
  params: DecodeParams,
  inputPath: string,
  options: DecodeOptions = {},
  tryRepair = true,
): Promise<CoredumpDecodeResult> {
  const { elfPath, toolPath } = params;
  const log = options.debug ?? (() => {});
  log('coredump decode start', { toolPath, elfPath, inputPath });
  const client = new GdbMiClient(
    toolPath,
    ['--interpreter=mi2', '-c', inputPath, elfPath],
    options,
  );
  const results: ThreadDecodeResult[] = [];
  let lastError: unknown;

  try {
    // Use -thread-info for a more reliable MI listing of threads
    await client.drainHandshake();

    const threadsRaw = await client.sendCommand('-thread-info');
    log('thread-info raw length', threadsRaw.length);

    const currentThreadMatch = threadsRaw.match(/current-thread-id="(\d+)"/);
    const currentThreadId = currentThreadMatch ? currentThreadMatch[1] : null;

    // Extract the contents of the top-level threads=[ ... ] block, handling nested brackets
    const threadsContent = extractMiListContent(threadsRaw, 'threads');
    const threadEntries: [string, string][] = [];
    if (threadsContent) {
      const objs: string[] = [];
      let depth = 0;
      let objStart = -1;
      let inQuotes = false;
      let escape = false;
      for (let i = 0; i < threadsContent.length; i++) {
        const ch = threadsContent[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (inQuotes && ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inQuotes = !inQuotes;
          continue;
        }
        if (inQuotes) {
          continue;
        }
        // Braces inside quoted MI strings are data, not tuple boundaries.
        if (ch === '{') {
          if (depth === 0) {
            objStart = i;
          }
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0 && objStart >= 0) {
            objs.push(threadsContent.slice(objStart, i + 1));
          }
        }
      }
      for (const objStr of objs) {
        const idMatch = /id="([^"]+)"/.exec(objStr);
        if (idMatch) {
          const tid = idMatch[1];
          const tcbMatch =
            /target-id="process\s+(\d+)"/.exec(objStr) ??
            /target-id="[^\"]*?(\d+)/.exec(objStr);
          const tcb = tcbMatch ? tcbMatch[1] : '0';
          threadEntries.push([tid, tcb]);
        }
      }
    }
    const threadIds = threadEntries.map(([id]) => id);
    const threadTcbs = Object.fromEntries(
      threadEntries.map(([id, tcb]) => [id, Number(tcb)]),
    );
    log('threads parsed', { threadIds, threadTcbs });

    for (const tid of threadIds) {
      try {
        log('select thread', tid);
        const selectOut = await client.sendCommand(`-thread-select ${tid}`);
        const selectError = miErrorRecord(selectOut);
        if (selectError) {
          const msg = `Thread ${tid}: thread selection failed (${selectError})`;
          log('thread-select failed; skipping thread', tid, selectError);
          options.onWarning?.(msg);
          continue;
        }

        const regNamesRaw = await client.sendCommand('-data-list-register-names');
        const regNameMatch = regNamesRaw.match(/register-names=\[(.*?)\]/);
        const regNames = regNameMatch
          ? regNameMatch[1]
              .split(',')
              .map((s) => s.trim().replace(/^"|"$/g, ''))
              .map((name, i) => [i.toString(), name] as [string, string])
              .filter(([, name]) => !!name)
          : [];
        const regNameMap = Object.fromEntries(regNames);

        const regsOut = await client.sendCommand('-data-list-register-values x');
        const parsedRegs = parseRegisters(regsOut);

        const regsAsNamed = Object.fromEntries(
          Object.entries(parsedRegs)
            .map(([num, val]) => [regNameMap[num], Number(val)])
            .filter(([name]) => !!name),
        );
        log('regs', tid, Object.keys(regsAsNamed));

        const programCounter = regsAsNamed['pc'] ?? regsAsNamed['mepc'];
        const programCounterHex =
          programCounter !== undefined ? toHexString(programCounter) : '??';

        const btOut = await client.sendCommand('-stack-list-frames');
        const btError = miErrorRecord(btOut);
        // A stack-frame failure is recorded for this thread but must not
        // abort decoding of the remaining threads.
        if (btError) {
          const msg = `Thread ${tid}: stack-list-frames failed (${btError})`;
          log('stack-list-frames failed; continuing without frames', btError);
          options.onWarning?.(msg);
        }
        log('stack frames raw length', btOut.length);

        let argsOut = '';
        let argsError: string | undefined;
        try {
          argsOut = await client.sendCommand(
            '-stack-list-arguments --simple-values 0 100',
          );
          // Arguments are optional: an MI error keeps the frames, just without args.
          argsError = miErrorRecord(argsOut);
          if (argsError) {
            const msg = `Thread ${tid}: stack-list-arguments failed (${argsError})`;
            log('stack-list-arguments failed; continuing without args', argsError);
            options.onWarning?.(msg);
          }
        } catch (err) {
          const msg = `Thread ${tid}: stack-list-arguments failed (${err instanceof Error ? err.message : String(err)})`;
          log('stack-list-arguments failed; continuing without args', err);
          options.onWarning?.(msg);
        }
        log('stack args raw length', argsOut.length);
        // Parse frame arguments safely, splitting on top-level frame boundaries
        const argsListMatch = argsError ? null : argsOut.match(/stack-args=\[([\s\S]*)\]/);
        const frameArgs: { level?: string; args: FrameArg[] }[] = [];
        if (argsListMatch) {
          const content = argsListMatch[1];
          const parts = splitFrameArgEntries(content);
          for (const frameStr of parts) {
            const rawMatch = frameStr.match(/frame=\{([\s\S]*)\}/);
            const raw = rawMatch ? rawMatch[1] : '';
            const obj: { level?: string; args: FrameArg[] } = { args: [] };
            const levelMatch = raw.match(/level="(\d+)"/);
            if (levelMatch) {
              obj.level = levelMatch[1];
            }
            const argsMatchInner = raw.match(/args=\[([\s\S]*)\]/);
            if (argsMatchInner && argsMatchInner[1].trim()) {
              const argsContent = argsMatchInner[1];
              for (const tupleMatch of argsContent.matchAll(MI_TUPLE_RE)) {
                const fields: Record<string, string> = {};
                for (const field of splitMiFields(tupleMatch[1])) {
                  const kv = parseMiField(field);
                  if (kv) {
                    fields[kv[0]] = kv[1];
                  }
                }
                if (fields.name !== undefined) {
                  obj.args.push({ name: fields.name, type: fields.type, value: fields.value });
                }
              }
            }
            frameArgs.push(obj);
          }
        }

        const btParsed = btError ? [] : parseBacktrace(btOut);
        const stacktraceLines = btParsed.map((frame, index) => {
          const args = frameArgs[index]?.args || [];
          // Prefer GDB's resolved fullname (comp_dir + file) over the bare file.
          const rawFile = frame.fullname || frame.file;
          const sourceFile = rawFile && rawFile !== '??' ? rawFile : undefined;
          if (frame.func) {
            return {
              regAddr: frame.addr,
              lineNumber: frame.line ?? '??',
              method: frame.func,
              file: sourceFile ?? '??',
              args,
            };
          }
          return {
            regAddr: frame.addr,
            lineNumber: frame.line ?? '??',
          };
        });
        log('stacktrace lines', tid, stacktraceLines.length);

        const threadResult: DecodeResult = {
          faultInfo: {
            programCounter: {
              addr: programCounterHex,
              location: stacktraceLines[0] ?? {
                regAddr: programCounterHex,
                lineNumber: '??',
              },
            },
          },
          regs: regsAsNamed,
          stacktraceLines,
        };

        results.push({
          threadId: tid,
          TCB: threadTcbs[tid] ?? 0,
          result: threadResult,
          current: tid === currentThreadId,
          warning: btError ? `stack-list-frames failed (${btError})` : undefined,
        });
      } catch (err) {
        if (options.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          throw err;
        }
        lastError = err;
        const msg = `Thread ${tid}: decode failed or terminated early (${err instanceof Error ? err.message : String(err)})`;
        log('thread decode failed or terminated early', tid, err);
        options.onWarning?.(msg);
        const currentIndex = threadIds.indexOf(tid);
        if (currentIndex >= 0 && currentIndex < threadIds.length - 1) {
          const remaining = threadIds.slice(currentIndex + 1);
          options.onWarning?.(`Remaining threads skipped due to earlier failure: ${remaining.join(', ')}`);
        }
        break;
      }
    }
  } finally {
    await client.close();
  }

  if (!results.length && tryRepair) {
    const raw = await fs.readFile(inputPath);
    const fallback = await tryRawElfFallback(params, raw, options);
    if (fallback) {
      return fallback;
    }
  }

  if (!results.length && lastError) {
    throw lastError;
  }

  return results;
}
