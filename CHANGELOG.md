# Changelog

## [0.8.0] - 2026-03-10

### Added
- **Native IDF support** contributed by [h2zero](https://github.com/h2zero)

## [0.7.0] - 2026-03-10

### Bug fixes

## [0.6.0] - 2026-03-09

### Added
- **Scroll-to-bottom button** in the serial monitor — a prominent button now appears when the output is not scrolled to the bottom, allowing quick navigation to the latest output.
- **Upload artifact step** in the CI build job — the compiled `.vsix` extension package is now stored as a downloadable artifact on every successful build.
- **Restored publish job** in the GitHub Actions workflow with corrected `needs` dependency and permissions.

### Changed / Improved
- **Increased decoding speed** — overall crash decoding performance has been improved.

### Fixed
- **Serial monitor slowdown at high baud rates** — serial data is now batched in 50 ms intervals before being sent to the webview, preventing IPC message queue flooding that caused the UI to become unresponsive.
- **Post-disconnect message flooding** — pending flush is cancelled and the buffer is discarded on disconnect, stopping queued messages from draining for minutes after the device is unplugged.
- **Autoscroll layout reflows** — autoscroll now uses `requestAnimationFrame` instead of synchronous DOM updates to avoid forced layout reflows on every incoming message.
- **Line-buffer trimming performance** — replaced repeated `Array.shift()` (O(n²)) with `Array.slice(-maxLines)` and `replaceChildren()` for a single-DOM-operation trim.
- **Autoscroll re-enable on manual scroll** — autoscroll is correctly re-enabled when the user manually scrolls back to the bottom of the output.
- **Autoscroll race condition** — programmatic `scrollTop` updates are now guarded with a `programmaticScroll` flag so that scroll events triggered by the extension itself do not incorrectly disable autoscroll.
