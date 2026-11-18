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
    /(0x[0-9a-f]+)\s+in\s+((?:[^()]|\((?:[^()]|\([^()]*\))*\))+)\s+at\s+(.+):(\d+)/i,
    // GDB style with frame number and ?? file/line
    /(?:#\d+\s+)?(0x[0-9a-f]+)\s+in\s+((?:[^()]|\((?:[^()]|\([^()]*\))*\))+)\s+at\s+(\?+):(\?+)/i,
    // "is in" format with numeric file/line
    /(0x[0-9a-f]+)\s+is\s+in\s+((?:[^()]|\((?:[^()]|\([^()]*\))*\))+)\s+\((.+):(\d+)\)/i,
    // "is in" format without line number
    /(0x[0-9a-f]+)\s+is\s+in\s+((?:[^()]|\((?:[^()]|\([^()]*\))*\))+)\s+\(([^():]+)\)/i,
    // Address with "is at" and numeric file/line
    /(0x[0-9a-f]+)\s+is\s+at\s+(.+):(\d+)/i,
    // Method with file/line but no address
    /(?:#\d+\s+)?((?:[^()]|\((?:[^()]|\([^()]*\))*\))+)\s+at\s+(.+):(\d+)/,
    // GDB `info line` response: Line 42 of "/path/file.cpp" starts at address 0x...
    /Line\s+(\d+)\s+of\s+"((?:\\.|[^"\\])*)"\s+starts\s+at\s+address\s+(0x[0-9a-f]+)/i,
    // GDB `info line` without line info keeps the symbol in angle brackets:
    // "No line number information available for address 0x400d1234 <func+0x10>".
    // The symbol may itself contain angle brackets (template names like
    // <ns::worker<int>()+16>), so allow one level of nesting and match the
    // record's outer closing bracket.
    /No line number information available for address\s+(0x[0-9a-f]+)\s+<((?:[^<>]|<[^<>]*>)*)>/i,
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
      if (i === 7) {
        const [, lineNumber, file, regAddr] = match;
        return normalizeParsedLine({
          regAddr,
          method: '??',
          file: file.replace(/\\(["\\])/g, '$1'),
          lineNumber,
        });
      }
      if (i === 8) {
        const [, regAddr, symbol] = match;
        // '<func+0x10>' -> 'func'; keep the bare symbol as the method.
        const method = symbol.replace(/\+0x[0-9a-f]+$/i, '').replace(/\+\d+$/, '');
        return normalizeParsedLine({ regAddr, method, file: '??', lineNumber: '??' });
      }
    }
  }
  // Fallback for addresses without file/line info
  const fallbackMatch = line.match(
    /(?:#\d+\s+)?(0x[0-9a-f]+)\s+(?:is\s+in|in)\s+((?:[^()]|\((?:[^()]|\([^()]*\))*\))+)/i,
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
