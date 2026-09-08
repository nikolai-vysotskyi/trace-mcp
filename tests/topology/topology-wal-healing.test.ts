import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
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

  it('TopologyStore heals an empty 0-byte WAL file instead of failing with SQLITE_IOERR_SHORT_READ', () => {
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

  it('DecisionStore heals an empty 0-byte WAL file instead of failing with SQLITE_IOERR_SHORT_READ', () => {
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
