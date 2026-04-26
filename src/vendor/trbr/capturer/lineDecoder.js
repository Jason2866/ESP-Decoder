// @ts-check

export class LineDecoder {
  _decoder = new TextDecoder('utf-8')
  _buffer = ''

  /**
   * @param {Uint8Array} chunk
   * @returns {string[]}
   */
  push(chunk) {
    this._buffer += this._decoder.decode(chunk, { stream: true })
    return this._drain(false)
  }

  /** @returns {string[]} */
  flush() {
    this._buffer += this._decoder.decode()
    return this._drain(true)
  }

  /**
   * @param {boolean} isFinal
   * @returns {string[]}
   */
  _drain(isFinal) {
    /** @type {string[]} */
    const lines = []
    let start = 0

    for (let i = 0; i < this._buffer.length; i++) {
      const ch = this._buffer.charCodeAt(i)
      if (ch !== 10 && ch !== 13) {
        continue
      }
      if (ch === 13 && i === this._buffer.length - 1 && !isFinal) {
        break
      }

      lines.push(this._buffer.slice(start, i))
      if (ch === 13 && this._buffer.charCodeAt(i + 1) === 10) {
        i++
      }
      start = i + 1
    }

    if (isFinal) {
      if (start < this._buffer.length) {
        lines.push(this._buffer.slice(start))
      }
      this._buffer = ''
      return lines
    }

    this._buffer = this._buffer.slice(start)
    return lines
  }
}
