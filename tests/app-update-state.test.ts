/**
 * Pure-logic tests for the in-app updater's stuck-marker reasoning.
 * The Electron-side IPC handlers in packages/app/src/main/index.ts delegate
 * decisions to these helpers, so testing them in isolation gives us full
 * coverage of the cycle fix without standing up an Electron environment.
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
  writeAppUpdateState,
} from '../packages/app/src/main/update-state.js';

// Lexicographic comparison happens to coincide with semver order for the
// equal-segment-length, dotted-numeric version strings used in these tests
// (1.39.2 / 1.39.3 / 1.40.0). Keeps the test independent of the real
// cmpSemver implementation, which lives next to its only caller.
const cmp = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

describe('computeUpdateOutcome', () => {
  it('returns bundle-pending whenever a staged zip is present, regardless of versions', () => {
    expect(computeUpdateOutcome('1.39.3', '1.39.2', true, cmp)).toBe('bundle-pending');
    expect(computeUpdateOutcome('1.39.2', '1.39.2', true, cmp)).toBe('bundle-pending');
    expect(computeUpdateOutcome(undefined, '1.39.2', true, cmp)).toBe('bundle-pending');
  });

  it('returns npm-only when on-disk package moved ahead but no zip is staged', () => {
    expect(computeUpdateOutcome('1.39.3', '1.39.2', false, cmp)).toBe('npm-only');
  });

  it('returns already-current when installed === running', () => {
    expect(computeUpdateOutcome('1.39.3', '1.39.3', false, cmp)).toBe('already-current');
  });

  it('returns already-current when installed is missing (failed read)', () => {
    expect(computeUpdateOutcome(undefined, '1.39.2', false, cmp)).toBe('already-current');
  });

  it('returns already-current when installed somehow went backwards', () => {
    // Defensive: a stale or rolled-back npm install should not be advertised
    // as a pending forward step.
    expect(computeUpdateOutcome('1.39.1', '1.39.2', false, cmp)).toBe('already-current');
  });
});

describe('isStuckOnVersion', () => {
  const stuck: AppUpdateState = {
    lastNpmOnlyAttempt: { bundle: '1.39.2', target: '1.39.3', at: 0 },
  };

  it('returns false when no marker has been written', () => {
    expect(isStuckOnVersion('1.39.2', '1.39.3', {}, cmp)).toBe(false);
  });

  it('returns true when bundle and latest match the marker exactly', () => {
    expect(isStuckOnVersion('1.39.2', '1.39.3', stuck, cmp)).toBe(true);
  });

  it('returns false when a new release lands beyond the stuck target', () => {
    // A genuine new release should re-enable the banner.
    expect(isStuckOnVersion('1.39.2', '1.40.0', stuck, cmp)).toBe(false);
  });

  it('returns false when the bundle has moved since the stuck attempt', () => {
    // The user reinstalled the .app manually — banner can re-arm.
    expect(isStuckOnVersion('1.39.3', '1.39.3', stuck, cmp)).toBe(false);
  });

  it('returns true when the latest regresses to the marker target', () => {
    // Treat <= target as stuck — if registry briefly flaps backwards, we still
    // don't want to retry the same npm-only flow.
    expect(isStuckOnVersion('1.39.2', '1.39.3', stuck, cmp)).toBe(true);
  });
});

describe('readAppUpdateState / writeAppUpdateState round-trip', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-app-update-state-'));
    tmpFile = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('reads an empty object when the file is missing', () => {
    expect(readAppUpdateState(tmpFile)).toEqual({});
  });

  it('reads an empty object when the file is malformed JSON', () => {
    fs.writeFileSync(tmpFile, 'not valid {{ json');
    expect(readAppUpdateState(tmpFile)).toEqual({});
  });

  it('round-trips a written marker', () => {
    const written: AppUpdateState = {
      lastNpmOnlyAttempt: { bundle: '1.39.2', target: '1.39.3', at: 1700000000000 },
    };
    writeAppUpdateState(written, tmpFile);
    expect(readAppUpdateState(tmpFile)).toEqual(written);
  });

  it('creates the parent directory if missing', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'state.json');
    writeAppUpdateState({ lastNpmOnlyAttempt: { bundle: '1', target: '2', at: 0 } }, nested);
    expect(fs.existsSync(nested)).toBe(true);
    expect(readAppUpdateState(nested).lastNpmOnlyAttempt?.target).toBe('2');
  });
});
