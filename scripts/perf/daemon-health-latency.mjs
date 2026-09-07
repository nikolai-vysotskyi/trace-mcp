#!/usr/bin/env node
/**
 * TRA-1127 — how long does `/health` stop answering while the daemon indexes?
 *
 * The production symptom was a `/health` that accepted the connection and then
 * never replied inside 5 s, at 99% CPU, with the main thread 62% inside
 * synchronous `better-sqlite3`. A session that cannot reach `/health` concludes
 * the daemon is dead and falls back to indexing the repo itself, so a merely
 * busy daemon manufactures N independent indexers.
 *
 *   node scripts/perf/daemon-health-latency.mjs [--port 37419] [--touch 300]
 *
 * Phases (a probe hits `/health` every 100 ms throughout, 10 s timeout):
 *   index — register the pinned fixture, poll until it is served
 *   burst — touch `--touch` source files at once, poll until reindexed
 *
 * Prints JSON: per-phase p50/p95/max latency and how many probes exceeded the
 * 2 s watchdog the desktop app uses. Every number is a reading.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const PORT = Number(flag('port', 37419));
const TOUCH = Number(flag('touch', 300));
const PROJECTS = Number(flag('projects', 1));
const DAEMON = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tra1127-'));
const ENV = {
  ...process.env,
  TRACE_MCP_DATA_DIR: DATA_DIR,
  TRACE_MCP_HOME: DATA_DIR,
  TRACE_MCP_AUTO_UPDATE: '0',
  TRACE_MCP_NO_UPDATE_CHECK: '1',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(`${s}\n`);
const pct = (xs, p) =>
  xs.length
    ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]
    : null;

function fixture() {
  const pin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages/app/scripts/perf-fixture.json'), 'utf8'),
  );
  // realpath: on macOS os.tmpdir() is a symlink and the watcher canonicalizes,
  // so an uncanonicalized root silently receives no fs events. Extracting into
  // a throwaway dir also keeps the fixture out of ~/.trace-mcp, which the
  // watcher excludes.
  const dirs = [];
  for (let i = 0; i < PROJECTS; i++) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tra1127-fx-')));
    execFileSync('/bin/sh', ['-c', `git archive ${pin.commit} | tar -x -C "${dir}"`], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    dirs.push(dir);
  }
  return dirs;
}

/** Background probe: one in-flight /health at a time, ~10/s, tagged by phase. */
function startProbe(state) {
  const samples = [];
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const t0 = performance.now();
      let ok = false;
      try {
        const res = await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(10_000) });
        ok = res.ok;
        await res.text();
      } catch {
        ok = false;
      }
      samples.push({ phase: state.phase, ms: performance.now() - t0, ok });
      await sleep(100);
    }
  })();
  return {
    samples,
    stop: async () => {
      stop = true;
      await loop;
    },
  };
}

function summarize(samples, phase) {
  const xs = samples.filter((s) => s.phase === phase);
  const ms = xs.map((s) => s.ms);
  return {
    probes: xs.length,
    failed: xs.filter((s) => !s.ok).length,
    over_2s: ms.filter((m) => m >= 2000).length,
    p50_ms: Math.round(pct(ms, 0.5) ?? 0),
    p95_ms: Math.round(pct(ms, 0.95) ?? 0),
    max_ms: Math.round(Math.max(0, ...ms)),
  };
}

async function req(method, pathname, body) {
  const res = await fetch(DAEMON + pathname, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}`);
  return res.json().catch(() => ({}));
}

async function totals(roots) {
  const parts = await Promise.all(
    roots.map((r) => indexedFiles(r).catch(() => ({ files: 0, symbols: 0, edges: 0 }))),
  );
  return parts.reduce(
    (a, b) => ({
      files: a.files + b.files,
      symbols: a.symbols + b.symbols,
      edges: a.edges + b.edges,
    }),
    { files: 0, symbols: 0, edges: 0 },
  );
}

async function indexedFiles(root) {
  const s = await req('GET', `/api/projects/stats?project=${encodeURIComponent(root)}`).catch(
    () => null,
  );
  return s
    ? { files: s.files ?? 0, symbols: s.symbols ?? 0, edges: s.edges ?? 0 }
    : { files: 0, symbols: 0, edges: 0 };
}

let FIXTURES = [];

async function main() {
  const roots = fixture();
  FIXTURES = roots;
  const root = roots[0];
  const cli = path.join(repoRoot, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error(`missing ${cli} — pnpm run build first`);
  const child = spawn(process.execPath, [cli, 'serve-http', '--port', String(PORT)], {
    stdio: 'ignore',
    cwd: DATA_DIR,
    env: ENV,
  });
  const state = { phase: 'startup' };
  let probe;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
      } catch {}
      await sleep(300);
    }
    probe = startProbe(state);

    state.phase = 'index';
    log(`registering ${roots.length} fixture copies…`);
    const t0 = performance.now();
    // All at once: the production report had 21 projects loaded, and what
    // starves /health is the depth of the macrotask queue, not one project.
    await Promise.all(roots.map((r) => req('POST', '/api/projects', { root: r })));
    // Wait until the index settles: file count stops moving for 3 s.
    let last = { files: -1 },
      stable = 0;
    while (stable < 3 && performance.now() - t0 < 300_000) {
      await sleep(1000);
      const n = await totals(roots).catch(() => last);
      stable = n.files === last.files && n.files > 0 ? stable + 1 : 0;
      last = n;
    }
    const indexMs = Math.round(performance.now() - t0);
    log(`indexed ${last.files} files / ${last.symbols} symbols in ${indexMs} ms`);
    await sleep(2000);

    state.phase = 'burst';
    log(`touching ${TOUCH} files…`);
    const files = fs
      .readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.includes('__tests__'))
      .slice(0, TOUCH);
    const t1 = performance.now();
    for (const r of roots)
      for (const f of files) {
        const p = path.join(r, 'src', f);
        // A real new symbol per file — a comment-only edit is hash-different but
        // adds nothing to `symbols`, so the settle check would never see the work.
        fs.appendFileSync(p, `\nexport const tra1127Burst${t1 | 0} = ${Date.now()};\n`);
      }
    // Hold until the reindex is visibly done: symbol count moves and then
    // settles for 5 s. A burst that never lands would measure nothing.
    const symbolsBefore = last.symbols;
    let bl = last,
      bstable = 0,
      moved = false;
    while (performance.now() - t1 < 180_000) {
      await sleep(1000);
      const n = await totals(roots).catch(() => bl);
      if (n.symbols !== bl.symbols || n.edges !== bl.edges) {
        moved = true;
        bstable = 0;
      } else if (moved) bstable++;
      bl = n;
      if (moved && bstable >= 5) break;
    }
    const burstMs = Math.round(performance.now() - t1);
    log(`burst settled after ${burstMs} ms (+${bl.symbols - symbolsBefore} symbols)`);

    await probe.stop();
    const out = {
      version: JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version,
      at: new Date().toISOString(),
      projects: roots.length,
      fixture: { root, ...last },
      touched: files.length * roots.length,
      burst_symbols_added: bl.symbols - symbolsBefore,
      burst_observed: moved,
      index_ms: indexMs,
      burst_window_ms: burstMs,
      phases: {
        index: summarize(probe.samples, 'index'),
        burst: summarize(probe.samples, 'burst'),
      },
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } finally {
    if (probe) await probe.stop().catch(() => {});
    child.kill('SIGTERM');
    await sleep(1500);
    child.kill('SIGKILL');
    if (!process.env.KEEP_DATA_DIR) fs.rmSync(DATA_DIR, { recursive: true, force: true });
    else log(`data dir kept: ${DATA_DIR}`);
    if (!process.env.KEEP_DATA_DIR)
      for (const d of FIXTURES) fs.rmSync(d, { recursive: true, force: true });
  }
}

main().catch((e) => {
  log(String(e));
  process.exit(1);
});
