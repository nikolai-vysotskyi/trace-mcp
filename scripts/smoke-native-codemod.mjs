#!/usr/bin/env node
/**
 * Smoke test: confirm the `@ast-grep/napi` native binding resolves and parses
 * through the exact resolution path the SHIPPED bundle uses (a `createRequire`
 * anchored at `dist/index.js`).
 *
 * Why this exists
 * ---------------
 * `@ast-grep/napi` is a NAPI module whose real binary lives in an OPTIONAL,
 * platform-specific dependency (`@ast-grep/napi-<platform>`). npm intermittently
 * fails to install that optional dep (npm/cli#4828), producing a package that
 * builds fine locally but throws "Cannot find native binding" on a fresh
 * install elsewhere. The server itself now DEGRADES gracefully when this
 * happens (see src/tools/refactoring/codemod-ast.ts — the AST codemod engine
 * and extract_function disable themselves instead of crashing), but a
 * production/CI publish should still FAIL LOUDLY if the AST engine can't load,
 * because those tools would silently be unavailable.
 *
 * Run this after `pnpm run build` in CI (and optionally in a fresh-install job)
 * to catch the missing-binary class before publish.
 *
 * Exit codes: 0 = binding loads + parses; 1 = binding missing/broken.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const distIndex = resolve(process.cwd(), 'dist/index.js');
if (!existsSync(distIndex)) {
  console.error(
    `[smoke-native-codemod] dist/index.js not found at ${distIndex} — run \`pnpm run build\` first.`,
  );
  process.exit(1);
}

const req = createRequire(pathToFileURL(distIndex).href);

try {
  const napi = req('@ast-grep/napi');
  const { parse, Lang } = napi;
  const root = parse(Lang.TypeScript, 'const x = foo(1, 2, 3);').root();
  const matches = root.findAll('foo($$$ARGS)');
  if (matches.length !== 1) {
    console.error(`[smoke-native-codemod] unexpected match count ${matches.length} (expected 1).`);
    process.exit(1);
  }
  console.log(
    '[smoke-native-codemod] OK — @ast-grep/napi native binding loaded and parsed a call expression.',
  );
  process.exit(0);
} catch (err) {
  console.error('[smoke-native-codemod] FAIL — @ast-grep/napi native binding did not load:');
  console.error(`  ${(err && err.message ? err.message : String(err)).split('\n')[0]}`);
  console.error('  This is usually the npm optional-dependency bug (npm/cli#4828).');
  console.error('  Fix: remove node_modules + lockfile and reinstall so the platform');
  console.error('  package @ast-grep/napi-<platform> is installed alongside @ast-grep/napi.');
  process.exit(1);
}
