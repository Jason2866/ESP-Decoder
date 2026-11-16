/** Incremental UTF-8 line decoder for serial byte chunks (handles CR/LF/CRLF). */
export class LineDecoder {
  private decoder = new TextDecoder('utf-8');
  private buffer = '';

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  flush(): string[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  /** True while an unterminated line (or held-back CR) is still buffered. */
  hasPendingLine(): boolean {
    return this.buffer.length > 0;
  }

  private drain(isFinal: boolean): string[] {
    const lines: string[] = [];
    let start = 0;

    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer.charCodeAt(i);
      if (ch !== 10 && ch !== 13) {
        continue;
      }
      if (ch === 13 && i === this.buffer.length - 1 && !isFinal) {
        break;
      }

      lines.push(this.buffer.slice(start, i));
      if (ch === 13 && this.buffer.charCodeAt(i + 1) === 10) {
        i++;
      }
      start = i + 1;
    }

    if (isFinal) {
      if (start < this.buffer.length) {
        lines.push(this.buffer.slice(start));
      }
      this.buffer = '';
      return lines;
    }

    this.buffer = this.buffer.slice(start);
    return lines;
  }
}
