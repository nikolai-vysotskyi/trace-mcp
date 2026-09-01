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
 *                                 [--settle-minutes 10]
 *
 * `--workload` adds the fixture-dependent metrics (TRA-258, TRA-617):
 * `ui_p95_ms`, `heap_after_workload_mb`, `heap_growth_mb_per_hour` and the
 * process-tree set (`tree_rss_peak_mb`, `tree_rss_idle_mb`, `tree_cpu_peak_pct`,
 * `rss_after_index_settle_mb`). The fixture is this repo at the commit pinned in
 * `scripts/perf-fixture.json`; the action script is documented in
 * `docs/perf/README.md`. It runs its daemon on a private port against a
 * throwaway data dir, so it does not need :3741 to be free.
 *
 * Requires `pnpm run build` first — it measures the production bundle, not dev.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fitGrowth,
  median,
  p95,
  pidOnPort,
  pidsInTree,
  procStats,
  round,
  thin,
} from './perf-lib.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* Not a constant, and not 9333 unconditionally. A fixed CDP port is the same
   trap as the fixed daemon port: on 2026-09-01 a Chrome running with
   --remote-debugging-port=9333 (chrome-devtools-mcp) already held it, the
   harness attached to a Chrome tab instead of the app it had just spawned, and
   reported cold_start_ms 23 and window_interactive_ms 16327 with a straight
   face. Every launch takes a free port and then proves the process listening on
   it is its own. */
const PORT_RANGE = [9333, 9353];

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
const SETTLE_MINUTES = Number(flag('settle-minutes', 10));
/* The renderer hardcodes http://127.0.0.1:3741, and on a working machine that
   port is permanently contested — sibling agent runs, the installed app and a
   20-project registry all want it, and whoever holds it is usually mid-reindex.
   Earlier runs waited for it to come free and gave up, which is why the three
   workload metrics stayed null in four consecutive baseline entries. The daemon
   under test now gets a private port and every renderer request to :3741 is
   rewritten onto it over CDP (see the Fetch.requestPaused handler in
   runWorkload) — the same technique scripts/tabs-scale.mjs already uses. */
const DAEMON_PORT = 37412;
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;
/* Throwaway trace-mcp home, so the daemon under test serves the fixture and
   nothing else. The real registry holds dozens of projects and its daemon
   spends the run indexing them — real, but not the variable under test. */
const DATA_DIR = path.join(os.tmpdir(), 'tracemcp-perf-home');
/* Both names, deliberately: the CLI and daemon resolve their home from
   TRACE_MCP_DATA_DIR (src/global.ts), the Electron main process from
   TRACE_MCP_HOME (main/daemon-lifecycle.ts). Set only one and the app looks for
   daemon.pid in ~/.trace-mcp, does not find this run's daemon, concludes it is
   dead and starts another — a restart loop the measurement cannot survive.
   TRACE_MCP_BIN points the app's own restart path at a no-op shim. */
const ENV = {
  ...process.env,
  TRACE_MCP_DATA_DIR: DATA_DIR,
  TRACE_MCP_HOME: DATA_DIR,
  TRACE_MCP_BIN: path.join(DATA_DIR, 'bin', 'trace-mcp'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP client over the Node 22 global WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.waiters = new Map();
    // One named handler rather than a method-name-keyed map: the key would come
    // straight off the wire, which is a dynamic dispatch on an attacker-shaped
    // string as far as CodeQL is concerned, and only one event ever needed it.
    this.onFetchPaused = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) {
        const w = this.waiters.get(msg.method) ?? [];
        this.waiters.delete(msg.method);
        for (const resolve of w) resolve(msg.params);
        if (msg.method === 'Fetch.requestPaused') this.onFetchPaused?.(msg.params);
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
      // Inside the promise, deliberately: `ws.send` throws synchronously on a
      // socket that is already closing, and outside it that throw escapes into
      // whatever happened to be on the stack — for the Fetch interceptor, a
      // WebSocket message handler, where it takes the whole run down.
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
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
  /**
   * Stop listening and abandon every in-flight call without rejecting it. The
   * harness kills the app on purpose, and the target's parting
   * "Inspected target navigated or closed" would otherwise arrive as an
   * unhandled rejection — which killed a completed run after its last cycle and
   * before it could write any of it out.
   */
  dispose() {
    this.onFetchPaused = null;
    // Resolved, not rejected and not merely dropped: dropping them would leave
    // their timeout timers to reject into the same void a few seconds later.
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
    this.ws.close();
  }
  close() {
    this.ws.close();
  }
}

async function rendererTarget(deadline, port, ownerPid) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const t = (await res.json()).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) {
        // Someone else can win the port between picking it and Electron binding
        // it. Driving their browser instead of our app produces numbers that
        // look real, so this is a hard failure rather than a warning.
        const listener = pidOnPort(port);
        if (listener && !pidsInTree(ownerPid).has(listener)) {
          throw new Error(
            `pid ${listener} owns CDP port ${port}, not this run's app (pid ${ownerPid})`,
          );
        }
        return t;
      }
    } catch (e) {
      if (e.message.includes('owns CDP port')) throw e;
      /* devtools endpoint not up yet */
    }
    await sleep(20);
  }
  throw new Error('renderer target never appeared');
}

function freePort([from, to]) {
  for (let p = from; p <= to; p++) if (!pidOnPort(p)) return p;
  throw new Error(`no free CDP port in ${from}-${to}`);
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
async function launchApp(extraArgs = [], env = process.env) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-perf-'));
  const electron = path.join(appDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const port = freePort(PORT_RANGE);
  const t0 = Date.now();
  const child = spawn(electron, [appDir, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, ...extraArgs], {
    cwd: appDir,
    env: { ...env, ELECTRON_RUN_AS_NODE: '' },
    stdio: 'ignore',
  });
  const stop = async () => {
    child.kill('SIGKILL');
    await sleep(500);
    fs.rmSync(userData, { recursive: true, force: true });
  };
  try {
    const target = await rendererTarget(t0 + 60_000, port, child.pid);
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
  if (!fs.existsSync(dir)) return { mac_app_unpacked: null, mac_asar: null };
  const bundle = fs.readdirSync(dir).find((f) => f.endsWith('.app'));
  if (!bundle) return { mac_app_unpacked: null, mac_asar: null };
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
  //
  // Except for one layer. The GPU graph repaints its HTML label overlay every
  // animation frame — measured at ~730 mutations/second, unbroken, with no input
  // at all — so a whole-document observer never sees 120 ms of quiet and every
  // action in the Graph tab burns the cap instead of being timed. That is how
  // ui_p95_ms first read as exactly 5000 ms (TRA-617). An animation that never
  // stops cannot be a completion signal, so its mutations are not one.
  const IGNORED = '.cosmos-gpu-label';
  const ignorable = (rec) => {
    const el = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement;
    return !!(el && el.closest && el.closest(IGNORED));
  };
  const settled = (start) =>
    new Promise((resolve) => {
      let last = start;
      const obs = new MutationObserver((recs) => {
        if (recs.every(ignorable)) return;
        last = performance.now();
      });
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
  const dir = path.join(os.homedir(), '.trace-mcp', 'perf-fixture', pin.commit.slice(0, 12));
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
  execFileSync(process.execPath, [cliPath(), 'index', dir], { stdio: 'ignore', env: ENV });
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
 * A no-op `trace-mcp` binary, on purpose. The app's health watchdog polls the
 * hardcoded :3741, which this run deliberately does not own, so it will decide
 * the daemon is dead and shell out to TRACE_MCP_BIN. Letting it start anything
 * would fight the other daemons on this machine for a port the run never uses.
 */
function installShim() {
  const bin = path.join(DATA_DIR, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'trace-mcp');
  fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(shim, 0o755);
}

/**
 * The daemon under test, on its own port and its own data dir. Nothing on the
 * machine competes for either, so a run no longer depends on 3741 coming free.
 */
let daemonStarts = 0;
async function ensureDaemon(owned) {
  if (await healthy()) return owned;
  owned?.kill('SIGKILL');
  // Bounded: respawning forever just hammers the machine. Fail with something
  // the reader can act on.
  if (++daemonStarts > 3) {
    throw new Error(`could not keep a daemon on ${DAEMON_PORT}`);
  }
  const child = spawn(process.execPath, [cliPath(), 'serve-http', '--port', String(DAEMON_PORT)], {
    stdio: 'ignore',
    env: ENV,
  });
  await waitDaemon(Date.now() + 180_000);
  process.stderr.write(`started a harness-owned daemon on ${DAEMON_PORT}\n`);
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
  throw new Error(`daemon never came up on ${DAEMON_PORT}`);
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

/**
 * RSS and %CPU of both process trees under test, by role. Sampled throughout the
 * workload so the run reports what the machine actually paid, not just what the
 * renderer's own heap counter saw.
 */
function treeSample(appPid, daemonPid) {
  const app = procStats(appPid);
  const daemon = procStats(daemonPid);
  return {
    app_rss_mb: round(app.rss_mb, 0),
    app_cpu_pct: round(app.cpu),
    app_procs: app.procs,
    daemon_rss_mb: round(daemon.rss_mb, 0),
    daemon_cpu_pct: round(daemon.cpu),
    daemon_procs: daemon.procs,
    rss_mb: round(app.rss_mb + daemon.rss_mb, 0),
    cpu_pct: round(app.cpu + daemon.cpu),
  };
}

async function runWorkload({ minutes, opens, settleMinutes }) {
  const pin = JSON.parse(fs.readFileSync(path.join(appDir, 'scripts', 'perf-fixture.json'), 'utf8'));
  installShim();
  let perfDaemon = await ensureDaemon(null);
  const indexStart = Date.now();
  const fixture = ensureFixture(pin);
  const index_s = round((Date.now() - indexStart) / 1000, 1);
  const rendererUrl = `file://${path.join(appDir, 'dist', 'renderer', 'index.html')}?view=project&root=${encodeURIComponent(fixture)}`;
  const durations = { open_project: [], search: [], switch_view: [] };
  // The workload window is never focused, and Chromium throttles timers and
  // rAF in an occluded renderer — which would stall the driver, not just slow
  // it. Startup samples deliberately do not get these flags.
  const { child, cdp, stop } = await launchApp(
    [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
    ENV,
  );

  // Sampled on a timer for the whole run rather than at phase boundaries: the
  // peak of a tree that spawns index workers is never where you look for it.
  const tree = [];
  const sampleTree = () => {
    const daemonPid = pidOnPort(DAEMON_PORT);
    if (daemonPid) tree.push({ t: Date.now(), ...treeSample(child.pid, daemonPid) });
  };
  const treeTimer = setInterval(sampleTree, 5000);

  try {
    const stats = await waitFixtureServed(fixture);
    process.stderr.write(
      `fixture served in ${index_s} s: ${stats.files} files, ${stats.symbols} symbols\n`,
    );

    await cdp.send('Page.enable');
    await cdp.send('HeapProfiler.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: DRIVER });
    // Point the renderer's hardcoded :3741 at the daemon under test. Only daemon
    // requests match the pattern; assets and the file:// document are untouched.
    cdp.onFetchPaused = ({ requestId, request }) => {
      cdp
        .send('Fetch.continueRequest', {
          requestId,
          url: request.url.replace('127.0.0.1:3741', `127.0.0.1:${DAEMON_PORT}`),
        })
        .catch(() => {});
    };
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:3741/*' }] });

    // Idle reference for the process-tree metrics: app up, fixture indexed and
    // served, nothing driven. Taken before phase A because after it the daemon
    // holds a graph the app asked for, which is load, not idle.
    await sleep(60_000);
    const idle = tree.slice(-6);
    const tree_rss_idle_mb = idle.length ? round(median(idle.map((s) => s.rss_mb)), 0) : null;
    process.stderr.write(`tree idle: ${tree_rss_idle_mb} MB\n`);

    // A lost daemon leaves the Overview unpopulated. On a private port that is
    // rare, but a crash is still an environment failure rather than a UI
    // measurement — retry the open and count it instead of losing the run.
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
    let consecutiveErrors = 0;
    let cycleErrors = 0;
    let afterFirstCycle = null;
    const runCycle = async () => {
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
    };
    do {
      try {
        await runCycle();
      } catch (e) {
        // A single lost cycle must not cost the other 299. The 2026-09-01 run
        // reached cycle 299 of a 30-minute pass and then threw
        // "Inspected target navigated or closed" — every measurement it had
        // taken went in the bin with it. Reopening the project rebuilds the
        // page context the driver lives in; two failures in a row means the
        // app is gone for good and the run stops with what it has.
        cycleErrors++;
        consecutiveErrors++;
        process.stderr.write(`cycle ${cycles + 1} failed (${consecutiveErrors} in a row): ${e.message}\n`);
        if (consecutiveErrors >= 2) break;
        try {
          perfDaemon = await ensureDaemon(perfDaemon);
          await openProject();
          await evaluateAction('__perf.switchView("Graph")');
          consecutiveErrors = 0;
        } catch (recoverError) {
          process.stderr.write(`recovery failed: ${recoverError.message}\n`);
          break;
        }
      }
    } while (Date.now() < endAt);

    const workloadMinutes = round((Date.now() - startedAt) / 60_000, 1);

    // Settle — the app is gone and the daemon still holds the fixture's index.
    // What it is still holding N minutes later is the number that matters for a
    // daemon that lives for days, and it is not visible while the UI drives it.
    cdp.dispose();
    await stop().catch(() => {});
    const settleEnd = Date.now() + settleMinutes * 60_000;
    const settle = [];
    while (Date.now() < settleEnd) {
      const daemonPid = pidOnPort(DAEMON_PORT);
      if (daemonPid) settle.push(round(procStats(daemonPid).rss_mb, 0));
      await sleep(10_000);
    }
    const rss_after_index_settle_mb = settle.length ? median(settle.slice(-6)) : null;
    process.stderr.write(`daemon after ${settleMinutes} min settle: ${rss_after_index_settle_mb} MB\n`);

    // Worst of the three per-action p95s, not the p95 of everything pooled:
    // there are ~100x more searches than opens, so a pooled percentile would
    // just be the search p95 and a slow project-open would never show up.
    const byAction = Object.values(durations).map((v) => p95(v));
    return {
      ui_p95_ms: round(Math.max(...byAction), 0),
      heap_after_workload_mb: afterFirstCycle,
      heap_growth_mb_per_hour: fitGrowth(series),
      // Empty only if the daemon was never on its port, which would have failed
      // the run long before here — but Math.max() of nothing is -Infinity, and
      // JSON turns that into a `null` that reads like "not measured".
      tree_rss_peak_mb: tree.length ? Math.max(...tree.map((s) => s.rss_mb)) : null,
      tree_rss_idle_mb,
      tree_cpu_peak_pct: tree.length ? Math.max(...tree.map((s) => s.cpu_pct)) : null,
      rss_after_index_settle_mb,
      workload: {
        fixture: {
          commit: pin.commit,
          revision: pin.revision,
          files: stats.files,
          symbols: stats.symbols,
        },
        minutes: workloadMinutes,
        index_s,
        settle_minutes: settleMinutes,
        cycles,
        cycle_errors: cycleErrors,
        open_warmup_ms: warmup,
        open_retries: openRetries,
        open_project_ms: durations.open_project.map((d) => round(d, 0)),
        actions: Object.fromEntries(
          Object.entries(durations).map(([k, v]) => [
            k,
            { n: v.length, median_ms: round(median(v), 0), p95_ms: round(p95(v), 0) },
          ]),
        ),
        /* The fits above use every sample; these are only the shape, and this
           file is committed. */
        heap_series: thin(series, 60),
        tree_series: thin(tree, 60),
      },
    };
  } finally {
    clearInterval(treeTimer);
    await stop();
    if (perfDaemon) perfDaemon.kill('SIGKILL');
    // The registry lived in DATA_DIR, so nothing outside it was touched (TRA-185).
    if (!process.env.PERF_KEEP) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

const samples = [];
for (let i = 0; i < SAMPLES; i++) {
  // Only the last sample pays the idle-hold cost; cold start is what needs N.
  samples.push(await runSample({ idleSeconds: i === SAMPLES - 1 ? IDLE_SECONDS : 0 }));
  process.stderr.write(`sample ${i + 1}/${SAMPLES}: ${JSON.stringify(samples[i])}\n`);
}

// A workload pass costs the better part of an hour. If it dies at minute 50 the
// startup samples it already has are still worth writing out — losing them too
// is how a run ends with nothing to show for the machine time it spent.
let workload = {};
if (WORKLOAD) {
  try {
    workload = await runWorkload({
      minutes: WORKLOAD_MINUTES,
      opens: OPENS,
      settleMinutes: SETTLE_MINUTES,
    });
  } catch (e) {
    workload = { workload_error: String(e?.stack ?? e) };
    process.stderr.write(`workload failed: ${e?.message ?? e}\n`);
  }
}

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
    ui_p95_ms: workload.ui_p95_ms ?? null,
    heap_idle_mb: last.heap_idle_mb ?? null,
    heap_after_workload_mb: workload.heap_after_workload_mb ?? null,
    heap_growth_mb_per_hour: workload.heap_growth_mb_per_hour ?? null,
    tree_rss_peak_mb: workload.tree_rss_peak_mb ?? null,
    tree_rss_idle_mb: workload.tree_rss_idle_mb ?? null,
    tree_cpu_peak_pct: workload.tree_cpu_peak_pct ?? null,
    rss_after_index_settle_mb: workload.rss_after_index_settle_mb ?? null,
    main_cpu_idle_pct: last.main_cpu_idle_pct ?? null,
    renderer_bundle_kb: bundleSizes(),
    renderer_eager_kb: eagerKb(),
    artifact_mb: artifactMb(),
  },
  raw_samples: samples,
  ...(workload.workload ? { workload: workload.workload } : {}),
  ...(workload.workload_error ? { workload_error: workload.workload_error } : {}),
};

const json = JSON.stringify(entry, null, 2);
OUT ? fs.writeFileSync(OUT, `${json}\n`) : console.log(json);
