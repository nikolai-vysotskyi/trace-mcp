/* The server payload the app ships (TRA-438). Two things it must never do:
   collect a dependency it cannot find, and stage native binaries built for one
   architecture into a bundle for another — that produces a DMG that looks fine
   and whose daemon dies with ERR_DLOPEN_FAILED on first launch. */

import fs, { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* Dynamic, not a static import: the main process compiles as CommonJS
   (tsconfig.main.json, `module: Node16`) and cannot `require` an ES module. */
const stageServer = () => import('../../../scripts/stage-server.mjs');

describe('assertStagedArch', () => {
  /* A payload shaped like the real one: one package with a single
     architecture's binary, one that ships every platform's and picks at
     runtime (better-sqlite3's `prebuilds/` layout). */
  function payload(layout: Record<string, string[]>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-arch-'));
    for (const [sub, files] of Object.entries(layout)) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(dir, sub, f), '');
    }
    return dir;
  }
  const inspect = (f: string) => (f.includes('x64') ? 'x64' : f.includes('arm64') ? 'arm64' : null);

  it('passes when every native directory covers the target', async () => {
    const { assertStagedArch } = await stageServer();
    const dir = payload({
      'napi-darwin-x64': ['binding.x64.node'],
      'better-sqlite3/prebuilds': ['darwin-x64.node', 'darwin-arm64.node'],
    });
    expect(() => assertStagedArch(dir, 'x64', inspect)).not.toThrow();
  });

  it('refuses a payload whose natives are all the other architecture', async () => {
    const { assertStagedArch } = await stageServer();
    const dir = payload({ 'napi-darwin-arm64': ['binding.arm64.node'] });
    expect(() => assertStagedArch(dir, 'x64', inspect)).toThrow(/nothing loadable on x64/);
  });
});

describe('PAYLOAD_ROOTS', () => {
  it('covers every dependency tsup leaves external', async () => {
    const { PAYLOAD_ROOTS } = await stageServer();
    // vitest runs with packages/app as its root.
    const tsup = readFileSync(path.resolve(process.cwd(), '../../tsup.config.ts'), 'utf-8');
    const block = tsup.match(/const NATIVE_EXTERNALS = \[([\s\S]*?)\];/)?.[1] ?? '';
    const externals = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(externals.length).toBeGreaterThan(0);
    for (const name of externals) {
      // @huggingface/transformers is excluded on purpose — see the header of
      // scripts/stage-server.mjs. Everything else must ship, or the daemon
      // cannot resolve it at runtime.
      if (name === '@huggingface/transformers') continue;
      expect(PAYLOAD_ROOTS).toContain(name);
    }
  });
});

describe('PAYLOAD_GRAMMARS', () => {
  it('covers every grammar getParser can ask for', async () => {
    const { PAYLOAD_GRAMMARS } = await stageServer();
    // vitest runs with packages/app as its root, as above.
    const src = readFileSync(path.resolve(process.cwd(), '../../src/parser/tree-sitter.ts'), 'utf-8');
    const block =
      src.match(/LANG_GRAMMARS: Record<string, SupportedLanguage> = \{([\s\S]*?)\n\};/)?.[1] ?? '';
    const grammars = [...block.matchAll(/:\s*'([^']+)',/g)].map((m) => m[1]);
    expect(grammars.length).toBeGreaterThan(0);
    // Every line of the map must have yielded a grammar, or this test passes
    // by matching nothing while the payload silently loses a language.
    expect(grammars.length).toBe(block.trim().split('\n').length);
    for (const grammar of grammars) {
      // Missing here means the DMG ships no parse table for that language and
      // every file in it indexes as zero symbols — silently.
      expect(PAYLOAD_GRAMMARS).toContain(grammar);
    }
  });
});

describe('collectClosure', () => {
  it('reports a required dependency it cannot resolve instead of staging a hole', async () => {
    const { collectClosure } = await stageServer();
    const { found, missing } = collectClosure(['definitely-not-a-real-package'], process.cwd(), {
      resolve: () => null,
    });
    expect(found.size).toBe(0);
    expect(missing).toEqual(['definitely-not-a-real-package']);
  });

  /* CI's app job installs only `packages/app`, so the server's own
     node_modules is not there to walk. The closure over the real tree is worth
     asserting where it exists — locally, and in the release job that actually
     stages the payload — and is not worth faking where it does not. */
  const repoRoot = path.resolve(process.cwd(), '../..');
  const rootInstalled = existsSync(path.join(repoRoot, 'node_modules', '@ast-grep', 'napi'));

  it.runIf(rootInstalled)('picks the target architecture out of the real tree', async () => {
    const { collectClosure } = await stageServer();
    // `pnpm.supportedArchitectures` installs both; exactly one must ship, or
    // the DMG for that architecture carries a binary it cannot load.
    const x64 = collectClosure(['@ast-grep/napi'], repoRoot, {
      targetOs: 'darwin',
      targetCpu: 'x64',
    });
    expect(x64.missing).toEqual([]);
    expect(x64.found.has('@ast-grep/napi-darwin-x64')).toBe(true);
    expect(x64.found.has('@ast-grep/napi-darwin-arm64')).toBe(false);

    const arm64 = collectClosure(['@ast-grep/napi'], repoRoot, {
      targetOs: 'darwin',
      targetCpu: 'arm64',
    });
    expect(arm64.found.has('@ast-grep/napi-darwin-arm64')).toBe(true);
    expect(arm64.found.has('@ast-grep/napi-darwin-x64')).toBe(false);
  });
});
