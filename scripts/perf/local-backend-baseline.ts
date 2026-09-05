/**
 * TRA-925 measurement harness: per-session baseline cost of one LocalBackend.
 *
 * Starts a single LocalBackend against a root and reports start latency, RSS
 * and thread count once start() resolves — the "before any work" cost the
 * issue is about. Two modes:
 *
 *   full     — a real project root (indexing stack live)
 *   readonly — a dangerous root, which LocalBackend serves read-only
 *
 * Usage: tsx scripts/perf/local-backend-baseline.ts [root] [--json]
 * Threads are read from `ps -M` (macOS) / /proc/self/status (Linux).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { LocalBackend } from '../../src/daemon/router/local-backend.js';

function threadCount(): number {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-M', String(process.pid)], { encoding: 'utf8' });
      return out.trim().split('\n').length - 1; // minus header
    }
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    return Number(/Threads:\s+(\d+)/.exec(status)?.[1] ?? 0);
  } catch {
    return -1;
  }
}

const args = process.argv.slice(2).filter((a) => a !== '--json');
const projectRoot = path.resolve(args[0] ?? process.cwd());
const indexRoot = path.join(os.tmpdir(), `tra925-${process.pid}`);
fs.mkdirSync(indexRoot, { recursive: true });

const configResult = await loadConfig(projectRoot);
if (configResult.isErr()) throw configResult.error;
const config = configResult.value;
const backend = new LocalBackend({
  projectRoot,
  indexRoot,
  config,
  sharedDbPath: path.join(indexRoot, 'index.db'),
});

const t0 = performance.now();
await backend.start();
const startMs = performance.now() - t0;

// Let anything start() kicked off settle for a moment, then sample.
await new Promise((r) => setTimeout(r, 2000));
const mem = process.memoryUsage();
console.log(
  JSON.stringify({
    root: projectRoot,
    startMs: Math.round(startMs),
    rssMB: +(mem.rss / 1024 / 1024).toFixed(1),
    heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(1),
    externalMB: +(mem.external / 1024 / 1024).toFixed(1),
    threads: threadCount(),
  }),
);
await backend.stop();
process.exit(0);
