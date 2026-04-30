import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateFreshness,
  computeFileFreshness,
  computeFileFreshnessFromSignals,
  computeRepoFreshness,
} from '../../src/scoring/freshness.js';

describe('freshness', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-fresh-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('computeFileFreshnessFromSignals', () => {
    it("returns 'fresh' when current mtime is at or below indexed mtime", () => {
      const file = path.join(tmpRoot, 'a.ts');
      fs.writeFileSync(file, 'x');
      const indexed = Math.floor(fs.statSync(file).mtimeMs);
      expect(computeFileFreshnessFromSignals({ indexedMtimeMs: indexed, absolutePath: file })).toBe(
        'fresh',
      );
    });

    it("returns 'edited_uncommitted' when on-disk mtime is newer than the index", () => {
      const file = path.join(tmpRoot, 'b.ts');
      fs.writeFileSync(file, 'x');
      // Stale baseline: claim we indexed the file 10 seconds ago.
      const indexedTooOld = Math.floor(fs.statSync(file).mtimeMs) - 10_000;
      expect(
        computeFileFreshnessFromSignals({ indexedMtimeMs: indexedTooOld, absolutePath: file }),
      ).toBe('edited_uncommitted');
    });

    it("returns 'stale_index' when the file is missing from disk", () => {
      const missing = path.join(tmpRoot, 'gone.ts');
      expect(computeFileFreshnessFromSignals({ indexedMtimeMs: 1, absolutePath: missing })).toBe(
        'stale_index',
      );
    });

    it("returns 'fresh' when no indexed mtime is recorded (older index format)", () => {
      const file = path.join(tmpRoot, 'c.ts');
      fs.writeFileSync(file, 'x');
      expect(computeFileFreshnessFromSignals({ indexedMtimeMs: null, absolutePath: file })).toBe(
        'fresh',
      );
    });
  });

  describe('computeFileFreshness', () => {
    it('resolves the project-relative path against rootPath', () => {
      const sub = path.join(tmpRoot, 'src');
      fs.mkdirSync(sub);
      const file = path.join(sub, 'd.ts');
      fs.writeFileSync(file, 'x');
      const indexed = Math.floor(fs.statSync(file).mtimeMs);
      expect(computeFileFreshness(tmpRoot, { path: 'src/d.ts', mtime_ms: indexed })).toBe('fresh');
    });
  });

  describe('computeRepoFreshness', () => {
    it('returns null when no index_head_sha was captured', () => {
      const store = { getRepoMetadata: () => null };
      const r = computeRepoFreshness(tmpRoot, store);
      expect(r).toBeNull();
    });

    it('returns null when the path is not a git working tree', () => {
      // tmpRoot is a fresh tmpdir with no .git. Even if we have a baseline SHA,
      // `git rev-parse HEAD` should fail and we resolve to null.
      const store = { getRepoMetadata: () => 'a'.repeat(40) };
      const r = computeRepoFreshness(tmpRoot, store);
      expect(r).toBeNull();
    });

    it('reports repo_is_stale=false when current HEAD matches the baseline', () => {
      // Use this repo's working tree — it's a real git repo. Read the current
      // SHA via execSync and pass that as the indexed value.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require('node:child_process') as typeof import('node:child_process');
      const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
      const store = { getRepoMetadata: () => sha };
      const r = computeRepoFreshness(process.cwd(), store);
      expect(r).not.toBeNull();
      expect(r!.repo_is_stale).toBe(false);
      expect(r!.current_head_sha).toBe(sha);
    });

    it('reports repo_is_stale=true when baseline differs from HEAD', () => {
      const fakeOldSha = '0000000000000000000000000000000000000000';
      const store = { getRepoMetadata: () => fakeOldSha };
      const r = computeRepoFreshness(process.cwd(), store);
      expect(r).not.toBeNull();
      expect(r!.repo_is_stale).toBe(true);
      expect(r!.index_head_sha).toBe(fakeOldSha);
    });
  });

  describe('aggregateFreshness', () => {
    it('counts levels and sets repo_is_stale only when any non-fresh entry exists', () => {
      expect(aggregateFreshness(['fresh', 'fresh'])).toEqual({
        fresh: 2,
        edited_uncommitted: 0,
        stale_index: 0,
        repo_is_stale: false,
      });
      expect(aggregateFreshness(['fresh', 'edited_uncommitted'])).toEqual({
        fresh: 1,
        edited_uncommitted: 1,
        stale_index: 0,
        repo_is_stale: true,
      });
      expect(aggregateFreshness(['stale_index'])).toEqual({
        fresh: 0,
        edited_uncommitted: 0,
        stale_index: 1,
        repo_is_stale: true,
      });
    });

    it('handles an empty input', () => {
      expect(aggregateFreshness([])).toEqual({
        fresh: 0,
        edited_uncommitted: 0,
        stale_index: 0,
        repo_is_stale: false,
      });
    });
  });
});
