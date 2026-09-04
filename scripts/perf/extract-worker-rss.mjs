/**
 * Per-extract-worker RSS cost (TRA-811).
 *
 * Spawns N workers against a built `dist/extract-worker.js`, sends one real
 * extract each, and reports process RSS at four points: baseline, after spawn,
 * after one parse per worker, after terminate. The gap between the third and
 * fourth number is what an idle teardown gives back.
 *
 * Usage (after `pnpm run build`):
 *   N=8 WORKER_ENTRY=./dist/extract-worker.js EXTRACT_ROOT=$PWD \
 *     EXTRACT_FILES=src/cli.ts,src/config.ts node scripts/perf/extract-worker-rss.mjs
 *
 * macOS/Linux only — reads RSS from `ps`.
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const ENTRY = pathToFileURL(resolve(process.env.WORKER_ENTRY ?? './dist/extract-worker.js'));
const ROOT = resolve(process.env.EXTRACT_ROOT ?? process.cwd());
const FILES = (process.env.EXTRACT_FILES ?? 'src/cli.ts').split(',');
const N = Number(process.env.N ?? 8);

const rss = () => Number(execSync(`ps -o rss= -p ${process.pid}`).toString().trim()) / 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (label, mb, base) =>
  console.log(
    `${label.padEnd(34)} rss=${mb.toFixed(1)} MB` +
      (base === undefined ? '' : `  (+${(mb - base).toFixed(1)}, ${((mb - base) / N).toFixed(1)}/worker)`),
  );

await sleep(300);
const base = rss();
show('baseline', base);

const workers = Array.from({ length: N }, () => new Worker(ENTRY));
await sleep(1500);
show(`after spawn of ${N} workers`, rss(), base);

let id = 0;
for (const [i, w] of workers.entries()) {
  await new Promise((res) => {
    w.once('message', res);
    w.postMessage({
      id: ++id,
      relPath: FILES[i % FILES.length],
      rootPath: ROOT,
      force: true,
      existing: null,
      gitignored: false,
      workspaces: [],
    });
  });
}
await sleep(1500);
show('after 1 extract per worker', rss(), base);

await Promise.all(workers.map((w) => w.terminate()));
await sleep(1500);
show('after terminate', rss());
