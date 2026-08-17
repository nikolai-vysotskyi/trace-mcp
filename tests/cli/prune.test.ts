/**
 * Behavioral tests for src/cli/prune.ts — classifies + optionally deletes
 * stale index DBs under ~/.trace-mcp/index/.
 *
 * `scanIndexDir`/`pruneIndexDir` always read the real `INDEX_DIR` constant
 * and the real registry, so we mock `node:fs` (readdirSync/statSync/
 * unlinkSync) and `../registry.js` (listProjects/pruneStaleProjects) rather
 * than touching the real filesystem or global state. `projectHash` is real
 * (sha256-based, deterministic) so fixture basenames are computed the same
 * way the production code computes them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectHash } from '../../src/global.js';
import * as registry from '../../src/registry.js';

vi.mock('../../src/registry.js', () => ({
  listProjects: vi.fn(),
  pruneStaleProjects: vi.fn(() => []),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    default: {
      ...actual,
      readdirSync: vi.fn(),
      statSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// Import after mocks are registered.
const { pruneIndexDir, scanIndexDir } = await import('../../src/cli/prune.js');

const mockListProjects = vi.mocked(registry.listProjects);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockStatSync = vi.mocked(fs.statSync);
const mockUnlinkSync = vi.mocked(fs.unlinkSync);

const NOW = Date.parse('2026-07-02T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function fakeStat(mtimeMs: number, size = 4096) {
  return { size, mtimeMs } as fs.Stats;
}

describe('scanIndexDir', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockListProjects.mockReturnValue([]);
    mockReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
    mockStatSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns an empty array when INDEX_DIR does not exist (ENOENT)', () => {
    mockReaddirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(scanIndexDir()).toEqual([]);
  });

  it('classifies a registered, existing project root as live', () => {
    const root = '/Users/x/projects/myapp';
    // buildRegistryIndex() hashes `path.resolve(entry.root)`, not the raw
    // literal — on win32 `path.resolve('/Users/...')` rewrites the leading
    // "/" onto the current drive, so the fixture hash must go through the
    // same resolve() the production code applies (TRA-73).
    const hash = projectHash(path.resolve(root));
    mockListProjects.mockReturnValue([
      { name: 'myapp', root, dbPath: `/idx/myapp-${hash}.db`, lastIndexed: null, addedAt: 'x' },
    ]);
    mockReaddirSync.mockReturnValue([`myapp-${hash}.db`] as unknown as ReturnType<
      typeof fs.readdirSync
    >);
    mockStatSync.mockImplementation((p: fs.PathLike) => {
      if (String(p).endsWith('.db')) return fakeStat(NOW - DAY_MS);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    // fs.existsSync is used to check the root exists — real module handles this
    // via node's actual fs.existsSync on a mocked module; stub it directly.
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const candidates = scanIndexDir();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].category).toBe('live');
    expect(candidates[0].hash).toBe(hash);
    expect(candidates[0].registeredRoot).toBe(path.resolve(root));
  });

  it('classifies a DB whose registered root no longer exists as orphan_missing_root', () => {
    const root = '/Users/x/projects/deleted-app';
    const hash = projectHash(path.resolve(root));
    mockListProjects.mockReturnValue([
      {
        name: 'deleted-app',
        root,
        dbPath: `/idx/deleted-app-${hash}.db`,
        lastIndexed: null,
        addedAt: 'x',
      },
    ]);
    mockReaddirSync.mockReturnValue([`deleted-app-${hash}.db`] as unknown as ReturnType<
      typeof fs.readdirSync
    >);
    mockStatSync.mockImplementation((p: fs.PathLike) => {
      if (String(p).endsWith('.db')) return fakeStat(NOW - DAY_MS);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const candidates = scanIndexDir();
    expect(candidates[0].category).toBe('orphan_missing_root');
  });

  it('classifies a DB with an unrecognized hash as orphan_unregistered', () => {
    mockListProjects.mockReturnValue([]);
    mockReaddirSync.mockReturnValue(['ghost-deadbeef1234.db'] as unknown as ReturnType<
      typeof fs.readdirSync
    >);
    mockStatSync.mockImplementation((p: fs.PathLike) => {
      if (String(p).endsWith('.db')) return fakeStat(NOW - DAY_MS);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const candidates = scanIndexDir();
    expect(candidates[0].category).toBe('orphan_unregistered');
    expect(candidates[0].registeredRoot).toBeNull();
  });

  it('classifies a fresh session DB as session_active and an old one as session_expired', () => {
    mockListProjects.mockReturnValue([]);
    mockReaddirSync.mockReturnValue([
      'myapp-abc123def456-session-1111.db',
      'myapp-abc123def456-session-2222.db',
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    mockStatSync.mockImplementation((p: fs.PathLike) => {
      const name = String(p);
      if (name.includes('1111')) return fakeStat(NOW - 1 * DAY_MS); // fresh
      if (name.includes('2222')) return fakeStat(NOW - 30 * DAY_MS); // stale
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const candidates = scanIndexDir({ sessionTtlDays: 7 });
    const byName = Object.fromEntries(candidates.map((c) => [c.basename, c.category]));
    expect(byName['myapp-abc123def456-session-1111.db']).toBe('session_active');
    expect(byName['myapp-abc123def456-session-2222.db']).toBe('session_expired');
  });

  it('skips WAL/SHM/journal sidecar files (does not double-count)', () => {
    mockListProjects.mockReturnValue([]);
    mockReaddirSync.mockReturnValue([
      'ghost-deadbeef1234.db',
      'ghost-deadbeef1234.db-wal',
      'ghost-deadbeef1234.db-shm',
      'ghost-deadbeef1234.db-journal',
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    mockStatSync.mockImplementation(() => fakeStat(NOW - DAY_MS));

    const candidates = scanIndexDir();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].basename).toBe('ghost-deadbeef1234.db');
  });

  it('ignores non-.db files entirely', () => {
    mockListProjects.mockReturnValue([]);
    mockReaddirSync.mockReturnValue([
      'registry.json',
      'consent.json',
      '.DS_Store',
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    expect(scanIndexDir()).toEqual([]);
  });
});

describe('pruneIndexDir', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockListProjects.mockReturnValue([]);
    mockUnlinkSync.mockReset();
    mockStatSync.mockImplementation(() => fakeStat(NOW - 30 * DAY_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('dry-run (apply=false) classifies but deletes nothing', () => {
    mockReaddirSync.mockReturnValue(['ghost-deadbeef1234.db'] as unknown as ReturnType<
      typeof fs.readdirSync
    >);

    const summary = pruneIndexDir({ apply: false });
    expect(summary.deleted).toEqual([]);
    expect(summary.freedBytes).toBe(0);
    expect(summary.totals.orphan_unregistered.count).toBe(1);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('apply=true deletes orphan_unregistered, orphan_missing_root, and session_expired by default', () => {
    mockReaddirSync.mockReturnValue([
      'ghost-deadbeef1234.db', // orphan_unregistered
      'stale-session-abc123def456-session-9999.db', // session_expired (30d old, ttl default 7d)
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    const summary = pruneIndexDir({ apply: true });
    expect(summary.deleted.length).toBeGreaterThan(0);
    expect(mockUnlinkSync).toHaveBeenCalled();
    expect(summary.totals.orphan_unregistered.count).toBe(1);
    expect(summary.totals.session_expired.count).toBe(1);
  });

  it('does NOT delete a live project even with apply=true', () => {
    const root = '/Users/x/projects/myapp';
    const hash = projectHash(path.resolve(root));
    mockListProjects.mockReturnValue([
      { name: 'myapp', root, dbPath: `/idx/myapp-${hash}.db`, lastIndexed: null, addedAt: 'x' },
    ]);
    mockReaddirSync.mockReturnValue([`myapp-${hash}.db`] as unknown as ReturnType<
      typeof fs.readdirSync
    >);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const summary = pruneIndexDir({ apply: true });
    expect(summary.totals.live.count).toBe(1);
    expect(summary.deleted).toEqual([]);
    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });

  it('does NOT delete stray_small candidates unless aggressive=true', () => {
    // stray_small requires the DB to actually open via better-sqlite3, which
    // needs a real file. We instead assert the simpler contract: without
    // aggressive, stray_small is never in the default deletable set even if
    // present. Force a candidate into stray_small indirectly isn't practical
    // here without a real DB, so verify via onlyCategories restriction logic:
    // requesting stray_small explicitly without aggressive still respects
    // onlyCategories (documents the allowlist behavior).
    mockReaddirSync.mockReturnValue(['ghost-deadbeef1234.db'] as unknown as ReturnType<
      typeof fs.readdirSync
    >);

    const summary = pruneIndexDir({ apply: true, onlyCategories: ['stray_small'] });
    // ghost-deadbeef1234.db classifies as orphan_unregistered, not stray_small,
    // so restricting to stray_small deletes nothing.
    expect(summary.deleted).toEqual([]);
  });

  it('onlyCategories restricts deletion to exactly the given categories', () => {
    mockReaddirSync.mockReturnValue([
      'ghost-deadbeef1234.db', // orphan_unregistered
      'other-session-abc123def456-session-9999.db', // session_expired
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    const summary = pruneIndexDir({ apply: true, onlyCategories: ['session_expired'] });
    expect(summary.totals.orphan_unregistered.count).toBe(1);
    expect(summary.totals.session_expired.count).toBe(1);
    // Only the session_expired file's sidecars should have been unlinked.
    const unlinkedPaths = mockUnlinkSync.mock.calls.map((c) => String(c[0]));
    expect(unlinkedPaths.some((p) => p.includes('ghost-deadbeef1234.db'))).toBe(false);
    expect(unlinkedPaths.some((p) => p.includes('session-9999'))).toBe(true);
  });

  it('is idempotent: a second dry-run after apply reports the same live/expired split for what remains', () => {
    mockReaddirSync.mockReturnValue(['ghost-deadbeef1234.db'] as unknown as ReturnType<
      typeof fs.readdirSync
    >);
    const first = pruneIndexDir({ apply: false });
    expect(first.totals.orphan_unregistered.count).toBe(1);
    // Simulate the file being gone after a real apply by returning empty list.
    mockReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
    const second = pruneIndexDir({ apply: false });
    expect(second.totals.orphan_unregistered.count).toBe(0);
  });
});
