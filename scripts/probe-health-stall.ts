#!/usr/bin/env tsx
/**
 * TRA-1127 probe: how long does a full index block the event loop, and which
 * synchronous unit is responsible? Attribution by wrapping the suspect call
 * sites and recording each call's own synchronous wall time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { TraceMcpConfigSchema } from '../src/config.js';
import * as schema from '../src/db/schema.js';
import { initializeDatabase } from '../src/db/schema.js';
import * as snapshots from '../src/graph/snapshots.js';
import { Store } from '../src/db/store.js';
import { EdgeResolver } from '../src/indexer/edge-resolver.js';
import { FilePersister } from '../src/indexer/file-persister.js';
import { IndexingPipeline } from '../src/indexer/pipeline.js';
import { PluginRegistry } from '../src/plugin-api/registry.js';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const ROOT = process.argv[2] ?? REPO_ROOT;

const T0abs = performance.now();
const calls: Array<{ name: string; ms: number; start: number }> = [];
function wrap(obj: any, label: string): void {
  for (const key of Object.getOwnPropertyNames(obj)) {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (!d || typeof d.value !== 'function' || key === 'constructor') continue;
    const orig = d.value;
    obj[key] = function (this: unknown, ...args: unknown[]) {
      const t = performance.now();
      try {
        return orig.apply(this, args);
      } finally {
        calls.push({ name: `${label}.${key}`, ms: performance.now() - t, start: t - T0abs });
      }
    };
  }
}
wrap(FilePersister.prototype, 'FilePersister');
wrap(EdgeResolver.prototype, 'EdgeResolver');
wrap(Store.prototype, 'Store');
{
  const Database = (await import('better-sqlite3')).default as any;
  wrap(Database.prototype, 'DB');
}
// module-level synchronous suspects
{
  const Database = (await import('better-sqlite3')).default as any;
  wrap(Database.prototype, 'DB');
}

// Worker shim: ExtractPool checks for a sibling extract-worker.js on disk.
const WORKER_SHIM = path.join(REPO_ROOT, 'src/indexer/extract-worker.js');
let shimmed = false;
if (!fs.existsSync(WORKER_SHIM)) {
  fs.copyFileSync(path.join(REPO_ROOT, 'dist/extract-worker.js'), WORKER_SHIM);
  shimmed = true;
}
process.on('exit', () => {
  if (shimmed) fs.rmSync(WORKER_SHIM, { force: true });
});

const N = Number(process.env.PROBE_N ?? '1');
const config = TraceMcpConfigSchema.parse({ root: ROOT });
const pipelines = Array.from({ length: N }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-probe-'));
  const db = initializeDatabase(path.join(tmp, 'index.db'));
  const store = new Store(db);
  return {
    tmp,
    db,
    pipeline: new IndexingPipeline(store, PluginRegistry.createWithDefaults(), config, ROOT),
  };
});

// Real HTTP probe against a trivial handler — same shape as the daemon's /health.
const http = await import('node:http');
const srv = http.createServer((_q, res) => res.end('ok')).listen(3997);
const httpLat: number[] = [];
const httpProbe = setInterval(() => {
  const t = performance.now();
  http.get('http://127.0.0.1:3997/', (r) => {
    r.resume();
    r.on('end', () => httpLat.push(performance.now() - t));
  });
}, 20);

// Health probe: a timer that should fire every 10ms. Its overshoot is exactly
// what a /health request would wait.
const h = monitorEventLoopDelay({ resolution: 5 });
h.enable();
let worstTick = 0;
let last = performance.now();
const stalls: Array<{ at: number; ms: number }> = [];
const T0 = performance.now();
const ticker = setInterval(() => {
  const now = performance.now();
  const over = now - last - 10;
  if (over > 50) stalls.push({ at: now - T0, ms: over });
  worstTick = Math.max(worstTick, over);
  last = now;
}, 10);

const t0 = performance.now();
const results = await Promise.all(pipelines.map((p) => p.pipeline.indexAll(false)));
const r = results[0];
const wall = performance.now() - t0;
clearInterval(httpProbe);
httpLat.sort((a, b) => a - b);
clearInterval(ticker);
h.disable();
for (const p of pipelines) {
  await p.pipeline.dispose();
  p.db.close();
  fs.rmSync(p.tmp, { recursive: true, force: true });
}
srv.close();
console.log(
  `http /health latency (n=${httpLat.length}): p50=${httpLat[Math.floor(httpLat.length * 0.5)]?.toFixed(1)}ms p99=${httpLat[Math.floor(httpLat.length * 0.99)]?.toFixed(1)}ms max=${httpLat.at(-1)?.toFixed(1)}ms`,
);

console.log('stalls > 50ms (offset ms, stall ms) with top-level calls inside:');
const offset = T0 - T0abs;
for (const s of stalls) {
  const from = s.at + offset - s.ms - 10;
  const to = s.at + offset;
  const inside = calls
    .filter((c) => c.start >= from && c.start < to && c.ms > 5)
    .filter(
      (c, _i, arr) =>
        !arr.some((o) => o !== c && o.start <= c.start && o.start + o.ms >= c.start + c.ms),
    )
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 6)
    .map((c) => `${c.name}:${c.ms.toFixed(0)}`);
  console.log(`  @${s.at.toFixed(0)}  ${s.ms.toFixed(0)}ms  [${inside.join(', ')}]`);
}
const marks = calls.map((c, i) => c);
const top = calls.sort((a, b) => b.ms - a.ms).slice(0, 20);
const agg = new Map<string, { n: number; total: number; max: number }>();
for (const c of calls) {
  const a = agg.get(c.name) ?? { n: 0, total: 0, max: 0 };
  a.n++;
  a.total += c.ms;
  a.max = Math.max(a.max, c.ms);
  agg.set(c.name, a);
}
console.log(
  `N=${N} root=${ROOT} indexed=${r.indexed} skipped=${r.skipped} wall=${Math.round(wall)}ms`,
);
console.log(
  `loop delay: p50=${(h.percentile(50) / 1e6).toFixed(1)}ms p99=${(h.percentile(99) / 1e6).toFixed(1)}ms max=${(h.max / 1e6).toFixed(1)}ms  worstTimerOvershoot=${worstTick.toFixed(1)}ms`,
);
console.log('\ntop 20 single synchronous calls:');
for (const c of top) console.log(`  ${c.ms.toFixed(1)}ms  ${c.name}`);
console.log('\nby call site (total ms, n, max):');
for (const [name, a] of [...agg].sort((x, y) => y[1].total - x[1].total).slice(0, 20)) {
  console.log(`  ${a.total.toFixed(0)}ms  n=${a.n}  max=${a.max.toFixed(1)}ms  ${name}`);
}
