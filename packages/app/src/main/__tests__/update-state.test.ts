/**
 * The updater's decisions, pinned against the machine state from TRA-357:
 * bundle stuck at 1.50.0, npm package walked 1.48.5 → 3.1.1, five consecutive
 * `npm-only` outcomes, `pending:false` every time.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AppUpdateState,
  computeUpdateOutcome,
  findStaleRoots,
  type GlobalInstall,
  isStuckOnVersion,
  readAppUpdateState,
  scanGlobalInstalls,
  shouldAttemptRepair,
  writeAppUpdateState,
} from '../update-state';

// Enough for the version pairs under test; mirrors the main-process helper.
function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

describe('computeUpdateOutcome', () => {
  it('reports npm-only when the package moved but no zip is staged', () => {
    expect(computeUpdateOutcome('3.1.1', '1.50.0', false, cmpSemver)).toBe('npm-only');
  });

  it('prefers a staged bundle over everything else', () => {
    expect(computeUpdateOutcome('3.1.1', '1.50.0', true, cmpSemver)).toBe('bundle-pending');
  });

  it('reports already-current when nothing moved', () => {
    expect(computeUpdateOutcome('3.1.1', '3.1.1', false, cmpSemver)).toBe('already-current');
  });
});

describe('shouldAttemptRepair', () => {
  it('fires for the stale bundle that nothing used to retry', () => {
    expect(shouldAttemptRepair('3.1.1', '1.50.0', false, cmpSemver)).toBe(true);
  });

  it('does not fire when a swap is already staged', () => {
    expect(shouldAttemptRepair('3.1.1', '1.50.0', true, cmpSemver)).toBe(false);
  });

  it('does not fire when the bundle is current or the version is unknown', () => {
    expect(shouldAttemptRepair('3.1.1', '3.1.1', false, cmpSemver)).toBe(false);
    expect(shouldAttemptRepair(undefined, '1.50.0', false, cmpSemver)).toBe(false);
  });
});

describe('isStuckOnVersion', () => {
  const state: AppUpdateState = {
    lastNpmOnlyAttempt: { bundle: '1.50.0', target: '3.1.1', at: 1_787_988_925_616 },
  };

  it('suppresses a repeat prompt for the same (bundle, target) pair', () => {
    expect(isStuckOnVersion('1.50.0', '3.1.1', state, cmpSemver)).toBe(true);
  });

  it('re-arms when a newer release appears', () => {
    expect(isStuckOnVersion('1.50.0', '3.2.0', state, cmpSemver)).toBe(false);
  });

  it('clears once the bundle actually moved', () => {
    expect(isStuckOnVersion('3.1.1', '3.1.1', state, cmpSemver)).toBe(false);
  });
});

describe('state persistence', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-update-state-'));
    file = path.join(dir, 'app-update-state.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips the attempt counter', () => {
    writeAppUpdateState(
      { lastNpmOnlyAttempt: { bundle: '1.50.0', target: '3.1.1', at: 1, attempts: 5 } },
      file,
    );
    expect(readAppUpdateState(file).lastNpmOnlyAttempt?.attempts).toBe(5);
  });

  it('returns an empty state for a missing or malformed file', () => {
    expect(readAppUpdateState(path.join(dir, 'nope.json'))).toEqual({});
    fs.writeFileSync(file, '{not json');
    expect(readAppUpdateState(file)).toEqual({});
  });
});

describe('scanGlobalInstalls', () => {
  let tmp: string;

  const makeRoot = (name: string, version?: string): string => {
    const root = path.join(tmp, name);
    if (version === undefined) {
      fs.mkdirSync(root, { recursive: true });
      return root;
    }
    const pkgDir = path.join(root, 'trace-mcp');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version }));
    return root;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-global-roots-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports the version in every root that has trace-mcp', () => {
    const a = makeRoot('nvm', '3.1.1');
    const b = makeRoot('hermes', '3.0.0');
    expect(scanGlobalInstalls([a, b])).toEqual([
      { root: a, version: '3.1.1' },
      { root: b, version: '3.0.0' },
    ]);
  });

  it('skips absent roots, roots without trace-mcp, and null entries', () => {
    const withPkg = makeRoot('nvm', '3.1.1');
    const empty = makeRoot('empty');
    expect(scanGlobalInstalls([withPkg, empty, path.join(tmp, 'nope'), null, undefined])).toEqual([
      { root: withPkg, version: '3.1.1' },
    ]);
  });

  it('counts a symlinked duplicate of the same install once', () => {
    const real = makeRoot('nvm', '3.1.1');
    const link = path.join(tmp, 'linked');
    fs.mkdirSync(link);
    fs.symlinkSync(path.join(real, 'trace-mcp'), path.join(link, 'trace-mcp'), 'dir');
    expect(scanGlobalInstalls([real, link])).toEqual([{ root: real, version: '3.1.1' }]);
  });

  it('skips a package whose package.json is unreadable or has no version', () => {
    const broken = makeRoot('broken', '3.1.1');
    fs.writeFileSync(path.join(broken, 'trace-mcp', 'package.json'), '{ not json');
    const versionless = makeRoot('versionless', '3.1.1');
    fs.writeFileSync(path.join(versionless, 'trace-mcp', 'package.json'), '{}');
    expect(scanGlobalInstalls([broken, versionless])).toEqual([]);
  });
});

describe('findStaleRoots', () => {
  const install = (root: string, version: string): GlobalInstall => ({ root, version });

  it('reports nothing for a single-root machine', () => {
    expect(findStaleRoots([install('/a', '3.1.1')], cmpSemver)).toEqual([]);
    expect(findStaleRoots([], cmpSemver)).toEqual([]);
  });

  it('reports nothing when every root agrees', () => {
    expect(findStaleRoots([install('/a', '3.1.1'), install('/b', '3.1.1')], cmpSemver)).toEqual([]);
  });

  it('reports every root behind the newest — the TRA-364 three-root case', () => {
    const stale = findStaleRoots(
      [install('/herd', '3.1.1'), install('/nvm', '3.1.1'), install('/hermes', '3.0.0')],
      cmpSemver,
    );
    expect(stale).toEqual([install('/hermes', '3.0.0')]);
  });

  it('measures against the newest root, not the first one seen', () => {
    const stale = findStaleRoots(
      [install('/old', '3.0.0'), install('/new', '3.1.1'), install('/older', '2.9.0')],
      cmpSemver,
    );
    expect(stale.map((s) => s.root)).toEqual(['/old', '/older']);
  });
});
