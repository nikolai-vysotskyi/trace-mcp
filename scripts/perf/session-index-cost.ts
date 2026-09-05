/**
 * TRA-925: memory/throughput cost of one stdio session's ExtractPool.
 *
 * Runs a full index of a project through the same pipeline a fallback session
 * uses, with a given worker count, and reports wall time, peak RSS and thread
 * count. Peak RSS is sampled from `ps`, so it includes worker-thread heaps —
 * which is the whole point: worker threads live inside the session's RSS.
 *
 * Requires `pnpm run build` first: unbundled runs resolve no worker entry, and
 * the pipeline then falls back to in-process extraction — which would make
 * every worker count measure the same thing.
 *
 * Usage: pnpm run build && WORKERS=4 tsx scripts/perf/session-index-cost.ts [root]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { ExtractPool } from '../../src/indexer/extract-pool.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { SqliteTaskCache } from '../../src/pipeline/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { ProgressState } from '../../src/progress.js';

const rssMB = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(process.pid)])) / 1024;
const threads = () =>
  execFileSync('ps', ['-M', String(process.pid)], { encoding: 'utf8' })
    .trim()
    .split('\n').length - 1;

const root = path.resolve(process.argv[2] ?? process.cwd());
const workers = Number(process.env.WORKERS ?? 4);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tra925-'));
const configResult = await loadConfig(root);
if (configResult.isErr()) throw configResult.error;
const config = configResult.value;

const db = initializeDatabase(path.join(dir, 'index.db'));
const store = new Store(db);
const registry = PluginRegistry.createWithDefaults();
const progress = new ProgressState(db);
const workerEntry = pathToFileURL(
  path.resolve(import.meta.dirname, '../../dist/extract-worker.js'),
);
if (!fs.existsSync(workerEntry)) {
  throw new Error(`no worker entry at ${workerEntry.pathname} — run \`pnpm run build\` first`);
}
const pool = new ExtractPool({ keepAlive: true, size: workers, workerEntry });
if (!pool.available)
  throw new Error('extract pool unavailable — would measure in-process extraction');
const pipeline = new IndexingPipeline(store, registry, config, root, progress, {
  extractPool: pool,
  taskCache: new SqliteTaskCache(db),
});

let peak = rssMB();
let peakThreads = threads();
const sampler = setInterval(() => {
  peak = Math.max(peak, rssMB());
  peakThreads = Math.max(peakThreads, threads());
}, 250);

const t0 = performance.now();
await pipeline.indexAll();
const ms = Math.round(performance.now() - t0);
clearInterval(sampler);
peak = Math.max(peak, rssMB());
peakThreads = Math.max(peakThreads, threads());

console.log(
  JSON.stringify({
    root,
    workers,
    indexMs: ms,
    files: store.db.prepare('SELECT COUNT(*) c FROM files').get() as unknown,
    symbols: store.db.prepare('SELECT COUNT(*) c FROM symbols').get() as unknown,
    peakRssMB: +peak.toFixed(1),
    peakThreads,
  }),
);
await pipeline.dispose();
await pool.terminate();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
