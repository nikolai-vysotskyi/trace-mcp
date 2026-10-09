import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { initializeDatabase } from '../src/db/schema.js';
import { Store } from '../src/db/store.js';
import { PluginRegistry } from '../src/plugin-api/registry.js';
import { TraceMcpConfigSchema } from '../src/config.js';
import { IndexingPipeline } from '../src/indexer/pipeline.js';
import { FilePersister } from '../src/indexer/file-persister.js';
import {
  findPackageJsonEntries,
  clearPackageEntriesCache,
} from '../src/indexer/package-entries.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-tra-2305-'));
const root = path.join(tmp, 'project');
fs.mkdirSync(root);
fs.writeFileSync(
  path.join(root, 'package.json'),
  JSON.stringify({ name: 'bench', version: '1.0.0' }),
);
const count = Number(process.argv[2] ?? 2701);
const extraDirs = Number(process.argv[3] ?? 0);
for (let i = 0; i < count; i++) {
  const dir = path.join(root, 'src', `part-${Math.floor(i / 100)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `file-${i}.ts`),
    Array.from(
      { length: 12 },
      (_, j) => `export function fn${i}_${j}(x: number): number { return x + ${j}; }`,
    ).join('\n'),
  );
}
for (let i = 0; i < extraDirs; i++) fs.mkdirSync(path.join(root, 'src', `empty-${i}`));
const packageStart = performance.now();
findPackageJsonEntries(root, { bypassCache: true });
const packageEntriesMs = performance.now() - packageStart;
clearPackageEntriesCache(root);

const db = initializeDatabase(path.join(tmp, 'index.db'));
const store = new Store(db);
const registry = PluginRegistry.createWithDefaults();
const config = TraceMcpConfigSchema.parse({ root, include: ['**/*.ts'] });
const pipeline = new IndexingPipeline(store, registry, config, root);
const phases: Array<{ name: string; ms: number; start: number; end: number }> = [];
function wrap(proto: object, name: string, label = name) {
  const p = proto as Record<string, (...a: unknown[]) => unknown>;
  const orig = p[name];
  p[name] = function (this: unknown, ...args: unknown[]) {
    const start = performance.now();
    const result = orig.apply(this, args);
    if (result instanceof Promise)
      return result.finally(() => {
        const end = performance.now();
        phases.push({ name: label, ms: end - start, start, end });
      });
    const end = performance.now();
    phases.push({ name: label, ms: end - start, start, end });
    return result;
  };
}
for (const name of [
  'indexAll',
  'runPipeline',
  'collectFiles',
  'reconcileScope',
  'extractAndPersist',
  'resolveAllEdges',
  'runEdgeResolvers',
  'maybeAnalyze',
  'registerFrameworkEdgeTypes',
  'getWorkspaceFrameworkPlugins',
])
  wrap(IndexingPipeline.prototype, name);
wrap(PluginRegistry.prototype, 'getActiveFrameworkPlugins');
for (const plugin of registry.getAllFrameworkPlugins())
  wrap(plugin, 'detect', plugin.manifest.name);
wrap(FilePersister.prototype, 'persistBatch');
let maxLagMs = 0;
let last = performance.now();
const stalls: Array<{ lagMs: number; start: number; end: number }> = [];
const tick = setInterval(() => {
  const now = performance.now();
  const lagMs = now - last - 20;
  maxLagMs = Math.max(maxLagMs, lagMs);
  if (lagMs > 100) stalls.push({ lagMs, start: last, end: now });
  last = now;
}, 20);
const server = http.createServer((_req, res) => {
  res.end('ok');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No port');
const probe = spawn(
  process.execPath,
  [
    '-e',
    `let max=0,n=0,stop=false; process.on('SIGTERM',()=>{stop=true}); (async()=>{while(!stop){const t=Date.now();try{await fetch('http://127.0.0.1:${address.port}/health')}catch{};max=Math.max(max,Date.now()-t);n++;await new Promise(r=>setTimeout(r,20))}console.log(JSON.stringify({maxHealthMs:max,probes:n}))})()`,
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
let probeOut = '';
probe.stdout.on('data', (d) => {
  probeOut += d;
});
try {
  const started = performance.now();
  const result = await pipeline.indexAll(false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(
    JSON.stringify({
      totalMs: performance.now() - started,
      indexed: result.indexed,
      packageEntriesMs,
      maxLagMs,
      stalls: stalls
        .sort((a, b) => b.lagMs - a.lagMs)
        .slice(0, 5)
        .map((s) => ({
          ...s,
          phases: phases.filter((p) => p.start < s.end && p.end > s.start).map((p) => p.name),
        })),
      phases: phases.sort((a, b) => b.ms - a.ms).slice(0, 12),
    }),
  );
} finally {
  clearInterval(tick);
  probe.kill();
  await new Promise<void>((resolve) => probe.on('exit', () => resolve()));
  await pipeline.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(probeOut);
