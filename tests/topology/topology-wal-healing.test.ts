import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs, { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TopologyStore } from '../../src/topology/topology-db.js';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('TopologyStore & DecisionStore WAL healing and leak prevention (TRA-1233)', () => {
  let tmpDir: string;
  let topoDbPath: string;
  let decisionsDbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'trace-wal-heal-'));
    topoDbPath = join(tmpDir, 'topology.db');
    decisionsDbPath = join(tmpDir, 'decisions.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('TopologyStore opens with a stray 0-byte WAL left by a dead process (TRA-1233)', () => {
    const store1 = new TopologyStore(topoDbPath);
    store1.upsertService({
      name: 'auth-service',
      repoRoot: '/repo/auth',
      dbPath: '/repo/auth/.trace/index.db',
      serviceType: 'service',
    });
    store1.close();

    const walPath = `${topoDbPath}-wal`;
    writeFileSync(walPath, Buffer.alloc(0));
    expect(existsSync(walPath)).toBe(true);
    expect(statSync(walPath).size).toBe(0);

    const store2 = new TopologyStore(topoDbPath);
    const service = store2.getService('auth-service');
    expect(service).toBeDefined();
    expect(service?.name).toBe('auth-service');
    store2.close();
  });

  it('DecisionStore opens with a stray 0-byte WAL left by a dead process (TRA-1233)', () => {
    const store1 = new DecisionStore(decisionsDbPath);
    store1.addDecision({
      project_root: '/repo/app',
      title: 'Use SQLite WAL',
      content: 'High concurrency with WAL mode',
      type: 'architecture',
      source: 'test',
    });
    store1.close();

    const walPath = `${decisionsDbPath}-wal`;
    writeFileSync(walPath, Buffer.alloc(0));
    expect(existsSync(walPath)).toBe(true);
    expect(statSync(walPath).size).toBe(0);

    const store2 = new DecisionStore(decisionsDbPath);
    const stats = store2.getStats();
    expect(stats.total).toBeGreaterThanOrEqual(1);
    store2.close();
  });

  it('TopologyStore closes this.db and does not leak file descriptor if constructor throws', () => {
    writeFileSync(topoDbPath, 'corrupted header not a valid sqlite database');
    expect(() => new TopologyStore(topoDbPath)).toThrow();
    expect(existsSync(topoDbPath)).toBe(true);
  });
});

describe('Concurrent open never unlinks a live 0-byte WAL (TRA-2068, GH#1445)', () => {
  let tmpDir: string;
  let topoDbPath: string;
  let decisionsDbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'trace-wal-live-'));
    topoDbPath = join(tmpDir, 'topology.db');
    decisionsDbPath = join(tmpDir, 'decisions.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('TopologyStore: second opener keeps the live 0-byte WAL inode and shares data', () => {
    const store1 = new TopologyStore(topoDbPath);
    try {
      store1.upsertService({
        name: 'auth-service',
        repoRoot: '/repo/auth',
        dbPath: '/repo/auth/.trace/index.db',
        serviceType: 'service',
      });
      // TRUNCATE checkpoint: the live WAL on disk is now 0 bytes — the exact
      // state the old constructor unlinked from under live connections.
      store1.db.pragma('wal_checkpoint(TRUNCATE)');
      const walPath = `${topoDbPath}-wal`;
      expect(existsSync(walPath)).toBe(true);
      expect(statSync(walPath).size).toBe(0);
      const inoBefore = statSync(walPath).ino;

      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const store2 = new TopologyStore(topoDbPath);
      try {
        // The WAL must not have been unlinked + recreated (new inode), and
        // no unlinkSync call may ever target it (exact, platform-independent).
        expect(existsSync(walPath)).toBe(true);
        expect(statSync(walPath).ino).toBe(inoBefore);
        expect(unlinkSpy.mock.calls.filter(([p]) => p === walPath)).toHaveLength(0);
        // Both connections share one coherent database.
        expect(store2.getService('auth-service')?.name).toBe('auth-service');
        store2.upsertService({
          name: 'billing-service',
          repoRoot: '/repo/billing',
          dbPath: '/repo/billing/.trace/index.db',
          serviceType: 'service',
        });
        expect(store1.getService('billing-service')?.name).toBe('billing-service');
        expect(store1.db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      } finally {
        store2.close();
        unlinkSpy.mockRestore();
      }
    } finally {
      store1.close();
    }
  });

  it('DecisionStore: second opener keeps the live 0-byte WAL inode and shares data', () => {
    const store1 = new DecisionStore(decisionsDbPath);
    try {
      store1.addDecision({
        project_root: '/repo/app',
        title: 'Use SQLite WAL',
        content: 'High concurrency with WAL mode',
        type: 'architecture',
        source: 'test',
      });
      store1.db.pragma('wal_checkpoint(TRUNCATE)');
      const walPath = `${decisionsDbPath}-wal`;
      expect(existsSync(walPath)).toBe(true);
      expect(statSync(walPath).size).toBe(0);
      const inoBefore = statSync(walPath).ino;

      const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
      const store2 = new DecisionStore(decisionsDbPath);
      try {
        expect(existsSync(walPath)).toBe(true);
        expect(statSync(walPath).ino).toBe(inoBefore);
        expect(unlinkSpy.mock.calls.filter(([p]) => p === walPath)).toHaveLength(0);
        expect(store2.getStats().total).toBeGreaterThanOrEqual(1);
        store2.addDecision({
          project_root: '/repo/app',
          title: 'Second decision',
          content: 'Written through the second connection',
          type: 'architecture',
          source: 'test',
        });
        expect(store1.getStats().total).toBeGreaterThanOrEqual(2);
        expect(store1.db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      } finally {
        store2.close();
        unlinkSpy.mockRestore();
      }
    } finally {
      store1.close();
    }
  });
});
