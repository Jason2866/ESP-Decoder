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
import {
  type AnsiState,
  ANSI_256,
  resetAnsiState,
  ansiStateToSgr,
  ansiApplyCodes,
  createAnsiState,
} from '../ansiParser';



describe('ANSI Color Support', () => {
  let state: AnsiState;

  beforeEach(() => {
    state = createAnsiState();
  });

  describe('Text Styles', () => {
    it('should apply bold style (code 1)', () => {
      // Set preconditions: bold off, dim on - verify bold applies independently
      state.bold = false;
      state.dim = true;
      expect(state.bold).toBe(false);
      expect(state.dim).toBe(true);

      ansiApplyCodes(state, [1]);
      expect(state.bold).toBe(true);
      // dim remains true (only code 22 clears both bold and dim)
      expect(state.dim).toBe(true);
    });

    it('should apply dim style (code 2)', () => {
      // Set preconditions: dim off, bold on - verify dim applies independently
      state.dim = false;
      state.bold = true;
      expect(state.dim).toBe(false);
      expect(state.bold).toBe(true);

      ansiApplyCodes(state, [2]);
      expect(state.dim).toBe(true);
      // bold remains true (only code 22 clears both bold and dim)
      expect(state.bold).toBe(true);
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

    it('should handle split escape-sequence continuity across chunks (ansiTail pattern)', () => {
      // Simulate chunk processing with ansiTail pattern
      // First chunk ends mid-ANSI escape (e.g., "\x1b[38;2;255;")
      const chunk1 = '\x1b[38;2;255;';
      // Second chunk supplies the remainder (e.g., "128;0m")
      const chunk2 = '128;0m';

      // Process chunk1 - this simulates what the webview does with ansiTail
      // In the webview, incomplete escapes at the end are saved to ansiTail
      // and prepended to the next chunk

      // For this test, we simulate the combined result:
      // ansiTail + chunk2 forms the complete escape sequence
      let ansiTail = '';

      // Check if chunk1 ends with incomplete escape
      const lastEscape1 = chunk1.lastIndexOf('\x1b');
      if (lastEscape1 >= 0) {
        const candidate1 = chunk1.substring(lastEscape1);
        const completeEscape1 = /^\x1b(?:\[[0-9;?]*[\x20-\x2f]*[\x40-\x7e]|[^\[][^\x00-\x1f]?)/.test(candidate1);
        if (!completeEscape1) {
          ansiTail = candidate1;
        }
      }

      // Verify ansiTail captured the incomplete escape
      expect(ansiTail).toBe('\x1b[38;2;255;');

      // Process combined: ansiTail + chunk2
      const combinedText = ansiTail + chunk2;
      const escapeMatch = combinedText.match(/\x1b\[([0-9;]*)m/);
      expect(escapeMatch).not.toBeNull();

      if (escapeMatch) {
        const codes = escapeMatch[1].split(';').map((c) => parseInt(c, 10) || 0);
        ansiApplyCodes(state, codes);
      }

      // Verify state reflects the full escape (orange color: rgb(255,128,0))
      expect(state.fgRgb).toBe('rgb(255,128,0)');

      // Simulate font attributes also being set in the same sequence
      // Reset and test with bold/italic prefix
      ansiTail = '';
      const chunk1WithAttrs = '\x1b[1;3;38;2;255;';
      const chunk2WithAttrs = '128;0m';

      const lastEscape2 = chunk1WithAttrs.lastIndexOf('\x1b');
      if (lastEscape2 >= 0) {
        const candidate2 = chunk1WithAttrs.substring(lastEscape2);
        const completeEscape2 = /^\x1b(?:\[[0-9;?]*[\x20-\x2f]*[\x40-\x7e]|[^\[][^\x00-\x1f]?)/.test(candidate2);
        if (!completeEscape2) {
          ansiTail = candidate2;
        }
      }

      expect(ansiTail).toBe('\x1b[1;3;38;2;255;');

      const combinedWithAttrs = ansiTail + chunk2WithAttrs;
      const escapeMatch2 = combinedWithAttrs.match(/\x1b\[([0-9;]*)m/);
      expect(escapeMatch2).not.toBeNull();

      if (escapeMatch2) {
        const codes2 = escapeMatch2[1].split(';').map((c) => parseInt(c, 10) || 0);
        ansiApplyCodes(state, [0]); // reset first
        ansiApplyCodes(state, codes2);
      }

      // Verify both color and font attributes restored correctly
      expect(state.bold).toBe(true);
      expect(state.italic).toBe(true);
      expect(state.fgRgb).toBe('rgb(255,128,0)');

      // Clear ansiTail after successful processing
      ansiTail = '';
      expect(ansiTail).toBe('');
    });
  });
});
