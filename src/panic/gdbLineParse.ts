import type { Debug, GDBLine, ParsedGDBLine } from './types';

/**
 * Parses GDB human-readable output (`list *addr`, `info line *addr`) into
 * address/location pairs.
 */

function parseMethodSignature(sig: string): {
  name: string;
  args: { name: string; value?: string; type?: string }[];
} {
  const nameMatch = sig.match(/^([^(]+)\s*\((.*)\)$/s);
  if (!nameMatch) {
    return { name: sig.trim(), args: [] };
  }

  const [, name, argsStr] = nameMatch;
  const args =
    argsStr
      .match(/(?:[^,"']+|"[^"]*"|'[^']*')+/g)
      ?.map((arg) => {
        const parts = arg.split('=');
        if (parts.length === 2) {
          const [argName, value] = parts.map((s) => s.trim());
          return { name: argName, value };
        }
        return { name: arg.trim() };
      }) || [];
  return { name: name.trim(), args };
}

export function parseLines(
  stdout: string,
  debug?: Debug,
): (GDBLine | ParsedGDBLine)[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseLine(line, debug))
    .filter((entry): entry is GDBLine | ParsedGDBLine => entry !== undefined);
}

export function parseLine(line: string, _debug?: Debug): GDBLine | ParsedGDBLine | undefined {
  const patterns: RegExp[] = [
    // GDB style with frame number and numeric file/line
    /#\d+\s+(0x[0-9a-f]+)\s+in\s+([^(]+\((?:"(?:\\.|[^"\\])*"|[^()])*?\))\s+at\s+(.+):(\d+)/i,
    // GDB style without frame number and numeric file/line
    /(0x[0-9a-f]+)\s+in\s+([^(]+(?:\([^()]*\))?)\s+at\s+(.+):(\d+)/i,
    // GDB style with frame number and ?? file/line
    /(?:#\d+\s+)?(0x[0-9a-f]+)\s+in\s+([^(]+(?:\([^()]*\))?)\s+at\s+(\?+):(\?+)/i,
    // "is in" format with numeric file/line
    /(0x[0-9a-f]+)\s+is\s+in\s+([^(]+(?:\([^()]*\))?)\s+\((.+):(\d+)\)/i,
    // "is in" format without line number
    /(0x[0-9a-f]+)\s+is\s+in\s+([^(]+(?:\([^()]*\))?)\s+\(([^():]+)\)/i,
    // Address with "is at" and numeric file/line
    /(0x[0-9a-f]+)\s+is\s+at\s+(.+):(\d+)/i,
    // Method with file/line but no address
    /(?:#\d+\s+)?([^(]+(?:\([^()]*\))?)\s+at\s+(.+):(\d+)/,
  ];

  for (const [i, pattern] of patterns.entries()) {
    const match = line.match(pattern);
    if (match) {
      if (i === 0 || i === 1) {
        const [, regAddr, method, file, lineNumber] = match;
        return normalizeParsedLine({ regAddr, method, file, lineNumber });
      }
      if (i === 2) {
        const [, regAddr, method, file, lineNumber] = match;
        return normalizeParsedLine({ regAddr, method, file, lineNumber });
      }
      if (i === 3) {
        const [, regAddr, method, file, lineNumber] = match;
        return normalizeParsedLine({ regAddr, method, file, lineNumber });
      }
      if (i === 4) {
        const [, regAddr, method, file] = match;
        return normalizeParsedLine({ regAddr, method, file, lineNumber: '??' });
      }
      if (i === 5) {
        const [, regAddr, file, lineNumber] = match;
        return normalizeParsedLine({ regAddr, method: '??', file, lineNumber });
      }
      if (i === 6) {
        const [, method, file, lineNumber] = match;
        return normalizeParsedLine({ regAddr: '??', method, file, lineNumber });
      }
    }
  }
  // Fallback for addresses without file/line info
  const fallbackMatch = line.match(
    /(?:#\d+\s+)?(0x[0-9a-f]+)\s+(?:is\s+in|in)\s+([^(]+(?:\([^()]*\))?)/i,
  );
  if (fallbackMatch) {
    const [, regAddr, method] = fallbackMatch;
    return normalizeParsedLine({
      regAddr,
      method: method.trim(),
      file: '??',
      lineNumber: '??',
    });
  }
  return undefined;
}

function normalizeParsedLine(entry: ParsedGDBLine): GDBLine | ParsedGDBLine {
  const { file, lineNumber, method, regAddr } = entry;
  const parsedMethod = parseMethodSignature(method);

  const hasValidFile = file && file !== '' && file !== '??';
  const hasValidLine = lineNumber && lineNumber !== '' && lineNumber !== '??';

  if (hasValidFile || hasValidLine) {
    const result: ParsedGDBLine = {
      regAddr,
      method: parsedMethod.name,
      file: hasValidFile ? file : '??',
      lineNumber: hasValidLine ? lineNumber : '??',
    };
    if (parsedMethod.args && parsedMethod.args.length > 0) {
      Object.assign(result, { args: parsedMethod.args });
    }
    return result;
  }

  const hasValidMethod = parsedMethod.name && parsedMethod.name !== '' && parsedMethod.name !== '??';

  if (!hasValidLine && hasValidMethod) {
    return {
      regAddr,
      method: parsedMethod.name,
      file: '??',
      lineNumber: '??',
    };
  }

  return { regAddr, lineNumber: lineNumber || '??' };
}
