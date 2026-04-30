/**
 * ANSI escape sequence parser and state management.
 * 
 * This module contains the core ANSI SGR (Select Graphic Rendition) logic
 * for parsing ANSI escape sequences and managing color/state information.
 * It is used by both the webview (for rendering) and tests (for verification).
 */

// ESC character used in ANSI escape sequences
export const ESC = '\x1b';

/**
 * ANSI color state interface
 */
export interface AnsiState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  blink: boolean;
  fastBlink: boolean;
  hidden: boolean;
  dim: boolean;
  reverse: boolean;
  fg: string | null;
  bg: string | null;
  fgRgb: string | null;
  bgRgb: string | null;
}

/**
 * Standard 256-color palette (indices 0-255)
 * Note: Index 12 (bright blue) is intentionally set to rgb(99,153,255)
 * to match the existing .ansi-fg-blue CSS class rather than the xterm standard.
 */
export const ANSI_256: string[] = (() => {
  const t: string[] = [];
  // 0-7: standard colors
  t[0] = 'rgb(0,0,0)';
  t[1] = 'rgb(128,0,0)';
  t[2] = 'rgb(0,128,0)';
  t[3] = 'rgb(128,128,0)';
  t[4] = 'rgb(0,0,128)';
  t[5] = 'rgb(128,0,128)';
  t[6] = 'rgb(0,128,128)';
  t[7] = 'rgb(192,192,192)';
  // 8-15: bright colors
  t[8] = 'rgb(128,128,128)';
  t[9] = 'rgb(255,0,0)';
  t[10] = 'rgb(0,255,0)';
  t[11] = 'rgb(255,255,0)';
  t[12] = 'rgb(99,153,255)';
  t[13] = 'rgb(255,0,255)';
  t[14] = 'rgb(0,255,255)';
  t[15] = 'rgb(255,255,255)';
  // 16-231: 6x6x6 color cube
  for (let i = 0; i < 216; i++) {
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    t[16 + i] =
      'rgb(' +
      (r ? r * 40 + 55 : 0) +
      ',' +
      (g ? g * 40 + 55 : 0) +
      ',' +
      (b ? b * 40 + 55 : 0) +
      ')';
  }
  // 232-255: grayscale ramp
  for (let i = 0; i < 24; i++) {
    const v = i * 10 + 8;
    t[232 + i] = 'rgb(' + v + ',' + v + ',' + v + ')';
  }
  return t;
})();

/**
 * Reset state to default values
 */
export function resetAnsiState(state: AnsiState): void {
  state.bold = false;
  state.dim = false;
  state.italic = false;
  state.underline = false;
  state.strikethrough = false;
  state.blink = false;
  state.fastBlink = false;
  state.hidden = false;
  state.reverse = false;
  state.fg = null;
  state.bg = null;
  state.fgRgb = null;
  state.bgRgb = null;
}

/**
 * Serialize current state back to SGR escape sequence
 */
export function ansiStateToSgr(state: AnsiState): string {
  const codes: number[] = [];
  if (state.bold) { codes.push(1); }
  if (state.dim) { codes.push(2); }
  if (state.italic) { codes.push(3); }
  if (state.underline) { codes.push(4); }
  if (state.blink) { codes.push(5); }
  if (state.fastBlink) { codes.push(6); }
  if (state.reverse) { codes.push(7); }
  if (state.hidden) { codes.push(8); }
  if (state.strikethrough) { codes.push(9); }

  const fgMap: Record<string, number> = {
    black: 30,
    red: 31,
    green: 32,
    yellow: 33,
    blue: 34,
    magenta: 35,
    cyan: 36,
    white: 37,
  };
  const bgMap: Record<string, number> = {
    black: 40,
    red: 41,
    green: 42,
    yellow: 43,
    blue: 44,
    magenta: 45,
    cyan: 46,
    white: 47,
  };

  if (state.fgRgb) {
    const mfg = /rgb\((\d+),(\d+),(\d+)\)/.exec(state.fgRgb);
    if (mfg) {
      codes.push(38, 2, +mfg[1], +mfg[2], +mfg[3]);
    }
  } else if (state.fg && fgMap[state.fg] !== undefined) {
    codes.push(fgMap[state.fg]);
  }

  if (state.bgRgb) {
    const mbg = /rgb\((\d+),(\d+),(\d+)\)/.exec(state.bgRgb);
    if (mbg) {
      codes.push(48, 2, +mbg[1], +mbg[2], +mbg[3]);
    }
  } else if (state.bg && bgMap[state.bg] !== undefined) {
    codes.push(bgMap[state.bg]);
  }

  if (codes.length === 0) { return ''; }
  return ESC + '[' + codes.join(';') + 'm';
}

/**
 * Process an array of SGR codes
 */
export function ansiApplyCodes(state: AnsiState, codes: number[]): void {
  for (let ci = 0; ci < codes.length; ci++) {
    const code = codes[ci];

    // Extended foreground: 38;5;n or 38;2;r;g;b
    if (code === 38 && ci + 1 < codes.length) {
      if (codes[ci + 1] === 5) {
        if (ci + 2 < codes.length) {
          const idx = codes[ci + 2];
          if (idx >= 0 && idx <= 255 && ANSI_256[idx]) {
            state.fg = null;
            state.fgRgb = ANSI_256[idx];
          }
          ci += 2;
        } else {
          ci += 1;
        }
        continue;
      }
      if (codes[ci + 1] === 2) {
        if (ci + 4 < codes.length) {
          state.fg = null;
          const r = Math.max(0, Math.min(255, codes[ci + 2]));
          const g = Math.max(0, Math.min(255, codes[ci + 3]));
          const b = Math.max(0, Math.min(255, codes[ci + 4]));
          state.fgRgb = 'rgb(' + r + ',' + g + ',' + b + ')';
          ci += 4;
        } else {
          ci = codes.length - 1;
        }
        continue;
      }
    }

    // Extended background: 48;5;n or 48;2;r;g;b
    if (code === 48 && ci + 1 < codes.length) {
      if (codes[ci + 1] === 5) {
        if (ci + 2 < codes.length) {
          const idx = codes[ci + 2];
          if (idx >= 0 && idx <= 255 && ANSI_256[idx]) {
            state.bg = null;
            state.bgRgb = ANSI_256[idx];
          }
          ci += 2;
        } else {
          ci += 1;
        }
        continue;
      }
      if (codes[ci + 1] === 2) {
        if (ci + 4 < codes.length) {
          state.bg = null;
          const r = Math.max(0, Math.min(255, codes[ci + 2]));
          const g = Math.max(0, Math.min(255, codes[ci + 3]));
          const b = Math.max(0, Math.min(255, codes[ci + 4]));
          state.bgRgb = 'rgb(' + r + ',' + g + ',' + b + ')';
          ci += 4;
        } else {
          ci = codes.length - 1;
        }
        continue;
      }
    }

    switch (code) {
      case 0:
        resetAnsiState(state);
        break;
      case 1:
        state.bold = true;
        break;
      case 2:
        state.dim = true;
        break;
      case 3:
        state.italic = true;
        break;
      case 4:
        state.underline = true;
        break;
      case 5:
        state.blink = true;
        state.fastBlink = false;
        break;
      case 6:
        state.fastBlink = true;
        state.blink = false;
        break;
      case 7:
        state.reverse = true;
        break;
      case 8:
        state.hidden = true;
        break;
      case 9:
        state.strikethrough = true;
        break;
      case 22:
        state.bold = false;
        state.dim = false;
        break;
      case 23:
        state.italic = false;
        break;
      case 24:
        state.underline = false;
        break;
      case 25:
        state.blink = false;
        state.fastBlink = false;
        break;
      case 27:
        state.reverse = false;
        break;
      case 28:
        state.hidden = false;
        break;
      case 29:
        state.strikethrough = false;
        break;
      case 30:
        state.fg = 'black';
        state.fgRgb = null;
        break;
      case 31:
        state.fg = 'red';
        state.fgRgb = null;
        break;
      case 32:
        state.fg = 'green';
        state.fgRgb = null;
        break;
      case 33:
        state.fg = 'yellow';
        state.fgRgb = null;
        break;
      case 34:
        state.fg = 'blue';
        state.fgRgb = null;
        break;
      case 35:
        state.fg = 'magenta';
        state.fgRgb = null;
        break;
      case 36:
        state.fg = 'cyan';
        state.fgRgb = null;
        break;
      case 37:
        state.fg = 'white';
        state.fgRgb = null;
        break;
      case 39:
        state.fg = null;
        state.fgRgb = null;
        break;
      case 40:
        state.bg = 'black';
        state.bgRgb = null;
        break;
      case 41:
        state.bg = 'red';
        state.bgRgb = null;
        break;
      case 42:
        state.bg = 'green';
        state.bgRgb = null;
        break;
      case 43:
        state.bg = 'yellow';
        state.bgRgb = null;
        break;
      case 44:
        state.bg = 'blue';
        state.bgRgb = null;
        break;
      case 45:
        state.bg = 'magenta';
        state.bgRgb = null;
        break;
      case 46:
        state.bg = 'cyan';
        state.bgRgb = null;
        break;
      case 47:
        state.bg = 'white';
        state.bgRgb = null;
        break;
      case 49:
        state.bg = null;
        state.bgRgb = null;
        break;
      // Bright foreground colors (90-97)
      case 90:
        state.fg = null;
        state.fgRgb = ANSI_256[8];
        break;
      case 91:
        state.fg = null;
        state.fgRgb = ANSI_256[9];
        break;
      case 92:
        state.fg = null;
        state.fgRgb = ANSI_256[10];
        break;
      case 93:
        state.fg = null;
        state.fgRgb = ANSI_256[11];
        break;
      case 94:
        state.fg = null;
        state.fgRgb = ANSI_256[12];
        break;
      case 95:
        state.fg = null;
        state.fgRgb = ANSI_256[13];
        break;
      case 96:
        state.fg = null;
        state.fgRgb = ANSI_256[14];
        break;
      case 97:
        state.fg = null;
        state.fgRgb = ANSI_256[15];
        break;
      // Bright background colors (100-107)
      case 100:
        state.bg = null;
        state.bgRgb = ANSI_256[8];
        break;
      case 101:
        state.bg = null;
        state.bgRgb = ANSI_256[9];
        break;
      case 102:
        state.bg = null;
        state.bgRgb = ANSI_256[10];
        break;
      case 103:
        state.bg = null;
        state.bgRgb = ANSI_256[11];
        break;
      case 104:
        state.bg = null;
        state.bgRgb = ANSI_256[12];
        break;
      case 105:
        state.bg = null;
        state.bgRgb = ANSI_256[13];
        break;
      case 106:
        state.bg = null;
        state.bgRgb = ANSI_256[14];
        break;
      case 107:
        state.bg = null;
        state.bgRgb = ANSI_256[15];
        break;
    }
  }
}

/**
 * Create a fresh ANSI state object
 */
export function createAnsiState(): AnsiState {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strikethrough: false,
    blink: false,
    fastBlink: false,
    hidden: false,
    reverse: false,
    fg: null,
    bg: null,
    fgRgb: null,
    bgRgb: null,
  };
}
