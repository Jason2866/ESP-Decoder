/**
 * Unit tests for ANSI color support.
 *
 * Tests all ANSI SGR (Select Graphic Rendition) features used in the serial terminal:
 * - Text styles (bold, dim, italic, underline, strikethrough, blink, fastBlink, hidden, reverse)
 * - Foreground colors (standard 8, bright 8, 256-color palette, truecolor RGB)
 * - Background colors (standard 8, bright 8, 256-color palette, truecolor RGB)
 * - Reset codes (partial and full reset)
 * - ANSI state serialization/deserialization
 * - Multi-code sequences
 * - Edge cases (incomplete sequences, invalid codes)
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ESC character used in ANSI escape sequences
const ESC = '\x1b';

// ANSI color state interface matching the implementation
interface AnsiState {
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

// Standard 256-color palette (indices 0-255) - matches webviewPanel.ts
const ANSI_256: string[] = (() => {
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

// Reset state to default values
function resetAnsiState(state: AnsiState): void {
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

// Serialize current state back to SGR escape sequence
function ansiStateToSgr(state: AnsiState): string {
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

// Process an array of SGR codes
function ansiApplyCodes(state: AnsiState, codes: number[]): void {
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

// Create a fresh ANSI state object
function createAnsiState(): AnsiState {
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

describe('ANSI Color Support', () => {
  let state: AnsiState;

  beforeEach(() => {
    state = createAnsiState();
  });

  describe('Text Styles', () => {
    it('should apply bold style (code 1)', () => {
      ansiApplyCodes(state, [1]);
      expect(state.bold).toBe(true);
      expect(state.dim).toBe(false);
    });

    it('should apply dim style (code 2)', () => {
      ansiApplyCodes(state, [2]);
      expect(state.dim).toBe(true);
      expect(state.bold).toBe(false);
    });

    it('should apply italic style (code 3)', () => {
      ansiApplyCodes(state, [3]);
      expect(state.italic).toBe(true);
    });

    it('should apply underline style (code 4)', () => {
      ansiApplyCodes(state, [4]);
      expect(state.underline).toBe(true);
    });

    it('should apply blink style (code 5)', () => {
      ansiApplyCodes(state, [5]);
      expect(state.blink).toBe(true);
      expect(state.fastBlink).toBe(false);
    });

    it('should apply fast blink style (code 6)', () => {
      ansiApplyCodes(state, [6]);
      expect(state.fastBlink).toBe(true);
      expect(state.blink).toBe(false);
    });

    it('should apply reverse style (code 7)', () => {
      ansiApplyCodes(state, [7]);
      expect(state.reverse).toBe(true);
    });

    it('should apply hidden style (code 8)', () => {
      ansiApplyCodes(state, [8]);
      expect(state.hidden).toBe(true);
    });

    it('should apply strikethrough style (code 9)', () => {
      ansiApplyCodes(state, [9]);
      expect(state.strikethrough).toBe(true);
    });

    it('should handle all style codes in single sequence', () => {
      ansiApplyCodes(state, [1, 2, 3, 4, 5, 7, 8, 9]);
      expect(state.bold).toBe(true);
      expect(state.dim).toBe(true);
      expect(state.italic).toBe(true);
      expect(state.underline).toBe(true);
      expect(state.blink).toBe(true);
      expect(state.reverse).toBe(true);
      expect(state.hidden).toBe(true);
      expect(state.strikethrough).toBe(true);
    });
  });

  describe('Style Reset Codes', () => {
    beforeEach(() => {
      // Set all styles
      ansiApplyCodes(state, [1, 2, 3, 4, 5, 7, 8, 9]);
    });

    it('should reset bold and dim with code 22', () => {
      ansiApplyCodes(state, [22]);
      expect(state.bold).toBe(false);
      expect(state.dim).toBe(false);
      expect(state.italic).toBe(true); // others unchanged
    });

    it('should reset italic with code 23', () => {
      ansiApplyCodes(state, [23]);
      expect(state.italic).toBe(false);
      expect(state.bold).toBe(true); // others unchanged
    });

    it('should reset underline with code 24', () => {
      ansiApplyCodes(state, [24]);
      expect(state.underline).toBe(false);
    });

    it('should reset all blink styles with code 25', () => {
      ansiApplyCodes(state, [6]); // set fast blink
      ansiApplyCodes(state, [25]);
      expect(state.blink).toBe(false);
      expect(state.fastBlink).toBe(false);
    });

    it('should reset reverse with code 27', () => {
      ansiApplyCodes(state, [27]);
      expect(state.reverse).toBe(false);
    });

    it('should reset hidden with code 28', () => {
      ansiApplyCodes(state, [28]);
      expect(state.hidden).toBe(false);
    });

    it('should reset strikethrough with code 29', () => {
      ansiApplyCodes(state, [29]);
      expect(state.strikethrough).toBe(false);
    });

    it('should reset all styles with code 0', () => {
      // Also set some colors
      ansiApplyCodes(state, [31, 42]);
      ansiApplyCodes(state, [0]);

      expect(state.bold).toBe(false);
      expect(state.dim).toBe(false);
      expect(state.italic).toBe(false);
      expect(state.underline).toBe(false);
      expect(state.blink).toBe(false);
      expect(state.fastBlink).toBe(false);
      expect(state.reverse).toBe(false);
      expect(state.hidden).toBe(false);
      expect(state.strikethrough).toBe(false);
      expect(state.fg).toBeNull();
      expect(state.bg).toBeNull();
      expect(state.fgRgb).toBeNull();
      expect(state.bgRgb).toBeNull();
    });
  });

  describe('Standard Foreground Colors (30-37)', () => {
    it('should set foreground black (code 30)', () => {
      ansiApplyCodes(state, [30]);
      expect(state.fg).toBe('black');
      expect(state.fgRgb).toBeNull();
    });

    it('should set foreground red (code 31)', () => {
      ansiApplyCodes(state, [31]);
      expect(state.fg).toBe('red');
    });

    it('should set foreground green (code 32)', () => {
      ansiApplyCodes(state, [32]);
      expect(state.fg).toBe('green');
    });

    it('should set foreground yellow (code 33)', () => {
      ansiApplyCodes(state, [33]);
      expect(state.fg).toBe('yellow');
    });

    it('should set foreground blue (code 34)', () => {
      ansiApplyCodes(state, [34]);
      expect(state.fg).toBe('blue');
    });

    it('should set foreground magenta (code 35)', () => {
      ansiApplyCodes(state, [35]);
      expect(state.fg).toBe('magenta');
    });

    it('should set foreground cyan (code 36)', () => {
      ansiApplyCodes(state, [36]);
      expect(state.fg).toBe('cyan');
    });

    it('should set foreground white (code 37)', () => {
      ansiApplyCodes(state, [37]);
      expect(state.fg).toBe('white');
    });

    it('should reset foreground with code 39', () => {
      ansiApplyCodes(state, [31]);
      ansiApplyCodes(state, [39]);
      expect(state.fg).toBeNull();
      expect(state.fgRgb).toBeNull();
    });
  });

  describe('Standard Background Colors (40-47)', () => {
    it('should set background black (code 40)', () => {
      ansiApplyCodes(state, [40]);
      expect(state.bg).toBe('black');
      expect(state.bgRgb).toBeNull();
    });

    it('should set background red (code 41)', () => {
      ansiApplyCodes(state, [41]);
      expect(state.bg).toBe('red');
    });

    it('should set background green (code 42)', () => {
      ansiApplyCodes(state, [42]);
      expect(state.bg).toBe('green');
    });

    it('should set background yellow (code 43)', () => {
      ansiApplyCodes(state, [43]);
      expect(state.bg).toBe('yellow');
    });

    it('should set background blue (code 44)', () => {
      ansiApplyCodes(state, [44]);
      expect(state.bg).toBe('blue');
    });

    it('should set background magenta (code 45)', () => {
      ansiApplyCodes(state, [45]);
      expect(state.bg).toBe('magenta');
    });

    it('should set background cyan (code 46)', () => {
      ansiApplyCodes(state, [46]);
      expect(state.bg).toBe('cyan');
    });

    it('should set background white (code 47)', () => {
      ansiApplyCodes(state, [47]);
      expect(state.bg).toBe('white');
    });

    it('should reset background with code 49', () => {
      ansiApplyCodes(state, [41]);
      ansiApplyCodes(state, [49]);
      expect(state.bg).toBeNull();
      expect(state.bgRgb).toBeNull();
    });
  });

  describe('Bright Foreground Colors (90-97)', () => {
    it('should set bright foreground colors using 256-color palette', () => {
      ansiApplyCodes(state, [90]);
      expect(state.fg).toBeNull();
      expect(state.fgRgb).toBe(ANSI_256[8]);

      ansiApplyCodes(state, [91]);
      expect(state.fgRgb).toBe(ANSI_256[9]);

      ansiApplyCodes(state, [92]);
      expect(state.fgRgb).toBe(ANSI_256[10]);

      ansiApplyCodes(state, [93]);
      expect(state.fgRgb).toBe(ANSI_256[11]);

      ansiApplyCodes(state, [94]);
      expect(state.fgRgb).toBe(ANSI_256[12]);

      ansiApplyCodes(state, [95]);
      expect(state.fgRgb).toBe(ANSI_256[13]);

      ansiApplyCodes(state, [96]);
      expect(state.fgRgb).toBe(ANSI_256[14]);

      ansiApplyCodes(state, [97]);
      expect(state.fgRgb).toBe(ANSI_256[15]);
    });
  });

  describe('Bright Background Colors (100-107)', () => {
    it('should set bright background colors using 256-color palette', () => {
      ansiApplyCodes(state, [100]);
      expect(state.bg).toBeNull();
      expect(state.bgRgb).toBe(ANSI_256[8]);

      ansiApplyCodes(state, [101]);
      expect(state.bgRgb).toBe(ANSI_256[9]);

      ansiApplyCodes(state, [102]);
      expect(state.bgRgb).toBe(ANSI_256[10]);

      ansiApplyCodes(state, [103]);
      expect(state.bgRgb).toBe(ANSI_256[11]);

      ansiApplyCodes(state, [104]);
      expect(state.bgRgb).toBe(ANSI_256[12]);

      ansiApplyCodes(state, [105]);
      expect(state.bgRgb).toBe(ANSI_256[13]);

      ansiApplyCodes(state, [106]);
      expect(state.bgRgb).toBe(ANSI_256[14]);

      ansiApplyCodes(state, [107]);
      expect(state.bgRgb).toBe(ANSI_256[15]);
    });
  });

  describe('256-Color Palette (38;5;n and 48;5;n)', () => {
    it('should set foreground using 256-color palette index', () => {
      ansiApplyCodes(state, [38, 5, 196]); // Bright red from color cube
      expect(state.fg).toBeNull();
      expect(state.fgRgb).toBe(ANSI_256[196]);
    });

    it('should set background using 256-color palette index', () => {
      ansiApplyCodes(state, [48, 5, 46]); // Green from color cube
      expect(state.bg).toBeNull();
      expect(state.bgRgb).toBe(ANSI_256[46]);
    });

    it('should handle standard colors (0-7) via 256-color syntax', () => {
      ansiApplyCodes(state, [38, 5, 1]); // Red
      expect(state.fgRgb).toBe(ANSI_256[1]);
    });

    it('should handle bright colors (8-15) via 256-color syntax', () => {
      ansiApplyCodes(state, [38, 5, 9]); // Bright red
      expect(state.fgRgb).toBe(ANSI_256[9]);
    });

    it('should handle color cube colors (16-231)', () => {
      ansiApplyCodes(state, [38, 5, 16]); // First color cube color
      expect(state.fgRgb).toBe(ANSI_256[16]);

      ansiApplyCodes(state, [38, 5, 231]); // Last color cube color
      expect(state.fgRgb).toBe(ANSI_256[231]);
    });

    it('should handle grayscale ramp (232-255)', () => {
      ansiApplyCodes(state, [38, 5, 232]); // First grayscale
      expect(state.fgRgb).toBe(ANSI_256[232]);

      ansiApplyCodes(state, [48, 5, 255]); // Last grayscale
      expect(state.bgRgb).toBe(ANSI_256[255]);
    });

    it('should ignore out-of-range palette indices', () => {
      ansiApplyCodes(state, [38, 5, 300]); // Out of range
      // Should not crash and state should remain unchanged from default
      expect(state.fgRgb).toBeNull();
    });

    it('should ignore incomplete 256-color sequences', () => {
      ansiApplyCodes(state, [38, 5]); // Missing index
      expect(state.fg).toBeNull();
      expect(state.fgRgb).toBeNull();
    });
  });

  describe('Truecolor RGB (38;2;r;g;b and 48;2;r;g;b)', () => {
    it('should set foreground truecolor RGB', () => {
      ansiApplyCodes(state, [38, 2, 255, 128, 64]);
      expect(state.fg).toBeNull();
      expect(state.fgRgb).toBe('rgb(255,128,64)');
    });

    it('should set background truecolor RGB', () => {
      ansiApplyCodes(state, [48, 2, 64, 128, 255]);
      expect(state.bg).toBeNull();
      expect(state.bgRgb).toBe('rgb(64,128,255)');
    });

    it('should clamp RGB values to valid range', () => {
      ansiApplyCodes(state, [38, 2, 300, -50, 255]);
      expect(state.fgRgb).toBe('rgb(255,0,255)');
    });

    it('should handle black RGB values', () => {
      ansiApplyCodes(state, [38, 2, 0, 0, 0]);
      expect(state.fgRgb).toBe('rgb(0,0,0)');
    });

    it('should handle white RGB values', () => {
      ansiApplyCodes(state, [38, 2, 255, 255, 255]);
      expect(state.fgRgb).toBe('rgb(255,255,255)');
    });

    it('should ignore incomplete truecolor sequences', () => {
      ansiApplyCodes(state, [38, 2, 255, 128]); // Missing blue component
      expect(state.fgRgb).toBeNull();
    });

    it('should handle multiple RGB codes in sequence', () => {
      ansiApplyCodes(state, [38, 2, 100, 150, 200, 48, 2, 50, 75, 100]);
      expect(state.fgRgb).toBe('rgb(100,150,200)');
      expect(state.bgRgb).toBe('rgb(50,75,100)');
    });
  });

  describe('Combined Sequences', () => {
    it('should handle foreground color with style', () => {
      ansiApplyCodes(state, [1, 31]); // Bold red
      expect(state.bold).toBe(true);
      expect(state.fg).toBe('red');
    });

    it('should handle foreground and background with styles', () => {
      ansiApplyCodes(state, [1, 3, 31, 42]); // Bold italic red on green
      expect(state.bold).toBe(true);
      expect(state.italic).toBe(true);
      expect(state.fg).toBe('red');
      expect(state.bg).toBe('green');
    });

    it('should handle 256-color with styles', () => {
      ansiApplyCodes(state, [1, 2, 38, 5, 196]); // Bold dim with bright red
      expect(state.bold).toBe(true);
      expect(state.dim).toBe(true);
      expect(state.fgRgb).toBe(ANSI_256[196]);
    });

    it('should handle truecolor with styles', () => {
      ansiApplyCodes(state, [4, 38, 2, 255, 128, 0, 48, 2, 0, 0, 255]); // Underline orange on blue
      expect(state.underline).toBe(true);
      expect(state.fgRgb).toBe('rgb(255,128,0)');
      expect(state.bgRgb).toBe('rgb(0,0,255)');
    });

    it('should handle reset followed by new styles', () => {
      ansiApplyCodes(state, [1, 31, 42]); // Bold red on green
      ansiApplyCodes(state, [0, 4, 34]); // Reset, then underline blue
      expect(state.bold).toBe(false);
      expect(state.fg).toBe('blue');
      expect(state.bg).toBeNull();
      expect(state.underline).toBe(true);
    });

    it('should handle partial reset in sequence', () => {
      ansiApplyCodes(state, [1, 3, 4, 31]); // Bold italic underline red
      ansiApplyCodes(state, [22, 24]); // Reset bold/dim and underline
      expect(state.bold).toBe(false);
      expect(state.italic).toBe(true); // Preserved
      expect(state.underline).toBe(false);
      expect(state.fg).toBe('red'); // Preserved
    });
  });

  describe('ANSI State Serialization (ansiStateToSgr)', () => {
    it('should return empty string for default state', () => {
      const sgr = ansiStateToSgr(state);
      expect(sgr).toBe('');
    });

    it('should serialize bold style', () => {
      state.bold = true;
      expect(ansiStateToSgr(state)).toBe('\x1b[1m');
    });

    it('should serialize multiple styles', () => {
      state.bold = true;
      state.italic = true;
      expect(ansiStateToSgr(state)).toBe('\x1b[1;3m');
    });

    it('should serialize foreground color', () => {
      state.fg = 'red';
      expect(ansiStateToSgr(state)).toBe('\x1b[31m');
    });

    it('should serialize background color', () => {
      state.bg = 'blue';
      expect(ansiStateToSgr(state)).toBe('\x1b[44m');
    });

    it('should serialize truecolor foreground', () => {
      state.fgRgb = 'rgb(255,128,64)';
      expect(ansiStateToSgr(state)).toBe('\x1b[38;2;255;128;64m');
    });

    it('should serialize truecolor background', () => {
      state.bgRgb = 'rgb(64,128,255)';
      expect(ansiStateToSgr(state)).toBe('\x1b[48;2;64;128;255m');
    });

    it('should serialize complex state', () => {
      state.bold = true;
      state.underline = true;
      state.fg = 'green';
      state.bgRgb = 'rgb(128,0,0)';
      const sgr = ansiStateToSgr(state);
      expect(sgr).toBe('\x1b[1;4;32;48;2;128;0;0m');
    });

    it('should serialize all styles', () => {
      state.bold = true;
      state.dim = true;
      state.italic = true;
      state.underline = true;
      state.blink = true;
      state.reverse = true;
      state.hidden = true;
      state.strikethrough = true;
      expect(ansiStateToSgr(state)).toBe('\x1b[1;2;3;4;5;7;8;9m');
    });
  });

  describe('State Reset Function', () => {
    it('should reset all properties to defaults', () => {
      // Set everything to non-default
      ansiApplyCodes(state, [1, 2, 3, 4, 5, 6, 7, 8, 9, 31, 42]);
      expect(state.fastBlink).toBe(true); // 6 sets fast blink, cancels blink

      // Set both for testing reset
      ansiApplyCodes(state, [5]); // Add blink back

      resetAnsiState(state);

      expect(state.bold).toBe(false);
      expect(state.dim).toBe(false);
      expect(state.italic).toBe(false);
      expect(state.underline).toBe(false);
      expect(state.blink).toBe(false);
      expect(state.fastBlink).toBe(false);
      expect(state.reverse).toBe(false);
      expect(state.hidden).toBe(false);
      expect(state.strikethrough).toBe(false);
      expect(state.fg).toBeNull();
      expect(state.bg).toBeNull();
      expect(state.fgRgb).toBeNull();
      expect(state.bgRgb).toBeNull();
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should ignore unknown SGR codes', () => {
      ansiApplyCodes(state, [99, 1, 999]); // Unknown codes mixed with valid
      expect(state.bold).toBe(true); // Valid code still applied
    });

    it('should handle empty code array', () => {
      ansiApplyCodes(state, []);
      expect(state).toEqual(createAnsiState());
    });

    it('should handle single code 0 (reset)', () => {
      ansiApplyCodes(state, [1, 31]); // Set some state
      ansiApplyCodes(state, [0]);
      expect(state).toEqual(createAnsiState());
    });

    it('should handle code 0 in multi-code sequence', () => {
      ansiApplyCodes(state, [1, 0, 31]); // Reset then red
      expect(state.bold).toBe(false);
      expect(state.fg).toBe('red');
    });

    it('should switch between standard and 256-color modes', () => {
      ansiApplyCodes(state, [31]); // Standard red
      expect(state.fg).toBe('red');
      expect(state.fgRgb).toBeNull();

      ansiApplyCodes(state, [38, 5, 196]); // 256-color bright red
      expect(state.fg).toBeNull();
      expect(state.fgRgb).toBe(ANSI_256[196]);

      ansiApplyCodes(state, [31]); // Back to standard red
      expect(state.fg).toBe('red');
      expect(state.fgRgb).toBeNull();
    });

    it('should switch between 256-color and truecolor modes', () => {
      ansiApplyCodes(state, [38, 5, 196]); // 256-color
      expect(state.fgRgb).toBe(ANSI_256[196]);

      ansiApplyCodes(state, [38, 2, 255, 0, 0]); // Truecolor
      expect(state.fgRgb).toBe('rgb(255,0,0)');
    });

    it('should handle blink mutually exclusive properly', () => {
      ansiApplyCodes(state, [5]); // Slow blink
      expect(state.blink).toBe(true);
      expect(state.fastBlink).toBe(false);

      ansiApplyCodes(state, [6]); // Fast blink - should cancel slow
      expect(state.blink).toBe(false);
      expect(state.fastBlink).toBe(true);

      ansiApplyCodes(state, [5]); // Slow blink - should cancel fast
      expect(state.blink).toBe(true);
      expect(state.fastBlink).toBe(false);
    });
  });

  describe('256-Color Palette Accuracy', () => {
    it('should have correct standard colors (0-7)', () => {
      expect(ANSI_256[0]).toBe('rgb(0,0,0)'); // Black
      expect(ANSI_256[1]).toBe('rgb(128,0,0)'); // Red
      expect(ANSI_256[2]).toBe('rgb(0,128,0)'); // Green
      expect(ANSI_256[3]).toBe('rgb(128,128,0)'); // Yellow
      expect(ANSI_256[4]).toBe('rgb(0,0,128)'); // Blue
      expect(ANSI_256[5]).toBe('rgb(128,0,128)'); // Magenta
      expect(ANSI_256[6]).toBe('rgb(0,128,128)'); // Cyan
      expect(ANSI_256[7]).toBe('rgb(192,192,192)'); // White
    });

    it('should have correct bright colors (8-15)', () => {
      expect(ANSI_256[8]).toBe('rgb(128,128,128)'); // Bright black (gray)
      expect(ANSI_256[9]).toBe('rgb(255,0,0)'); // Bright red
      expect(ANSI_256[10]).toBe('rgb(0,255,0)'); // Bright green
      expect(ANSI_256[11]).toBe('rgb(255,255,0)'); // Bright yellow
      expect(ANSI_256[12]).toBe('rgb(99,153,255)'); // Bright blue
      expect(ANSI_256[13]).toBe('rgb(255,0,255)'); // Bright magenta
      expect(ANSI_256[14]).toBe('rgb(0,255,255)'); // Bright cyan
      expect(ANSI_256[15]).toBe('rgb(255,255,255)'); // Bright white
    });

    it('should generate correct color cube values', () => {
      // First color in cube (16) - all channels at 0 intensity
      expect(ANSI_256[16]).toBe('rgb(0,0,0)');

      // Color with red at intensity 1 (16 + 36)
      expect(ANSI_256[52]).toBe('rgb(95,0,0)');

      // Color with green at intensity 1 (16 + 6)
      expect(ANSI_256[22]).toBe('rgb(0,95,0)');

      // Color with blue at intensity 1 (16 + 1)
      expect(ANSI_256[17]).toBe('rgb(0,0,95)');

      // Maximum color (16 + 215 = 231) - all channels at max
      expect(ANSI_256[231]).toBe('rgb(255,255,255)');
    });

    it('should generate correct grayscale ramp values', () => {
      // First grayscale (232) - should be rgb(8,8,8)
      expect(ANSI_256[232]).toBe('rgb(8,8,8)');

      // Middle grayscale (around 243)
      expect(ANSI_256[243]).toBe('rgb(118,118,118)');

      // Last grayscale (255) - should be rgb(238,238,238)
      expect(ANSI_256[255]).toBe('rgb(238,238,238)');
    });

    it('should have exactly 256 colors', () => {
      expect(ANSI_256.length).toBe(256);
    });
  });

  describe('Complex Real-World Scenarios', () => {
    it('should handle ESP32 log color scheme', () => {
      // ESP32 log levels typically use colors:
      // ERROR - red, WARN - yellow, INFO - green, DEBUG - cyan, VERBOSE - gray

      // ERROR: bold red
      ansiApplyCodes(state, [1, 31]);
      expect(state.bold).toBe(true);
      expect(state.fg).toBe('red');
      resetAnsiState(state);

      // WARN: bold yellow
      ansiApplyCodes(state, [1, 33]);
      expect(state.bold).toBe(true);
      expect(state.fg).toBe('yellow');
      resetAnsiState(state);

      // INFO: green
      ansiApplyCodes(state, [32]);
      expect(state.fg).toBe('green');
      resetAnsiState(state);

      // DEBUG: cyan
      ansiApplyCodes(state, [36]);
      expect(state.fg).toBe('cyan');
      resetAnsiState(state);

      // VERBOSE: dim gray (using 256-color)
      ansiApplyCodes(state, [2, 38, 5, 8]);
      expect(state.dim).toBe(true);
      expect(state.fgRgb).toBe(ANSI_256[8]);
    });

    it('should handle syntax highlighting patterns', () => {
      // Keywords: bold blue
      ansiApplyCodes(state, [1, 34]);
      expect(state.bold && state.fg === 'blue').toBe(true);
      resetAnsiState(state);

      // Strings: green
      ansiApplyCodes(state, [32]);
      expect(state.fg).toBe('green');
      resetAnsiState(state);

      // Comments: dim gray (italic)
      ansiApplyCodes(state, [2, 3, 90]);
      expect(state.dim).toBe(true);
      expect(state.italic).toBe(true);
      expect(state.fgRgb).toBe(ANSI_256[8]);
      resetAnsiState(state);

      // Numbers: magenta
      ansiApplyCodes(state, [35]);
      expect(state.fg).toBe('magenta');
    });

    it('should handle timestamp prefix with preserved state', () => {
      // Original state: bold red
      ansiApplyCodes(state, [1, 31]);

      // Save state
      const savedState = ansiStateToSgr(state);
      expect(savedState).toBe('\x1b[1;31m');

      // Reset for timestamp (dim)
      ansiApplyCodes(state, [0, 2]);
      expect(state.dim).toBe(true);
      expect(state.bold).toBe(false);

      // Restore original state
      // Parse the saved SGR sequence
      const match = savedState.match(/^\x1b\[(.*)m$/);
      if (match) {
        const codes = match[1].split(';').map((c) => parseInt(c, 10) || 0);
        ansiApplyCodes(state, [0]); // Reset first
        ansiApplyCodes(state, codes);
      }

      expect(state.bold).toBe(true);
      expect(state.fg).toBe('red');
      expect(state.dim).toBe(false);
    });

    it('should handle multi-line colored output state preservation', () => {
      // Set up a complex state
      ansiApplyCodes(state, [1, 3, 38, 2, 255, 128, 0]); // Bold italic orange

      // Verify initial state
      expect(state.bold).toBe(true);
      expect(state.italic).toBe(true);
      expect(state.fgRgb).toBe('rgb(255,128,0)');

      // Serialize state
      const sgr = ansiStateToSgr(state);

      // Simulate reset for timestamp
      ansiApplyCodes(state, [0, 2]);

      // Restore
      const match = sgr.match(/^\x1b\[(.*)m$/);
      if (match) {
        const codes = match[1].split(';').map((c) => parseInt(c, 10) || 0);
        ansiApplyCodes(state, [0]);
        ansiApplyCodes(state, codes);
      }

      // State should be fully restored
      expect(state.bold).toBe(true);
      expect(state.italic).toBe(true);
      expect(state.fgRgb).toBe('rgb(255,128,0)');
    });
  });
});
