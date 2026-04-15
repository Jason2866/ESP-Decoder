# @jason2866/serialport-bindings-cpp

Fork of [@serialport/bindings-cpp](https://github.com/serialport/bindings-cpp) v13.0.0
with a fix for the Windows `GetOverlappedResult: Invalid handle` bug.

## What's fixed

In `ReadIOCompletion` and `WriteIOCompletion` (`src/serialport_win.cpp`), the
`OVERLAPPED.hEvent` field is used as a user-data pointer (to store the baton).
This is allowed by `ReadFileEx`/`WriteFileEx` which ignore `hEvent`.  However,
the subsequent `GetOverlappedResult(..., bWait=TRUE)` call will invoke
`WaitForSingleObject(ov->hEvent)` if `ov->Internal` is still `STATUS_PENDING`.
Since `hEvent` holds a pointer instead of a valid event handle, this fails with
`ERROR_INVALID_HANDLE`.

The fix temporarily clears `hEvent` before calling `GetOverlappedResult` and
restores it afterwards, so the function falls back to the file-handle signalling
path.

Upstream issue: https://github.com/serialport/node-serialport/issues/3086

## Setup for fork maintainer

1. Fork or clone [`serialport/bindings-cpp`](https://github.com/serialport/bindings-cpp)
2. Apply the fix to `src/serialport_win.cpp` (see diff below)
3. Update `package.json`: set `"name": "@jason2866/serialport-bindings-cpp"`
4. Set `NPM_TOKEN` secret in GitHub repo settings
5. Tag a release (`git tag v13.0.0 && git push --tags`) to trigger the CI

The CI workflow builds prebuilds for all platforms and publishes to npm.

## package.json changes needed in the fork

```json
{
  "name": "@jason2866/serialport-bindings-cpp",
  "version": "13.0.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jason2866/serialport-bindings-cpp.git"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

## Using in ESP-Decoder

In ESP-Decoder's `package.json`:

```json
{
  "overrides": {
    "@serialport/bindings-cpp": "npm:@jason2866/serialport-bindings-cpp@^13.0.0"
  }
}
```

This tells npm to install `@jason2866/serialport-bindings-cpp` whenever
`serialport` (or anything else) asks for `@serialport/bindings-cpp`.
