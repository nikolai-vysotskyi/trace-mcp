/* The server payload the app ships (TRA-438). Two things it must never do:
   collect a dependency it cannot find, and stage native binaries built for one
   architecture into a bundle for another — that produces a DMG that looks fine
   and whose daemon dies with ERR_DLOPEN_FAILED on first launch. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* Dynamic, not a static import: the main process compiles as CommonJS
   (tsconfig.main.json, `module: Node16`) and cannot `require` an ES module. */
const stageServer = () => import('../../../scripts/stage-server.mjs');

describe('assertNativeArch', () => {
  it('allows a same-architecture build', async () => {
    const { assertNativeArch } = await stageServer();
    expect(() => assertNativeArch('arm64', 'arm64')).not.toThrow();
    expect(() => assertNativeArch(undefined, 'arm64')).not.toThrow();
  });

  it('refuses a cross-architecture build rather than shipping a dead daemon', async () => {
    const { assertNativeArch } = await stageServer();
    expect(() => assertNativeArch('x64', 'arm64')).toThrow(/refusing to stage/);
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

describe('collectClosure', () => {
  it('reports a required dependency it cannot resolve instead of staging a hole', async () => {
    const { collectClosure } = await stageServer();
    const { found, missing } = collectClosure(
      ['definitely-not-a-real-package'],
      process.cwd(),
      () => null,
    );
    expect(found.size).toBe(0);
    expect(missing).toEqual(['definitely-not-a-real-package']);
  });

  /* CI's app job installs only `packages/app`, so the server's own
     node_modules is not there to walk. The closure over the real tree is worth
     asserting where it exists — locally, and in the release job that actually
     stages the payload — and is not worth faking where it does not. */
  const repoRoot = path.resolve(process.cwd(), '../..');
  const rootInstalled = existsSync(path.join(repoRoot, 'node_modules', 'better-sqlite3'));

  it.runIf(rootInstalled)('reaches the transitive closure of the real installed tree', async () => {
    const { collectClosure } = await stageServer();
    const { found, missing } = collectClosure(['better-sqlite3'], repoRoot);
    expect(missing).toEqual([]);
    expect(found.has('better-sqlite3')).toBe(true);
    // better-sqlite3's own runtime require — the reason a naive one-level copy
    // produces a daemon that cannot open its database.
    expect(found.has('bindings')).toBe(true);
  });
});
