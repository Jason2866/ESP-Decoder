# Serial Monitor Filters

The serial monitor includes a filter toolbar that lets you transform, suppress, and annotate incoming serial output in real time. Filter settings are persisted to VS Code settings via the **Save** button.

---

## Toolbar Overview

```text
Filters: [✓ Timestamp] | Suppress: [regex…] | Highlight: [regex…] | Dedup: [regex…] after [N] | [Save]
```

All filters operate on the **raw text** of each line (including ANSI escape codes) before it is rendered to the DOM.

---

## Timestamp

Prepends a dimmed `[HH:MM:SS.mmm]` timestamp to every completed line.

**VS Code setting:** `esp-decoder.serialFilters.timestamp` (boolean, default `false`)

**Example output:**

```text
[12:34:56.789] I (1234) wifi: connected to AP
[12:34:56.812] I (1235) app_main: starting loop
```

Useful for correlating serial events with external logs or measuring time between messages.

---

## Suppress

Hides lines that match a given regular expression. The pattern is evaluated with JavaScript `RegExp.test()`, which succeeds if the regex matches **anywhere** in the line (a substring match) unless you explicitly anchor it with `^` and/or `$`.

**VS Code setting:** `esp-decoder.serialFilters.suppressPattern` (string, default `""`)

The input field turns red if the regex is invalid.

**Examples:**

| Pattern | Effect |
|---|---|
| `^\s*$` | Hide blank / whitespace-only lines (anchored — must match the entire line) |
| `^\[V\]` | Hide lines starting with `[V]` (start-anchored) |
| `heap_caps` | Hide any line containing `heap_caps` (unanchored — substring match) |
| `^D \(\d+\)` | Hide lines starting with `D (nnn)` — ESP-IDF debug lines |

---

## Highlight

Wraps every match of a regex in ANSI inverse-video styling, making matches visually stand out without hiding any content.

**VS Code setting:** `esp-decoder.serialFilters.highlightPattern` (string, default `""`)

The input field turns red if the regex is invalid.

**Examples:**

| Pattern | Effect |
|---|---|
| `ERROR` | Highlight every occurrence of the word ERROR |
| `0x[0-9a-fA-F]+` | Highlight hex addresses |
| `\d+\.\d+\.\d+\.\d+` | Highlight IP addresses |
| `(?i:assert)` | Highlight assert (case-insensitive) |

---

## Dedup (Repeated Character Collapse)

Collapses repeated occurrences of a regex match within a single line. The first N matches are rendered normally; further matches are suppressed and a live counter badge (`×N`) is appended inline to the line.

The badge updates in real time as more matching characters arrive — no new DOM lines are created.

**VS Code settings:**

| Setting | Type | Default | Description |
|---|---|---|---|
| `esp-decoder.serialFilters.dedupPattern` | string | `""` | Regex matching the character(s) to collapse |
| `esp-decoder.serialFilters.dedupThreshold` | number | `3` | Number of matches to show before collapsing |

The input field turns red if the regex is invalid. Set the pattern to empty to disable.

**Examples:**

### ArduinoOTA progress dots

ArduinoOTA prints a `.` for every kilobyte transferred, all on one line:

```text
...................................................................................................
```

With pattern `\.` and threshold `3`:

```text
... ×98
```

### ESP-IDF flash progress `#`

```text
######## ×512
```

Pattern: `#`, threshold: `8`

### Spinner characters

```text
| ×47
```

Pattern: `[|/\-\\]`, threshold: `1`

### Repeated log prefix

Collapse repeated identical words within a line:

Pattern: `OK`, threshold: `2` turns `OK OK OK OK OK` into `OK OK ×3`

---

## Log2File

Writes incoming serial data to a text file on disk. Click the **Log2File** button in the filter toolbar to start; click **Stop Log** to finish.

### File location and naming

The log file is created in the first open workspace folder, or `$HOME` if no folder is open. By default the filename follows the pattern `serial-YYYYMMDD_HHMMSS.log`. You can override it by typing a custom name into the filename field next to the button.

### Raw vs. filtered mode

| Filtered checkbox | Behaviour |
|---|---|
| unchecked | Raw serial bytes are written verbatim — no filters are applied. |
| checked | The active **Suppress**, **Timestamp**, and **Dedup** filters are applied server-side before writing. Highlight is display-only and is never written to the file. |

When filtered mode is active the filters use the settings that were current at the moment **Log2File** was clicked. Changing filter inputs in the toolbar afterwards does not affect the running log session.

### Behaviour during pioarduino uploads

When the pioarduino extension requests the serial port for an upload, ESP Decoder automatically:

1. Closes the current log file.
2. Releases the port to the uploader.
3. After the upload finishes and the port is reacquired, opens a **new** log file (with a fresh timestamp in the filename) using the same filter settings and resumes logging.

If you explicitly click **Stop Log** before or during an upload, logging is not resumed after the upload.

---

## Saving Settings

Click **Save** in the filter toolbar to write all current filter values to your global VS Code settings (`settings.json`). They are restored automatically the next time the panel opens.

You can also edit them directly in VS Code settings under **ESP Decoder > Serial Filters**.

Settings are also re-applied immediately if you change them in `settings.json` while the panel is open.
