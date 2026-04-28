// @ts-check

import { execFile } from 'node:child_process'

// Default child-process stdout/stderr buffer cap. Node's built-in default is
// only ~1 MiB which is easily exceeded by tools like `arduino-cli board
// details` or large addr2line dumps. Callers may override via `options`.
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024

/**
 * @param {string} file
 * @param {string[]} [args=[]] Default is `[]`
 * @param {import('node:child_process').ExecFileOptions} [options={}] Default is
 *   `{}`
 * @returns {Promise<{ stdout: string; stderr: string }>}
 */
export async function exec(file, args = [], options = {}) {
  const mergedOptions = { maxBuffer: DEFAULT_MAX_BUFFER, ...options }
  return new Promise((resolve, reject) => {
    execFile(file, args, mergedOptions, (error, stdout, stderr) => {
      if (error) {
        reject(error)
      } else {
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        })
      }
    })
  })
}
