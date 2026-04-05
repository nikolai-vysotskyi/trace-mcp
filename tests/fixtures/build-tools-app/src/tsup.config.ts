// @ts-nocheck
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  target: ['node20'],
  external: ['better-sqlite3', 'tree-sitter'],
  dts: true,
  sourcemap: true,
  clean: true,
});
