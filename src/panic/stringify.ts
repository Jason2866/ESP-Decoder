import { isParsedGDBLine } from './types';
import type { AddrLocation, CoredumpDecodeResult, DecodeResult, ThreadDecodeResult } from './types';

/**
 * Plain-text rendering of decode results (ANSI colors disabled — output goes
 * into the extension's log/webview).
 */

export function stringifyDecodeResult(
  result: DecodeResult | CoredumpDecodeResult,
  _options?: { color?: 'force' | 'disable'; lineSeparator?: string },
): string {
  const lineSeparator = _options?.lineSeparator ?? '\r\n';
  const lines = Array.isArray(result)
    ? stringifyCoredumpDecodeResult(result)
    : stringifySingleDecodeResult(result);
  return lines.join(lineSeparator);
}

function stringifyCoredumpDecodeResult(result: CoredumpDecodeResult): string[] {
  const lines = [...stringifyThreadsInfo(result), ''];

  for (let i = 0; i < result.length; i++) {
    const thread = result[i];
    lines.push(formatThreadHeader(thread), ...stringifyThreadDecodeResult(thread));
    if (i < result.length - 1) {
      lines.push('');
    }
  }

  return lines;
}

function stringifySingleDecodeResult(result: DecodeResult): string[] {
  const lines: string[] = [];
  if (typeof result.faultInfo?.faultCode === 'number') {
    const parts: string[] = [];
    if (result.faultInfo.coreId !== undefined) {
      parts.push(`${result.faultInfo.coreId}`);
    }
    if (result.faultInfo.faultMessage) {
      parts.push(result.faultInfo.faultMessage);
    }
    parts.push(`${result.faultInfo.faultCode}`);
    lines.push(parts.join(' | '));
  }

  const pc = result.faultInfo?.programCounter?.location;
  if (pc) {
    if (lines.length) {
      lines.push('');
    }
    lines.push(`PC -> ${stringifyAddrLocation(pc)}`);
  }

  const faultAddr = result.faultInfo?.faultAddr?.location;
  if (faultAddr) {
    lines.push(`Fault -> ${stringifyAddrLocation(faultAddr)}`);
  }

  if (result.stacktraceLines.length && lines.length) {
    lines.push('');
  }

  for (const line of result.stacktraceLines) {
    lines.push(stringifyAddrLocation(line));
  }

  if (result.allocInfo) {
    if (lines.length) {
      lines.push('');
    }
    lines.push(
      `Memory allocation of ${result.allocInfo.allocSize} bytes failed at ${stringifyAddrLocation(result.allocInfo.allocAddr)}`,
    );
  }

  return lines;
}

function stringifyThreadsInfo(result: CoredumpDecodeResult): string[] {
  const lines: string[] = [];
  lines.push('==================== THREADS INFO ====================');
  lines.push('  ID  Target ID            Frame');

  for (const thread of result) {
    const mark = thread.current ? '*' : ' ';
    const tid = thread.threadId.toString().padStart(2);
    const tcb = thread.TCB.toString().padEnd(12);
    const top = thread.result.stacktraceLines?.[0];
    const topText = top ? stringifyAddrLocation(top) : '';
    lines.push(` ${mark}${tid}  process ${tcb} ${topText}`);
  }
  return lines;
}

function formatThreadHeader(thread: ThreadDecodeResult): string {
  return `==================== THREAD ${thread.threadId} (TCB: 0x${(+thread.TCB).toString(16)}) ====================`;
}

function stringifyThreadDecodeResult(result: ThreadDecodeResult): string[] {
  // Reuse the single-decode renderer so fault info (PC/Fault lines) and
  // alloc info are not dropped; it also prints the program counter when
  // the thread has no stack frames.
  return stringifySingleDecodeResult(result.result);
}

function stringifyAddrLocation(location: AddrLocation): string {
  if (typeof location === 'string') {
    return location;
  }
  if (!isParsedGDBLine(location)) {
    return `${location.regAddr}: ${location.lineNumber}`;
  }

  const args =
    location.args?.map((arg) => `${arg.name}${arg.value ? `=${arg.value}` : ''}`).join(', ') ?? '';

  const signature = `${location.method} (${args})`;

  return `${location.regAddr}: ${signature} at ${location.file}:${location.lineNumber}`;
}
