#!/usr/bin/env node
// Ensures native prebuilds are available for platform+arch combinations that
// can transparently run another arch's binary (e.g. Windows ARM64 running x64
// DLLs via emulation).  node-gyp-build performs strict platform-arch matching,
// so we must have a directory for each arch we want to support.
const fs = require('fs');
const path = require('path');

// Walk up from @serialport/bindings-cpp to handle both hoisted and nested layouts.
const candidates = [
  path.join(__dirname, '..', 'node_modules', 'serialport', 'node_modules', '@serialport', 'bindings-cpp', 'prebuilds'),
  path.join(__dirname, '..', 'node_modules', '@serialport', 'bindings-cpp', 'prebuilds'),
];

const prebuildsDir = candidates.find((p) => fs.existsSync(p));
if (!prebuildsDir) {
  // Nothing to patch — bindings-cpp not yet installed or layout changed.
  process.exit(0);
}

// Map: [target] -> [source that can run via emulation]
// Windows ARM64 transparently runs x64 DLLs via WoW64 emulation.
const copies = [
  { src: 'win32-x64', dst: 'win32-arm64' },
];

for (const { src, dst } of copies) {
  const srcDir = path.join(prebuildsDir, src);
  const dstDir = path.join(prebuildsDir, dst);
  if (!fs.existsSync(srcDir) || fs.existsSync(dstDir)) {
    continue;
  }
  fs.mkdirSync(dstDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
  }
  console.log(`[fix-prebuilds] Copied ${src} -> ${dst}`);
}
