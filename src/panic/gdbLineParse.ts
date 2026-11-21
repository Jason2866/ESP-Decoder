import type { Debug, GDBLine, ParsedGDBLine } from './types';

/**
 * Parses GDB human-readable output (`list *addr`, `info line *addr`) into
 * address/location pairs.
 */

function parseMethodSignature(sig: string): {
  name: string;
  args: { name: string; value?: string; type?: string }[];
} {
  const trimmed = sig.trim();
  // Strip only a top-level trailing argument list: scan back from the final
  // ')' to its matching '(' so parentheses inside template arguments (e.g.
  // 'ns::worker<void (int)()>()') stay part of the symbol name. A signature
  // without a trailing ')' (e.g. 'app_main+0x10') is kept whole.
  let openIdx = -1;
  if (trimmed.endsWith(')')) {
    // Forward scan with a paren stack so parentheses inside quoted strings
    // (e.g. 'foo("a)b")') cannot corrupt the depth count; quotes honor
    // backslash escapes.
    const stack: number[] = [];
    let quote: string | undefined;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (quote) {
        if (ch === '\\') {
          i++;
        } else if (ch === quote) {
          quote = undefined;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '(') {
        stack.push(i);
      } else if (ch === ')') {
        const open = stack.pop();
        if (i === trimmed.length - 1) {
          openIdx = open ?? -1;
        }
      }
    }
  }
  if (openIdx <= 0) {
    return { name: trimmed, args: [] };
  }

  const name = trimmed.slice(0, openIdx).trim();
  const argsStr = trimmed.slice(openIdx + 1, -1);
  const args = splitTopLevelArgs(argsStr).map((arg) => {
    // Split only at the first '=' so values containing '=' (e.g.
    // 'key=a=b') keep their full text; 'n=1' still parses normally.
    const eq = arg.indexOf('=');
    if (eq > 0) {
      return {
        name: arg.slice(0, eq).trim(),
        value: arg.slice(eq + 1).trim(),
      };
    }
    return { name: arg.trim() };
  });
  return { name: name.trim(), args };
}

/**
 * Split an argument list on top-level commas only: commas inside quoted
 * strings (honoring backslash escapes) and inside nested parentheses stay
 * part of the argument, so `msg="a, b", n=1` yields two args.
 */
function splitTopLevelArgs(argsStr: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | undefined;
  let depth = 0;
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < argsStr.length) {
        current += argsStr[++i];
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
    }
    if (ch === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  args.push(current);
  return args.filter((arg) => arg.trim() !== '');
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
    // <ns::worker<int>()+16>), so the capture below scans to the matching
    // outer close instead of stopping at the first '>'.
    /No line number information available for address\s+(0x[0-9a-f]+)\s+</i,
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
        const [, regAddr] = match;
        // Extract the complete symbol inside the outer '<...>', using the
        // final closing angle bracket as outer delimiter, then strip the
        // trailing '+0x..'/'+N' offset before returning it as the method.
        const openIdx = line.indexOf('<', match.index);
        const closeIdx = line.lastIndexOf('>');
        const symbol =
          openIdx >= 0 && closeIdx > openIdx
            ? line.slice(openIdx + 1, closeIdx)
            : '';
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
    const result: ParsedGDBLine = {
      regAddr,
      method: parsedMethod.name,
      file: '??',
      lineNumber: '??',
    };
    if (parsedMethod.args && parsedMethod.args.length > 0) {
      Object.assign(result, { args: parsedMethod.args });
    }
    return result;
  }

  return { regAddr, lineNumber: lineNumber || '??' };
}
