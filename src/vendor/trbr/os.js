// @ts-check

/** @param {string} filename */
export function appendDotExeOnWindows(filename) {
  return `${filename}${process.platform === 'win32' ? '.exe' : ''}`
}
