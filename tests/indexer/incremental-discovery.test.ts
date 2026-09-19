/**
 * TRA-1576 — incremental discovery fast paths (watcher since-query +
 * git-status) with the full `collectFiles()` walk as fallback.
 *
 * Contract under test: a fast path may OVER-report (noise the pipeline's
 * own gates drop) but must never UNDER-report what it observed — every
 * file the full walk + prefilter would flag as changed must survive
 * discovery. Staleness beyond that (a source that never saw the change)
 * is bounded by the periodic full-walk policy, not eliminated here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import {
  GIT_FAST_PATH_MAX_FILES,
  META_LAST_FULL_MS,
  META_RUNS_SINCE_FULL,
  discoverIncrementalFiles,
  intersectWithInclude,
  parseGitStatusPorcelainZ,
  queryGitStatus,
  shouldForceFullWalk,
  snapshotPathForDb,
  toRelPosix,
} from '../../src/indexer/incremental-discovery.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const INCLUDE = ['src/**/*.ts'];

function makePipeline(tmpRoot: string) {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const config: TraceMcpConfig = {
    root: tmpRoot,
    include: INCLUDE,
    exclude: [],
    plugins: [],
  };
  const pipeline = new IndexingPipeline(store, registry, config, tmpRoot, undefined, {
    incrementalDiscovery: {
      snapshotPath: null,
      discover: async () => ({ source: 'full-walk', changed: [], deleted: [] }),
    },
  });
  return { store, pipeline };
}

function write(tmpRoot: string, rel: string, content: string): string {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** Deterministic PRNG (mulberry32) so the property round is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('parseGitStatusPorcelainZ', () => {
  it('parses modifies, renames, deletes and untracked', () => {
    const out = 'M  src/a.ts\0 M src/b.ts\0D  src/gone.ts\0 D src/gone2.ts\0?? src/fresh.ts\0';
    const { changed, deleted } = parseGitStatusPorcelainZ(out);
    expect(changed.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/fresh.ts'].sort());
    expect(deleted.sort()).toEqual(['src/gone.ts', 'src/gone2.ts'].sort());
  });

  it('parses real -z rename records (R new NUL old, no arrow)', () => {
    // Byte-exact shape of `git status --porcelain=v1 -z` after `git mv`:
    // the orig path follows as a bare NUL-separated record. Verified
    // against a live repo (TRA-1576 review): the arrow form below never
    // appears in -z output.
    const out = 'R  src/new.ts\0src/old.ts\0';
    const { changed, deleted } = parseGitStatusPorcelainZ(out);
    expect(changed).toEqual(['src/new.ts']);
    expect(deleted).toEqual(['src/old.ts']);
  });

  it('keeps the arrow form as a defensive fallback (both sides recorded)', () => {
    const out = 'R  src/old.ts -> src/new.ts\0';
    const { changed, deleted } = parseGitStatusPorcelainZ(out);
    expect(changed).toEqual(['src/new.ts']);
    expect(deleted).toEqual(['src/old.ts']);
  });

  it('drops bare records that lost their rename parent instead of mangling them', () => {
    const out = 'M  src/a.ts\0src/orphan.ts\0';
    const { changed, deleted } = parseGitStatusPorcelainZ(out);
    expect(changed).toEqual(['src/a.ts']);
    expect(deleted).toEqual([]);
  });

  it('handles spaces in names (NUL-separated, no quoting)', () => {
    const out = ' M src/my file.ts\0?? src/other dir/n space.ts\0';
    const { changed, deleted } = parseGitStatusPorcelainZ(out);
    expect(changed.sort()).toEqual(['src/my file.ts', 'src/other dir/n space.ts'].sort());
    expect(deleted).toEqual([]);
  });

  it('empty output means clean tree', () => {
    expect(parseGitStatusPorcelainZ('')).toEqual({ changed: [], deleted: [] });
  });
});

describe('queryGitStatus', () => {
  it('returns null over the cap (bulk change → walk)', () => {
    const files = Array.from({ length: GIT_FAST_PATH_MAX_FILES + 1 }, (_, i) => ` M f${i}.ts`);
    const res = queryGitStatus('/nonexistent', GIT_FAST_PATH_MAX_FILES, () => files.join('\0'));
    expect(res).toBeNull();
  });

  it('returns null when git fails (non-repo)', () => {
    const res = queryGitStatus('/nonexistent', GIT_FAST_PATH_MAX_FILES, () => {
      throw new Error('not a git repository');
    });
    expect(res).toBeNull();
  });
});

describe('intersectWithInclude / toRelPosix / snapshotPathForDb / shouldForceFullWalk', () => {
  it('include gate drops non-matching paths and dedups', () => {
    expect(
      intersectWithInclude(['src/a.ts', 'notes.md', 'src/a.ts', 'build/out.js'], INCLUDE),
    ).toEqual(['src/a.ts']);
  });

  it('toRelPosix rejects escapes and absolute outsiders', () => {
    const root = path.join(os.tmpdir(), 'trace-mcp-rel-xyz');
    expect(toRelPosix(root, path.join(root, 'src/a.ts'))).toBe('src/a.ts');
    expect(toRelPosix(root, '../evil.ts')).toBeNull();
    expect(toRelPosix(root, '/etc/passwd')).toBeNull();
  });

  it('snapshot sits next to the DB, never in the tree', () => {
    expect(snapshotPathForDb('/home/u/.trace/index/proj-abc.db')).toBe(
      '/home/u/.trace/index/proj-abc.db.watcher-snapshot',
    );
  });

  it('forces a verifying walk every N runs, on age, or when never walked', () => {
    expect(shouldForceFullWalk({ runsSinceFull: 10, lastFullMs: Date.now() })).toBe(true);
    expect(shouldForceFullWalk({ runsSinceFull: 9, lastFullMs: Date.now() })).toBe(false);
    expect(
      shouldForceFullWalk({ runsSinceFull: 0, lastFullMs: Date.now() - 25 * 3600 * 1000 }),
    ).toBe(true);
    expect(shouldForceFullWalk({ runsSinceFull: 0, lastFullMs: null })).toBe(true);
  });
});

describe('discoverIncrementalFiles orchestration', () => {
  const root = path.join(os.tmpdir(), 'trace-mcp-discover-xyz');

  it('prefers watcher-since, filters noise, passes deletes through', async () => {
    const res = await discoverIncrementalFiles({
      rootPath: root,
      snapshotPath: '/snap',
      include: INCLUDE,
      queryWatcher: async () => ({
        changedAbs: [
          path.join(root, 'src/a.ts'),
          path.join(root, 'notes.md'),
          '/elsewhere/b.ts',
          path.join(root, '..', 'escape.ts'),
        ],
        deletedAbs: [path.join(root, 'src/old.ts')],
      }),
      queryGit: () => {
        throw new Error('must not reach git when watcher answers');
      },
    });
    expect(res.source).toBe('watcher-since');
    expect(res.changed).toEqual(['src/a.ts']);
    expect(res.deleted).toEqual(['src/old.ts']);
  });

  it('falls back to git-status when the snapshot is missing', async () => {
    const res = await discoverIncrementalFiles({
      rootPath: root,
      snapshotPath: null,
      include: INCLUDE,
      queryWatcher: async () => null,
      queryGit: () => ({ changed: ['src/a.ts', 'README.md'], deleted: [] }),
    });
    expect(res.source).toBe('git-status');
    expect(res.changed).toEqual(['src/a.ts']);
  });

  it('a throwing source degrades to full-walk, never partial', async () => {
    const res = await discoverIncrementalFiles({
      rootPath: root,
      snapshotPath: '/snap',
      include: INCLUDE,
      queryWatcher: async () => {
        throw new Error('FSEvents truncated');
      },
      queryGit: () => null,
    });
    expect(res).toEqual({ source: 'full-walk', changed: [], deleted: [] });
  });
});

describe('property: fast path never misses what the walk+prefilter flags', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-disc-prop-'));
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('randomized rounds: oracle-changed ⊆ discovery.changed, oracle-deleted ⊆ discovery.deleted', async () => {
    const { selectChangedFiles } = await import('../../src/indexer/change-prefilter.js');
    const { collectFiles } = await import('../../src/indexer/file-collector.js');

    let roundsWithChanges = 0;
    for (let round = 0; round < 30; round++) {
      if (await runRound(round)) roundsWithChanges++;
    }
    // Sanity: the rounds actually exercised changes (or the property is vacuous).
    expect(roundsWithChanges).toBeGreaterThan(15);
    return;

    async function runRound(round: number): Promise<boolean> {
      const rand = rng(0x9e3779b9 ^ round);
      const dir = fs.mkdtempSync(path.join(tmpRoot, `r${round}-`));
      const names = Array.from({ length: 6 + Math.floor(rand() * 8) }, (_, i) => `src/f${i}.ts`);
      for (const n of names) write(dir, n, `export const v = ${Math.floor(rand() * 1e6)};\n`);
      // A non-indexable file that must never leak into `changed`.
      write(dir, 'notes.md', '# notes\n');

      const walked = (
        await collectFiles({
          config: { include: INCLUDE, exclude: [] } as TraceMcpConfig,
          rootPath: dir,
          workspaces: [],
          traceignore: undefined,
          gitignore: undefined,
          maxFiles: 10_000,
        })
      ).files;
      // Fake "stored rows" with the real mtimes/sizes of the just-written files.
      const existing = new Map(
        walked.map((rel) => {
          const st = fs.statSync(path.join(dir, rel));
          return [
            rel,
            {
              id: 1,
              path: rel,
              mtime_ms: Math.floor(st.mtimeMs),
              byte_length: st.size,
            } as never,
          ];
        }),
      );

      // Random mutations: modify / delete / create / rename.
      const changedAbs: string[] = [];
      const deletedAbs: string[] = [];
      const oracleChanged = new Set<string>();
      const oracleDeleted = new Set<string>();
      for (const rel of [...walked]) {
        const r = rand();
        const abs = path.join(dir, rel);
        if (r < 0.3) {
          fs.appendFileSync(abs, `// round ${round}\n`);
          // Bump mtime past the ms floor so the oracle sees the drift.
          const t = new Date(Date.now() + 5000);
          fs.utimesSync(abs, t, t);
          changedAbs.push(abs);
          oracleChanged.add(rel);
        } else if (r < 0.4) {
          fs.rmSync(abs);
          deletedAbs.push(abs);
          oracleDeleted.add(rel);
        } else if (r < 0.45) {
          const target = path.join(dir, `${rel}.renamed.ts`);
          fs.renameSync(abs, target);
          deletedAbs.push(abs);
          changedAbs.push(target);
          oracleDeleted.add(rel);
          oracleChanged.add(`${rel}.renamed.ts`);
        }
      }
      if (rand() < 0.7) {
        const fresh = `src/new-${round}.ts`;
        write(dir, fresh, 'export const n = 1;\n');
        changedAbs.push(path.join(dir, fresh));
        oracleChanged.add(fresh);
      }
      // Noise the source must survive: ignored/out-of-include/foreign paths.
      changedAbs.push(path.join(dir, 'notes.md'));
      changedAbs.push('/elsewhere/outside.ts');

      const res = await discoverIncrementalFiles({
        rootPath: dir,
        snapshotPath: '/snap',
        include: INCLUDE,
        queryWatcher: async () => ({ changedAbs: [...changedAbs], deletedAbs: [...deletedAbs] }),
        queryGit: () => null,
      });
      expect(res.source).toBe('watcher-since');

      // Oracle = what the downstream consumer (prefilter over the full walk)
      // would flag: re-walk, then split against drifted stored rows. New and
      // renamed-target files have no stored row → candidates by definition.
      const rewalked = (
        await collectFiles({
          config: { include: INCLUDE, exclude: [] } as TraceMcpConfig,
          rootPath: dir,
          workspaces: [],
          traceignore: undefined,
          gitignore: undefined,
          maxFiles: 10_000,
        })
      ).files;
      const { candidates } = selectChangedFiles(dir, rewalked, existing, false);
      for (const c of candidates) {
        expect(res.changed).toContain(c);
      }
      for (const d of oracleDeleted) {
        // Renamed-away sources and deleted files no longer walk: they must
        // arrive via the delete channel (deleteFiles no-ops unknown rows).
        if (!rewalked.includes(d)) expect(res.deleted).toContain(d);
      }
      // Precision: nothing out-of-include / out-of-root leaks through.
      for (const c of res.changed) {
        expect(c.endsWith('.ts')).toBe(true);
        expect(c.startsWith('src/')).toBe(true);
      }

      fs.rmSync(dir, { recursive: true, force: true });
      return oracleChanged.size > 0 || oracleDeleted.size > 0;
    }
  });
});

describe('pipeline indexAll fast path', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-disc-pipe-'));
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makePipelineWithDiscover(
    discover: (
      args: never,
    ) => Promise<{ source: 'watcher-since'; changed: string[]; deleted: string[] }>,
  ) {
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config: TraceMcpConfig = {
      root: tmpRoot,
      include: INCLUDE,
      exclude: [],
      plugins: [],
    };
    let calls = 0;
    const pipeline = new IndexingPipeline(store, registry, config, tmpRoot, undefined, {
      incrementalDiscovery: {
        snapshotPath: null,
        discover: (async (args: never) => {
          calls++;
          return discover(args);
        }) as never,
      },
    });
    return { store, pipeline, calls: () => calls };
  }

  it('1-file change via fast path indexes exactly 1 and skips the walk', async () => {
    const { store, pipeline, calls } = makePipelineWithDiscover(async () => ({
      source: 'watcher-since',
      changed: [],
      deleted: [],
    }));
    write(tmpRoot, 'src/a.ts', 'export const a = 1;\n');
    write(tmpRoot, 'src/b.ts', 'export const b = 2;\n');
    const cold = await pipeline.indexAll(false);
    expect(cold.indexed).toBe(2);
    expect(calls()).toBe(0); // from-scratch always walks

    // Second run: source reports nothing → zero-change early return.
    const zero = await pipeline.indexAll(false);
    expect(calls()).toBe(1);
    expect(zero.totalFiles).toBe(0);
    expect(zero.indexed).toBe(0);

    // Third run: source reports the touched file only.
    (pipeline as unknown as { _incrementalDiscovery: unknown })._incrementalDiscovery = {
      snapshotPath: null,
      discover: async () => {
        return { source: 'watcher-since', changed: ['src/b.ts'], deleted: [] };
      },
    };
    const abs = path.join(tmpRoot, 'src/b.ts');
    fs.appendFileSync(abs, 'export const extra = 1;\n');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(abs, t, t);
    const inc = await pipeline.indexAll(false);
    expect(inc.indexed).toBe(1);
    expect(store.getRepoMetadata(META_RUNS_SINCE_FULL)).toBe('2');
  });

  it('deletes via fast path drop rows without a walk', async () => {
    const deleted = ['src/b.ts'];
    const { pipeline, calls } = makePipelineWithDiscover(async () => ({
      source: 'git-status' as const,
      changed: [],
      deleted: [...deleted],
    }));
    write(tmpRoot, 'src/a.ts', 'export const a = 1;\n');
    write(tmpRoot, 'src/b.ts', 'export const b = 2;\n');
    await pipeline.indexAll(false);
    expect(calls()).toBe(0);
    const r = await pipeline.indexAll(false);
    expect(calls()).toBe(1);
    expect(r.errors).toBe(0);
  });

  it('force, full-walk opt, and due verification all bypass discovery', async () => {
    let calls = 0;
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config: TraceMcpConfig = {
      root: tmpRoot,
      include: INCLUDE,
      exclude: [],
      plugins: [],
    };
    const pipeline = new IndexingPipeline(store, registry, config, tmpRoot, undefined, {
      incrementalDiscovery: {
        snapshotPath: null,
        discover: (async () => {
          calls++;
          return { source: 'watcher-since', changed: [], deleted: [] };
        }) as never,
      },
    });
    write(tmpRoot, 'src/a.ts', 'export const a = 1;\n');
    await pipeline.indexAll(false);
    const afterCold = calls;

    await pipeline.indexAll(true);
    expect(calls).toBe(afterCold); // force walks

    await pipeline.indexAll(false, { discovery: 'full-walk' });
    expect(calls).toBe(afterCold); // explicit full walk

    store.setRepoMetadata(META_RUNS_SINCE_FULL, '10');
    store.setRepoMetadata(META_LAST_FULL_MS, String(Date.now()));
    await pipeline.indexAll(false);
    expect(calls).toBe(afterCold); // periodic verification walks
    expect(store.getRepoMetadata(META_RUNS_SINCE_FULL)).toBe('0');
    expect(store.getRepoMetadata(META_LAST_FULL_MS)).not.toBeNull();
  });

  it('empty watcher answer with dirty git falls back to git lists (snapshot race)', async () => {
    // The bench caught this: a snapshot write that lands after a touch
    // makes the next since-query report empty while the tree is dirty.
    // The pipeline must not take the zero-change miss — git disagrees.
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config: TraceMcpConfig = {
      root: tmpRoot,
      include: INCLUDE,
      exclude: [],
      plugins: [],
    };
    const pipeline = new IndexingPipeline(store, registry, config, tmpRoot, undefined, {
      incrementalDiscovery: {
        snapshotPath: null,
        discover: (async () => ({ source: 'watcher-since', changed: [], deleted: [] })) as never,
        queryGit: () => ({ changed: ['src/a.ts'], deleted: [] }),
      },
    });
    const abs = write(tmpRoot, 'src/a.ts', 'export const a = 1;\n');
    await pipeline.indexAll(false);
    fs.appendFileSync(abs, 'export const extra = 1;\n');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(abs, t, t);
    const r = await pipeline.indexAll(false);
    expect(r.indexed).toBe(1);
    expect(r.totalFiles).toBe(1);
  });

  it('empty watcher answer with clean/absent git stays zero-change', async () => {
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config: TraceMcpConfig = {
      root: tmpRoot,
      include: INCLUDE,
      exclude: [],
      plugins: [],
    };
    const pipeline = new IndexingPipeline(store, registry, config, tmpRoot, undefined, {
      incrementalDiscovery: {
        snapshotPath: null,
        discover: (async () => ({ source: 'watcher-since', changed: [], deleted: [] })) as never,
        queryGit: () => ({ changed: [], deleted: [] }),
      },
    });
    write(tmpRoot, 'src/a.ts', 'export const a = 1;\n');
    await pipeline.indexAll(false);
    const r = await pipeline.indexAll(false);
    expect(r.totalFiles).toBe(0);
    expect(r.indexed).toBe(0);
  });
});
