#!/usr/bin/env tsx
/**
 * TRA-936 — indexing throughput broken down by stage, before any optimization.
 *
 * Preregistration (question, corpus, method, known-suspect predictions,
 * scope): docs/perf/prereg-index-throughput.md. Read that first — this file
 * only implements the method described there.
 *
 * Run after `pnpm run build` (the production run needs dist/extract-worker.js):
 *
 *   npx tsx scripts/bench-index-throughput.ts
 *   npx tsx scripts/bench-index-throughput.ts --json docs/perf/index-throughput.json
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Parser } from 'web-tree-sitter';

import { TraceMcpConfigSchema } from '../src/config.js';
import { initializeDatabase } from '../src/db/schema.js';
import { Store } from '../src/db/store.js';
import { ExtractPool } from '../src/indexer/extract-pool.js';
import { FileExtractor } from '../src/indexer/file-extractor.js';
import { FilePersister } from '../src/indexer/file-persister.js';
import { IndexingPipeline } from '../src/indexer/pipeline.js';
import {
  getTreeCacheStats,
  NO_TREE_CACHE_ENV,
  resetTreeCacheStats,
} from '../src/parser/tree-cache.js';
import { getParser, parseIncremental } from '../src/parser/tree-sitter.js';
import { PluginRegistry } from '../src/plugin-api/registry.js';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
// packages/app/scripts/perf-fixture.json revision 2 — this repo's own pinned
// dogfooding corpus, shared with the desktop app perf harness. Not reinvented
// here; see the prereg doc for why.
const FIXTURE_COMMIT = 'fc47c10f44eb539cbb01b0bb2e4ff633c59b7151';
const FIXTURE_ROOT = path.join(os.homedir(), '.trace', 'perf-fixture', FIXTURE_COMMIT.slice(0, 12));
const WORKER_SHIM = path.join(REPO_ROOT, 'src/indexer/extract-worker.js');
const ONE_FILE_TARGET = 'src/util/debounce.ts';
const HUNDRED_FILE_COUNT = 100;

function sh(cmd: string[], cwd = REPO_ROOT): string {
  return execFileSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf-8' }).trim();
}

function ensureFixture(): void {
  if (fs.existsSync(path.join(FIXTURE_ROOT, '.git'))) return;
  fs.mkdirSync(path.dirname(FIXTURE_ROOT), { recursive: true });
  sh(['git', 'worktree', 'add', '--detach', FIXTURE_ROOT, FIXTURE_COMMIT]);
}

/** tsx resolves `./extract-worker.js` imports to the sibling `.ts`, but
 *  ExtractPool looks it up as a raw file (`fs.existsSync`, not an import) —
 *  that check never sees tsx's loader. Copying the real build artifact next
 *  to the source file satisfies the check with the exact code that ships;
 *  removed in a `finally` and never committed. */
function ensureWorkerShim(): () => void {
  if (fs.existsSync(WORKER_SHIM)) return () => {};
  const built = path.join(REPO_ROOT, 'dist/extract-worker.js');
  if (!fs.existsSync(built)) {
    throw new Error('dist/extract-worker.js missing — run `pnpm run build` first');
  }
  fs.copyFileSync(built, WORKER_SHIM);
  return () => fs.rmSync(WORKER_SHIM, { force: true });
}

function revertFixture(): void {
  sh(['git', 'checkout', '--', '.'], FIXTURE_ROOT);
}

interface StageTotals {
  extractMs: number;
  extractCalls: number;
  extractDurations: number[];
  parseMs: number;
  parseCalls: number;
  persistMs: number;
  persistCalls: number;
  edgesMs: number;
  lspMs: number;
  scipMs: number;
  envMs: number;
  collectMs: number;
}

function freshTotals(): StageTotals {
  return {
    extractMs: 0,
    extractCalls: 0,
    extractDurations: [],
    parseMs: 0,
    parseCalls: 0,
    persistMs: 0,
    persistCalls: 0,
    edgesMs: 0,
    lspMs: 0,
    scipMs: 0,
    envMs: 0,
    collectMs: 0,
  };
}

/** Prototype-patches the pipeline's internal seams with timers. Zero
 *  production code changes — every patched method is reached through a live
 *  object's method call (`this.foo()` / `obj.foo()`), which resolves through
 *  the prototype chain at call time, so swapping the prototype method before
 *  construction is enough; no captured references to work around. */
function instrument(totals: StageTotals, opts: { patchParse: boolean }): () => void {
  const restore: Array<() => void> = [];

  const origExtract = FileExtractor.prototype.extract;
  FileExtractor.prototype.extract = async function (this: FileExtractor, ...args: unknown[]) {
    const t0 = performance.now();
    try {
      // biome-ignore lint: bench instrumentation, not production code
      return await (origExtract as any).apply(this, args);
    } finally {
      const dt = performance.now() - t0;
      totals.extractMs += dt;
      totals.extractCalls++;
      totals.extractDurations.push(dt);
    }
  } as typeof origExtract;
  restore.push(() => {
    FileExtractor.prototype.extract = origExtract;
  });

  const origPoolExtract = ExtractPool.prototype.extract;
  ExtractPool.prototype.extract = async function (this: ExtractPool, ...args: unknown[]) {
    const t0 = performance.now();
    try {
      // biome-ignore lint: bench instrumentation, not production code
      return await (origPoolExtract as any).apply(this, args);
    } finally {
      const dt = performance.now() - t0;
      totals.extractMs += dt;
      totals.extractCalls++;
      totals.extractDurations.push(dt);
    }
  } as typeof origPoolExtract;
  restore.push(() => {
    ExtractPool.prototype.extract = origPoolExtract;
  });

  const origPersist = FilePersister.prototype.persistBatch;
  FilePersister.prototype.persistBatch = function (this: FilePersister, ...args: unknown[]) {
    const t0 = performance.now();
    try {
      // biome-ignore lint: bench instrumentation, not production code
      return (origPersist as any).apply(this, args);
    } finally {
      totals.persistMs += performance.now() - t0;
      totals.persistCalls++;
    }
  } as typeof origPersist;
  restore.push(() => {
    FilePersister.prototype.persistBatch = origPersist;
  });

  // Private in TS, plain enumerable methods at runtime — reached via
  // `this.resolveAllEdges()` etc. inside pipeline.ts, so patching the
  // prototype before construction is visible to every call.
  const proto = IndexingPipeline.prototype as unknown as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  const passes: Array<[string, keyof StageTotals]> = [
    ['resolveAllEdges', 'edgesMs'],
    ['runLspEnrichment', 'lspMs'],
    ['runScipIngestion', 'scipMs'],
    ['indexEnvFiles', 'envMs'],
    ['collectFiles', 'collectMs'],
  ];
  for (const [name, key] of passes) {
    const orig = proto[name];
    proto[name] = async function (this: unknown, ...args: unknown[]) {
      const t0 = performance.now();
      try {
        return await orig.apply(this, args);
      } finally {
        (totals[key] as number) += performance.now() - t0;
      }
    };
    restore.push(() => {
      proto[name] = orig;
    });
  }

  if (opts.patchParse) {
    const origParse = Parser.prototype.parse;
    (Parser.prototype as unknown as Record<string, unknown>).parse = function (
      this: Parser,
      ...args: unknown[]
    ) {
      const t0 = performance.now();
      try {
        // biome-ignore lint: bench instrumentation, not production code
        return (origParse as any).apply(this, args);
      } finally {
        totals.parseMs += performance.now() - t0;
        totals.parseCalls++;
      }
    };
    restore.push(() => {
      (Parser.prototype as unknown as Record<string, unknown>).parse = origParse;
    });
  }

  return () => restore.forEach((r) => r());
}

function sampleRss(intervalMs = 50): () => number {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    return peak;
  };
}

const MB = 1024 * 1024;

interface RunResult {
  label: string;
  wallMs: number;
  filesTotal: number;
  filesIndexed: number;
  filesPerSec: number;
  peakRssMb: number;
  steadyRssMb: number;
  stages: {
    collectMs: number;
    extractMs: number;
    extractCalls: number;
    parseMs: number;
    parseCalls: number;
    persistMs: number;
    persistCalls: number;
    edgesMs: number;
    lspMs: number;
    scipMs: number;
    envMs: number;
  };
  workerWarmup: { firstBatchMedianMs: number; steadyMedianMs: number; poolSize: number } | null;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function runIndexAll(
  label: string,
  opts: {
    workers: boolean;
    patchParse: boolean;
    poolSizeForWarmup?: number;
    /** Inject a daemon-shaped keepAlive pool (DEFAULT_KEEPALIVE_WORKER_COUNT =
     *  min(4, cpus/2)) instead of the pipeline's own one-shot pool
     *  (DEFAULT_WORKER_COUNT = min(8, cpus-1)) — the two are sized
     *  differently and only the keepAlive one is what the issue's known
     *  suspect (extract-pool.ts:90) actually describes. */
    daemonPool?: boolean;
  },
): Promise<RunResult> {
  const prevWorkersEnv = process.env.TRACE_MCP_WORKERS;
  if (!opts.workers) process.env.TRACE_MCP_WORKERS = '0';
  else delete process.env.TRACE_MCP_WORKERS;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-bench-'));
  const dbPath = path.join(tmpDir, 'index.db');

  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  const registry = PluginRegistry.createWithDefaults();
  const config = TraceMcpConfigSchema.parse({ root: FIXTURE_ROOT });
  const injectedPool = opts.daemonPool ? new ExtractPool({ keepAlive: true }) : undefined;
  const pipeline = new IndexingPipeline(
    store,
    registry,
    config,
    FIXTURE_ROOT,
    undefined,
    injectedPool ? { extractPool: injectedPool } : undefined,
  );

  const totals = freshTotals();
  const restore = instrument(totals, { patchParse: opts.patchParse });
  const stopRss = sampleRss();

  const t0 = performance.now();
  const result = await pipeline.indexAll(false);
  const wallMs = performance.now() - t0;

  const peakRss = stopRss();
  restore();
  await pipeline.dispose();
  // dispose() deliberately does not terminate an injected (non-owned) pool —
  // that is the daemon's shared-pool contract. This harness owns it, so it
  // must clean it up itself.
  if (injectedPool) await injectedPool.terminate();
  db.close();

  await new Promise((r) => setTimeout(r, 3000));
  const steadyRss = process.memoryUsage().rss;

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (prevWorkersEnv === undefined) delete process.env.TRACE_MCP_WORKERS;
  else process.env.TRACE_MCP_WORKERS = prevWorkersEnv;

  let workerWarmup: RunResult['workerWarmup'] = null;
  if (opts.workers && opts.poolSizeForWarmup) {
    const n = opts.poolSizeForWarmup;
    const first = totals.extractDurations.slice(0, n);
    const rest = totals.extractDurations.slice(n);
    workerWarmup = {
      firstBatchMedianMs: median(first),
      steadyMedianMs: median(rest),
      poolSize: n,
    };
  }

  return {
    label,
    wallMs,
    filesTotal: result.totalFiles,
    filesIndexed: result.indexed,
    filesPerSec: result.indexed / (wallMs / 1000),
    peakRssMb: peakRss / MB,
    steadyRssMb: steadyRss / MB,
    stages: {
      collectMs: totals.collectMs,
      extractMs: totals.extractMs,
      extractCalls: totals.extractCalls,
      parseMs: totals.parseMs,
      parseCalls: totals.parseCalls,
      persistMs: totals.persistMs,
      persistCalls: totals.persistCalls,
      edgesMs: totals.edgesMs,
      lspMs: totals.lspMs,
      scipMs: totals.scipMs,
      envMs: totals.envMs,
    },
    workerWarmup,
  };
}

async function runIncremental(label: string, touchedFiles: string[]): Promise<RunResult> {
  for (const rel of touchedFiles) {
    const abs = path.join(FIXTURE_ROOT, rel);
    fs.appendFileSync(abs, '\n// bench: TRA-936 incremental touch\n');
  }

  const dbPath = path.join(os.tmpdir(), 'trace-mcp-bench-incremental-shared.db');
  // Fresh cold index first (untouched content) so the incremental pass below
  // has a warm store to diff against — this DB is discarded after.
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });

  revertFixture();
  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  const registry = PluginRegistry.createWithDefaults();
  const config = TraceMcpConfigSchema.parse({ root: FIXTURE_ROOT });
  const warmPipeline = new IndexingPipeline(store, registry, config, FIXTURE_ROOT);
  await warmPipeline.indexAll(false);
  await warmPipeline.dispose();
  db.close();

  for (const rel of touchedFiles) {
    const abs = path.join(FIXTURE_ROOT, rel);
    fs.appendFileSync(abs, '\n// bench: TRA-936 incremental touch\n');
  }

  const db2 = initializeDatabase(dbPath);
  const store2 = new Store(db2);
  const registry2 = PluginRegistry.createWithDefaults();
  const pipeline2 = new IndexingPipeline(store2, registry2, config, FIXTURE_ROOT);

  const totals = freshTotals();
  const restore = instrument(totals, { patchParse: false });
  const stopRss = sampleRss();
  const t0 = performance.now();
  const result = await pipeline2.indexAll(false);
  const wallMs = performance.now() - t0;
  const peakRss = stopRss();
  restore();
  await pipeline2.dispose();
  db2.close();

  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  revertFixture();

  return {
    label,
    wallMs,
    filesTotal: result.totalFiles,
    filesIndexed: result.indexed,
    filesPerSec: result.indexed / (wallMs / 1000),
    peakRssMb: peakRss / MB,
    steadyRssMb: process.memoryUsage().rss / MB,
    stages: {
      collectMs: totals.collectMs,
      extractMs: totals.extractMs,
      extractCalls: totals.extractCalls,
      parseMs: totals.parseMs,
      parseCalls: totals.parseCalls,
      persistMs: totals.persistMs,
      persistCalls: totals.persistCalls,
      edgesMs: totals.edgesMs,
      lspMs: totals.lspMs,
      scipMs: totals.scipMs,
      envMs: totals.envMs,
    },
    workerWarmup: null,
  };
}

function pickHundredFiles(): string[] {
  const out = sh(['git', 'ls-files', 'src'], FIXTURE_ROOT)
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
    .slice(0, HUNDRED_FILE_COUNT);
  if (out.length < HUNDRED_FILE_COUNT) {
    throw new Error(
      `fixture only has ${out.length} eligible .ts files, need ${HUNDRED_FILE_COUNT}`,
    );
  }
  return out;
}

// ── TRA-1577: realistic edit-session scenario ─────────────────────────────
//
// Drives a synthetic project through a deterministic 60-edit session shaped
// like watcher traffic — one file changed, one `indexFiles([file])` — and
// measures (a) the share of edited files that reparsed incrementally and
// (b) the wall-time + tree-sitter parse-time win vs the cache disabled.
//
// Both arms run in-process (`TRACE_MCP_WORKERS=0`): single-file watcher
// batches never reach the worker pool in production either (they sit far
// below the pool threshold), so the main-thread `Parser.prototype.parse`
// patch sees every parse and the numbers describe the real watcher path.

const EDIT_SESSION_FILES = 40;
const EDIT_SESSION_EDITS = 60;

/** Deterministic PRNG so both arms replay the identical edit script. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSessionFile(fnCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < fnCount; i++) {
    lines.push(`export function fn${i}(x: number): number {`, `  return x + ${i};`, `}`, ``);
  }
  return lines.join('\n');
}

/** One deterministic edit; always changes size (defeats the mtime prefilter). */
function applySessionEdit(source: string, rand: () => number, n: number): string {
  const op = Math.floor(rand() * 4);
  if (op === 0) {
    // Append a new function.
    return `${source}\nexport function added${n}(x: number): number {\n  return x * ${n};\n}\n`;
  }
  if (op === 1) {
    // Prepend a comment line (comment-only change).
    return `// session edit ${n}\n${source}`;
  }
  if (op === 2) {
    // Tweak a return literal.
    return source.replace(/return x \+ (\d+);/, (_m, k) => `return x + ${Number(k) + 1000};`);
  }
  // Rename the first function (single occurrence — declaration only).
  const m = source.match(/export function (fn\d+|added\d+)\(/);
  if (!m) return `${source}\n// fallback touch ${n}\n`;
  return source.replace(m[1], `${m[1]}r${n}`);
}

interface EditSessionArm {
  label: string;
  sessionWallMs: number;
  parseMs: number;
  parseCalls: number;
  indexedTotal: number;
  incrementalParses: number;
  fullParses: number;
  identicalHits: number;
  incrementalShare: number;
  finalSymbols: number;
}

interface EditSessionComparison {
  files: number;
  edits: number;
  withCache: EditSessionArm;
  withoutCache: EditSessionArm;
  micro: {
    fullParseMedianMs: number;
    incrementalMedianMs: number;
    speedupVsFull: number;
  };
}

async function runEditSessionArm(label: string, useCache: boolean): Promise<EditSessionArm> {
  const prevWorkers = process.env.TRACE_MCP_WORKERS;
  const prevNoCache = process.env[NO_TREE_CACHE_ENV];
  process.env.TRACE_MCP_WORKERS = '0';
  if (useCache) delete process.env[NO_TREE_CACHE_ENV];
  else process.env[NO_TREE_CACHE_ENV] = '1';

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-edit-session-'));
  const dbPath = path.join(projectDir, 'index.db');
  // 30 small + 8 medium + 2 large files: parse weight concentrated where
  // incremental reuse matters, long tail where it doesn't.
  const relPaths: string[] = [];
  const contents = new Map<string, string>();
  try {
    const rand = mulberry32(0x1577);
    for (let i = 0; i < EDIT_SESSION_FILES; i++) {
      const rel = `src/mod${i}.ts`;
      const fnCount = i < 30 ? 12 : i < 38 ? 120 : 900;
      const text = makeSessionFile(fnCount);
      fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, rel), text);
      relPaths.push(rel);
      contents.set(rel, text);
    }

    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    const registry = PluginRegistry.createWithDefaults();
    const config = TraceMcpConfigSchema.parse({ root: projectDir });
    const pipeline = new IndexingPipeline(store, registry, config, projectDir);
    await pipeline.indexAll(false);
    // The warm pass seeds the cache (arm-dependent); the session below is
    // what we measure.
    resetTreeCacheStats();
    const totals = freshTotals();
    const restore = instrument(totals, { patchParse: true });

    let indexedTotal = 0;
    const sessionT0 = performance.now();
    try {
      for (let n = 0; n < EDIT_SESSION_EDITS; n++) {
        // Round-robin with repeats: every file is edited ~1.5×, so the
        // second touch onwards can reuse the first touch's tree.
        const rel = relPaths[n % relPaths.length];
        const next = applySessionEdit(contents.get(rel)!, rand, n);
        contents.set(rel, next);
        fs.writeFileSync(path.join(projectDir, rel), next);
        const r = await pipeline.indexFiles([rel]);
        indexedTotal += r.indexed;
      }
    } finally {
      restore();
    }
    const sessionWallMs = performance.now() - sessionT0;
    const cacheStats = getTreeCacheStats();
    const finalSymbols = store.getStats().totalSymbols;
    await pipeline.dispose();
    db.close();

    const incrementalShare =
      cacheStats.incrementalParses + cacheStats.fullParses === 0
        ? 0
        : cacheStats.incrementalParses / (cacheStats.incrementalParses + cacheStats.fullParses);
    return {
      label,
      sessionWallMs,
      parseMs: totals.parseMs,
      parseCalls: totals.parseCalls,
      indexedTotal,
      incrementalParses: cacheStats.incrementalParses,
      fullParses: cacheStats.fullParses,
      identicalHits: cacheStats.identicalHits,
      incrementalShare,
      finalSymbols,
    };
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    if (prevWorkers === undefined) delete process.env.TRACE_MCP_WORKERS;
    else process.env.TRACE_MCP_WORKERS = prevWorkers;
    if (prevNoCache === undefined) delete process.env[NO_TREE_CACHE_ENV];
    else process.env[NO_TREE_CACHE_ENV] = prevNoCache;
  }
}

/** Parse-level microbench on a large file: full vs incremental medians. */
async function runIncrementalMicro(): Promise<EditSessionComparison['micro']> {
  const parser = await getParser('typescript');
  const base = makeSessionFile(900);
  const full: number[] = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    const tree = parser.parse(base);
    full.push(performance.now() - t0);
    tree.delete();
  }
  const incr: number[] = [];
  let oldTree = parser.parse(base);
  let oldText = base;
  try {
    for (let i = 0; i < 15; i++) {
      const next = `${oldText}\nexport function micro${i}(): number {\n  return ${i};\n}\n`;
      const t0 = performance.now();
      const newTree = await parseIncremental('typescript', oldTree, oldText, next);
      incr.push(performance.now() - t0);
      if (newTree !== oldTree) oldTree.delete();
      oldTree = newTree;
      oldText = next;
    }
  } finally {
    oldTree.delete();
  }
  const fullParseMedianMs = median(full);
  const incrementalMedianMs = median(incr);
  return {
    fullParseMedianMs,
    incrementalMedianMs,
    speedupVsFull: fullParseMedianMs / Math.max(incrementalMedianMs, 1e-9),
  };
}

async function runEditSessionComparison(): Promise<EditSessionComparison> {
  console.error('[bench] edit session — cache arm...');
  const withCache = await runEditSessionArm('edit_session_cached', true);
  console.error(
    `[bench]   cached: ${withCache.sessionWallMs.toFixed(0)} ms wall, ` +
      `${withCache.parseMs.toFixed(1)} ms parse, ` +
      `incremental ${withCache.incrementalParses}/${withCache.incrementalParses + withCache.fullParses}`,
  );
  console.error('[bench] edit session — no-cache arm...');
  const withoutCache = await runEditSessionArm('edit_session_nocache', false);
  console.error(
    `[bench]   no-cache: ${withoutCache.sessionWallMs.toFixed(0)} ms wall, ` +
      `${withoutCache.parseMs.toFixed(1)} ms parse`,
  );
  console.error('[bench] edit session — parse-level microbench...');
  const micro = await runIncrementalMicro();
  console.error(
    `[bench]   micro: full ${micro.fullParseMedianMs.toFixed(2)} ms vs ` +
      `incremental ${micro.incrementalMedianMs.toFixed(2)} ms ` +
      `(${micro.speedupVsFull.toFixed(1)}x)`,
  );
  // Cross-arm sanity: both arms must index the same graph (identical edit
  // script) — otherwise the comparison is meaningless.
  if (withCache.finalSymbols !== withoutCache.finalSymbols) {
    throw new Error(
      `edit-session arms diverged: ${withCache.finalSymbols} vs ${withoutCache.finalSymbols} symbols`,
    );
  }
  return { files: EDIT_SESSION_FILES, edits: EDIT_SESSION_EDITS, withCache, withoutCache, micro };
}

async function main() {
  // TRA-1577: the edit-session scenario is self-contained (synthetic tmp
  // project, no fixture, no build artifact) so it runs standalone:
  //   npx tsx scripts/bench-index-throughput.ts --edit-session-only
  if (process.argv.includes('--edit-session-only')) {
    const session = await runEditSessionComparison();
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  console.error(`[bench] fixture: ${FIXTURE_ROOT} @ ${FIXTURE_COMMIT.slice(0, 12)}`);
  ensureFixture();
  revertFixture();

  // Pool eligibility (WORKER_THRESHOLD = 100 files) is decided by the size of
  // the FULL file walk, not the changed-file count — collectFiles() always
  // returns the whole ~1800-file corpus, so the pool is in play for every run
  // below including the 1-file and 100-file incremental cases. The shim must
  // stay in place for the whole benchmark, not just the first cold run.
  const removeShim = ensureWorkerShim();
  let production: RunResult;
  let daemonPooled: RunResult;
  let diagnostic: RunResult;
  let incremental1: RunResult;
  let incremental100: RunResult;
  let editSession: Awaited<ReturnType<typeof runEditSessionComparison>>;
  try {
    console.error('[bench] cold index — production (one-shot pool, min(8,cpus-1))...');
    production = await runIndexAll('cold_production_pooled', {
      workers: true,
      patchParse: false,
      // Mirrors DEFAULT_WORKER_COUNT in extract-pool.ts — the one-shot
      // (non-daemon-keepalive) pool size this benchmark actually exercises.
      // The daemon's shared keepalive pool uses a different, smaller default
      // (DEFAULT_KEEPALIVE_WORKER_COUNT = min(4, cpus/2)) — see the report.
      poolSizeForWarmup: Math.max(1, Math.min(8, os.cpus().length - 1)),
    });
    console.error(
      `[bench]   ${production.filesIndexed} files in ${production.wallMs.toFixed(0)} ms`,
    );

    console.error('[bench] cold index — daemon-shaped keepalive pool (min(4,cpus/2))...');
    daemonPooled = await runIndexAll('cold_daemon_keepalive_pool', {
      workers: true,
      patchParse: false,
      daemonPool: true,
      poolSizeForWarmup: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))),
    });
    console.error(
      `[bench]   ${daemonPooled.filesIndexed} files in ${daemonPooled.wallMs.toFixed(0)} ms`,
    );

    console.error('[bench] cold index — single-threaded diagnostic (parse-time split)...');
    diagnostic = await runIndexAll('cold_single_threaded_diagnostic', {
      workers: false,
      patchParse: true,
    });
    console.error(
      `[bench]   ${diagnostic.filesIndexed} files in ${diagnostic.wallMs.toFixed(0)} ms`,
    );

    console.error('[bench] incremental — 1 file...');
    incremental1 = await runIncremental('incremental_1_file', [ONE_FILE_TARGET]);
    console.error(`[bench]   ${incremental1.wallMs.toFixed(0)} ms`);

    console.error('[bench] incremental — 100 files...');
    const hundred = pickHundredFiles();
    incremental100 = await runIncremental('incremental_100_files', hundred);
    console.error(`[bench]   ${incremental100.wallMs.toFixed(0)} ms`);

    console.error('[bench] edit session — tree-sitter cache on vs off...');
    editSession = await runEditSessionComparison();
    console.error(
      `[bench]   session wall: cache ${editSession.withCache.sessionWallMs.toFixed(0)} ms vs ` +
        `no-cache ${editSession.withoutCache.sessionWallMs.toFixed(0)} ms ` +
        `(incremental share ${((editSession.withCache.incrementalShare ?? 0) * 100).toFixed(1)}%)`,
    );
  } finally {
    removeShim();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    fixtureCommit: FIXTURE_COMMIT,
    node: process.version,
    platform: `${os.platform()} ${os.release()} / ${os.arch()}`,
    cpuCount: os.cpus().length,
    runs: [production, daemonPooled, diagnostic, incremental1, incremental100],
    // Derived read for the single-threaded diagnostic run: extract-total
    // minus tree-sitter parse-time is disk read + framework-plugin
    // extraction + hashing (a remainder, not a direct measurement — see
    // prereg doc).
    diagnosticExtractRemainderMs: diagnostic.stages.extractMs - diagnostic.stages.parseMs,
    // TRA-1577: realistic edit session (watcher-shaped single-file reindexes)
    // with the per-file tree-sitter cache on vs off. Self-contained — also
    // runnable alone via --edit-session-only.
    editSession,
  };

  const jsonFlagIdx = process.argv.indexOf('--json');
  if (jsonFlagIdx !== -1 && process.argv[jsonFlagIdx + 1]) {
    fs.writeFileSync(process.argv[jsonFlagIdx + 1], `${JSON.stringify(report, null, 2)}\n`);
    console.error(`[bench] wrote ${process.argv[jsonFlagIdx + 1]}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
