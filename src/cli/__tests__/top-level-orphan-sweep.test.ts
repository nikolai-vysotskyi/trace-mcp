/**
 * TRA-1908: TTL sweep for top-level index DBs with no registry row.
 *
 * The night QA contour found 718 files (~1.1 GB) under `index/*.db*`
 * referenced by no `dbPath` in registry.json — mostly `trace-mcp-*` /
 * `app-*` / `workdir-*` leftovers of old naming schemes and razed
 * throwaway checkouts. `sweepTopLevelOrphanDbs` deletes exactly those past
 * the TTL while keeping everything a live project could still need.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTmpDir, tmpRootOutsideTaskDir } from '../../../tests/test-utils.js';

describe('sweepTopLevelOrphanDbs (TRA-1908)', () => {
  let tmpHome: string;
  let tmpProjects: string;
  let indexDir: string;
  let prune: typeof import('../prune.js');
  let registry: typeof import('../../registry.js');
  let holders: typeof import('../../db-holders.js');

  function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(tmpProjects, 'proj-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    return dir;
  }

  function writeDb(name: string, ageDays: number): string {
    const full = path.join(indexDir, name);
    fs.writeFileSync(full, 'x');
    const t = Date.now() / 1000 - ageDays * 24 * 3600;
    fs.utimesSync(full, t, t);
    return full;
  }

  /** A pid guaranteed not to be running (mirrors db-holders.test.ts). */
  function deadPid(): number {
    for (let pid = 999_990; pid > 100; pid--) {
      try {
        process.kill(pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
      }
    }
    throw new Error('no dead pid found');
  }

  /** Plant a dead holder marker for `root` on `dbPath` as if its process exited. */
  function plantDeadHolder(dbPath: string, root: string): void {
    const dir = holders.holdersDir(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    const { createHash } = crypto;
    const id = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        pid: deadPid(),
        root: path.resolve(root),
        startedAt: new Date().toISOString(),
      }),
    );
  }

  beforeEach(async () => {
    tmpHome = tmpRootOutsideTaskDir('trace-orphan-sweep-home-');
    tmpProjects = tmpRootOutsideTaskDir('trace-orphan-sweep-proj-');
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    prune = await import('../prune.js');
    registry = await import('../../registry.js');
    holders = await import('../../db-holders.js');
    const paths = await import('../../shared/paths.js');
    indexDir = paths.INDEX_DIR;
    fs.mkdirSync(indexDir, { recursive: true });
    fs.mkdirSync(path.join(indexDir, 'ephemeral'), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    removeTmpDir(tmpHome);
    removeTmpDir(tmpProjects);
  });

  it('deletes an old unregistered DB with its whole family', () => {
    const base = writeDb('trace-mcp-deadbeef1234.db', 20);
    for (const suffix of ['-wal', '-shm']) {
      fs.writeFileSync(base + suffix, 'sidecar');
      const t = Date.now() / 1000 - 20 * 24 * 3600;
      fs.utimesSync(base + suffix, t, t);
    }
    fs.writeFileSync(`${base}.watcher-snapshot`, '{}');
    const snapT = Date.now() / 1000 - 20 * 24 * 3600;
    fs.utimesSync(`${base}.watcher-snapshot`, snapT, snapT);

    const res = prune.sweepTopLevelOrphanDbs(7);

    expect(res.removed).toEqual([base]);
    expect(res.scannedOrphans).toBe(1);
    expect(res.retainedWithinTtl).toBe(0);
    for (const suffix of ['', '-wal', '-shm', '.watcher-snapshot']) {
      expect(fs.existsSync(base + suffix)).toBe(false);
    }
  });

  it('keeps a fresh orphan inside the TTL and reports it as retained', () => {
    const base = writeDb('app-0123456789ab.db', 1);

    const res = prune.sweepTopLevelOrphanDbs(7);

    expect(res.removed).toEqual([]);
    expect(res.scannedOrphans).toBe(1);
    expect(res.retainedWithinTtl).toBe(1);
    expect(fs.existsSync(base)).toBe(true);
  });

  it('keeps a registered live project DB no matter its age', () => {
    const repo = makeRepo();
    const entry = registry.registerProject(repo);
    // Plant the live DB under its registry dbPath with an old mtime.
    fs.mkdirSync(path.dirname(entry.dbPath), { recursive: true });
    fs.writeFileSync(entry.dbPath, 'live');
    const t = Date.now() / 1000 - 30 * 24 * 3600;
    fs.utimesSync(entry.dbPath, t, t);

    const res = prune.sweepTopLevelOrphanDbs(7);

    expect(res.removed).not.toContain(entry.dbPath);
    expect(fs.existsSync(entry.dbPath)).toBe(true);
  });

  it('keeps a DB shared via TRA-38 dbPath with a live sibling', () => {
    const first = makeRepo();
    const second = makeRepo();
    // Same git remote → second checkout shares the first DB once the first
    // run's process is gone (a live holder forces a private DB instead).
    for (const root of [first, second]) {
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      fs.writeFileSync(
        path.join(root, '.git', 'config'),
        '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n',
      );
    }
    const a = registry.registerProject(first);
    // Simulate the first run's process having exited without cleanup.
    holders.releaseDbHolder(a.dbPath, first);
    plantDeadHolder(a.dbPath, first);
    const b = registry.registerProject(second);
    expect(b.dbPath).toBe(a.dbPath);
    fs.mkdirSync(path.dirname(a.dbPath), { recursive: true });
    fs.writeFileSync(a.dbPath, 'shared');
    const t = Date.now() / 1000 - 30 * 24 * 3600;
    fs.utimesSync(a.dbPath, t, t);

    const res = prune.sweepTopLevelOrphanDbs(7);

    expect(res.removed).not.toContain(a.dbPath);
    expect(fs.existsSync(a.dbPath)).toBe(true);
  });

  it('treats a fresh WAL sidecar as activity on an otherwise old base', () => {
    const base = writeDb('workdir-0123456789ab.db', 20);
    fs.writeFileSync(`${base}-wal`, 'fresh writes'); // fresh mtime: active run

    const res = prune.sweepTopLevelOrphanDbs(7);

    expect(res.removed).toEqual([]);
    expect(fs.existsSync(base)).toBe(true);
  });

  it('treats a fresh watcher snapshot as activity (TRA-1714)', () => {
    const base = writeDb('scratch-0123456789ab.db', 20);
    fs.writeFileSync(`${base}.watcher-snapshot`, '{}'); // fresh mtime: live watcher

    const res = prune.sweepTopLevelOrphanDbs(7);

    expect(res.removed).toEqual([]);
    expect(fs.existsSync(base)).toBe(true);
  });

  it('keeps an old orphan a live holder still has open', () => {
    const base = writeDb('bench-tools-0123456789ab.db', 20);
    holders.announceDbHolder(base, path.join(tmpProjects, 'running-root'));

    const res = prune.sweepTopLevelOrphanDbs(7);

    expect(res.removed).toEqual([]);
    expect(fs.existsSync(base)).toBe(true);
  });

  it('leaves session files to their own TTL', () => {
    const session = writeDb('myapp-abc123def456-session-99999999-aaaa-bbbb-cccc.db', 30);

    const res = prune.sweepTopLevelOrphanDbs(7);

    // Classified session_expired, never orphan_unregistered.
    expect(res.scannedOrphans).toBe(0);
    expect(res.removed).toEqual([]);
    expect(fs.existsSync(session)).toBe(true);
  });

  it('is idempotent: a second run finds nothing to delete', () => {
    writeDb('trace-mcp-0123456789ab.db', 20);

    expect(prune.sweepTopLevelOrphanDbs(7).removed).toHaveLength(1);
    const second = prune.sweepTopLevelOrphanDbs(7);
    expect(second.removed).toEqual([]);
    expect(second.scannedOrphans).toBe(0);
  });

  it('ignores the ephemeral subdir (sweepEphemeralDbs owns it)', () => {
    const ephemeralBase = path.join(indexDir, 'ephemeral', 'run-abcdef123456.db');
    fs.writeFileSync(ephemeralBase, 'x');
    const t = Date.now() / 1000 - 30 * 24 * 3600;
    fs.utimesSync(ephemeralBase, t, t);

    const res = prune.sweepTopLevelOrphanDbs(7);

    expect(res.removed).toEqual([]);
    expect(fs.existsSync(ephemeralBase)).toBe(true);
  });

  it('reproduces the TRA-1709 shape: only >7d unregistered top-level .db go', () => {
    const old1 = writeDb('trace-mcp-aaaabbbbcccc.db', 20);
    const old2 = writeDb('workdir-ddddeeeeffff.db', 24);
    const fresh = writeDb('app-111122223333.db', 1);
    const liveRepo = makeRepo();
    const live = registry.registerProject(liveRepo);
    fs.mkdirSync(path.dirname(live.dbPath), { recursive: true });
    fs.writeFileSync(live.dbPath, 'live');

    const res = prune.sweepTopLevelOrphanDbs(7);

    expect(res.removed.sort()).toEqual([old1, old2].sort());
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(live.dbPath)).toBe(true);
    expect(res.scannedOrphans).toBe(3); // old1, old2, fresh
    expect(res.retainedWithinTtl).toBe(1); // fresh
  });
});
