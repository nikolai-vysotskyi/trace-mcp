import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'cli': 'src/cli.ts',
    // Worker entry. Built next to cli.js so the pool can resolve it via
    // `new URL('./extract-worker.js', import.meta.url)`.
    'extract-worker': 'src/indexer/extract-worker.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: process.env.TSUP_TARGET || 'node20',
  splitting: false,
  define: {
    'PKG_VERSION_INJECTED': JSON.stringify(version),
  },
});
