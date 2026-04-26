// @ts-check

export class AbortError extends Error {
  constructor() {
    super('User abort')
    this.name = 'AbortError'
    this.code = 'ABORT_ERR'
  }
}

export const neverSignal = new AbortController().signal
