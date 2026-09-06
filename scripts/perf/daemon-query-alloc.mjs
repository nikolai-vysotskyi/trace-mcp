#!/usr/bin/env node
/**
 * TRA-651 — per-endpoint allocation on the daemon's read path.
 *
 * `daemon-serving-rss.mjs` shows the daemon's RSS going from 400 MB idle to
 * 850 MB while a client drives it, with the V8 heap tracking it (91 MB → 412
 * MB) and collapsing back the moment queries stop. That is transient garbage,
 * not retention — so the useful question is which endpoint produces it and how
 * much per call. This drives one endpoint at a time and reports heap growth
 * per request.
 *
 *   node scripts/perf/daemon-query-alloc.mjs [--port 37421] [--calls 200]
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { procStats, round } from '../../packages/app/scripts/perf-lib.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = Number(flag('port', 37421));
const CALLS = Number(flag('calls', 200));
const DAEMON = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tra651q-'));
const ENV = { ...process.env, TRACE_MCP_DATA_DIR: DATA_DIR, TRACE_MCP_HOME: DATA_DIR };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(`${s}\n`);

async function req(pathname, method = 'GET', body) {
  const res = await fetch(DAEMON + pathname, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, bytes: Buffer.byteLength(text) };
}

async function mem() {
  const r = await fetch(`${DAEMON}/debug/memory`);
  return (await r.json()).process;
}

async function main() {
  const pin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages/app/scripts/perf-fixture.json'), 'utf8'),
  );
  const root = path.join(os.homedir(), '.trace-mcp', 'perf-fixture', pin.commit.slice(0, 12));
  const cli = path.join(repoRoot, 'dist', 'cli.js');
  const child = spawn(process.execPath, [cli, 'serve-http', '--port', String(PORT)], {
    stdio: 'ignore',
    cwd: DATA_DIR,
    env: ENV,
  });
  try {
    for (let i = 0; i < 240; i++) {
      try {
        if ((await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
      } catch {
        /* not up */
      }
      await sleep(500);
    }
    await req('/api/projects', 'POST', { root });
    for (let i = 0; i < 300; i++) {
      const l = await (await fetch(`${DAEMON}/api/projects`)).json();
      if (l.projects?.[0]?.status === 'ready') break;
      await sleep(2000);
    }
    const p = encodeURIComponent(root);
    const cases = {
      symbols: (q) => `/api/projects/symbols?project=${p}&q=${q}&limit=50`,
      graph: (q) => `/api/projects/graph?project=${p}&q=${q}&limit=100`,
      'graph-stats': () => `/api/projects/graph-stats?project=${p}`,
      stats: () => `/api/projects/stats?project=${p}`,
      files: () => `/api/projects/files?project=${p}`,
      smells: () => `/api/projects/smells?project=${p}`,
      health: () => '/health',
    };
    const out = {};
    for (const [name, mk] of Object.entries(cases)) {
      await sleep(4000); // let the previous case's garbage go
      const before = await mem();
      let bytes = 0;
      const t0 = Date.now();
      for (let i = 0; i < CALLS; i++) {
        const r = await req(mk(pin.queries[i % pin.queries.length]));
        bytes += r.bytes;
      }
      const ms = Date.now() - t0;
      const after = await mem();
      out[name] = {
        calls: CALLS,
        ms_per_call: round(ms / CALLS, 2),
        response_kb_per_call: round(bytes / CALLS / 1024, 1),
        heap_growth_mb: round((after.heapUsed - before.heapUsed) / 1048576, 1),
        rss_growth_mb: round((after.rss - before.rss) / 1048576, 1),
        rss_mb: round(after.rss / 1048576, 0),
        tree_rss_mb: round(procStats(child.pid).rss_mb, 0),
      };
      log(`${name}: ${JSON.stringify(out[name])}`);
    }
    process.stdout.write(
      `${JSON.stringify({ tra: 'TRA-651', calls: CALLS, cases: out }, null, 2)}\n`,
    );
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}
main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
