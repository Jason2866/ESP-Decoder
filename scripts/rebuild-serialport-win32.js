/**
 * Apply the serialport_win.cpp patch and rebuild the native binding.
 *
 * Usage (run on Windows):
 *   node scripts/rebuild-serialport-win32.js
 *
 * Prerequisites:
 *   - Node.js matching VS Code's Electron Node version
 *   - Python 3
 *   - Visual Studio Build Tools (Desktop C++ workload)
 *   - node-gyp: npm i -g node-gyp
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const bindingsCppDir = path.join(
  __dirname,
  '..',
  'node_modules',
  '@serialport',
  'bindings-cpp'
);

const srcFile = path.join(bindingsCppDir, 'src', 'serialport_win.cpp');

// ─── 1. Verify we're on Windows ────────────────────────────────────────
if (process.platform !== 'win32') {
  console.log('This script must be run on Windows. Skipping.');
  process.exit(0);
}

// ─── 2. Check the source file exists ────────────────────────────────────
if (!fs.existsSync(srcFile)) {
  console.error(`Source file not found: ${srcFile}`);
  console.error('Run "npm install" first.');
  process.exit(1);
}

// ─── 3. Apply patch (idempotent) ────────────────────────────────────────
const src = fs.readFileSync(srcFile, 'utf8');

const needsPatch =
  src.includes('GetOverlappedResult(int2handle(baton->fd), ov,') &&
  !src.includes('HANDLE savedEvent = ov->hEvent;');

if (needsPatch) {
  console.log('Applying GetOverlappedResult hEvent fix ...');

  let patched = src;

  // ── Fix WriteIOCompletion ──
  patched = patched.replace(
    `void __stdcall WriteIOCompletion(DWORD errorCode, DWORD bytesTransferred, OVERLAPPED* ov) {
  WriteBaton* baton = static_cast<WriteBaton*>(ov->hEvent);
  DWORD bytesWritten;
  if (!GetOverlappedResult(int2handle(baton->fd), ov, &bytesWritten, TRUE)) {
    errorCode = GetLastError();
    ErrorCodeToString("Writing to COM port (GetOverlappedResult)", errorCode, baton->errorString);
    baton->complete = true;
    return;
  }`,
    `void __stdcall WriteIOCompletion(DWORD errorCode, DWORD bytesTransferred, OVERLAPPED* ov) {
  WriteBaton* baton = static_cast<WriteBaton*>(ov->hEvent);
  DWORD bytesWritten;

  if (errorCode) {
    ErrorCodeToString("Writing to COM port (WriteIOCompletion)", errorCode, baton->errorString);
    baton->complete = true;
    return;
  }

  // hEvent holds a user pointer (baton), not a valid event handle.
  // Temporarily clear it so GetOverlappedResult does not try to
  // WaitForSingleObject on a non-handle value.
  HANDLE savedEvent = ov->hEvent;
  ov->hEvent = NULL;
  if (!GetOverlappedResult(int2handle(baton->fd), ov, &bytesWritten, TRUE)) {
    ov->hEvent = savedEvent;
    errorCode = GetLastError();
    ErrorCodeToString("Writing to COM port (GetOverlappedResult)", errorCode, baton->errorString);
    baton->complete = true;
    return;
  }
  ov->hEvent = savedEvent;`
  );

  // ── Fix ReadIOCompletion ──
  patched = patched.replace(
    `  DWORD lastError;
  if (!GetOverlappedResult(int2handle(baton->fd), ov, &bytesTransferred, TRUE)) {
    lastError = GetLastError();
    ErrorCodeToString("Reading from COM port (GetOverlappedResult)", lastError, baton->errorString);
    baton->complete = true;
    return;
  }
  if (bytesTransferred) {`,
    `  DWORD lastError;
  // hEvent holds a user pointer (baton), not a valid event handle.
  // Temporarily clear it so GetOverlappedResult does not try to
  // WaitForSingleObject on a non-handle value.
  HANDLE savedEvent = ov->hEvent;
  ov->hEvent = NULL;
  if (!GetOverlappedResult(int2handle(baton->fd), ov, &bytesTransferred, TRUE)) {
    ov->hEvent = savedEvent;
    lastError = GetLastError();
    ErrorCodeToString("Reading from COM port (GetOverlappedResult)", lastError, baton->errorString);
    baton->complete = true;
    return;
  }
  ov->hEvent = savedEvent;
  if (bytesTransferred) {`
  );

  fs.writeFileSync(srcFile, patched, 'utf8');
  console.log('Patch applied successfully.');
} else {
  console.log('Source already patched (or unrecognised layout). Skipping patch step.');
}

// ─── 4. Delete win32 prebuilds so node-gyp-build compiles from source ──
const prebuildsDir = path.join(bindingsCppDir, 'prebuilds');
const win32Dirs = ['win32-x64', 'win32-ia32', 'win32-arm64'];
for (const dir of win32Dirs) {
  const full = path.join(prebuildsDir, dir);
  if (fs.existsSync(full)) {
    console.log(`Removing prebuilt: ${dir}`);
    fs.rmSync(full, { recursive: true, force: true });
  }
}

// ─── 5. Rebuild native module ───────────────────────────────────────────
console.log('Rebuilding @serialport/bindings-cpp ...');
try {
  execSync('node-gyp rebuild', {
    cwd: bindingsCppDir,
    stdio: 'inherit',
    env: { ...process.env },
  });
  console.log('Rebuild succeeded.');
} catch (err) {
  console.error('Rebuild FAILED. Make sure you have:');
  console.error('  - Python 3');
  console.error('  - Visual Studio Build Tools (Desktop C++ workload)');
  console.error('  - node-gyp: npm i -g node-gyp');
  process.exit(1);
}

console.log('Done. The patched native binding will be used on next run.');
