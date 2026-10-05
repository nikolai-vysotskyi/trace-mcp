/**
 * Branch index for linked worktrees (GH #1481, step 2).
 *
 * A real main checkout with a linked worktree, a real file-backed canonical
 * index, and the daemon's WorktreeIndexManager. The worktree renames a
 * function (and its caller), deletes a file and adds an untracked one; tool
 * calls go through a real MCP session over an in-memory transport, created
 * against the canonical index exactly as the daemon creates a routed
 * worktree session.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TraceMcpConfig, TraceMcpConfigSchema } from '../../src/config.js';
import {
  BranchIndex,
  DEFAULT_WORKTREE_INDEX_SETTINGS,
  resolveWorktreeIndexSettings,
  WorktreeIndexManager,
  type WorktreeIndexManagerDeps,
  type WorktreeIndexSettings,
} from '../../src/daemon/worktree-index.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { beginReindex } from '../../src/indexer/reindex-inflight.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { ProgressState } from '../../src/progress.js';
import { createServer } from '../../src/server/server.js';
import { clearWorktreeDeltaCache } from '../../src/worktree-delta.js';

type Json = Record<string, unknown>;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf-8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

/** Content digest of what the canonical index holds — must not move. */
function digest(db: Database.Database): string {
  const files = db.prepare('SELECT path, content_hash FROM files ORDER BY path').all();
  const symbols = db.prepare('SELECT symbol_id FROM symbols ORDER BY symbol_id').all();
  const edges = db.prepare('SELECT COUNT(*) AS n FROM edges').get();
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ files, symbols, edges }))
    .digest('hex');
}

const flagged = (value: unknown, out: string[] = []): string[] => {
  if (Array.isArray(value)) for (const v of value) flagged(v, out);
  else if (value && typeof value === 'object') {
    const o = value as Json;
    if (o.stale_on_branch === true) out.push(String(o.file ?? o.path ?? o.file_path));
    for (const v of Object.values(o)) flagged(v, out);
  }
  return out;
};

describe.skipIf(process.platform === 'win32')('worktree branch index', () => {
  let tmp: string;
  let main: string;
  let wt: string;
  let snapshotsDir: string;
  let config: TraceMcpConfig;
  let canonical: {
    root: string;
    db: Database.Database;
    store: Store;
    config: TraceMcpConfig;
    status: 'ready';
    pipeline: IndexingPipeline;
  };
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(async () => {
    clearWorktreeDeltaCache();
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-wt-index-')));
    main = path.join(tmp, 'main');
    wt = path.join(tmp, 'wt');
    snapshotsDir = path.join(tmp, 'snapshots');
    fs.mkdirSync(main, { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    write(main, 'src/lib.ts', 'export function oldName(): number {\n  return 1;\n}\n');
    write(
      main,
      'src/use.ts',
      "import { oldName } from './lib';\n\nexport function caller(): number {\n  return oldName();\n}\n",
    );
    write(main, 'src/gone.ts', 'export function goneFn(): number {\n  return 3;\n}\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);

    // The branch: rename oldName → newName (definition and caller), delete
    // gone.ts, add an untracked file.
    write(wt, 'src/lib.ts', 'export function newName(): number {\n  return 1;\n}\n');
    write(
      wt,
      'src/use.ts',
      "import { newName } from './lib';\n\nexport function caller(): number {\n  return newName();\n}\n",
    );
    fs.rmSync(path.join(wt, 'src/gone.ts'));
    write(wt, 'src/added.ts', 'export function addedFn(): number {\n  return 4;\n}\n');

    config = TraceMcpConfigSchema.parse({
      include: ['src/**/*.ts'],
      exclude: [],
      tools: { preset: 'full' },
    });
    const db = initializeDatabase(path.join(tmp, 'canonical.db'));
    const store = new Store(db);
    const pipeline = new IndexingPipeline(
      store,
      PluginRegistry.createWithDefaults(),
      config,
      main,
      new ProgressState(db),
    );
    await pipeline.indexAll();
    canonical = { root: main, db, store, config, status: 'ready', pipeline };
    cleanups.push(async () => {
      await pipeline.dispose();
      db.close();
    });
  });

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function manager(
    over: Partial<WorktreeIndexSettings> = {},
    deps: Partial<WorktreeIndexManagerDeps> = {},
  ): WorktreeIndexManager {
    const m = new WorktreeIndexManager({
      ...deps,
      settings: {
        ...DEFAULT_WORKTREE_INDEX_SETTINGS,
        enabled: true,
        initialWaitMs: 30_000,
        ...over,
      },
      getCanonical: (root) => (path.resolve(root) === main ? canonical : undefined),
      dir: snapshotsDir,
      version: 'test',
    });
    cleanups.push(() => m.shutdown());
    return m;
  }

  /** A session created against the canonical index, as the daemon does. */
  /** `hint: null` is a main-checkout session (no `?worktree=` hint). */
  async function session(m: WorktreeIndexManager | null, hint: string | null = wt) {
    const worktreeHint = hint ?? undefined;
    const handle = createServer(
      canonical.store,
      PluginRegistry.createWithDefaults(),
      config,
      main,
      new ProgressState(canonical.db),
      {
        worktreeRoot: worktreeHint,
        worktreeIndex: m?.routeFor(main, worktreeHint) ?? undefined,
        serveFullSurface: true,
        skipUsagePing: true,
      },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'worktree-index-probe', version: '1.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close().catch(() => {});
      handle.dispose();
    });
    let n = 0;
    return async (name: string, args: Json = {}): Promise<{ text: string; json: Json }> => {
      // Distinct args per call: identical repeats are deduplicated by the journal.
      const res = (await client.callTool({
        name,
        arguments: { ...args, ...(name === 'search' ? { offset: 0, limit: 20 + n++ } : {}) },
      })) as { content: Array<{ type: string; text: string }> };
      const text = res.content[0].text;
      let json: Json = {};
      try {
        json = JSON.parse(text) as Json;
      } catch {
        /* non-JSON error text */
      }
      return { text, json };
    };
  }

  const dbFiles = (): string[] =>
    fs.existsSync(snapshotsDir)
      ? fs.readdirSync(snapshotsDir).filter((f) => f.endsWith('.db'))
      : [];

  const names = (json: Json): string[] =>
    ((json.items ?? json.results ?? []) as Array<Json>).map((i) =>
      String((i.symbol as Json | undefined)?.name ?? i.name),
    );

  it('copies without touching the canonical index', async () => {
    const before = digest(canonical.db);
    const m = manager();
    const call = await session(m);
    const { json } = await call('get_index_health');
    expect((json.worktree as Json).served_from).toBe('branch_index');
    expect(digest(canonical.db)).toBe(before);
    expect(canonical.store.getSymbolBySymbolId('src/lib.ts::oldName#function')).toBeTruthy();
    expect(canonical.store.getSymbolBySymbolId('src/lib.ts::newName#function')).toBeFalsy();
    const files = fs.readdirSync(snapshotsDir);
    expect(files.some((f) => f.endsWith('.db'))).toBe(true);
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
  });

  it('answers search, find_usages and get_change_impact for the branch', async () => {
    const m = manager();
    const call = await session(m);

    const renamed = await call('search', { query: 'newName' });
    expect(names(renamed.json)).toContain('newName');
    expect(flagged(renamed.json)).toEqual([]);
    expect(renamed.text).not.toContain('Worktree:');

    const old = await call('search', { query: 'oldName' });
    expect(names(old.json)).not.toContain('oldName');
    const gone = await call('search', { query: 'goneFn' });
    expect(names(gone.json)).not.toContain('goneFn');
    const added = await call('search', { query: 'addedFn' });
    expect(names(added.json)).toContain('addedFn');

    const usages = await call('find_usages', { symbol_id: 'src/lib.ts::newName#function' });
    expect(usages.text).toContain('src/use.ts');

    const impact = await call('get_change_impact', { file_path: 'src/lib.ts' });
    expect(impact.text).toContain('src/use.ts');
    expect(flagged(impact.json)).toEqual([]);

    const missing = await call('find_usages', { symbol_id: 'src/lib.ts::oldName#function' });
    expect(missing.text).not.toContain('src/use.ts');
  });

  it('routes batch sub-calls to the branch index', async () => {
    const m = manager();
    const call = await session(m);
    const res = await call('batch', {
      calls: [
        { tool: 'get_outline', args: { path: 'src/lib.ts' } },
        { tool: 'get_outline', args: { path: 'src/added.ts' } },
      ],
    });
    const results = res.json.batch_results as Array<{ result: Json }>;
    expect(JSON.stringify(results[0].result)).toContain('newName');
    expect(JSON.stringify(results[1].result)).toContain('addedFn');
    expect(flagged(results)).toEqual([]);
  });

  it('leaves a main-checkout session on the canonical index', async () => {
    const m = manager();
    // Warm the branch index first so it exists while main is queried.
    const wtCall = await session(m);
    await wtCall('get_index_health');
    const mainCall = await session(m, null);
    const renamed = await mainCall('search', { query: 'newName' });
    expect(names(renamed.json)).not.toContain('newName');
    const old = await mainCall('search', { query: 'oldName' });
    expect(names(old.json)).toContain('oldName');
    const health = await mainCall('get_index_health');
    expect(health.json).not.toHaveProperty('worktree');
  });

  it('writes reindex-file posts from the worktree into the copy only', async () => {
    const m = manager();
    const call = await session(m);
    await call('get_index_health');
    write(
      wt,
      'src/lib.ts',
      'export function newName(): number {\n  return 1;\n}\nexport function lateFn() {}\n',
    );
    const before = digest(canonical.db);
    const res = await m.reindexFile(wt, path.join(wt, 'src/lib.ts'), { wait: true });
    expect(res).toEqual({ ok: true, relPath: 'src/lib.ts' });
    const late = await call('search', { query: 'lateFn' });
    expect(names(late.json)).toContain('lateFn');
    expect(digest(canonical.db)).toBe(before);
    expect(canonical.store.getSymbolBySymbolId('src/lib.ts::lateFn#function')).toBeFalsy();

    expect(await m.reindexFile(wt, '/etc/passwd')).toMatchObject({ ok: false, status: 400 });
    // Not a worktree: not ours, the caller takes its usual path.
    expect(await m.reindexFile(main, 'src/lib.ts')).toBeNull();
  });

  it('picks up an edit made without the reindex hook on the next call', async () => {
    const m = manager();
    const call = await session(m);
    await call('get_index_health');
    write(
      wt,
      'src/added.ts',
      'export function addedFn(): number {\n  return 4;\n}\nexport function sneaky() {}\n',
    );
    clearWorktreeDeltaCache();
    const res = await call('search', { query: 'sneaky' });
    expect(names(res.json)).toContain('sneaky');
  });

  it('rebuilds when the canonical HEAD moves past the copy', async () => {
    const dropped: string[] = [];
    const m = manager({}, { dropPoolRoot: (root) => dropped.push(root) });
    const call = await session(m);
    await call('get_index_health');
    const first = dbFiles();
    expect(first).toHaveLength(1);

    write(main, 'src/mainonly.ts', 'export function mainOnly() {}\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'main moves');
    await canonical.pipeline.indexFiles(['src/mainonly.ts']);
    clearWorktreeDeltaCache();

    // This call notices the move and keeps serving the old copy meanwhile.
    await call('get_index_health');
    const deadline = Date.now() + 15_000;
    let health: Json = {};
    while (Date.now() < deadline) {
      clearWorktreeDeltaCache();
      health = (await call('get_index_health')).json;
      const bi = (health.worktree as Json | undefined)?.branch_index as Json | undefined;
      if (bi && bi.canonical_head_at_copy === git(main, 'rev-parse', 'HEAD')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const bi = (health.worktree as Json).branch_index as Json;
    expect(bi.canonical_head_at_copy).toBe(git(main, 'rev-parse', 'HEAD'));
    // The old copy is closed and deleted once the new one serves.
    await new Promise((r) => setTimeout(r, 200));
    const now = dbFiles();
    expect(now).toHaveLength(1);
    expect(now[0]).not.toBe(first[0]);
    // Closing the old copy leaves the worktree's shared caches to the new one.
    expect(dropped).toEqual([]);
    // The branch still sees its rename, and now the main-only file (in the
    // delta: the branch does not have it, so it is deleted from the copy).
    const renamed = await call('search', { query: 'newName' });
    expect(names(renamed.json)).toContain('newName');
    const mainOnly = await call('search', { query: 'mainOnly' });
    expect(names(mainOnly.json)).not.toContain('mainOnly');
  });

  it('stamps the copy with what the canonical index indexed, not its git HEAD', async () => {
    const indexedHead = git(main, 'rev-parse', 'HEAD');
    // A pull the canonical watcher has not picked up yet.
    write(main, 'src/mainonly.ts', 'export function mainOnly() {}\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'main moves');
    const gitHead = git(main, 'rev-parse', 'HEAD');
    const m = manager({}, { canonicalQuietWaitMs: 300 });
    const call = await session(m);
    const atCopy = async () => {
      clearWorktreeDeltaCache();
      const health = (await call('get_index_health')).json;
      return ((health.worktree as Json).branch_index as Json).canonical_head_at_copy;
    };
    expect(await atCopy()).toBe(indexedHead);
    // Not a reason to rebuild while the canonical index stays where it is.
    expect(await atCopy()).toBe(indexedHead);
    const first = dbFiles();
    expect(first).toHaveLength(1);
    expect(first[0]).toContain(indexedHead.slice(0, 12));

    // The watcher batch lands: now the copy is behind, and is rebuilt.
    await canonical.pipeline.indexFiles(['src/mainonly.ts']);
    const deadline = Date.now() + 15_000;
    let head: unknown = indexedHead;
    while (Date.now() < deadline && head !== gitHead) {
      head = await atCopy();
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(head).toBe(gitHead);
  });

  it('waits for the canonical index to catch up with its HEAD before copying', async () => {
    write(main, 'src/mainonly.ts', 'export function mainOnly() {}\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'main moves');
    const gitHead = git(main, 'rev-parse', 'HEAD');
    const m = manager();
    const call = await session(m);
    setTimeout(() => void canonical.pipeline.indexFiles(['src/mainonly.ts']), 300);
    const health = (await call('get_index_health')).json;
    expect(((health.worktree as Json).branch_index as Json).canonical_head_at_copy).toBe(gitHead);
  });

  it('keeps syncing the old copy while a rebuild for a moved HEAD is refused', async () => {
    // The branch delta is 4 files; the main-only file below makes it 5.
    const m = manager({ maxDeltaFiles: 4 });
    const call = await session(m);
    await call('get_index_health');
    expect(dbFiles()).toHaveLength(1);

    write(main, 'src/mainonly.ts', 'export function mainOnly() {}\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'main moves');
    await canonical.pipeline.indexFiles(['src/mainonly.ts']);
    clearWorktreeDeltaCache();
    await call('get_index_health'); // notices the move; the rebuild is refused

    write(
      wt,
      'src/added.ts',
      'export function addedFn(): number {\n  return 4;\n}\nexport function afterMove() {}\n',
    );
    clearWorktreeDeltaCache();
    const res = await call('search', { query: 'afterMove' });
    expect(names(res.json)).toContain('afterMove');
    expect(dbFiles()).toHaveLength(1);
  });

  it('reuses the copy after an unload and drops it once the worktree is removed', async () => {
    const m = manager({ idleUnloadMs: 1 });
    const call = await session(m);
    await call('get_index_health');
    await new Promise((r) => setTimeout(r, 5));
    expect(await m.sweepIdle()).toEqual([wt]);
    expect(m.stats().loaded).toBe(0);
    const files = dbFiles();
    expect(files).toHaveLength(1);

    // Reopened from disk on the next call, same file.
    const again = await call('search', { query: 'newName' });
    expect(names(again.json)).toContain('newName');
    expect(dbFiles()).toEqual(files);

    // Still listed by git: GC keeps it.
    expect(await m.gc()).toEqual([]);
    git(main, 'worktree', 'remove', '--force', wt);
    const deleted = await m.gc();
    expect(deleted).toHaveLength(1);
    expect(dbFiles()).toEqual([]);
  });

  it('does not reopen a copy that is still closing', async () => {
    const m = manager({ idleUnloadMs: 1 });
    const call = await session(m);
    await call('get_index_health');
    const entries = (m as unknown as { entries: Map<string, { current: BranchIndex | null }> })
      .entries;
    const old = entries.get(wt)!.current!;
    // Hold the old copy in its close: a re-index pass is still running.
    let release!: () => void;
    Object.assign(old, { chain: new Promise<void>((r) => (release = r)) });
    const statesAtOpen: string[] = [];
    const open = BranchIndex.prototype.open;
    const spy = vi.spyOn(BranchIndex.prototype, 'open').mockImplementation(function (
      this: BranchIndex,
      ...args
    ) {
      statesAtOpen.push(old.state);
      return open.apply(this, args);
    });
    cleanups.push(() => spy.mockRestore());

    await new Promise((r) => setTimeout(r, 5));
    const sweeping = m.sweepIdle();
    const answer = call('search', { query: 'newName' });
    await new Promise((r) => setTimeout(r, 100));
    expect(old.state).toBe('retiring');
    release();
    expect(await sweeping).toEqual([wt]);
    expect(names((await answer).json)).toContain('newName');
    // The file was reopened only once the old connection was closed.
    expect(statesAtOpen).toEqual(['closed']);
    expect(dbFiles()).toHaveLength(1);
  });

  it('replaces a reused copy that no longer opens', async () => {
    const first = manager();
    await (await session(first))('get_index_health');
    await first.shutdown();
    const [corrupt] = dbFiles();
    // Damaged on disk while the daemon was down.
    fs.writeFileSync(path.join(snapshotsDir, corrupt), 'not a database'.repeat(512));
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(path.join(snapshotsDir, corrupt + suffix), { force: true });
    }
    const m = manager();
    const call = await session(m);
    const health = (await call('get_index_health')).json;
    expect((health.worktree as Json).served_from).toBe('branch_index');
    const now = dbFiles();
    expect(now).toHaveLength(1);
    expect(now[0]).not.toBe(corrupt);
  });

  it('drops the copy on request (WorktreeRemove hook)', async () => {
    const m = manager();
    const call = await session(m);
    await call('get_index_health');
    expect(await m.drop(wt)).toBe(1);
    expect(
      fs.readdirSync(snapshotsDir).filter((f) => f.endsWith('.db') || f.endsWith('.json')),
    ).toEqual([]);
  });

  it('starts no copy for a worktree while its copies are being dropped', async () => {
    const m = manager({ initialWaitMs: 0 }, { canonicalQuietWaitMs: 30_000 });
    // Hold the build before its backup step: the canonical index is "busy".
    const release = beginReindex(main);
    cleanups.push(release);
    const call = await session(m);
    expect(m.stats().building).toBe(1);

    const dropping = m.drop(wt);
    // A call arriving meanwhile is answered from the canonical index and
    // must not start a second build the drop would then pull files from.
    const outline = await call('get_outline', { path: 'src/lib.ts' });
    expect(flagged(outline.json)).toContain('src/lib.ts');
    release();
    expect(await dropping).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(m.stats()).toMatchObject({ loaded: 0, building: 0 });
    expect(dbFiles()).toEqual([]);
  });

  it('with the feature off behaves exactly like the canonical worktree session', async () => {
    const m = manager({ enabled: false });
    expect(m.routeFor(main, wt)).toBeNull();
    // Off is also what a daemon without a worktree_index section gets.
    const byDefault = new WorktreeIndexManager({
      settings: resolveWorktreeIndexSettings(undefined, {}),
      getCanonical: () => canonical,
      dir: snapshotsDir,
    });
    expect(byDefault.routeFor(main, wt)).toBeNull();
    const call = await session(m);
    const outline = await call('get_outline', { path: 'src/lib.ts' });
    expect(flagged(outline.json)).toContain('src/lib.ts');
    const renamed = await call('search', { query: 'newName' });
    expect(names(renamed.json)).not.toContain('newName');
    const health = await call('get_index_health');
    expect((health.json.worktree as Json).served_from).toBe('canonical_index');
    expect(fs.existsSync(snapshotsDir)).toBe(false);
    expect(await m.reindexFile(wt, 'src/lib.ts')).toBeNull();
  });

  it('serves the canonical index while the copy is still building', async () => {
    const m = manager({ initialWaitMs: 0 });
    const call = await session(m);
    const outline = await call('get_outline', { path: 'src/lib.ts' });
    // No wait budget: this call is answered from the canonical index, flagged.
    expect(flagged(outline.json)).toContain('src/lib.ts');
  });

  it("counts the initial wait from the session's first call, not from the build start", async () => {
    let clock = Date.now();
    const m = manager({ initialWaitMs: 20_000 }, { now: () => clock });
    // Hold the copy before its backup step: the canonical index is "busy".
    const release = beginReindex(main);
    cleanups.push(release);
    const call = await session(m);
    // The session sat idle for a minute before its first call; the build it
    // started is still running.
    clock += 60_000;
    setTimeout(release, 200);
    const outline = await call('get_outline', { path: 'src/lib.ts' });
    expect(JSON.stringify(outline.json)).toContain('newName');
    expect(flagged(outline.json)).toEqual([]);
  });

  it('refuses a delta above the limit and stays on the canonical index', async () => {
    const m = manager({ maxDeltaFiles: 1 });
    const call = await session(m);
    const renamed = await call('search', { query: 'newName' });
    expect(names(renamed.json)).not.toContain('newName');
    expect(dbFiles()).toEqual([]);
  });
});

describe('resolveWorktreeIndexSettings', () => {
  it('defaults, overrides and the env switch', () => {
    expect(resolveWorktreeIndexSettings(undefined, {})).toEqual(DEFAULT_WORKTREE_INDEX_SETTINGS);
    // Opt-in: off unless the config or the env turns it on.
    expect(DEFAULT_WORKTREE_INDEX_SETTINGS.enabled).toBe(false);
    expect(resolveWorktreeIndexSettings({}, {}).enabled).toBe(false);
    expect(resolveWorktreeIndexSettings({}, { TRACE_MCP_WORKTREE_INDEX: '1' }).enabled).toBe(true);
    // The defaults are the config schema's, not a second copy.
    const schemaDefaults = TraceMcpConfigSchema.parse({ worktree_index: {} }).worktree_index!;
    expect(DEFAULT_WORKTREE_INDEX_SETTINGS.initialWaitMs).toBe(schemaDefaults.initial_wait_ms);
    expect(DEFAULT_WORKTREE_INDEX_SETTINGS.enabled).toBe(schemaDefaults.enabled);
    expect(DEFAULT_WORKTREE_INDEX_SETTINGS.maxDiskBytes).toBe(
      schemaDefaults.max_disk_mb * 1024 * 1024,
    );
    const s = resolveWorktreeIndexSettings(
      { enabled: true, idle_unload_minutes: 5, max_disk_mb: 100, max_loaded: 0 },
      {},
    );
    expect(s.idleUnloadMs).toBe(5 * 60_000);
    expect(s.maxDiskBytes).toBe(100 * 1024 * 1024);
    // Out of range falls back to the default.
    expect(s.maxLoaded).toBe(DEFAULT_WORKTREE_INDEX_SETTINGS.maxLoaded);
    // Bounds and types are the config schema's: a fraction where it wants an
    // integer is invalid too, and only that key falls back.
    const fractional = resolveWorktreeIndexSettings(
      { initial_wait_ms: 1500.5, max_loaded: 2.5, max_snapshots: 4 },
      {},
    );
    expect(fractional.initialWaitMs).toBe(DEFAULT_WORKTREE_INDEX_SETTINGS.initialWaitMs);
    expect(fractional.maxLoaded).toBe(DEFAULT_WORKTREE_INDEX_SETTINGS.maxLoaded);
    expect(fractional.maxSnapshots).toBe(4);
    expect(resolveWorktreeIndexSettings('nonsense', {})).toEqual(DEFAULT_WORKTREE_INDEX_SETTINGS);
    expect(
      resolveWorktreeIndexSettings({ enabled: true }, { TRACE_MCP_WORKTREE_INDEX: '0' }).enabled,
    ).toBe(false);
    expect(
      resolveWorktreeIndexSettings({ enabled: false }, { TRACE_MCP_WORKTREE_INDEX: 'on' }).enabled,
    ).toBe(true);
  });
});
