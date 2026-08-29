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
  isStuckOnVersion,
  readAppUpdateState,
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
