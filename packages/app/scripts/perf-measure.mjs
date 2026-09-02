#!/usr/bin/env node
/**
 * Desktop-app performance harness (TRA-257).
 *
 * Launches the built Electron app against a throwaway user-data dir, drives it
 * over CDP, and prints one `runs[]` entry for `docs/perf/baseline.json`.
 *
 * Usage:
 *   node scripts/perf-measure.mjs [--samples 3] [--idle-seconds 300] [--json out.json]
 *                                 [--workload] [--workload-minutes 30] [--opens 10]
 *
 * `--workload` adds the three fixture-dependent metrics (TRA-258): `ui_p95_ms`,
 * `heap_after_workload_mb` and `heap_growth_mb_per_hour`. The fixture is this
 * repo at the commit pinned in `scripts/perf-fixture.json`; the action script is
 * documented in `docs/perf/README.md`.
 *
 * Requires `pnpm run build` first — it measures the production bundle, not dev.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { traceHomeDir } from '../../../scripts/trace-home.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9333;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const SAMPLES = Number(flag('samples', 3));
const IDLE_SECONDS = Number(flag('idle-seconds', 300));
const OUT = flag('json', null);
const WORKLOAD = args.includes('--workload');
const WORKLOAD_MINUTES = Number(flag('workload-minutes', 30));
const OPENS = Number(flag('opens', 10));
const DAEMON = 'http://127.0.0.1:3741';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** Nearest-rank p95 — with N<20 this is just the max, which is the honest answer. */
const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
};
const round = (n, d = 1) => Number(n.toFixed(d));

/** Minimal CDP client over the Node 22 global WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.waiters = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) {
        const w = this.waiters.get(msg.method) ?? [];
        this.waiters.delete(msg.method);
        for (const resolve of w) resolve(msg.params);
        return;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }
  /** Resolves on the next occurrence of a CDP event. */
  once(method) {
    return new Promise((resolve) => {
      this.waiters.set(method, [...(this.waiters.get(method) ?? []), resolve]);
    });
  }
  // A navigating target silently drops in-flight replies, so every call is
  // bounded — a lost response must fail the run, not hang it.
  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
  async evaluate(expression, timeoutMs) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result?.value;
  }
  close() {
    this.ws.close();
  }
}

async function rendererTarget(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await res.json()).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch {
      /* devtools endpoint not up yet */
    }
    await sleep(20);
  }
  throw new Error('renderer target never appeared');
}

/** Main-process %CPU over a short window, via ps. */
function cpuPercent(pid) {
  return new Promise((resolve) => {
    const p = spawn('ps', ['-o', '%cpu=', '-p', String(pid)]);
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.on('close', () => resolve(Number(out.trim()) || 0));
  });
}

/** Spawn the built app against a throwaway profile and attach to its renderer. */
async function launchApp(extraArgs = []) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-perf-'));
  const electron = path.join(appDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const t0 = Date.now();
  const child = spawn(electron, [appDir, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, ...extraArgs], {
    cwd: appDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: 'ignore',
  });
  const stop = async () => {
    child.kill('SIGKILL');
    await sleep(500);
    fs.rmSync(userData, { recursive: true, force: true });
  };
  try {
    const target = await rendererTarget(t0 + 60_000);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    return { child, cdp, t0, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

async function runSample({ idleSeconds }) {
  const { child, cdp, t0, stop } = await launchApp();

  try {
    // Interactive = React has painted real content into #root and the main
    // thread is free enough to answer this evaluate.
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await cdp.evaluate(
        `document.readyState === 'complete' && !!document.querySelector('#root')?.firstElementChild`,
      );
      if (ready) break;
      await sleep(20);
    }
    if (!ready) throw new Error('window never became interactive');
    const interactiveAt = Date.now();

    const timeOrigin = await cdp.evaluate('performance.timeOrigin');
    const sample = {
      cold_start_ms: interactiveAt - t0,
      // Renderer-side share: first renderer bytes → interactive.
      window_interactive_ms: round(interactiveAt - timeOrigin, 0),
      // Read off the renderer's own clock after the fact, so — unlike the two
      // above — it carries none of this harness's polling and CDP round-trip
      // latency. On a loaded machine those two inflate by hundreds of ms while
      // this one does not, which is what makes it the comparable number.
      renderer_fcp_ms: round(
        await cdp.evaluate(
          `performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint')?.startTime ?? null`,
        ) ?? NaN,
        0,
      ),
    };

    if (idleSeconds > 0) {
      await sleep(idleSeconds * 1000);
      sample.heap_idle_mb = round((await cdp.evaluate('performance.memory.usedJSHeapSize')) / 1048576);
      const cpu = [];
      for (let i = 0; i < 3; i++) {
        cpu.push(await cpuPercent(child.pid));
        await sleep(1000);
      }
      sample.main_cpu_idle_pct = round(median(cpu));
    }

    cdp.close();
    return sample;
  } finally {
    await stop();
  }
}

function bundleSizes() {
  const dir = path.join(appDir, 'dist', 'renderer');
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      e.isDirectory() ? walk(f) : (bytes += fs.statSync(f).size);
    }
  };
  if (!fs.existsSync(dir)) throw new Error(`missing ${dir} — run \`pnpm run build\` first`);
  walk(dir);
  return round(bytes / 1024, 0);
}

/**
 * What the window actually downloads before it can render: the entry script plus
 * whatever `index.html` preloads. Splitting a tab behind `React.lazy` moves bytes
 * out of this number but leaves `renderer_bundle_kb` — the total on disk —
 * unchanged, so trending only the total hides every code-splitting win.
 */
function eagerKb() {
  const dir = path.join(appDir, 'dist', 'renderer');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\.?\/?([^"]+)"/g)].map((m) => m[1]);
  // A Vite `base` change that stops the refs matching must fail the run: silently
  // recording 0 KB would read as the largest win this metric has ever shown.
  if (!refs.length) throw new Error('index.html referenced no assets — check Vite `base`');
  const bytes = refs.reduce((a, r) => a + fs.statSync(path.join(dir, r)).size, 0);
  return round(bytes / 1024, 0);
}

/** Packaged-bundle sizes, if `pnpm run pack` has been run. Null otherwise. */
function artifactMb() {
  const dir = path.join(appDir, 'release', 'mac-arm64');
  if (!fs.existsSync(dir)) return { mac_app_unpacked: null, mac_asar: null, mac_server_payload: null };
  const bundle = fs.readdirSync(dir).find((f) => f.endsWith('.app'));
  if (!bundle) return { mac_app_unpacked: null, mac_asar: null, mac_server_payload: null };
  const size = (p) => {
    let bytes = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        e.isDirectory() ? walk(f) : (bytes += fs.lstatSync(f).size);
      }
    };
    fs.statSync(p).isDirectory() ? walk(p) : (bytes = fs.statSync(p).size);
    return round(bytes / 1048576);
  };
  return {
    mac_app_unpacked: size(path.join(dir, bundle)),
    mac_asar: size(path.join(dir, bundle, 'Contents', 'Resources', 'app.asar')),
    // Tracked separately because it is the only large part of the bundle the
    // repo controls: ~267 MB of the rest is the Electron framework, so a ×1.5
    // rule on the total cannot see the embedded daemon doubling (TRA-605).
    mac_server_payload: size(path.join(dir, bundle, 'Contents', 'Resources', 'server')),
  };
}

// ── Fixed workload (TRA-258) ────────────────────────────────────────────────
// Everything below only runs under `--workload`. The three metrics it produces
// need an identical scenario run to run, so the project under test is this repo
// at a pinned commit and the action script lives in scripts/perf-fixture.json.

/**
 * In-page driver, installed before any page script so `opened` starts its clock
 * at navigation. Every duration is read off the renderer's own `performance`
 * clock — the harness never times an action with wall-clock across CDP.
 */
const DRIVER = `
window.__perf = (() => {
  const QUIET_MS = 120;
  const SETTLE_CAP_MS = 5000;
  // An action is done when the DOM stops changing, not when React returns:
  // switching to the Graph tab paints an empty canvas in a few ms and then
  // spends real time loading the graph. Measuring only the first paint would
  // report single-digit milliseconds for every action and catch no regression.
  const settled = (start) =>
    new Promise((resolve) => {
      let last = start;
      const obs = new MutationObserver(() => { last = performance.now(); });
      obs.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
      });
      const tick = () => {
        const now = performance.now();
        if (now - last >= QUIET_MS || now - start >= SETTLE_CAP_MS) {
          obs.disconnect();
          return resolve(Math.min(last - start, SETTLE_CAP_MS));
        }
        setTimeout(tick, 16);
      };
      setTimeout(tick, 16);
    });
  const mainText = () => (document.querySelector('main') || {}).innerText || '';
  const overviewReady = () =>
    mainText().indexOf('Files indexed') !== -1 && mainText().indexOf('Symbols') !== -1;
  const poll = (fn, timeoutMs) =>
    new Promise((res, rej) => {
      const started = performance.now();
      const tick = () => {
        let ok = false;
        try { ok = fn(); } catch (e) { ok = false; }
        if (ok) return res(performance.now());
        if (performance.now() - started > timeoutMs) return rej(new Error('perf: readiness timeout'));
        setTimeout(tick, 16);
      };
      tick();
    });
  const sidebarButton = (label) =>
    Array.prototype.find.call(
      document.querySelectorAll('aside button'),
      (b) => b.textContent.trim() === label,
    );
  const searchInput = () => document.querySelector('input[placeholder^="Search"]');
  const setReactValue = (el, value) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const opened = poll(overviewReady, 180000);
  opened.catch(() => {}); // a navigation away before readiness is not a crash
  return {
    opened,
    matchCount: () => document.querySelectorAll('li[role="option"]').length,
    async switchView(label) {
      const btn = sidebarButton(label);
      if (!btn) throw new Error('perf: no sidebar tab "' + label + '"');
      const t = performance.now();
      btn.click();
      return settled(t);
    },
    async search(q) {
      const el = searchInput();
      if (!el) throw new Error('perf: no graph search input');
      const t = performance.now();
      setReactValue(el, q);
      return settled(t);
    },
  };
})();
`;

/**
 * Pinned-commit worktree of this repo — the project the workload drives.
 * It deliberately lives outside the checkout: the daemon reroutes a register
 * request for any path under an already-registered root to that parent, which
 * would silently point the workload at the wrong project.
 */
function cliPath() {
  const cli = path.resolve(appDir, '..', '..', 'dist', 'cli.js');
  if (!fs.existsSync(cli)) {
    throw new Error(`missing ${cli} — run \`pnpm run build\` in the repo root first`);
  }
  return cli;
}

function ensureFixture(pin) {
  const repoRoot = path.resolve(appDir, '..', '..');
  const dir = path.join(traceHomeDir(), 'perf-fixture', pin.commit.slice(0, 12));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', dir, pin.commit], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
  }
  // Index with this checkout's own CLI rather than leaving it to the daemon:
  // "index built by the pinned CLI" is the state we want identical on every run,
  // and a busy daemon can otherwise sit on the fixture for many minutes.
  execFileSync(process.execPath, [cliPath(), 'index', dir], { stdio: 'ignore' });
  return dir;
}

async function healthy() {
  try {
    const res = await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for a gap in which nothing holds 3741 and take it. A daemon that is
 * crash-looping under a large registry frees the port every minute or so; once
 * the harness holds it, the next respawn cannot bind and the run stays stable.
 * Returns null if a foreign daemon held the port for the whole window.
 */
async function grabPort() {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (!(await healthy())) return ensureDaemon(null);
    await sleep(1000);
  }
  process.stderr.write('another daemon held 3741 throughout — using it\n');
  return null;
}

/**
 * The renderer talks to 127.0.0.1:3741 unconditionally, so the workload cannot
 * be pointed at another port. When nothing is listening — the daemon crashed, or
 * was never started — bring up our own so the run does not stall. When something
 * is already listening it is left alone: killing a daemon another session is
 * using would be worse than the noise it adds.
 */
let daemonStarts = 0;
async function ensureDaemon(owned) {
  if (await healthy()) return owned;
  owned?.kill('SIGKILL');
  // Bounded: if our daemon keeps losing the port to another one, respawning it
  // forever just hammers the machine. Fail with something the reader can act on.
  if (++daemonStarts > 3) {
    throw new Error('could not keep a daemon on 3741 — another trace-mcp is claiming the port');
  }
  const child = spawn(process.execPath, [cliPath(), 'serve-http'], { stdio: 'ignore' });
  await waitDaemon(Date.now() + 180_000);
  process.stderr.write('started a harness-owned daemon on 3741\n');
  return child;
}

/**
 * Retry for ~60 s. The daemon is a shared, app-owned process: it drops
 * connections while busy indexing and restarts when another client claims it,
 * so a single refused connection is not a failed run.
 */
async function daemon(method, pathname, body, attempt = 0) {
  try {
    const res = await fetch(DAEMON + pathname, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}`);
    return await res.json().catch(() => ({}));
  } catch (e) {
    if (attempt >= 20) throw e;
    await sleep(3000);
    return daemon(method, pathname, body, attempt + 1);
  }
}

async function waitDaemon(deadline) {
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await sleep(500);
  }
  throw new Error('daemon never came up on 3741');
}

/** Register the fixture with whatever daemon holds 3741 and wait until served. */
async function waitFixtureServed(root) {
  const added = await daemon('POST', '/api/projects', { root });
  if (added.status === 'using_parent') {
    throw new Error(`fixture ${root} was rerouted to registered parent ${added.project}`);
  }
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    // `files > 0` is the gate, not the reported status: a busy daemon parks
    // projects in `indexing` long after the index is usable.
    const stats = await daemon(
      'GET',
      `/api/projects/stats?project=${encodeURIComponent(root)}`,
    ).catch(() => null);
    if (stats?.files > 0) return stats;
    await sleep(2000);
  }
  throw new Error(`the daemon on 3741 never served ${root}`);
}

/** Least-squares slope of heap over time, in MB/hour. */
function fitGrowth(series) {
  if (series.length < 3) return null;
  const xs = series.map((s) => s.t_min / 60);
  const ys = series.map((s) => s.heap_mb);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den === 0 ? null : round(num / den, 2);
}

async function runWorkload({ minutes, opens }) {
  const pin = JSON.parse(fs.readFileSync(path.join(appDir, 'scripts', 'perf-fixture.json'), 'utf8'));
  const fixture = ensureFixture(pin);
  const rendererUrl = `file://${path.join(appDir, 'dist', 'renderer', 'index.html')}?view=project&root=${encodeURIComponent(fixture)}`;
  const durations = { open_project: [], search: [], switch_view: [] };
  let perfDaemon = await grabPort();
  // The workload window is never focused, and Chromium throttles timers and
  // rAF in an occluded renderer — which would stall the driver, not just slow
  // it. Startup samples deliberately do not get these flags.
  const { cdp, stop } = await launchApp([
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ]);

  try {
    const stats = await waitFixtureServed(fixture);
    process.stderr.write(`fixture served: ${stats.files} files, ${stats.symbols} symbols\n`);

    await cdp.send('Page.enable');
    await cdp.send('HeapProfiler.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: DRIVER });

    // The daemon is shared: another client claiming it restarts it, and while it
    // is down the Overview never populates. That is an environment failure, not
    // a UI measurement — retry the open and count it instead of losing the run.
    let openRetries = 0;
    const openProject = async () => {
      for (let attempt = 0; ; attempt++) {
        perfDaemon = await ensureDaemon(perfDaemon);
        const loaded = cdp.once('Page.loadEventFired');
        await cdp.send('Page.navigate', { url: rendererUrl });
        await loaded;
        try {
          return await cdp.evaluate('window.__perf.opened', 200_000);
        } catch (e) {
          if (attempt >= 3) throw e;
          openRetries++;
          process.stderr.write(`open retry ${openRetries}: ${e.message}\n`);
        }
      }
    };
    const evaluateAction = (expr) => cdp.evaluate(expr);
    // `Runtime.getHeapUsage`, not `performance.memory`: Chromium only refreshes
    // `performance.memory` every ~20 min unless the app is launched with
    // --enable-precise-memory-info, which would pin every sample to one value.
    const heapMb = async () => {
      await cdp.send('HeapProfiler.collectGarbage', {}, 60_000);
      const { usedSize } = await cdp.send('Runtime.getHeapUsage');
      return round(usedSize / 1048576, 2);
    };

    // Phase A — open-project latency. Each open is a full document reload, so
    // it cannot be part of the leak loop below without resetting the heap.
    // The first open is a warm-up and is discarded: it also pays for the daemon
    // loading the fixture's index, which is setup cost, not UI latency.
    const warmup = round(await openProject(), 0);
    process.stderr.write(`open warm-up (discarded): ${warmup} ms\n`);
    for (let i = 0; i < opens; i++) {
      durations.open_project.push(await openProject());
      process.stderr.write(`open ${i + 1}/${opens}: ${round(durations.open_project[i], 0)} ms\n`);
    }

    // Phase B — one open, then the cycle replayed in a single JS context for
    // >= `minutes`. Heap is sampled post-GC after every cycle.
    durations.open_project.push(await openProject());
    durations.switch_view.push(await evaluateAction('__perf.switchView("Graph")'));
    const probeDeadline = Date.now() + 600_000;
    let graphReady = false;
    while (!graphReady && Date.now() < probeDeadline) {
      await evaluateAction(`__perf.search(${JSON.stringify(pin.queries[0])})`);
      graphReady = await cdp.evaluate('__perf.matchCount() > 0');
      if (graphReady) break;
      await sleep(5000);
      perfDaemon = await ensureDaemon(perfDaemon);
      // Remount the tab: a graph whose first fetch lost the daemon never
      // refetches on its own, and typing at it again will not fix that.
      await evaluateAction('__perf.switchView("Overview")');
      await evaluateAction('__perf.switchView("Graph")');
    }
    if (!graphReady) throw new Error('graph never produced search matches');

    const series = [];
    const startedAt = Date.now();
    const endAt = startedAt + minutes * 60_000;
    let cycles = 0;
    let afterFirstCycle = null;
    do {
      for (const q of pin.queries) {
        durations.search.push(await evaluateAction(`__perf.search(${JSON.stringify(q)})`));
      }
      for (const v of pin.views) {
        durations.switch_view.push(await evaluateAction(`__perf.switchView(${JSON.stringify(v)})`));
      }
      cycles++;
      const heap_mb = await heapMb();
      series.push({ t_min: round((Date.now() - startedAt) / 60_000, 2), heap_mb });
      afterFirstCycle ??= heap_mb;
      process.stderr.write(`cycle ${cycles}: heap ${heap_mb} MB\n`);
    } while (Date.now() < endAt);

    // Worst of the three per-action p95s, not the p95 of everything pooled:
    // there are ~100x more searches than opens, so a pooled percentile would
    // just be the search p95 and a slow project-open would never show up.
    const byAction = Object.values(durations).map((v) => p95(v));
    return {
      ui_p95_ms: round(Math.max(...byAction), 0),
      heap_after_workload_mb: afterFirstCycle,
      heap_growth_mb_per_hour: fitGrowth(series),
      workload: {
        fixture: {
          commit: pin.commit,
          revision: pin.revision,
          files: stats.files,
          symbols: stats.symbols,
        },
        minutes: round((Date.now() - startedAt) / 60_000, 1),
        cycles,
        open_warmup_ms: warmup,
        open_retries: openRetries,
        open_project_ms: durations.open_project.map((d) => round(d, 0)),
        actions: Object.fromEntries(
          Object.entries(durations).map(([k, v]) => [
            k,
            { n: v.length, median_ms: round(median(v), 0), p95_ms: round(p95(v), 0) },
          ]),
        ),
        heap_series: series,
      },
    };
  } finally {
    await stop();
    // Leave the project registry as we found it (TRA-185).
    await daemon('DELETE', `/api/projects?project=${encodeURIComponent(fixture)}`).catch(() => {});
    if (perfDaemon) perfDaemon.kill('SIGKILL');
  }
}

const samples = [];
for (let i = 0; i < SAMPLES; i++) {
  // Only the last sample pays the idle-hold cost; cold start is what needs N.
  samples.push(await runSample({ idleSeconds: i === SAMPLES - 1 ? IDLE_SECONDS : 0 }));
  process.stderr.write(`sample ${i + 1}/${SAMPLES}: ${JSON.stringify(samples[i])}\n`);
}

const workload = WORKLOAD
  ? await runWorkload({ minutes: WORKLOAD_MINUTES, opens: OPENS })
  : { ui_p95_ms: null, heap_after_workload_mb: null, heap_growth_mb_per_hour: null };

const last = samples[samples.length - 1];
const entry = {
  date: new Date().toISOString(),
  app_version: JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version,
  commit: process.env.PERF_COMMIT ?? null,
  // `os.release()` is the Darwin release (25.x), not the marketing macOS version
  // (26.x) — labelling it "macOS" made entries look like they came from different
  // machines when they did not.
  env: { os: `darwin ${os.release()}`, arch: os.arch(), node: process.version.slice(1) },
  samples: SAMPLES,
  metrics: {
    cold_start_ms: median(samples.map((s) => s.cold_start_ms)),
    window_interactive_ms: median(samples.map((s) => s.window_interactive_ms)),
    renderer_fcp_ms: median(samples.map((s) => s.renderer_fcp_ms)),
    ui_p95_ms: workload.ui_p95_ms,
    heap_idle_mb: last.heap_idle_mb ?? null,
    heap_after_workload_mb: workload.heap_after_workload_mb,
    heap_growth_mb_per_hour: workload.heap_growth_mb_per_hour,
    main_cpu_idle_pct: last.main_cpu_idle_pct ?? null,
    renderer_bundle_kb: bundleSizes(),
    renderer_eager_kb: eagerKb(),
    artifact_mb: artifactMb(),
  },
  raw_samples: samples,
  ...(workload.workload ? { workload: workload.workload } : {}),
};

const json = JSON.stringify(entry, null, 2);
OUT ? fs.writeFileSync(OUT, `${json}\n`) : console.log(json);
