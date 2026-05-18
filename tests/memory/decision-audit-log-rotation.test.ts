/**
 * Tests for the audit-log day-bucketed retention. Covers:
 *  - `pruneOlderThan` helper deletes only matching `YYYY-MM-DD.jsonl` files
 *    older than the window.
 *  - `createAuditLogger` prunes once at construction.
 *  - Day rollover during writes triggers another prune pass.
 *  - `retentionDays=0` (default) is a no-op.
 *  - Foreign filenames (anything not matching the bucket pattern) are kept.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditLogger, pruneOlderThan } from '../../src/memory/decision-audit-log.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function fileNameForDaysAgo(now: Date, daysAgo: number): string {
  const d = new Date(now.getTime() - daysAgo * DAY_MS);
  return `${d.toISOString().slice(0, 10)}.jsonl`;
}

describe('pruneOlderThan', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rotation-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('deletes only files older than `days` and leaves fresher ones', () => {
    const now = new Date('2030-06-30T12:00:00.000Z');
    // Files dated 30, 20, 10, 5, 2 days ago.
    for (const offset of [30, 20, 10, 5, 2]) {
      fs.writeFileSync(path.join(dir, fileNameForDaysAgo(now, offset)), 'x\n');
    }
    const result = pruneOlderThan(dir, 15, now);
    expect(result.deleted).toBe(2); // 30d + 20d gone
    const remaining = fs.readdirSync(dir).sort();
    expect(remaining).toEqual(
      [fileNameForDaysAgo(now, 10), fileNameForDaysAgo(now, 5), fileNameForDaysAgo(now, 2)].sort(),
    );
  });

  it('keeps a bucket whose midnight equals the cutoff (boundary is inclusive of "today - days")', () => {
    // With `now` exactly at UTC midnight, a bucket from `days` ago is at the
    // same UTC midnight as the cutoff. The implementation uses `bucketMs >=
    // cutoffMs` to keep the file alive — boundary inclusive on the keep side.
    const now = new Date('2030-06-30T00:00:00.000Z');
    fs.writeFileSync(path.join(dir, fileNameForDaysAgo(now, 15)), 'x\n');
    const result = pruneOlderThan(dir, 15, now);
    expect(result.deleted).toBe(0);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it('returns { deleted: 0 } when days <= 0 (retention disabled)', () => {
    const now = new Date('2030-06-30T12:00:00.000Z');
    fs.writeFileSync(path.join(dir, fileNameForDaysAgo(now, 100)), 'x\n');
    expect(pruneOlderThan(dir, 0, now).deleted).toBe(0);
    expect(pruneOlderThan(dir, -5, now).deleted).toBe(0);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it('returns { deleted: 0 } when the directory does not exist', () => {
    const missing = path.join(dir, 'no-such');
    expect(pruneOlderThan(missing, 30).deleted).toBe(0);
  });

  it('ignores filenames that do not match YYYY-MM-DD.jsonl', () => {
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    fs.writeFileSync(path.join(dir, 'not-a-date.jsonl'), 'x\n');
    fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), 'x\n');
    const result = pruneOlderThan(dir, 30, new Date('2030-06-30T12:00:00.000Z'));
    expect(result.deleted).toBe(1); // only 2020-01-01.jsonl
    expect(fs.readdirSync(dir).sort()).toEqual(['README.md', 'not-a-date.jsonl']);
  });
});

describe('createAuditLogger — retentionDays', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rotate-logger-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('prunes existing stale files at construction when retentionDays > 0', () => {
    const now = new Date('2030-06-30T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    // Seed: 30d-old + 5d-old files.
    fs.writeFileSync(path.join(dir, fileNameForDaysAgo(now, 30)), 'x\n');
    fs.writeFileSync(path.join(dir, fileNameForDaysAgo(now, 5)), 'x\n');
    const logger = createAuditLogger({ dir, retentionDays: 15 });
    try {
      const remaining = fs.readdirSync(dir);
      expect(remaining).toEqual([fileNameForDaysAgo(now, 5)]);
    } finally {
      logger.close();
    }
  });

  it('keeps every file when retentionDays is 0 (default)', () => {
    const now = new Date('2030-06-30T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    fs.writeFileSync(path.join(dir, fileNameForDaysAgo(now, 365)), 'x\n');
    const logger = createAuditLogger({ dir });
    try {
      expect(fs.readdirSync(dir)).toHaveLength(1);
    } finally {
      logger.close();
    }
  });

  it('prunes again when a write crosses a UTC day boundary', () => {
    vi.useFakeTimers();
    const day1 = new Date('2030-06-15T23:00:00.000Z');
    vi.setSystemTime(day1);
    // Seed an obsolete bucket relative to day1 (older than 15d).
    fs.writeFileSync(path.join(dir, fileNameForDaysAgo(day1, 30)), 'x\n');
    const logger = createAuditLogger({ dir, retentionDays: 15 });
    try {
      // Construction pruned the seed.
      let names = fs.readdirSync(dir);
      expect(names).toEqual([]);
      // Write on day1 — creates the day1 bucket.
      logger.log({ op: 'add', decision_id: 1 });
      names = fs.readdirSync(dir).sort();
      expect(names).toContain(`${day1.toISOString().slice(0, 10)}.jsonl`);
      // Advance ~16 days. Drop a stale file that is older than the new
      // window, write again, and confirm rollover-triggered prune ran.
      const day2 = new Date('2030-07-01T01:00:00.000Z');
      vi.setSystemTime(day2);
      // The day1 bucket is now ~16 days old — should be pruned next write.
      logger.log({ op: 'add', decision_id: 2 });
      names = fs.readdirSync(dir).sort();
      expect(names).toEqual([`${day2.toISOString().slice(0, 10)}.jsonl`]);
    } finally {
      logger.close();
    }
  });
});
