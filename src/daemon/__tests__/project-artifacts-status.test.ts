/**
 * TRA-2062: heartbeat files of removed projects must not accumulate.
 *
 * Every agent workdir left `trace-mcp-{alive,consulted,status}-<hash>` files
 * in STATUS_DIR forever (187 stale-only hashes measured) because no
 * deregistration path removed them. Covers the per-root deleter, the
 * removeProjectArtifacts hook (the collapse path sweepEphemeralProjects uses),
 * and the gated daemon-startup orphan sweep.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;
let g: typeof import('../../global.js');
let heartbeat: typeof import('../../server/heartbeat.js');
let artifacts: typeof import('../project-artifacts.js');
let prune: typeof import('../../cli/prune.js');

const DAY_S = 24 * 3600;

function backdate(p: string, ageDays: number): void {
  const t = Date.now() / 1000 - ageDays * DAY_S;
  fs.utimesSync(p, t, t);
}

/** Seed the three sentinels for a root inside STATUS_DIR; returns their paths. */
function seedSentinels(root: string, ageDays: number): string[] {
  const hash = g.projectHash(path.resolve(root));
  const status = path.join(g.STATUS_DIR, `trace-mcp-status-${hash}.json`);
  const alive = path.join(g.STATUS_DIR, `trace-mcp-alive-${hash}`);
  const consulted = path.join(g.STATUS_DIR, `trace-mcp-consulted-${hash}`);
  fs.mkdirSync(g.STATUS_DIR, { recursive: true });
  fs.writeFileSync(status, '{"schema":2}');
  fs.writeFileSync(alive, '123');
  fs.mkdirSync(consulted, { recursive: true });
  fs.writeFileSync(path.join(consulted, 'deadbeef'), '');
  // Backdate the dir last: creating the marker inside refreshes dir mtime.
  backdate(status, ageDays);
  backdate(alive, ageDays);
  backdate(consulted, ageDays);
  return [status, alive, consulted];
}

function seedRegistryEntry(root: string): void {
  const abs = path.resolve(root);
  const hash = g.projectHash(abs);
  const entry = {
    name: path.basename(abs),
    root: abs,
    dbPath: path.join(g.INDEX_DIR, `${path.basename(abs)}-${hash}.db`),
    lastIndexed: null,
    addedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(g.REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(g.REGISTRY_PATH, JSON.stringify({ version: 1, projects: { [abs]: entry } }));
}

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-status-cleanup-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
  g = await import('../../global.js');
  heartbeat = await import('../../server/heartbeat.js');
  artifacts = await import('../project-artifacts.js');
  prune = await import('../../cli/prune.js');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('deleteStatusSentinelsForRoot (TRA-2062)', () => {
  it('removes exactly this root’s sentinels and nothing else', () => {
    const gone = path.join(tmpHome, 'gone');
    const kept = path.join(tmpHome, 'kept');
    const goneFiles = seedSentinels(gone, 10);
    const keptFiles = seedSentinels(kept, 10);
    // Bystanders that must survive: daemon snapshot, bypass file, user file,
    // and a lookalike with the wrong suffix convention.
    fs.mkdirSync(g.STATUS_DIR, { recursive: true });
    const daemon = path.join(g.STATUS_DIR, 'trace-mcp-daemon.json');
    const bypass = path.join(g.STATUS_DIR, 'trace-mcp-bypass-abc123.json');
    const user = path.join(g.STATUS_DIR, 'notes.txt');
    const lookalike = path.join(
      g.STATUS_DIR,
      `trace-mcp-status-${g.projectHash(path.resolve(gone))}`,
    );
    for (const f of [daemon, bypass, user, lookalike]) fs.writeFileSync(f, 'x');

    const removed = heartbeat.deleteStatusSentinelsForRoot(gone);

    expect(new Set(removed)).toEqual(new Set(goneFiles));
    for (const f of goneFiles) expect(fs.existsSync(f)).toBe(false);
    for (const f of [...keptFiles, daemon, bypass, user, lookalike]) {
      expect(fs.existsSync(f)).toBe(true);
    }
    // Idempotent: a second call finds nothing.
    expect(heartbeat.deleteStatusSentinelsForRoot(gone)).toEqual([]);
  });

  it('also removes the $TMPDIR copies', () => {
    const gone = path.join(tmpHome, 'gone');
    const hash = g.projectHash(path.resolve(gone));
    const tmpCopy = path.join(os.tmpdir(), `trace-mcp-alive-${hash}`);
    fs.writeFileSync(tmpCopy, '123');
    try {
      seedSentinels(gone, 10);
      heartbeat.deleteStatusSentinelsForRoot(gone);
      expect(fs.existsSync(tmpCopy)).toBe(false);
    } finally {
      fs.rmSync(tmpCopy, { force: true });
    }
  });
});

describe('removeProjectArtifacts — status sentinels (TRA-2062)', () => {
  it('drops the removed project’s sentinels and keeps every other project’s', () => {
    const gone = path.join(tmpHome, 'gone');
    const kept = path.join(tmpHome, 'kept');
    const goneFiles = seedSentinels(gone, 10);
    const keptFiles = seedSentinels(kept, 10);

    const result = artifacts.removeProjectArtifacts(gone);

    for (const f of goneFiles) {
      expect(fs.existsSync(f)).toBe(false);
      expect(result.deleted).toContain(f);
    }
    for (const f of keptFiles) expect(fs.existsSync(f)).toBe(true);
    expect(result.failures).toEqual([]);

    // Idempotent: a second removal finds nothing left to drop.
    const second = artifacts.removeProjectArtifacts(gone);
    expect(second.failures).toEqual([]);
    for (const f of goneFiles) expect(second.deleted).not.toContain(f);
  });
});

describe('sweepOrphanStatusSentinels (TRA-2062)', () => {
  it('deletes old orphans, keeps fresh orphans, live projects, and non-sentinels', () => {
    fs.mkdirSync(g.STATUS_DIR, { recursive: true });
    fs.mkdirSync(g.INDEX_DIR, { recursive: true });

    // Old orphan: no registry row, no index DB → deleted.
    const orphanRoot = path.join(tmpHome, 'orphan-workdir');
    const [orphanStatus, orphanAlive, orphanConsulted] = seedSentinels(orphanRoot, 5);

    // Fresh orphan: same situation but inside the TTL → retained.
    const freshRoot = path.join(tmpHome, 'fresh-workdir');
    const freshFiles = seedSentinels(freshRoot, 0);

    // Live project: registered root with an old sentinel → retained.
    const liveRoot = path.join(tmpHome, 'live');
    seedRegistryEntry(liveRoot);
    const liveFiles = seedSentinels(liveRoot, 30);

    // Unregistered root whose index DB still exists → retained.
    const dbRoot = path.join(tmpHome, 'has-db');
    const dbHash = g.projectHash(path.resolve(dbRoot));
    fs.writeFileSync(path.join(g.INDEX_DIR, `has-db-${dbHash}.db`), 'x');
    const dbFiles = seedSentinels(dbRoot, 30);

    // Non-sentinel bystanders → untouched and uncounted.
    const daemon = path.join(g.STATUS_DIR, 'trace-mcp-daemon.json');
    fs.writeFileSync(daemon, '{}');
    backdate(daemon, 30);

    const res = prune.sweepOrphanStatusSentinels(1);

    expect(new Set(res.removed)).toEqual(new Set([orphanStatus, orphanAlive, orphanConsulted]));
    expect(res.scannedOrphans).toBe(3 + 3); // old orphan + fresh orphan entries
    expect(res.retainedWithinTtl).toBe(3); // the fresh orphan's three entries
    expect(res.retainedLive).toBe(3 + 3); // live root + has-db root
    for (const f of [orphanStatus, orphanAlive, orphanConsulted]) {
      expect(fs.existsSync(f)).toBe(false);
    }
    for (const f of [...freshFiles, ...liveFiles, ...dbFiles, daemon]) {
      expect(fs.existsSync(f)).toBe(true);
    }

    // Second run is a no-op (fresh orphan still within TTL, live still live).
    const second = prune.sweepOrphanStatusSentinels(1);
    expect(second.removed).toEqual([]);
  });

  it('is a no-op when STATUS_DIR does not exist', () => {
    expect(prune.sweepOrphanStatusSentinels(1)).toEqual({
      removed: [],
      scannedOrphans: 0,
      retainedWithinTtl: 0,
      retainedLive: 0,
    });
  });
});
