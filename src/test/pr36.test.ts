/**
 * Tests for PR #36 (Fix #35).
 *
 * Two regressions are addressed by PR #36 in
 * src/webviewPanel.ts:
 *
 *   1. **Empty serial lines collapse to zero height.** Each serial line is
 *      rendered as a `<div>` inside `#serial-output`. Empty `<div>` elements
 *      collapse to 0px so consecutive `\n\n` produced no visible blank rows.
 *      Fix: add `#serial-output > div { min-height: 1.4em; }` to the
 *      embedded webview CSS.
 *
 *   2. **ANSI colour lost on multi-line output when Timestamp filter on.**
 *      Each new line prepends a dim `[HH:MM:SS.mmm]` timestamp followed by
 *      `ESC[0m`. The `[0m` reset wiped the active SGR state, so the second
 *      and later lines of e.g. an `ESP_LOGI` block rendered uncoloured.
 *      Fix: save the current SGR state via `ansiStateToSgr()` and re-emit
 *      it immediately after the timestamp's `[0m` so subsequent text on the
 *      same logical line keeps its colour.
 *
 * These tests exercise the *source* files (src/ansiParser.ts +
 * src/webviewPanel.ts), not the compiled dist bundle, per the test-writing
 * directive for this PR.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  ESC,
  type AnsiState,
  ansiApplyCodes,
  ansiStateToSgr,
  createAnsiState,
  resetAnsiState,
} from '../ansiParser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEBVIEW_PANEL_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', 'webviewPanel.ts'),
  'utf8'
);

// ─────────────────────────────────────────────────────────────────────────────
// Fix 1 — blank serial lines must still occupy one row of height.
// ─────────────────────────────────────────────────────────────────────────────
describe('PR #36 – blank serial lines render with min-height', () => {
  it('embeds a CSS rule giving #serial-output children a non-zero min-height', () => {
    // Strip whitespace/newlines so we can match the rule regardless of
    // indentation or formatting tweaks.
    const flattened = WEBVIEW_PANEL_SRC.replace(/\s+/g, ' ');
    expect(flattened).toMatch(
      /#serial-output\s*>\s*div\s*\{[^}]*min-height:\s*1\.4em/
    );
  });

  it('targets only direct <div> children of #serial-output (not nested spans)', () => {
    // The rule must be `#serial-output > div`, not `#serial-output div`, so
    // it doesn't also stretch every inline ANSI span inside a line.
    const flattened = WEBVIEW_PANEL_SRC.replace(/\s+/g, ' ');
    expect(flattened).toMatch(/#serial-output\s*>\s*div\s*\{/);
    // Defensive: ensure we don't accidentally use the descendant selector
    // (which would target span/anchor children of each line as well).
    expect(flattened).not.toMatch(/#serial-output\s+div\s*\{[^}]*min-height/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2 — Timestamp filter must preserve ANSI colour across multi-line output.
// ─────────────────────────────────────────────────────────────────────────────
describe('PR #36 – timestamp prefix preserves active SGR state', () => {
  describe('source-level wiring in webviewPanel.ts', () => {
    it('saves the current SGR state into a "restore" variable before prefixing the timestamp', () => {
      // The pre-PR code was just:
      //   out = ESC + '[2m[' + ts + ']' + ESC + '[0m ' + out;
      // The post-PR code captures the active SGR state first so it can be
      // re-applied after the timestamp's [0m reset.
      expect(WEBVIEW_PANEL_SRC).toContain('var restore = ansiStateToSgr();');
    });

    it('emits the new prefix shape: reset + dim ts + reset + restore + space', () => {
      expect(WEBVIEW_PANEL_SRC).toContain(
        "out = ESC + '[0m' + ESC + '[2m[' + ts + ']' + ESC + '[0m' + restore + ' ' + out;"
      );
    });

    it('no longer emits the buggy bare prefix that wiped the SGR state', () => {
      expect(WEBVIEW_PANEL_SRC).not.toContain(
        "out = ESC + '[2m[' + ts + ']' + ESC + '[0m ' + out;"
      );
    });

    it('exposes ansiStateToSgr() in the webview JS via the AnsiParser module', () => {
      // The inline helper in the webview delegates to the source module so
      // the unit-testable implementation in ansiParser.ts is the one that
      // actually runs in the browser.
      expect(WEBVIEW_PANEL_SRC).toMatch(
        /function\s+ansiStateToSgr\s*\(\s*\)\s*\{\s*return\s+AnsiParser\.ansiStateToSgr\(ansiState\);\s*\}/
      );
    });
  });

  // The runtime behaviour the PR depends on is implemented in
  // src/ansiParser.ts (ansiStateToSgr). The webview just sandwiches the
  // timestamp between a reset and the serialised SGR state. We can fully
  // simulate the new prefix construction here.
  describe('behavioural simulation via src/ansiParser.ts', () => {
    /** Mirrors the post-PR construction in applyChunkFilters(). */
    function buildTimestampPrefix(state: AnsiState, ts: string, chunk: string): string {
      const restore = ansiStateToSgr(state);
      return ESC + '[0m' + ESC + '[2m[' + ts + ']' + ESC + '[0m' + restore + ' ' + chunk;
    }

    it('emits no restore sequence when no SGR state is active', () => {
      const state = createAnsiState();
      const out = buildTimestampPrefix(state, '12:34:56.789', 'hello');
      expect(out).toBe(
        `${ESC}[0m${ESC}[2m[12:34:56.789]${ESC}[0m` + ' hello'
      );
    });

    it('re-emits a basic foreground colour after the timestamp reset', () => {
      const state = createAnsiState();
      ansiApplyCodes(state, [32]); // green
      const out = buildTimestampPrefix(state, '00:00:00.000', 'log msg');

      // Sequence: reset, dim, [ts], reset, restore-fg-green, space, payload
      expect(out).toBe(
        `${ESC}[0m${ESC}[2m[00:00:00.000]${ESC}[0m${ESC}[32m log msg`
      );
    });

    it('re-emits combined bold + italic + RGB foreground (ESP_LOGI scenario)', () => {
      const state = createAnsiState();
      // Bold italic orange — a realistic stand-in for an ESP_LOGI block
      // whose second line previously lost its colour entirely.
      ansiApplyCodes(state, [1, 3, 38, 2, 255, 128, 0]);

      const out = buildTimestampPrefix(state, '11:22:33.444', 'second line');
      expect(out).toBe(
        `${ESC}[0m${ESC}[2m[11:22:33.444]${ESC}[0m` +
          `${ESC}[1;3;38;2;255;128;0m second line`
      );
    });

    it('restores background colour as well as foreground', () => {
      const state = createAnsiState();
      ansiApplyCodes(state, [31, 47]); // red on white
      const out = buildTimestampPrefix(state, '01:02:03.004', 'x');
      expect(out).toContain(`${ESC}[31;47m`);
    });

    it('re-applying the restore sequence reproduces the original AnsiState', () => {
      // Round-trip: original state → serialise → reset → re-apply → must match.
      const original = createAnsiState();
      ansiApplyCodes(original, [1, 4, 31, 48, 2, 10, 20, 30]); // bold,
      // underline, red fg, RGB bg

      const restoreSgr = ansiStateToSgr(original);
      expect(restoreSgr).not.toBe('');

      // Parse the SGR back into a code array and feed it into a fresh state
      // exactly the way the browser's ANSI parser does.
      const match = restoreSgr.match(/^\x1b\[(.*)m$/);
      expect(match).not.toBeNull();
      const codes = match![1].split(';').map((c) => parseInt(c, 10));

      const rehydrated = createAnsiState();
      ansiApplyCodes(rehydrated, codes);

      expect(rehydrated).toEqual(original);
    });

    it('a default-state prefix contains no spurious SGR codes between the [0m and the space', () => {
      const state = createAnsiState();
      const out = buildTimestampPrefix(state, '00:00:00.000', 'msg');
      // After the trailing [0m there must be no further SGR before the space.
      const tail = out.slice(out.lastIndexOf(']') + 1);
      // Expected tail: \x1b[0m + '' + ' msg'
      expect(tail).toBe(`${ESC}[0m msg`);
    });

    it('idempotent across consecutive lines — restoring twice yields the same SGR sandwich', () => {
      const state = createAnsiState();
      ansiApplyCodes(state, [1, 33]); // bold yellow
      const line1 = buildTimestampPrefix(state, '00:00:00.001', 'line1');
      // The webview does not mutate `state` while emitting the timestamp,
      // so producing a second timestamp for the next chunk must yield the
      // same SGR sandwich (just with a different ts and payload).
      const line2 = buildTimestampPrefix(state, '00:00:00.002', 'line2');
      const sandwich1 = line1.replace(/\[\d\d:\d\d:\d\d\.\d{3}\]/, '[TS]').replace(/ line\d$/, ' PAYLOAD');
      const sandwich2 = line2.replace(/\[\d\d:\d\d:\d\d\.\d{3}\]/, '[TS]').replace(/ line\d$/, ' PAYLOAD');
      expect(sandwich1).toBe(sandwich2);
      expect(sandwich1).toBe(
        `${ESC}[0m${ESC}[2m[TS]${ESC}[0m${ESC}[1;33m PAYLOAD`
      );
    });
  });

  // The issue (#35) showcases the bug with a real ESP_LOGI call:
  //   ESP_LOGI("Sys", "Help:\r\n%s", _cli->toString().c_str());
  // ESP-IDF opens an INFO log with "\x1b[0;32m" (reset-then-green) and ends
  // with "\x1b[0m". The embedded "\r\n" inside the formatted string used to
  // wipe the colour on every subsequent line because the timestamp prefix
  // ended with [0m without restoring the SGR state.
  describe('issue #35 — ESP_LOGI-style multi-line coloured output', () => {
    /**
     * Tiny driver that walks an arbitrary device byte stream, calling
     * applyChunkFilters() once per text chunk separated by newlines
     * (matching the webview's LINE_SPLIT_RE = (\r\n|\r|\n)). It mirrors the
     * post-PR webview logic just closely enough to verify state preservation.
     */
    function runStream(raw: string, makeTs: (i: number) => string): string {
      const state = createAnsiState();
      const LINE_SPLIT = /(\r\n|\r|\n)/;
      const parts = raw.split(LINE_SPLIT);
      let out = '';
      let lineStarted = false;
      let lineIdx = 0;

      for (const part of parts) {
        if (part === '\r\n' || part === '\r' || part === '\n') {
          out += part;
          lineStarted = false; // dedupResetLine() in the real code
          continue;
        }
        if (part === '') { continue; }

        // applyChunkFilters() prepends the timestamp BEFORE the ANSI parser
        // consumes the chunk's escapes, so the "restore" snapshot reflects
        // the state left over from the previous chunk.
        let emitted = part;
        if (!lineStarted) {
          const restore = ansiStateToSgr(state);
          const ts = makeTs(lineIdx++);
          emitted = `${ESC}[0m${ESC}[2m[${ts}]${ESC}[0m${restore} ${part}`;
          lineStarted = true;
        }
        out += emitted;

        // Now advance state by consuming the chunk's escape codes (mirrors
        // the ANSI parser that runs after applyChunkFilters in the webview).
        const re = /\x1b\[([0-9;]*)m/g;
        let m;
        while ((m = re.exec(part)) !== null) {
          const codes = m[1] === '' ? [0] : m[1].split(';').map((c) => parseInt(c, 10) || 0);
          ansiApplyCodes(state, codes);
        }
      }
      return out;
    }

    it('keeps the ESP_LOGI green colour active on every line after a \\r\\n', () => {
      // Simplified ESP_LOGI output: green opener, header, CRLF, body, reset.
      const stream =
        '\x1b[0;32mI (123) Sys: Help:\r\nLine A\r\nLine B\x1b[0m\r\n';
      const out = runStream(stream, (i) => `t${i}`);

      // The first line carries the *device's* own `\x1b[0;32m` opener; its
      // timestamp prefix therefore needs no restore (state was empty when
      // the chunk arrived). Lines 2 and 3 must each re-emit `\x1b[32m`
      // immediately after their timestamp's `[0m` — that is the substantive
      // PR #36 fix.
      const greenRestores = out.match(/\x1b\[2m\[t\d+\]\x1b\[0m\x1b\[32m /g);
      expect(greenRestores).not.toBeNull();
      expect(greenRestores!.length).toBe(2);

      // First line's timestamp must have an *empty* restore (no prior state).
      expect(out).toMatch(/\x1b\[2m\[t0\]\x1b\[0m \x1b\[0;32mI \(123\) Sys: Help:/);
    });

    it('drops the restore once the device emits the closing \\x1b[0m', () => {
      // After the LOG body ends with [0m, the next line must NOT be coloured.
      const stream =
        '\x1b[0;32mLine A\r\nLine B\x1b[0m\r\nplain after\r\n';
      const out = runStream(stream, (i) => `t${i}`);

      // Line 0 carries the device opener — empty restore, original opener intact.
      expect(out).toMatch(/\x1b\[2m\[t0\]\x1b\[0m \x1b\[0;32mLine A/);
      // Line 1 needs the green restore (this is the PR #36 fix in action).
      expect(out).toMatch(/\x1b\[2m\[t1\]\x1b\[0m\x1b\[32m Line B/);
      // Line 2 must have an *empty* restore (state was reset by [0m).
      expect(out).toMatch(/\x1b\[2m\[t2\]\x1b\[0m plain after/);
    });

    it('preserves an ESP_LOGW yellow opener across multiple CRLF-separated lines', () => {
      const stream = '\x1b[0;33mW (1) tag: a\r\nb\r\nc\x1b[0m\r\n';
      const out = runStream(stream, (i) => `t${i}`);
      // Two restores expected (for lines `b` and `c`); the opener line `a`
      // already includes the device's `[0;33m`.
      const yellowRestores = out.match(/\x1b\[2m\[t\d+\]\x1b\[0m\x1b\[33m /g);
      expect(yellowRestores).not.toBeNull();
      expect(yellowRestores!.length).toBe(2);
    });

    it('preserves an ESP_LOGE bold-red opener across CRLF-separated lines', () => {
      // Some ESP-IDF builds emit bold + red: "\x1b[1;31m".
      const stream = '\x1b[1;31mE (1) tag: a\r\nb\x1b[0m\r\n';
      const out = runStream(stream, (i) => `t${i}`);
      // Line 0 carries the device's bold-red opener — empty restore.
      expect(out).toMatch(/\x1b\[2m\[t0\]\x1b\[0m \x1b\[1;31mE \(1\) tag: a/);
      // Line 1 must have a bold-red restore (`[1;31m`) injected after [0m.
      expect(out).toMatch(/\x1b\[2m\[t1\]\x1b\[0m\x1b\[1;31m b/);
    });

    it('exactly reproduces the issue #35 ESP_LOGI("Sys", "Help:\\r\\n%s", ...) scenario', () => {
      // Faithful reproduction of the user's snippet — a multi-line help body
      // formatted by SimpleCLI under an INFO-level ESP_LOGI tag.
      const stream =
        '\x1b[0;32mI (42) Sys: Help:\r\n' +
        '  cmd1 - first command\r\n' +
        '  cmd2 - second command\r\n' +
        '  cmd3 - third command\x1b[0m\r\n';
      const out = runStream(stream, (i) => `t${i}`);

      // All three body lines (cmd1/cmd2/cmd3) must receive a green restore.
      // Sequence is: timestamp's [0m, green restore [32m, the prefix-space
      // injected by applyChunkFilters, then the two leading spaces in each
      // help line's payload — 3 spaces total before `cmd`.
      const restores = out.match(/\x1b\[2m\[t\d+\]\x1b\[0m\x1b\[32m {3}cmd/g);
      expect(restores).not.toBeNull();
      expect(restores!.length).toBe(3);
    });
  });

  // Issue #35 fix-1 is purely visual (CSS). Verify the supporting newline
  // splitter still produces an *empty* segment for every variant the user
  // demonstrated, so the new CSS rule has empty <div>s to size up.
  describe('issue #35 — newline variants all yield empty line segments', () => {
    const LINE_SPLIT = /(\r\n|\r|\n)/;

    function emptySegmentsBetweenSeparators(raw: string): number {
      const parts = raw.split(LINE_SPLIT);
      let count = 0;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const isSep = p === '\r\n' || p === '\r' || p === '\n';
        if (!isSep && p === '') { count++; }
      }
      return count;
    }

    it('\\n\\n produces a blank segment between the two LFs', () => {
      expect(emptySegmentsBetweenSeparators('a\n\nb')).toBe(1);
    });

    it('\\n\\n\\n\\n produces three consecutive blank segments', () => {
      expect(emptySegmentsBetweenSeparators('a\n\n\n\nb')).toBe(3);
    });

    it('\\r\\n\\r\\n produces a blank segment between two CRLFs', () => {
      expect(emptySegmentsBetweenSeparators('a\r\n\r\nb')).toBe(1);
    });

    it('\\r\\n\\n produces a blank segment between CRLF and LF', () => {
      expect(emptySegmentsBetweenSeparators('a\r\n\nb')).toBe(1);
    });

    it('mixed sequence \\r\\n\\n\\r\\n\\n produces three blank segments', () => {
      expect(emptySegmentsBetweenSeparators('a\r\n\n\r\n\nb')).toBe(3);
    });
  });

  describe('ansiStateToSgr() — colour serialisation used by the fix', () => {
    it('returns "" for a freshly created state (no codes to restore)', () => {
      expect(ansiStateToSgr(createAnsiState())).toBe('');
    });

    it('serialises every text-style flag', () => {
      const s = createAnsiState();
      ansiApplyCodes(s, [1, 2, 3, 4, 5, 7, 8, 9]);
      // Order must match the order in ansiStateToSgr: 1,2,3,4,5,7,8,9.
      // (fastBlink is exclusive with blink so omitted here.)
      expect(ansiStateToSgr(s)).toBe(`${ESC}[1;2;3;4;5;7;8;9m`);
    });

    it('serialises a named foreground colour', () => {
      const s = createAnsiState();
      ansiApplyCodes(s, [36]); // cyan
      expect(ansiStateToSgr(s)).toBe(`${ESC}[36m`);
    });

    it('serialises a named background colour', () => {
      const s = createAnsiState();
      ansiApplyCodes(s, [41]); // red bg
      expect(ansiStateToSgr(s)).toBe(`${ESC}[41m`);
    });

    it('serialises an RGB foreground colour (38;2;r;g;b)', () => {
      const s = createAnsiState();
      ansiApplyCodes(s, [38, 2, 12, 34, 56]);
      expect(ansiStateToSgr(s)).toBe(`${ESC}[38;2;12;34;56m`);
    });

    it('serialises an RGB background colour (48;2;r;g;b)', () => {
      const s = createAnsiState();
      ansiApplyCodes(s, [48, 2, 200, 100, 50]);
      expect(ansiStateToSgr(s)).toBe(`${ESC}[48;2;200;100;50m`);
    });

    it('prefers RGB foreground over named foreground when both are theoretically set', () => {
      // ansiStateToSgr's branch order is: fgRgb first, then named fg. Verify
      // that an RGB value wins, which is required for ESP_LOGI-style RGB
      // colours to survive the timestamp reset.
      const s = createAnsiState();
      s.fg = 'red';
      s.fgRgb = 'rgb(1,2,3)';
      const sgr = ansiStateToSgr(s);
      expect(sgr).toContain('38;2;1;2;3');
      expect(sgr).not.toContain(';31m');
      expect(sgr).not.toContain('[31');
    });

    it('emits foreground before background to match the order produced by the parser', () => {
      const s = createAnsiState();
      ansiApplyCodes(s, [31, 42]); // red fg, green bg
      expect(ansiStateToSgr(s)).toBe(`${ESC}[31;42m`);
    });

    it('returns "" again after a full reset', () => {
      const s = createAnsiState();
      ansiApplyCodes(s, [1, 31, 42]);
      resetAnsiState(s);
      expect(ansiStateToSgr(s)).toBe('');
    });
  });
});
