/** Parse PC:SP pairs from a firmware Backtrace record. */
export function printedBacktraceAddresses(line: string): number[] {
  const match = /^\s*Backtrace:(.*)$/i.exec(line);
  if (!match) {
    return [];
  }
  const addresses: number[] = [];
  for (const pair of match[1].matchAll(/(?:^|\s)(0x[0-9a-fA-F]+)\s*:\s*0x[0-9a-fA-F]+(?=\s|$)/g)) {
    const address = parseInt(pair[1], 16);
    if (!Number.isNaN(address)) {
      addresses.push(address);
    }
  }
  return addresses;
}

export function hasPrintedBacktracePair(line: string): boolean {
  return printedBacktraceAddresses(line).length > 0;
}
