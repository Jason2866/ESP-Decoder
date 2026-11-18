// @ts-check
const esbuild = require('esbuild');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: [
      'vscode',
      'serialport',
      '@serialport/bindings-cpp',
    ],
    logLevel: 'info',
    plugins: [],
  });

  // Compile the ANSI parser for the browser webview (single source of truth)
  const ctxAnsi = await esbuild.context({
    entryPoints: ['src/ansiParser.ts'],
    bundle: true,
    format: 'iife',
    globalName: 'AnsiParser',
    minify: production,
    sourcemap: false,
    platform: 'browser',
    outfile: 'dist/ansiParser.js',
    logLevel: 'info',
  });

  // The GDB panic stub runs as a standalone node process spawned by GDB via
  // `target remote |<cmd>`; keep it an unbundled-style plain JS file in dist.
  const ctxStub = await esbuild.context({
    entryPoints: ['src/panic/gdbStubMain.js'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: false,
    platform: 'node',
    outfile: 'dist/gdbStubMain.js',
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
    await ctxAnsi.watch();
    await ctxStub.watch();
    console.log('Watching for changes...');
  } else {
    await ctxAnsi.rebuild(); // build first so dist/ansiParser.js exists at runtime
    await ctxStub.rebuild();
    await ctx.rebuild();
    await ctx.dispose();
    await ctxAnsi.dispose();
    await ctxStub.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
