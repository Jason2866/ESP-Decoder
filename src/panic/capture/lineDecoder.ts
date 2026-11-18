/** Upper bound for a single unterminated serial line (64 KiB). */
const MAX_LINE_LENGTH = 64 * 1024;

/** Incremental UTF-8 line decoder for serial byte chunks (handles CR/LF/CRLF). */
export class LineDecoder {
  private decoder = new TextDecoder('utf-8');
  /** Raw bytes not yet decoded because they may end in an incomplete UTF-8 sequence. */
  private byteBuffer: number[] = [];
  private buffer = '';
  /**
   * Length of the buffer prefix already scanned for line breaks. Only the
   * newly appended text is scanned on each push, so a long unterminated
   * line cannot trigger quadratic rescans.
   */
  private scannedLength = 0;
  /** Set when a trailing CR was already emitted; swallows a following LF (split CRLF). */
  private skipLeadingLf = false;
  /** Set after an oversized unterminated line was dropped; bytes are discarded through the next line break. */
  private discardingLine = false;

  push(chunk: Uint8Array): string[] {
    for (const byte of chunk) {
      this.byteBuffer.push(byte);
    }
    const safeLength = this.completeUtf8Length(this.byteBuffer);
    if (safeLength > 0) {
      this.buffer += this.decoder.decode(
        Uint8Array.from(this.byteBuffer.slice(0, safeLength)),
      );
      this.byteBuffer = this.byteBuffer.slice(safeLength);
    }
    const lines = this.drain(false);
    if (this.buffer.length > MAX_LINE_LENGTH) {
      // Bound memory and rescan cost: drop the oversized line and discard
      // its remainder through the next CR or LF.
      this.buffer = '';
      this.scannedLength = 0;
      this.discardingLine = true;
    }
    return lines;
  }

  flush(): string[] {
    if (this.byteBuffer.length > 0) {
      this.buffer += this.decoder.decode(Uint8Array.from(this.byteBuffer));
      this.byteBuffer = [];
    }
    return this.drain(true);
  }

  /** True while an unterminated line or undecoded UTF-8 bytes are buffered. */
  hasPendingLine(): boolean {
    return this.buffer.length > 0 || this.byteBuffer.length > 0;
  }

  /**
   * Length of the longest prefix ending on a complete UTF-8 sequence. A
   * trailing incomplete sequence (lead byte plus fewer continuation bytes
   * than its length requires) stays in byteBuffer so hasPendingLine()
   * reports it until the rest of the sequence arrives.
   */
  private completeUtf8Length(bytes: number[]): number {
    let i = bytes.length - 1;
    let continuations = 0;
    while (i >= 0 && bytes[i] >= 0x80 && bytes[i] <= 0xbf) {
      continuations++;
      i--;
    }
    if (i < 0) {
      // Only continuation bytes: cannot be the start of a pending sequence.
      return bytes.length;
    }
    const lead = bytes[i];
    const expected =
      lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 0;
    if (expected === 0) {
      return bytes.length;
    }
    const have = continuations + 1;
    return have < expected ? bytes.length - have : bytes.length;
  }

  private drain(isFinal: boolean): string[] {
    const lines: string[] = [];
    let start = 0;

    if (this.skipLeadingLf) {
      this.skipLeadingLf = false;
      if (this.buffer.charCodeAt(0) === 10) {
        this.buffer = this.buffer.slice(1);
        this.scannedLength = Math.max(0, this.scannedLength - 1);
      }
    }

    if (this.discardingLine) {
      // Drop everything through the next line break, then resume normal
      // line detection. A CR at the chunk end keeps the split-CRLF rule.
      // `found` tracks delimiter consumption separately from buffer
      // exhaustion: a delimiter as the chunk's last byte must still clear
      // the discard state.
      let i = 0;
      let found = false;
      while (i < this.buffer.length) {
        const ch = this.buffer.charCodeAt(i);
        if (ch === 10) {
          i += 1;
          found = true;
          break;
        }
        if (ch === 13) {
          if (this.buffer.charCodeAt(i + 1) === 10) {
            i += 2;
          } else {
            if (i === this.buffer.length - 1 && !isFinal) {
              this.skipLeadingLf = true;
            }
            i += 1;
          }
          found = true;
          break;
        }
        i++;
      }
      if (!found && !isFinal) {
        this.buffer = '';
        this.scannedLength = 0;
        return lines;
      }
      this.discardingLine = false;
      this.buffer = this.buffer.slice(i);
      this.scannedLength = 0;
    }

    for (let i = this.scannedLength; i < this.buffer.length; i++) {
      const ch = this.buffer.charCodeAt(i);
      if (ch !== 10 && ch !== 13) {
        continue;
      }

      const line = this.buffer.slice(start, i);
      if (line.length <= MAX_LINE_LENGTH) {
        lines.push(line);
      }
      if (ch === 13) {
        if (this.buffer.charCodeAt(i + 1) === 10) {
          i++;
        } else if (i === this.buffer.length - 1 && !isFinal) {
          // Trailing CR at a chunk boundary: emit the line now and skip a
          // LF that may arrive in the next chunk (split CRLF).
          this.skipLeadingLf = true;
        }
      }
      start = i + 1;
    }

    if (isFinal) {
      if (start < this.buffer.length) {
        const tail = this.buffer.slice(start);
        if (tail.length <= MAX_LINE_LENGTH) {
          lines.push(tail);
        }
      }
      this.buffer = '';
      this.scannedLength = 0;
      return lines;
    }

    this.buffer = this.buffer.slice(start);
    // Everything left in the buffer was scanned above and contains no
    // line break, so the next push only needs to scan appended text.
    this.scannedLength = this.buffer.length;
    return lines;
  }
}
