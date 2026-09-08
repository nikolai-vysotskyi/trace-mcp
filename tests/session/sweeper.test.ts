import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepSessionFiles } from '../../src/session/sweeper.js';
import { sweepSessionFiles as sweepFromResume } from '../../src/session/resume.js';

describe('sweepSessionFiles (TRA-1218)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-sweep-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('re-exports cleanly from src/session/resume.ts', () => {
    expect(typeof sweepFromResume).toBe('function');
  });

  it('returns empty result when directory does not exist or is empty', () => {
    const nonExistent = path.join(tmpDir, 'does-not-exist');
    expect(sweepSessionFiles({ sessionsDir: nonExistent })).toEqual({
      deleted: [],
      freedBytes: 0,
    });

    expect(sweepSessionFiles({ sessionsDir: tmpDir })).toEqual({
      deleted: [],
      freedBytes: 0,
    });
  });

  it('sweeps snapshots older than 24 hours while keeping fresh ones', () => {
    const oldSnap = path.join(tmpDir, 'old123456789-snapshot.json');
    const freshSnap = path.join(tmpDir, 'fresh1234567-snapshot.json');

    fs.writeFileSync(oldSnap, '{"content": "old"}');
    fs.writeFileSync(freshSnap, '{"content": "fresh"}');

    const twoDaysAgo = (Date.now() - 48 * 3600 * 1000) / 1000;
    fs.utimesSync(oldSnap, twoDaysAgo, twoDaysAgo);

    const res = sweepSessionFiles({ sessionsDir: tmpDir });
    expect(res.deleted).toEqual(['old123456789-snapshot.json']);
    expect(res.freedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(oldSnap)).toBe(false);
    expect(fs.existsSync(freshSnap)).toBe(true);
  });

  it('sweeps end logs older than 7 days while keeping fresh ones', () => {
    const oldLog = path.join(tmpDir, 'old123456789-end.log');
    const freshLog = path.join(tmpDir, 'fresh1234567-end.log');

    fs.writeFileSync(oldLog, '2026-08-01T00:00:00Z\tsession-1\n');
    fs.writeFileSync(freshLog, '2026-09-08T00:00:00Z\tsession-2\n');

    const tenDaysAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(oldLog, tenDaysAgo, tenDaysAgo);

    const res = sweepSessionFiles({ sessionsDir: tmpDir });
    expect(res.deleted).toEqual(['old123456789-end.log']);
    expect(fs.existsSync(oldLog)).toBe(false);
    expect(fs.existsSync(freshLog)).toBe(true);
  });

  it('sweeps orphaned atomic-write tmp files older than 1 hour', () => {
    const oldTmp = path.join(tmpDir, '.somehash.tmp.1234.abcd');
    const freshTmp = path.join(tmpDir, '.somehash.tmp.5678.ef01');

    fs.writeFileSync(oldTmp, 'tmp data');
    fs.writeFileSync(freshTmp, 'fresh tmp data');

    const twoHoursAgo = (Date.now() - 2 * 3600 * 1000) / 1000;
    fs.utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);

    const res = sweepSessionFiles({ sessionsDir: tmpDir });
    expect(res.deleted).toEqual(['.somehash.tmp.1234.abcd']);
    expect(fs.existsSync(oldTmp)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);
  });

  it('sweeps corrupt and empty session resume JSON files', () => {
    const corruptFile = path.join(tmpDir, 'corrupt12345.json');
    const emptyArrayFile = path.join(tmpDir, 'empty1234567.json');

    fs.writeFileSync(corruptFile, 'not valid json {{{');
    fs.writeFileSync(emptyArrayFile, '[]');

    const res = sweepSessionFiles({ sessionsDir: tmpDir });
    expect(res.deleted.sort()).toEqual(['corrupt12345.json', 'empty1234567.json']);
    expect(fs.existsSync(corruptFile)).toBe(false);
    expect(fs.existsSync(emptyArrayFile)).toBe(false);
  });

  it('immediately sweeps ephemeral project resumes and their associated artifacts when root is deleted', () => {
    // Path matches Multica ephemeral workspace pattern
    const deadEphemeralRoot =
      '/Users/nikolai/multica_workspaces_desktop-api.multica.ai/tracemcp-2a3e85da063b/tra-999-123456789abc/workdir';
    const hash = 'ephem1234567';

    const resumeFile = path.join(tmpDir, `${hash}.json`);
    const snapFile = path.join(tmpDir, `${hash}-snapshot.json`);
    const endLogFile = path.join(tmpDir, `${hash}-end.log`);

    const summary = [
      {
        session_id: 's-1',
        project_root: deadEphemeralRoot,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      },
    ];

    fs.writeFileSync(resumeFile, JSON.stringify(summary));
    fs.writeFileSync(snapFile, '{"snapshot": true}');
    fs.writeFileSync(endLogFile, '2026-09-08T00:00:00Z\ts-1\n');

    // Root does not exist; even though created just now, it is ephemeral so should be cleaned immediately
    const res = sweepSessionFiles({ sessionsDir: tmpDir });
    expect(res.deleted.sort()).toEqual(
      [`${hash}-end.log`, `${hash}-snapshot.json`, `${hash}.json`].sort(),
    );
    expect(fs.existsSync(resumeFile)).toBe(false);
    expect(fs.existsSync(snapFile)).toBe(false);
    expect(fs.existsSync(endLogFile)).toBe(false);
  });

  it('keeps resume files for live projects', () => {
    const liveRoot = fs.mkdtempSync(path.join(tmpDir, 'live-project-'));
    const hash = 'live12345678';

    const resumeFile = path.join(tmpDir, `${hash}.json`);
    const snapFile = path.join(tmpDir, `${hash}-snapshot.json`);

    const summary = [
      {
        session_id: 's-live',
        project_root: liveRoot,
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      },
    ];

    fs.writeFileSync(resumeFile, JSON.stringify(summary));
    fs.writeFileSync(snapFile, '{"snapshot": true}');

    const res = sweepSessionFiles({ sessionsDir: tmpDir });
    expect(res.deleted).toEqual([]);
    expect(fs.existsSync(resumeFile)).toBe(true);
    expect(fs.existsSync(snapFile)).toBe(true);
  });

  it('respects missing root grace period for non-ephemeral project roots', () => {
    const missingRoot = '/tmp/nonexistent-normal-project-xyz';
    const hashYoung = 'young1234567';
    const hashOld = 'oldroot12345';

    const youngResume = path.join(tmpDir, `${hashYoung}.json`);
    const oldResume = path.join(tmpDir, `${hashOld}.json`);

    const youngSummary = [
      {
        session_id: 's-young',
        project_root: missingRoot,
        started_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
        ended_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      },
    ];

    const oldSummary = [
      {
        session_id: 's-old',
        project_root: missingRoot,
        started_at: new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString(),
        ended_at: new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString(),
      },
    ];

    fs.writeFileSync(youngResume, JSON.stringify(youngSummary));
    fs.writeFileSync(oldResume, JSON.stringify(oldSummary));

    const fourteenDaysAgo = (Date.now() - 14 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(oldResume, fourteenDaysAgo, fourteenDaysAgo);

    const res = sweepSessionFiles({ sessionsDir: tmpDir, missingRootGraceDays: 7 });
    expect(res.deleted).toEqual([`${hashOld}.json`]);
    expect(fs.existsSync(youngResume)).toBe(true);
    expect(fs.existsSync(oldResume)).toBe(false);
  });

  it('supports dry-run mode without unlinking files', () => {
    const oldSnap = path.join(tmpDir, 'old123456789-snapshot.json');
    fs.writeFileSync(oldSnap, '{"content": "old"}');
    const twoDaysAgo = (Date.now() - 48 * 3600 * 1000) / 1000;
    fs.utimesSync(oldSnap, twoDaysAgo, twoDaysAgo);

    const res = sweepSessionFiles({ sessionsDir: tmpDir, dryRun: true });
    expect(res.deleted).toEqual(['old123456789-snapshot.json']);
    expect(res.freedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(oldSnap)).toBe(true); // preserved because dryRun is true
  });
});
