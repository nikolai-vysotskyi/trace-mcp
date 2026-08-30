import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// TRA-567: better-sqlite3 13.x ships N-API prebuilds for every platform we
// support inside its npm tarball, so it is deliberately NOT in the root
// package.json `pnpm.onlyBuiltDependencies` — we never compile it. The 12.x
// line downloaded per-ABI prebuilds from a GitHub release and fell through to
// `node-gyp rebuild` when one was missing; that fallthrough is what killed the
// v3.9.0 Windows release once the runner image moved to Visual Studio 18 and
// pnpm's bundled node-gyp read it as version "undefined".
//
// This asserts the property that has to hold, not the config line: a prebuilt
// binary exists for the platform running the test. `lib/binding.js` checks
// `prebuilds/` before `build/Release`, so its presence is what decides whether
// a toolchain is ever needed. It fails if a future bump drops prebuilds for a
// platform we build on.
//
// Deliberately NOT asserting the absence of `build/` — pnpm's side-effects
// cache can restore a previously compiled directory into the store without
// running node-gyp at all, so its presence proves nothing either way.
describe('better-sqlite3 native binding', () => {
  it('ships a prebuild for this platform', () => {
    const pkgRoot = path.dirname(require.resolve('better-sqlite3/package.json'));

    expect(
      fs.existsSync(path.join(pkgRoot, 'prebuilds', `${process.platform}-${process.arch}.node`)) ||
        // musl linux gets its own prebuild name
        fs.existsSync(path.join(pkgRoot, 'prebuilds', `linuxmusl-${process.arch}.node`)),
    ).toBe(true);
  });

  it('opens a database', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    try {
      expect(db.prepare('select 1 as n').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
