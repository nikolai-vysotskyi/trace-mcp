/**
 * Branch index for linked git worktrees (GH #1481, step 2).
 *
 * A linked worktree is served from its main checkout's index, so callers,
 * usages and change impact across the files the branch touched come from the
 * main version. Answering "overlay first, canonical otherwise" per query would
 * mean touching most of the data layer, and it would still miss edges from an
 * unchanged file to a symbol the branch renamed (those live in the canonical
 * DB). Instead, per live worktree:
 *
 *  1. Copy the canonical DB with SQLite's online backup API, driven through the
 *     canonical project's own connection: incremental (a few MB per event loop
 *     turn), a read transaction per step only, never blocks the canonical
 *     writer, picks up WAL content, and writes made by that connection during
 *     the copy are carried into it instead of restarting it.
 *  2. Re-index the worktree delta (`worktree-delta.ts`: modified + untracked,
 *     deleted removed) into the copy with an ordinary incremental pipeline
 *     rooted at the worktree — the same `indexFiles` path a watcher batch takes,
 *     edge resolution and the deferred reconcile included.
 *  3. Host the copy in a tool-only server (`createServer({ toolHost })`). A
 *     worktree session keeps its canonical server for everything it owns
 *     (journal, savings, session state) and dispatches index tools to the copy
 *     once it is ready (`WorktreeIndexRoute`).
 *
 * No file watcher: each routed call re-checks the delta (cached two seconds by
 * `getWorktreeDelta`) and re-indexes what changed since the last pass, and
 * `POST /api/projects/reindex-file` for a worktree path lands here directly.
 * Copies are unloaded when idle, rebuilt when the canonical HEAD moves past the
 * snapshot, dropped on `WorktreeRemove` and garbage-collected once their
 * worktree is gone. Sessions in a main checkout never reach this module.
 *
 * Files: `<INDEX_DIR>/worktrees/<name>-<hash(worktree)>-<canonical HEAD>-<stamp>.db`
 * plus a `.json` sidecar naming the worktree, the canonical checkout and HEAD
 * the copy was taken at — what GC and reuse after a restart read.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import {
  BlobVectorStore,
  CachedInferenceService,
  createAIProvider,
  EmbeddingPipeline,
  InferenceCache,
} from '../ai/index.js';
import { SummarizationPipeline } from '../ai/summarization-pipeline.js';
import type { TraceMcpConfig } from '../config.js';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { INDEX_DIR, LOCKS_DIR, projectHash, projectName } from '../global.js';
import type { ExtractPool } from '../indexer/extract-pool.js';
import { IndexingPipeline } from '../indexer/pipeline.js';
import { clearProjectReindexCache } from '../indexer/recent-reindex-cache.js';
import { isReindexing } from '../indexer/reindex-inflight.js';
import { logger } from '../logger.js';
import { dropTreeCacheScope } from '../parser/tree-cache.js';
import { SqliteTaskCache } from '../pipeline/index.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { clearServerPid, ProgressState, writeServerPid } from '../progress.js';
import { createServer, type ServerDeps, type ServerHandle } from '../server/server.js';
import type { ToolResponse } from '../server/types.js';
import type { WorktreeIndexRoute, WorktreeIndexTarget } from '../server/worktree-index-route.js';
import { trailingDebounce } from '../util/debounce.js';
import { safeGitEnv } from '../utils/git-env.js';
import { isHotChurnPath } from '../utils/hot-churn.js';
import { LockError, withLock } from '../utils/pid-lock.js';
import {
  computeWorktreeDelta,
  findLinkedWorktree,
  getWorktreeDelta,
  resolveWorktreeLink,
  summarizeWorktreeDelta,
  type WorktreeDelta,
  type WorktreeDeltaSummary,
  type WorktreeLink,
  worktreeDeltaSize,
} from '../worktree-delta.js';
import { serializeError } from './log-error.js';

const execFileAsync = promisify(execFile);

// ─── Settings ──────────────────────────────────────────────────────

export interface WorktreeIndexSettings {
  /** Master switch. Off: worktree sessions behave exactly as in #1483. */
  enabled: boolean;
  /** How long the first calls of a session wait for a copy still being built. */
  initialWaitMs: number;
  /** How long a call waits for the delta re-check before answering anyway. */
  syncWaitMs: number;
  /** Unload a copy nobody used for this long (file stays for reuse). 0: never. */
  idleUnloadMs: number;
  /** Copies held open at once. */
  maxLoaded: number;
  /** Copies kept on disk. */
  maxSnapshots: number;
  /** Total bytes of copies kept on disk. 0: unlimited. */
  maxDiskBytes: number;
  /** A worktree whose delta is larger than this gets no copy. */
  maxDeltaFiles: number;
}

export const DEFAULT_WORKTREE_INDEX_SETTINGS: Readonly<WorktreeIndexSettings> = Object.freeze({
  enabled: true,
  initialWaitMs: 3_000,
  syncWaitMs: 1_000,
  idleUnloadMs: 30 * 60_000,
  maxLoaded: 3,
  maxSnapshots: 8,
  maxDiskBytes: 8 * 1024 * 1024 * 1024,
  maxDeltaFiles: 2_000,
});

function num(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
}

/**
 * Read the `worktree_index` section of the global config. Invalid values fall
 * back to the defaults. `TRACE_MCP_WORKTREE_INDEX=0|off|false` turns the
 * feature off regardless of the file (`1|on|true` turns it on).
 */
export function resolveWorktreeIndexSettings(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): WorktreeIndexSettings {
  const d = DEFAULT_WORKTREE_INDEX_SETTINGS;
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  let enabled = typeof o.enabled === 'boolean' ? o.enabled : d.enabled;
  const envSwitch = env.TRACE_MCP_WORKTREE_INDEX?.trim().toLowerCase();
  if (envSwitch === '0' || envSwitch === 'off' || envSwitch === 'false') enabled = false;
  else if (envSwitch === '1' || envSwitch === 'on' || envSwitch === 'true') enabled = true;
  const idleMin = num(o.idle_unload_minutes, 0, 1440);
  const diskMb = num(o.max_disk_mb, 0, 1_048_576);
  return {
    enabled,
    initialWaitMs: num(o.initial_wait_ms, 0, 60_000) ?? d.initialWaitMs,
    syncWaitMs: num(o.sync_wait_ms, 0, 60_000) ?? d.syncWaitMs,
    idleUnloadMs: idleMin !== undefined ? idleMin * 60_000 : d.idleUnloadMs,
    maxLoaded: Math.floor(num(o.max_loaded, 1, 64) ?? d.maxLoaded),
    maxSnapshots: Math.floor(num(o.max_snapshots, 1, 256) ?? d.maxSnapshots),
    maxDiskBytes: diskMb !== undefined ? diskMb * 1024 * 1024 : d.maxDiskBytes,
    maxDeltaFiles: Math.floor(num(o.max_delta_files, 1, 1_000_000) ?? d.maxDeltaFiles),
  };
}

// ─── Snapshot files ────────────────────────────────────────────────

const META_SCHEMA = 1;

/** Sidecar describing one copy. Written next to the DB, read by GC and reuse. */
export interface SnapshotMeta {
  schema: number;
  worktree_root: string;
  canonical_root: string;
  /** Canonical HEAD the copy was taken at. */
  canonical_head: string;
  /** trace-mcp version that wrote the copy; another version rebuilds. */
  version: string;
  created_at: number;
  last_used_at: number;
  /** Paths the copy has re-indexed from the worktree (the delta, over time). */
  applied: string[];
}

interface SnapshotFile {
  dbPath: string;
  metaPath: string;
  meta: SnapshotMeta;
}

const SIDECARS = ['', '-wal', '-shm', '-journal'];

/** Pages copied per backup step: 4 MB with the 4 KB page size, a few ms per turn. */
const BACKUP_PAGES_PER_STEP = 1024;

/** How long to wait for the canonical pipeline to go quiet before copying anyway. */
const CANONICAL_QUIET_WAIT_MS = 5_000;

/** Retry delay after a failed build (git error, canonical not ready, …). */
const BUILD_RETRY_MS = 60_000;

/** Retry delay after a build refused by a size limit. */
const BUILD_REFUSED_RETRY_MS = 10 * 60_000;

/** Rebuild instead of re-indexing when more than this many files left the delta. */
const REBUILD_REVERTED_MIN = 200;

/** How long a retired copy waits for in-flight calls before closing anyway. */
const RETIRE_DRAIN_MS = 30_000;

/** Lock retries for a sync that collides with register_edit / reindex-file. */
const LOCK_RETRIES = 20;
const LOCK_RETRY_DELAY_MS = 50;

/** Leftover `.tmp` copies older than this are swept. */
const STALE_TMP_MS = 60 * 60_000;

/**
 * How long a `POST reindex-file` waits for its file to land in the copy. The
 * PostToolUse hook gives the request 2 s; past this the re-index continues in
 * the background. `?wait=1` callers get `REINDEX_FILE_WAIT_FULL_MS` instead.
 */
const REINDEX_FILE_WAIT_MS = 1_000;
const REINDEX_FILE_WAIT_FULL_MS = 30_000;

const SWEEP_INTERVAL_MS = 60_000;
const GC_INTERVAL_MS = 30 * 60_000;
const GC_FIRST_DELAY_MS = 30_000;

/** Stable per-worktree file prefix: GC and reuse recognise a copy by it. */
export function snapshotPrefix(worktreeRoot: string): string {
  return `${projectName(worktreeRoot)}-${projectHash(worktreeRoot)}-`;
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function fileBytes(dbPath: string): number {
  let total = 0;
  for (const suffix of SIDECARS) {
    try {
      total += fs.statSync(dbPath + suffix).size;
    } catch {
      /* absent */
    }
  }
  return total;
}

function removeDbFiles(dbPath: string): void {
  for (const suffix of SIDECARS) {
    try {
      fs.rmSync(dbPath + suffix, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

function readMeta(metaPath: string): SnapshotMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Partial<SnapshotMeta>;
    if (
      raw.schema !== META_SCHEMA ||
      typeof raw.worktree_root !== 'string' ||
      typeof raw.canonical_root !== 'string' ||
      typeof raw.canonical_head !== 'string'
    ) {
      return null;
    }
    return {
      schema: META_SCHEMA,
      worktree_root: raw.worktree_root,
      canonical_root: raw.canonical_root,
      canonical_head: raw.canonical_head,
      version: typeof raw.version === 'string' ? raw.version : '',
      created_at: typeof raw.created_at === 'number' ? raw.created_at : 0,
      last_used_at: typeof raw.last_used_at === 'number' ? raw.last_used_at : 0,
      applied: Array.isArray(raw.applied)
        ? raw.applied.filter((p): p is string => typeof p === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

function writeMeta(metaPath: string, meta: SnapshotMeta): void {
  const tmp = `${metaPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
  fs.renameSync(tmp, metaPath);
}

/** `mtime:size` of a worktree file, or `absent`. Change detection for the sync. */
function statSignature(abs: string): string {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return 'absent';
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}

async function waitFor<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Paths `git worktree list` reports for the repository of `canonicalRoot`, or null. */
async function listGitWorktrees(canonicalRoot: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain', '-z'],
      { cwd: canonicalRoot, encoding: 'utf-8', timeout: 10_000, env: safeGitEnv() },
    );
    const out = new Set<string>();
    for (const field of stdout.split('\0')) {
      if (field.startsWith('worktree ')) out.add(realpathOr(field.slice('worktree '.length)));
    }
    return out;
  } catch {
    return null;
  }
}

// ─── Dependencies ──────────────────────────────────────────────────

/** What a copy needs from the canonical project. A `ManagedProject` fits. */
export interface CanonicalSource {
  root: string;
  db: Database.Database;
  config: TraceMcpConfig;
  status: 'starting' | 'indexing' | 'ready' | 'error';
}

export interface WorktreeIndexManagerDeps {
  settings: WorktreeIndexSettings;
  /** The loaded canonical project for a root, if the daemon has it. */
  getCanonical: (root: string) => CanonicalSource | undefined;
  /** Shared extract pool (the daemon's). Null: the pipeline runs in-process. */
  getExtractPool?: (config: TraceMcpConfig) => ExtractPool | null;
  /** Drop per-root caches from the shared extract pool when a copy closes. */
  dropPoolRoot?: (root: string) => void;
  /** Daemon-wide shared stores for the tool-host server. */
  sharedServerDeps?: (config: TraceMcpConfig) => ServerDeps;
  /** Directory holding the copies. Default `<INDEX_DIR>/worktrees`. */
  dir?: string;
  /** Version stamped into the sidecar. A different version rebuilds. */
  version?: string;
  now?: () => number;
}

export interface WorktreeIndexStats {
  loaded: number;
  building: number;
  on_disk: number;
  disk_bytes: number;
}

export type WorktreeReindexResult =
  | { ok: true; relPath: string; skippedChurn?: boolean }
  | { ok: false; status: 400; error: string };

// ─── One copy ──────────────────────────────────────────────────────

type IndexState = 'opening' | 'ready' | 'retiring' | 'closed';

interface SyncPlan {
  index: string[];
  remove: string[];
  signatures: Map<string, string>;
  /** Files that left the delta since the last pass and changed on disk. */
  reverted: number;
}

class BranchIndex {
  state: IndexState = 'opening';
  readonly worktreeRoot: string;
  readonly canonicalRoot: string;
  readonly canonicalHead: string;
  readonly dbPath: string;
  readonly metaPath: string;
  meta: SnapshotMeta;
  lastUsedAt: number;
  lastDelta: WorktreeDelta | null = null;
  builtAt = 0;

  private db: Database.Database | null = null;
  private pipeline: IndexingPipeline | null = null;
  private handle: ServerHandle | null = null;
  /** Path → stat signature of what the copy last indexed from the worktree. */
  private readonly applied = new Map<string, string>();
  private readonly pendingPaths = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private inflight = 0;
  private drained: (() => void) | null = null;
  /** Schedules embeddings/summaries after a re-index; null when AI is off. */
  private aiRun: (() => void) | null = null;
  private cancelAI: (() => void) | null = null;
  private metaDirty = false;
  private readonly lockName: string;

  constructor(
    private readonly owner: WorktreeIndexManager,
    file: SnapshotFile,
    now: number,
  ) {
    this.worktreeRoot = file.meta.worktree_root;
    this.canonicalRoot = file.meta.canonical_root;
    this.canonicalHead = file.meta.canonical_head;
    this.dbPath = file.dbPath;
    this.metaPath = file.metaPath;
    this.meta = file.meta;
    this.lastUsedAt = now;
    // Same name register_edit and reindex-file use for this root, so the three
    // writers of this copy serialize.
    this.lockName = `${projectHash(this.worktreeRoot)}-reindex`;
    // A reused copy: everything it ever re-indexed is re-checked on the first
    // pass (hash-gated), including files that have since left the delta.
    for (const p of file.meta.applied) this.applied.set(p, 'unknown');
  }

  open(config: TraceMcpConfig, deps: WorktreeIndexManagerDeps): void {
    const db = initializeDatabase(this.dbPath, {
      cacheMb: config.index_cache_mb,
      mmapMb: config.index_mmap_mb,
      memoryProfile: config.index_memory_profile ?? 'auto',
    });
    this.db = db;
    writeServerPid(db);
    const store = new Store(db);
    const registry = PluginRegistry.createWithDefaults();
    const progress = new ProgressState(db);
    this.pipeline = new IndexingPipeline(store, registry, config, this.worktreeRoot, progress, {
      extractPool: deps.getExtractPool?.(config) ?? null,
      taskCache: new SqliteTaskCache(db),
    });
    this.handle = createServer(store, registry, config, this.worktreeRoot, progress, {
      ...deps.sharedServerDeps?.(config),
      serveFullSurface: true,
      skipUsagePing: true,
      toolHost: true,
      worktreeIndexInfo: () => this.info(),
    });
    this.setupAI(config, store, progress);
  }

  /** Embeddings / summaries for re-indexed symbols, debounced like a watcher batch. */
  private setupAI(config: TraceMcpConfig, store: Store, progress: ProgressState): void {
    if (!config.ai?.enabled) return;
    const ai = config.ai;
    const provider = createAIProvider(config);
    const abort = new AbortController();
    const vectorStore = new BlobVectorStore(store.db);
    const embedding = new EmbeddingPipeline(store, provider.embedding(), vectorStore, progress);
    const summarization =
      ai.summarize_on_index === false
        ? null
        : new SummarizationPipeline(
            store,
            new CachedInferenceService(
              provider.fastInference(),
              new InferenceCache(store.db),
              ai.fast_model ?? 'fast',
            ),
            this.worktreeRoot,
            {
              batchSize: ai.summarize_batch_size ?? 20,
              kinds: ai.summarize_kinds ?? [
                'class',
                'function',
                'method',
                'interface',
                'trait',
                'enum',
                'type',
              ],
              concurrency: ai.concurrency ?? 1,
              summarizeFromDocstrings: ai.summarizeFromDocstrings,
              maxTokens: ai.summarize_max_tokens,
            },
            progress,
            vectorStore,
          );
    const run = trailingDebounce(() => {
      if (this.state !== 'ready') return;
      summarization?.summarizeUnsummarized(abort.signal).catch((err) => {
        logger.warn(
          { error: serializeError(err), root: this.worktreeRoot },
          'Branch index summarization failed',
        );
      });
      embedding.indexUnembedded(undefined, abort.signal).catch((err) => {
        logger.warn(
          { error: serializeError(err), root: this.worktreeRoot },
          'Branch index embedding failed',
        );
      });
    }, 5_000);
    this.aiRun = () => run();
    this.cancelAI = () => {
      run.cancel();
      abort.abort();
    };
  }

  markReady(now: number): void {
    this.state = 'ready';
    this.builtAt = now;
  }

  /** Decide what the copy must re-index to match `delta` and the worktree on disk. */
  private plan(delta: WorktreeDelta): SyncPlan {
    const index: string[] = [];
    const remove: string[] = [];
    const signatures = new Map<string, string>();
    const consider = (rel: string): string => {
      const sig = statSignature(path.join(this.worktreeRoot, rel));
      signatures.set(rel, sig);
      if (this.applied.get(rel) !== sig) (sig === 'absent' ? remove : index).push(rel);
      return sig;
    };
    const inDelta = new Set<string>();
    for (const rel of delta.modified) {
      inDelta.add(rel);
      consider(rel);
    }
    for (const rel of delta.untracked) {
      inDelta.add(rel);
      consider(rel);
    }
    for (const rel of delta.deleted) {
      inDelta.add(rel);
      consider(rel);
    }
    // Files that left the delta (reverted, or merged into the canonical HEAD):
    // the copy still holds their branch version. Re-index them from disk.
    let reverted = 0;
    for (const rel of this.applied.keys()) {
      if (inDelta.has(rel)) continue;
      const before = index.length + remove.length;
      consider(rel);
      if (index.length + remove.length > before) reverted++;
    }
    return { index, remove, signatures, reverted };
  }

  /** Files whose re-index is still running, as a delta for `markStaleOnBranch`. */
  pendingDelta(): WorktreeDelta | null {
    if (this.pendingPaths.size === 0) return null;
    return {
      worktreeRoot: this.worktreeRoot,
      canonicalRoot: this.canonicalRoot,
      worktreeHead: this.lastDelta?.worktreeHead ?? '',
      canonicalHead: this.canonicalHead,
      modified: [...this.pendingPaths],
      deleted: [],
      untracked: [],
      computedAt: this.lastDelta?.computedAt ?? 0,
    };
  }

  /**
   * Bring the copy in line with `delta`. Serialized per copy; resolves to the
   * number of files that left the delta and changed (the rebuild signal).
   */
  sync(delta: WorktreeDelta): Promise<number> {
    const run = this.chain.then(async () => {
      if (this.state !== 'ready' && this.state !== 'opening') return 0;
      this.lastDelta = delta;
      const plan = this.plan(delta);
      await this.apply(plan, false);
      return plan.reverted;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Re-index specific worktree paths (reindex-file), serialized with `sync`. */
  reindexPaths(relPaths: string[]): Promise<void> {
    const run = this.chain.then(async () => {
      if (this.state !== 'ready') return;
      const index: string[] = [];
      const remove: string[] = [];
      const signatures = new Map<string, string>();
      for (const rel of relPaths) {
        const sig = statSignature(path.join(this.worktreeRoot, rel));
        signatures.set(rel, sig);
        (sig === 'absent' ? remove : index).push(rel);
      }
      await this.apply({ index, remove, signatures, reverted: 0 }, false);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async apply(plan: SyncPlan, locked: boolean): Promise<void> {
    const pipeline = this.pipeline;
    if (!pipeline || (plan.index.length === 0 && plan.remove.length === 0)) return;
    for (const p of [...plan.index, ...plan.remove]) this.pendingPaths.add(p);
    const work = async () => {
      if (plan.remove.length > 0) pipeline.deleteFiles(plan.remove);
      if (plan.index.length > 0) await pipeline.indexFiles(plan.index);
    };
    try {
      if (locked) await work();
      else await this.withReindexLock(work);
      for (const [rel, sig] of plan.signatures) this.applied.set(rel, sig);
      for (const p of [...plan.index, ...plan.remove]) this.pendingPaths.delete(p);
      this.metaDirty = true;
      this.aiRun?.();
    } catch (err) {
      // Left pending: the next routed call re-plans and retries.
      logger.warn(
        {
          error: serializeError(err),
          root: this.worktreeRoot,
          files: plan.index.length + plan.remove.length,
        },
        'Branch index re-index failed (will retry on the next call)',
      );
      throw err;
    }
  }

  private async withReindexLock(fn: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await withLock({ lockDir: LOCKS_DIR, name: this.lockName, op: 'worktree-index-sync' }, fn);
        return;
      } catch (err) {
        if (!(err instanceof LockError) || attempt >= LOCK_RETRIES) throw err;
        await delay(LOCK_RETRY_DELAY_MS);
      }
    }
  }

  /** Persist the sidecar when the applied set changed. Never throws. */
  flushMeta(now: number): void {
    if (!this.metaDirty && now - this.meta.last_used_at < 5 * 60_000) return;
    this.meta = { ...this.meta, last_used_at: this.lastUsedAt, applied: [...this.applied.keys()] };
    try {
      writeMeta(this.metaPath, this.meta);
      this.metaDirty = false;
    } catch (err) {
      logger.debug({ err, metaPath: this.metaPath }, 'Branch index sidecar write failed');
    }
  }

  async run(tool: string, params: Record<string, unknown>): Promise<ToolResponse | undefined> {
    if (this.state !== 'ready' && this.state !== 'retiring') return undefined;
    const handler = this.handle?.toolHandlers.get(tool);
    if (!handler) return undefined;
    this.inflight++;
    this.lastUsedAt = this.owner.now();
    try {
      return await handler(params);
    } finally {
      this.inflight--;
      if (this.inflight === 0) this.drained?.();
    }
  }

  get busy(): boolean {
    return this.inflight > 0;
  }

  target(): WorktreeIndexTarget {
    return {
      run: (tool, params) => this.run(tool, params),
      pending: () => this.pendingDelta(),
    };
  }

  info(): WorktreeDeltaSummary | null {
    const delta = this.lastDelta;
    if (!delta) return null;
    return {
      ...summarizeWorktreeDelta(delta, undefined, 'branch_index'),
      branch_index: {
        canonical_head_at_copy: this.canonicalHead,
        built_at: new Date(this.builtAt).toISOString(),
        pending: [...this.pendingPaths].slice(0, 50),
        reindexed_files: this.applied.size,
      },
    };
  }

  /** Stop serving and close. Waits (bounded) for calls already running. */
  async close(opts: { drainMs?: number } = {}): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'retiring';
    if (this.inflight > 0) {
      await waitFor(
        new Promise<void>((resolve) => {
          this.drained = resolve;
        }),
        opts.drainMs ?? RETIRE_DRAIN_MS,
      );
    }
    await waitFor(this.chain, 5_000);
    this.state = 'closed';
    this.cancelAI?.();
    this.flushMeta(this.owner.now());
    try {
      this.handle?.dispose();
      await this.handle?.server.close();
    } catch {
      /* best-effort */
    }
    try {
      await this.pipeline?.dispose();
    } catch (err) {
      logger.debug({ err }, 'Branch index pipeline dispose failed');
    }
    try {
      if (this.db?.open) {
        clearServerPid(this.db);
        this.db.close();
      }
    } catch (err) {
      logger.debug({ err }, 'Branch index DB close failed');
    }
    this.handle = null;
    this.pipeline = null;
    this.db = null;
    clearProjectReindexCache(this.worktreeRoot);
    try {
      dropTreeCacheScope(this.worktreeRoot);
    } catch {
      /* best-effort */
    }
    this.owner.dropPoolRoot(this.worktreeRoot);
  }
}

// ─── Manager ───────────────────────────────────────────────────────

interface Entry {
  link: WorktreeLink;
  current: BranchIndex | null;
  building: Promise<BranchIndex | null> | null;
  buildStartedAt: number;
  retryAt: number;
  lastError: string | null;
}

/**
 * Owns every branch index of the daemon. One instance per daemon, created in
 * `serve-http`; nothing here runs for a session that is not a linked worktree.
 */
export class WorktreeIndexManager {
  private readonly entries = new Map<string, Entry>();
  private readonly dir: string;
  private readonly version: string;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private gcTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly deps: WorktreeIndexManagerDeps) {
    this.dir = deps.dir ?? path.join(INDEX_DIR, 'worktrees');
    this.version = deps.version ?? '0.0.0-dev';
  }

  get settings(): WorktreeIndexSettings {
    return this.deps.settings;
  }

  now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  dropPoolRoot(root: string): void {
    this.deps.dropPoolRoot?.(root);
  }

  /**
   * Route for a session created against `canonicalRoot` with the stdio
   * proxy's `?worktree=` hint. Null — and so no change at all — unless the
   * feature is on and the hint names a linked worktree of exactly that
   * checkout. Starts building the copy in the background.
   */
  routeFor(canonicalRoot: string, worktreeHint: string | undefined): WorktreeIndexRoute | null {
    if (!this.settings.enabled || this.stopped || !worktreeHint) return null;
    const link = resolveWorktreeLink(canonicalRoot, worktreeHint);
    if (!link) return null;
    const entry = this.entryFor(link);
    if (entry.current) entry.current.lastUsedAt = this.now();
    this.ensureBuilding(entry);
    return { resolve: () => this.resolve(link).catch(() => null) };
  }

  private entryFor(link: WorktreeLink): Entry {
    let entry = this.entries.get(link.worktreeRoot);
    if (!entry || entry.link.canonicalRoot !== link.canonicalRoot) {
      entry = {
        link,
        current: null,
        building: null,
        buildStartedAt: 0,
        retryAt: 0,
        lastError: null,
      };
      this.entries.set(link.worktreeRoot, entry);
    }
    return entry;
  }

  /** The ready copy for `link`, or null to answer from the canonical index. */
  async resolve(link: WorktreeLink): Promise<WorktreeIndexTarget | null> {
    if (!this.settings.enabled || this.stopped) return null;
    const entry = this.entryFor(link);
    const now = this.now();
    const current = entry.current;
    if (current && current.state === 'ready') {
      current.lastUsedAt = now;
      await waitFor(this.syncEntry(entry, current), this.settings.syncWaitMs);
      const served = entry.current;
      return served && (served.state === 'ready' || served.state === 'retiring')
        ? served.target()
        : null;
    }
    const building = this.ensureBuilding(entry);
    if (!building) return null;
    const remaining = entry.buildStartedAt + this.settings.initialWaitMs - now;
    const built = await waitFor(building, remaining);
    return built && built.state === 'ready' ? built.target() : null;
  }

  /** Re-check the delta and apply it, or schedule a rebuild. Never rejects. */
  private async syncEntry(entry: Entry, index: BranchIndex): Promise<void> {
    try {
      const delta = await getWorktreeDelta(entry.link);
      if (!delta || index.state !== 'ready') return;
      if (delta.canonicalHead !== index.canonicalHead) {
        // The canonical index moved on: files the branch shares with the new
        // HEAD are stale in this copy and in no delta. Keep serving it until
        // the new copy is ready.
        this.ensureBuilding(entry, { replace: true, reason: 'canonical_head_moved' });
        return;
      }
      const reverted = await index.sync(delta);
      if (reverted > REBUILD_REVERTED_MIN && reverted > worktreeDeltaSize(delta)) {
        this.ensureBuilding(entry, { replace: true, reason: 'delta_shrank' });
      }
    } catch (err) {
      logger.debug({ err, root: entry.link.worktreeRoot }, 'Branch index sync failed');
    }
  }

  private ensureBuilding(
    entry: Entry,
    opts: { replace?: boolean; reason?: string } = {},
  ): Promise<BranchIndex | null> | null {
    if (entry.building) return entry.building;
    if (entry.current && entry.current.state === 'ready' && !opts.replace) return null;
    const now = this.now();
    if (now < entry.retryAt) return null;
    const canonical = this.deps.getCanonical(entry.link.canonicalRoot);
    if (!canonical || canonical.status !== 'ready' || !canonical.db.open) return null;
    if (realpathOr(canonical.root) !== entry.link.canonicalRoot) return null;
    entry.buildStartedAt = now;
    const building = this.build(entry, canonical, opts.reason ?? 'first_use')
      .catch((err) => {
        entry.lastError = String(err);
        entry.retryAt = this.now() + BUILD_RETRY_MS;
        logger.warn(
          { error: serializeError(err), worktree: entry.link.worktreeRoot },
          'Branch index build failed — serving the canonical index meanwhile',
        );
        return null;
      })
      .finally(() => {
        entry.building = null;
      });
    entry.building = building;
    return building;
  }

  private refuse(entry: Entry, reason: string, detail: Record<string, unknown>): null {
    entry.lastError = reason;
    entry.retryAt = this.now() + BUILD_REFUSED_RETRY_MS;
    logger.info(
      { worktree: entry.link.worktreeRoot, reason, ...detail },
      'Branch index not built — serving the canonical index',
    );
    return null;
  }

  private async build(
    entry: Entry,
    canonical: CanonicalSource,
    reason: string,
  ): Promise<BranchIndex | null> {
    const { link } = entry;
    const t0 = performance.now();
    const delta = await computeWorktreeDelta(link);
    if (!delta) throw new Error('git could not compute the worktree delta');
    const deltaFiles = worktreeDeltaSize(delta);
    if (deltaFiles > this.settings.maxDeltaFiles) {
      return this.refuse(entry, 'delta_too_large', {
        deltaFiles,
        limit: this.settings.maxDeltaFiles,
      });
    }
    if (!this.makeRoomForLoad(entry)) {
      return this.refuse(entry, 'max_loaded', { limit: this.settings.maxLoaded });
    }

    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let file = this.findReusable(link, delta.canonicalHead);
    let copyMs = 0;
    let reused = true;
    if (!file) {
      reused = false;
      const estimate = fileBytes(canonical.db.name);
      if (!this.makeRoomOnDisk(estimate, link.worktreeRoot)) {
        return this.refuse(entry, 'disk_limit', {
          estimateBytes: estimate,
          limitBytes: this.settings.maxDiskBytes,
        });
      }
      const tc = performance.now();
      file = await this.copyCanonical(link, canonical, delta.canonicalHead);
      copyMs = Math.round(performance.now() - tc);
    }

    const index = new BranchIndex(this, file, this.now());
    const td = performance.now();
    try {
      index.open(canonical.config, this.deps);
      await index.sync(delta);
    } catch (err) {
      await index.close({ drainMs: 0 });
      if (!reused) this.deleteFile(file.dbPath, file.metaPath);
      throw err;
    }
    const deltaMs = Math.round(performance.now() - td);
    if (this.stopped) {
      await index.close({ drainMs: 0 });
      return null;
    }
    index.markReady(this.now());
    index.flushMeta(this.now());

    const previous = entry.current;
    entry.current = index;
    entry.lastError = null;
    entry.retryAt = 0;
    if (previous && previous !== index) {
      void previous.close().then(() => {
        if (previous.dbPath !== index.dbPath) this.deleteFile(previous.dbPath, previous.metaPath);
      });
    }
    logger.info(
      {
        worktree: link.worktreeRoot,
        canonical: link.canonicalRoot,
        reason,
        reused,
        copyMs,
        deltaMs,
        totalMs: Math.round(performance.now() - t0),
        deltaFiles,
        bytes: fileBytes(index.dbPath),
      },
      'Branch index ready',
    );
    return index;
  }

  /** Online backup of the canonical DB into a fresh copy for `link`. */
  private async copyCanonical(
    link: WorktreeLink,
    canonical: CanonicalSource,
    canonicalHead: string,
  ): Promise<SnapshotFile> {
    const created = this.now();
    const base = `${snapshotPrefix(link.worktreeRoot)}${canonicalHead.slice(0, 12)}-${created.toString(36)}`;
    const dbPath = path.join(this.dir, `${base}.db`);
    const metaPath = path.join(this.dir, `${base}.json`);
    const tmp = `${dbPath}.tmp`;
    removeDbFiles(tmp);
    // Copy between canonical pipeline runs when we can: the backup never
    // blocks them, but a copy taken mid-run carries a half-written pass.
    const quietBy = performance.now() + CANONICAL_QUIET_WAIT_MS;
    while (isReindexing(canonical.root) && performance.now() < quietBy) await delay(100);
    try {
      await canonical.db.backup(tmp, { progress: () => BACKUP_PAGES_PER_STEP });
      for (const suffix of ['-wal', '-shm']) {
        if (fs.existsSync(tmp + suffix)) fs.renameSync(tmp + suffix, dbPath + suffix);
      }
      fs.renameSync(tmp, dbPath);
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {
        /* best-effort */
      }
    } catch (err) {
      removeDbFiles(tmp);
      removeDbFiles(dbPath);
      throw err;
    }
    const meta: SnapshotMeta = {
      schema: META_SCHEMA,
      worktree_root: link.worktreeRoot,
      canonical_root: link.canonicalRoot,
      canonical_head: canonicalHead,
      version: this.version,
      created_at: created,
      last_used_at: created,
      applied: [],
    };
    writeMeta(metaPath, meta);
    return { dbPath, metaPath, meta };
  }

  /** Every copy on disk with a readable sidecar. */
  listSnapshots(): SnapshotFile[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: SnapshotFile[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const metaPath = path.join(this.dir, name);
      const meta = readMeta(metaPath);
      if (!meta) continue;
      out.push({ dbPath: metaPath.replace(/\.json$/, '.db'), metaPath, meta });
    }
    return out;
  }

  private loadedPaths(): Set<string> {
    const out = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.current && entry.current.state !== 'closed') out.add(entry.current.dbPath);
    }
    return out;
  }

  /** Newest reusable copy for `link` at `canonicalHead`; older ones of the worktree go. */
  private findReusable(link: WorktreeLink, canonicalHead: string): SnapshotFile | null {
    const loaded = this.loadedPaths();
    const mine = this.listSnapshots()
      .filter((f) => f.meta.worktree_root === link.worktreeRoot)
      .sort((a, b) => b.meta.created_at - a.meta.created_at);
    let pick: SnapshotFile | null = null;
    for (const f of mine) {
      const usable =
        !pick &&
        f.meta.canonical_root === link.canonicalRoot &&
        f.meta.canonical_head === canonicalHead &&
        f.meta.version === this.version &&
        fs.existsSync(f.dbPath) &&
        !loaded.has(f.dbPath);
      if (usable) pick = f;
      else if (!loaded.has(f.dbPath)) this.deleteFile(f.dbPath, f.metaPath);
    }
    return pick;
  }

  /** Close idle copies until another one fits under `maxLoaded`. */
  private makeRoomForLoad(except: Entry): boolean {
    const loaded = [...this.entries.values()].filter(
      (e) => e !== except && e.current && e.current.state === 'ready',
    );
    // The copy `except` already holds is replaced, not added.
    const willHold = loaded.length + 1;
    let excess = willHold - this.settings.maxLoaded;
    if (excess <= 0) return true;
    loaded.sort((a, b) => a.current!.lastUsedAt - b.current!.lastUsedAt);
    for (const e of loaded) {
      if (excess <= 0) break;
      if (e.current!.busy || e.building) continue;
      void this.unload(e);
      excess--;
    }
    return excess <= 0;
  }

  /** Delete unloaded copies, least recently used first, until a new one fits. */
  private makeRoomOnDisk(incomingBytes: number, forWorktree: string): boolean {
    const loaded = this.loadedPaths();
    const files = this.listSnapshots()
      .map((f) => ({ ...f, bytes: fileBytes(f.dbPath) }))
      .sort((a, b) => a.meta.last_used_at - b.meta.last_used_at);
    let count = files.length;
    let bytes = files.reduce((sum, f) => sum + f.bytes, 0);
    const fits = () =>
      count + 1 <= this.settings.maxSnapshots &&
      (this.settings.maxDiskBytes === 0 || bytes + incomingBytes <= this.settings.maxDiskBytes);
    for (const f of files) {
      if (fits()) break;
      if (loaded.has(f.dbPath)) continue;
      this.deleteFile(f.dbPath, f.metaPath);
      count--;
      bytes -= f.bytes;
      logger.info(
        { dbPath: f.dbPath, worktree: f.meta.worktree_root, forWorktree },
        'Branch index evicted to stay within the disk limits',
      );
    }
    return fits();
  }

  private deleteFile(dbPath: string, metaPath: string): void {
    removeDbFiles(dbPath);
    try {
      fs.rmSync(metaPath, { force: true });
    } catch {
      /* best-effort */
    }
  }

  private async unload(entry: Entry): Promise<void> {
    const index = entry.current;
    entry.current = null;
    if (this.entries.get(entry.link.worktreeRoot) === entry && !entry.building) {
      this.entries.delete(entry.link.worktreeRoot);
    }
    if (index) await index.close();
  }

  /**
   * `POST /api/projects/reindex-file` for a path in a linked worktree. Null
   * when this module does not handle the project (not a worktree, canonical
   * checkout not loaded, feature off) — the caller then takes its usual path.
   * Otherwise the file is re-indexed into the worktree's copy, or — while the
   * copy does not exist yet — left to the build, which reads the worktree as
   * it is. Never writes the canonical DB.
   */
  async reindexFile(
    project: string,
    rawPath: string,
    opts: { wait?: boolean } = {},
  ): Promise<WorktreeReindexResult | null> {
    if (!this.settings.enabled || this.stopped) return null;
    const found = findLinkedWorktree(project);
    if (!found) return null;
    const link: WorktreeLink = { worktreeRoot: found.worktreeRoot, canonicalRoot: found.mainRoot };
    const canonical = this.deps.getCanonical(link.canonicalRoot);
    if (!canonical || realpathOr(canonical.root) !== link.canonicalRoot) return null;

    const abs = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(project, rawPath));
    let rel = path.relative(link.worktreeRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      rel = path.relative(link.worktreeRoot, realpathOr(abs));
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { ok: false, status: 400, error: 'path is outside project root' };
      }
    }
    const relPosix = rel.split(path.sep).join('/');
    if (relPosix.length === 0) return { ok: false, status: 400, error: 'path is required' };
    if (isHotChurnPath(relPosix)) return { ok: true, relPath: relPosix, skippedChurn: true };

    const entry = this.entryFor(link);
    const index = entry.current;
    if (!index || index.state !== 'ready') {
      this.ensureBuilding(entry);
      return { ok: true, relPath: relPosix };
    }
    index.lastUsedAt = this.now();
    await waitFor(
      index.reindexPaths([relPosix]).catch(() => undefined),
      opts.wait ? REINDEX_FILE_WAIT_FULL_MS : REINDEX_FILE_WAIT_MS,
    );
    return { ok: true, relPath: relPosix };
  }

  /** What `GET /api/projects/worktree` adds about the copy, or null. */
  describe(link: WorktreeLink): Record<string, unknown> | null {
    const entry = this.entries.get(link.worktreeRoot);
    if (!entry) return null;
    const current = entry.current;
    return {
      state: current?.state ?? (entry.building ? 'building' : 'none'),
      building: entry.building !== null,
      db_path: current?.dbPath ?? null,
      canonical_head_at_copy: current?.canonicalHead ?? null,
      built_at: current?.builtAt ? new Date(current.builtAt).toISOString() : null,
      pending: current?.pendingDelta()?.modified.length ?? 0,
      last_error: entry.lastError,
    };
  }

  /**
   * Drop the copy of a worktree (WorktreeRemove hook). Matches sidecars by
   * the path as given and by its real path — the directory may be gone.
   * Returns how many copies were deleted.
   */
  async drop(worktreePath: string): Promise<number> {
    const candidates = new Set([path.resolve(worktreePath), realpathOr(worktreePath)]);
    for (const [key, entry] of [...this.entries]) {
      if (!candidates.has(key)) continue;
      this.entries.delete(key);
      await entry.building?.catch(() => null);
      if (entry.current) await entry.current.close({ drainMs: 5_000 });
    }
    let dropped = 0;
    for (const f of this.listSnapshots()) {
      if (!candidates.has(f.meta.worktree_root)) continue;
      this.deleteFile(f.dbPath, f.metaPath);
      dropped++;
    }
    if (dropped > 0) logger.info({ worktree: worktreePath, dropped }, 'Branch index dropped');
    return dropped;
  }

  /**
   * Delete copies whose worktree is gone: the directory is missing, it is no
   * longer a linked worktree of the recorded checkout, or `git worktree list`
   * of that checkout does not name it. Also sweeps stale `.tmp` copies and
   * DB files without a sidecar. Returns the deleted DB paths.
   */
  async gc(): Promise<string[]> {
    const deleted: string[] = [];
    const loaded = this.loadedPaths();
    const lists = new Map<string, Set<string> | null>();
    for (const f of this.listSnapshots()) {
      const wt = f.meta.worktree_root;
      let gone = !fs.existsSync(wt);
      if (!gone) {
        const found = findLinkedWorktree(wt);
        gone = !found || found.worktreeRoot !== wt || found.mainRoot !== f.meta.canonical_root;
      }
      if (!gone) {
        if (!lists.has(f.meta.canonical_root)) {
          lists.set(f.meta.canonical_root, await listGitWorktrees(f.meta.canonical_root));
        }
        const listed = lists.get(f.meta.canonical_root);
        if (listed && !listed.has(wt)) gone = true;
      }
      if (!gone) continue;
      const entry = this.entries.get(wt);
      if (entry) {
        this.entries.delete(wt);
        if (entry.current) await entry.current.close({ drainMs: 5_000 });
      } else if (loaded.has(f.dbPath)) {
        continue;
      }
      this.deleteFile(f.dbPath, f.metaPath);
      deleted.push(f.dbPath);
    }
    // Leftovers: interrupted copies and DBs whose sidecar was lost.
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      /* no directory yet */
    }
    const now = this.now();
    const stillLoaded = this.loadedPaths();
    for (const name of names) {
      const full = path.join(this.dir, name);
      const isTmp = name.includes('.db.tmp');
      const isOrphanDb = name.endsWith('.db') && !fs.existsSync(full.replace(/\.db$/, '.json'));
      if (!isTmp && !isOrphanDb) continue;
      if (stillLoaded.has(full)) continue;
      // Building writes a fresh .tmp; leave young ones alone.
      try {
        if (now - fs.statSync(full).mtimeMs < STALE_TMP_MS && isTmp) continue;
      } catch {
        continue;
      }
      if (isTmp) fs.rmSync(full, { force: true });
      else removeDbFiles(full);
      deleted.push(full);
    }
    if (deleted.length > 0) logger.info({ deleted: deleted.length }, 'Branch index GC');
    return deleted;
  }

  /** Unload copies nobody used for `idleUnloadMs`. Returns their worktree roots. */
  async sweepIdle(): Promise<string[]> {
    const idleMs = this.settings.idleUnloadMs;
    const now = this.now();
    const out: string[] = [];
    for (const entry of [...this.entries.values()]) {
      const index = entry.current;
      if (!index) {
        if (!entry.building && now >= entry.retryAt) this.entries.delete(entry.link.worktreeRoot);
        continue;
      }
      index.flushMeta(now);
      if (idleMs <= 0 || entry.building || index.busy) continue;
      if (now - index.lastUsedAt < idleMs) continue;
      await this.unload(entry);
      out.push(entry.link.worktreeRoot);
    }
    if (out.length > 0) logger.info({ worktrees: out }, 'Branch index unloaded (idle)');
    return out;
  }

  stats(): WorktreeIndexStats {
    let loaded = 0;
    let building = 0;
    for (const entry of this.entries.values()) {
      if (entry.current && entry.current.state !== 'closed') loaded++;
      if (entry.building) building++;
    }
    const files = this.listSnapshots();
    return {
      loaded,
      building,
      on_disk: files.length,
      disk_bytes: files.reduce((sum, f) => sum + fileBytes(f.dbPath), 0),
    };
  }

  /** Periodic idle unload and GC. Timers are unref'd. */
  start(): void {
    if (this.sweepTimer || this.stopped) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle().catch((err) => logger.debug({ err }, 'Branch index sweep failed'));
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    const scheduleGc = (ms: number) => {
      this.gcTimer = setTimeout(() => {
        void this.gc()
          .catch((err) => logger.debug({ err }, 'Branch index GC failed'))
          .finally(() => {
            if (!this.stopped) scheduleGc(GC_INTERVAL_MS);
          });
      }, ms);
      this.gcTimer.unref?.();
    };
    scheduleGc(GC_FIRST_DELAY_MS);
  }

  /** Close every copy. Files stay for reuse after the restart. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.gcTimer) clearTimeout(this.gcTimer);
    this.sweepTimer = null;
    this.gcTimer = null;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        await waitFor(entry.building ?? Promise.resolve(null), 2_000);
        if (entry.current) await entry.current.close({ drainMs: 2_000 });
      }),
    );
  }
}
