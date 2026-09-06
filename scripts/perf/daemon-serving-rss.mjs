#!/usr/bin/env node
/**
 * TRA-651 — daemon RSS while serving exactly one project.
 *
 * The number in TRA-651 (727 MB idle / 1014 MB peak) came out of the full
 * Electron workload harness, where the app is only the load generator. This
 * script is the daemon half of that on its own: same pinned fixture, same
 * REST endpoints the app's Overview/Graph/Activity views hit, no renderer.
 * That makes a run ~12 minutes instead of ~45 and attributes every byte to
 * `serve-http`.
 *
 *   node scripts/perf/daemon-serving-rss.mjs [--port 37413] [--drive-seconds 180]
 *                                            [--idle-seconds 480] [--searches 5720]
 *
 * Phases, each sampled once a second across the whole daemon process tree:
 *   index   — register the fixture, wait until served
 *   idleA   — 60 s untouched, immediately post-index   → `idle_after_index_mb`
 *   drive   — the app's query mix                      → `serving_peak_mb`
 *   idleB   — untouched again, long enough to cross the extract-pool
 *             idle-release window (TRA-811, 5 min)     → `idle_after_drive_mb`
 *
 * Prints JSON on stdout. Every number is a reading; nothing here is modelled.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { median, procStats, round } from '../../packages/app/scripts/perf-lib.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(flag('port', 37413));
const DRIVE_SECONDS = Number(flag('drive-seconds', 180));
const IDLE_SECONDS = Number(flag('idle-seconds', 480));
const SEARCHES = Number(flag('searches', 5720));
const DAEMON = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

// Throwaway data dir: an empty registry, so "one project" is literally true.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tra651-'));
const ENV = {
  ...process.env,
  TRACE_MCP_DATA_DIR: DATA_DIR,
  TRACE_MCP_HOME: DATA_DIR,
  TRACE_MCP_AUTO_UPDATE: '0',
  TRACE_MCP_NO_UPDATE_CHECK: '1',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stderr.write(`${s}\n`);

function fixture() {
  const pin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages/app/scripts/perf-fixture.json'), 'utf8'),
  );
  const dir = path.join(os.homedir(), '.trace-mcp', 'perf-fixture', pin.commit.slice(0, 12));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', dir, pin.commit], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }
  return { dir, queries: pin.queries };
}

async function req(method, pathname, body) {
  const res = await fetch(DAEMON + pathname, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}`);
  return res.json().catch(() => ({}));
}

async function waitHealthy(deadline) {
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`daemon never came up on ${PORT}`);
}

/** heapUsed alongside RSS — the gap between them is the whole question here. */
async function heapMb() {
  const m = await req('GET', '/debug/memory').catch(() => null);
  return m ? round(m.process.heapUsed / 1048576, 0) : null;
}

/**
 * Sample the tree once a second for `seconds`, without driving anything.
 * Returns the raw series so the caller can take its own median/peak.
 */
async function sampleIdle(pid, seconds, label) {
  const series = [];
  for (let i = 0; i < seconds; i++) {
    const s = procStats(pid);
    // /debug/memory is a `process.memoryUsage()` read on an otherwise idle
    // daemon — cheap enough to poll at the sample rate, and without it there
    // is no way to tell retained bytes from bytes V8 has not handed back.
    const heap = i % 5 === 0 ? await heapMb() : (series.at(-1)?.heap_mb ?? null);
    series.push({
      t: i,
      rss_mb: round(s.rss_mb, 0),
      heap_mb: heap,
      cpu_pct: round(s.cpu),
      procs: s.procs,
    });
    if (i % 60 === 0) {
      log(`  ${label} t=${i}s rss=${round(s.rss_mb, 0)}MB heap=${heap}MB procs=${s.procs}`);
    }
    await sleep(1000);
  }
  return series;
}

async function main() {
  const { dir: root, queries } = fixture();
  const cli = path.join(repoRoot, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error(`missing ${cli} — pnpm run build first`);

  log(`data dir ${DATA_DIR}`);
  // cwd is deliberately the throwaway data dir, not the repo: a daemon started
  // inside a checkout picks that checkout up as a project of its own, and then
  // "exactly one project" is no longer true.
  const child = spawn(process.execPath, [cli, 'serve-http', '--port', String(PORT)], {
    stdio: 'ignore',
    cwd: DATA_DIR,
    env: ENV,
  });
  const pid = child.pid;
  try {
    await waitHealthy(Date.now() + 120_000);
    const baseline = round(procStats(pid).rss_mb, 0);
    log(`daemon up, pid ${pid}, baseline ${baseline}MB`);

    // ── index ────────────────────────────────────────────────────────────
    const t0 = Date.now();
    const added = await req('POST', '/api/projects', { root });
    if (added.status === 'using_parent') throw new Error(`fixture rerouted to ${added.project}`);
    // Wait for `status === 'ready'`, not for `files > 0`: the first symbols
    // land within seconds and a `files > 0` gate measures a daemon that is
    // still mid-index, which is a different state entirely.
    let stats = null;
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const list = await req('GET', '/api/projects').catch(() => null);
      const me = list?.projects?.find((x) => x.root === root);
      if (me?.error) throw new Error(`fixture failed to index: ${me.error}`);
      if (me?.status === 'ready') {
        stats = await req('GET', `/api/projects/stats?project=${encodeURIComponent(root)}`);
        if (stats?.files > 0) break;
      }
      await sleep(2000);
    }
    if (!stats?.files) throw new Error('fixture never got indexed');
    const registered = (await req('GET', '/api/projects')).projects;
    const indexSeconds = round((Date.now() - t0) / 1000);
    log(`indexed ${stats.files} files / ${stats.symbols} symbols in ${indexSeconds}s`);

    // ── idleA ────────────────────────────────────────────────────────────
    const idleA = await sampleIdle(pid, 60, 'idleA');

    // ── drive ────────────────────────────────────────────────────────────
    const p = encodeURIComponent(root);
    const views = [
      `/api/projects/stats?project=${p}`,
      `/api/projects/graph-stats?project=${p}`,
      `/api/projects/smells?project=${p}`,
      `/api/projects/coverage?project=${p}`,
      `/api/projects/files?project=${p}`,
    ];
    const drive = [];
    let searches = 0;
    let sampled = 0;
    const driveEnd = Date.now() + DRIVE_SECONDS * 1000;
    while (Date.now() < driveEnd && searches < SEARCHES) {
      const q = queries[searches % queries.length];
      await Promise.all([
        req('GET', `/api/projects/symbols?project=${p}&q=${q}&limit=50`).catch(() => null),
        req('GET', `/api/projects/graph?project=${p}&q=${q}&limit=100`).catch(() => null),
      ]);
      searches += 2;
      if (searches % 40 === 0) {
        await req('GET', views[(searches / 40) % views.length]).catch(() => null);
      }
      const now = Date.now();
      if (now - sampled >= 1000) {
        sampled = now;
        const s = procStats(pid);
        drive.push({
          rss_mb: round(s.rss_mb, 0),
          heap_mb: await heapMb(),
          cpu_pct: round(s.cpu),
          procs: s.procs,
        });
      }
    }
    log(`drove ${searches} queries; peak ${Math.max(...drive.map((d) => d.rss_mb))}MB`);
    const memAtPeak = await req('GET', '/debug/memory').catch(() => null);

    // ── idleB ────────────────────────────────────────────────────────────
    const idleB = await sampleIdle(pid, IDLE_SECONDS, 'idleB');
    const memAfterIdle = await req('GET', '/debug/memory').catch(() => null);

    const out = {
      tra: 'TRA-651',
      at: new Date().toISOString(),
      version: JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version,
      commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })
        .toString()
        .trim(),
      fixture: { root, files: stats.files, symbols: stats.symbols, index_seconds: indexSeconds },
      registered,
      searches,
      baseline_rss_mb: baseline,
      idle_after_index_mb: median(idleA.map((s) => s.rss_mb)),
      idle_after_index_heap_mb: median(idleA.map((s) => s.heap_mb).filter((h) => h != null)),
      serving_median_mb: median(drive.map((s) => s.rss_mb)),
      serving_peak_mb: Math.max(...drive.map((s) => s.rss_mb)),
      serving_peak_heap_mb: Math.max(...drive.map((s) => s.heap_mb ?? 0)),
      idle_after_drive_mb: median(idleB.slice(-60).map((s) => s.rss_mb)),
      idle_after_drive_heap_mb: median(
        idleB
          .slice(-60)
          .map((s) => s.heap_mb)
          .filter((h) => h != null),
      ),
      idle_after_drive_min_mb: Math.min(...idleB.map((s) => s.rss_mb)),
      procs_peak: Math.max(...drive.map((s) => s.procs)),
      procs_idle_end: idleB.at(-1)?.procs ?? null,
      debug_memory_at_peak: memAtPeak,
      debug_memory_after_idle: memAfterIdle,
      series: { idleA, drive, idleB },
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
