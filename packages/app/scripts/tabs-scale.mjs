#!/usr/bin/env node
/**
 * Does the app get slower the more tabs are open? (TRA-526)
 *
 * A project tab on macOS is a whole BrowserWindow in a native tab group, so
 * "N tabs" means N renderer processes against one daemon. This measures, at
 * each `--steps` tab count and then back down to one:
 *
 *   - interaction latency in the FRONTMOST tab (the only one a person is using)
 *   - daemon requests per second at idle, summed over every renderer
 *   - live intervals / EventSources / WebSockets, summed over every renderer
 *   - post-GC JS heap, summed over every renderer
 *   - main-process + daemon CPU at idle, and /health latency from outside
 *
 * Plus the headline: how long a newly opened tab takes to show real data, and
 * whether it ever does. The last step returns to one tab: heap, timers and
 * streams that do not come back down are a leak, which looks exactly like
 * "more tabs = slower".
 *
 *   node scripts/tabs-scale.mjs [--idle 30] [--json out.json] [--steps 1,3,6]
 *
 * Requires `pnpm run build` here and in the repo root.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { median, p95, pidOnPort, procStats, round } from './perf-lib.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..', '..');
const PORT = 9334;
/* The renderer hardcodes http://127.0.0.1:3741 in six files, and on this
   machine that port is permanently contested — other agent runs, the installed
   app, and a 66-project registry all want it, and whoever holds it is usually
   mid-reindex. Measuring against that daemon measures the machine, not the tab
   count. So the daemon under test gets a private port and every renderer
   request to :3741 is rewritten onto it over CDP (see attachDaemonRewrite).
   Only requests to the daemon are intercepted; assets are untouched. */
const DAEMON_PORT = 37411;
const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const IDLE_S = Number(flag('idle', 30));
const OUT = flag('json', null);
const STEPS = String(flag('steps', '1,3,6')).split(',').map(Number);
const FIXTURES = Math.max(...STEPS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP, flattened sessions ─────────────────────────────────────────────────
// Browser-level so every window this run opens is attached to before it runs a
// line of page script — which is the only way to count timers a tab installs
// during its own boot.
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.onEvent = () => {};
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) return this.onEvent(msg);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${msg.error.message}`)) : p.resolve(msg.result);
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
  send(method, params = {}, sessionId, timeoutMs = 60_000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }
  async evaluate(sessionId, expression, timeoutMs = 60_000) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
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

/**
 * Installed before any page script. Counts what an idle tab keeps alive:
 * intervals it never cleared, EventSources and WebSockets it never closed, and
 * every request it sends to the daemon. Also carries the interaction driver, so
 * the frontmost tab can be timed without a second injection.
 */
const PROBE = `
(() => {
  const w = window;
  const p = { intervals: new Set(), es: 0, ws: 0, daemonReqs: 0, allReqs: 0 };
  w.__probe = p;
  const si = w.setInterval.bind(w), ci = w.clearInterval.bind(w);
  w.setInterval = (...a) => { const id = si(...a); p.intervals.add(id); return id; };
  w.clearInterval = (id) => { p.intervals.delete(id); return ci(id); };
  const isDaemon = (u) => String(u).indexOf('3741') !== -1;
  p.reqs = [];
  const f = w.fetch.bind(w);
  w.fetch = (input, init) => {
    p.allReqs++;
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!isDaemon(url)) return f(input, init);
    p.daemonReqs++;
    const t = performance.now();
    const done = (tag) => { p.reqs.push({ url: url.slice(url.indexOf('3741') + 4), ms: Math.round(performance.now() - t), tag }); };
    return f(input, init).then((r) => (done('ok'), r), (e) => { done('err'); throw e; });
  };
  p.sseMsgs = 0;
  const ES = w.EventSource;
  if (ES) {
    w.EventSource = function (...a) {
      const s = new ES(...a); p.es++;
      s.addEventListener('message', () => { p.sseMsgs++; });
      const close = s.close.bind(s);
      s.close = () => { p.es--; return close(); };
      return s;
    };
    w.EventSource.prototype = ES.prototype;
  }
  const WS = w.WebSocket;
  w.WebSocket = function (...a) {
    const s = new WS(...a); p.ws++;
    s.addEventListener('close', () => { p.ws--; });
    return s;
  };
  w.WebSocket.prototype = WS.prototype;

  // Interaction driver: an action is done when the DOM stops changing, not when
  // React returns — same rule as scripts/perf-measure.mjs.
  const settled = (start) => new Promise((resolve) => {
    let last = start;
    const obs = new MutationObserver(() => { last = performance.now(); });
    obs.observe(document.documentElement,
      { subtree: true, childList: true, characterData: true, attributes: true });
    const tick = () => {
      const now = performance.now();
      if (now - last >= 120 || now - start >= 5000) {
        obs.disconnect();
        return resolve(Math.min(last - start, 5000));
      }
      setTimeout(tick, 16);
    };
    setTimeout(tick, 16);
  });
  w.__switchView = async (label) => {
    const btn = Array.prototype.find.call(
      document.querySelectorAll('aside button'), (b) => b.textContent.trim() === label);
    if (!btn) throw new Error('no sidebar tab "' + label + '"');
    const t = performance.now();
    btn.click();
    return settled(t);
  };
  w.__ready = () => !!document.querySelector('#root')?.firstElementChild;
  /* Painted is not loaded: a project tab renders its shell in a few ms and then
     waits on the daemon for the Overview. Timing a view switch before the data
     lands measures an empty page and reports it as fast. */
  w.__contentReady = () => {
    const txt = ((document.querySelector('main') || {}).innerText || '');
    return txt.indexOf('Files indexed') !== -1 && txt.indexOf('Symbols') !== -1;
  };
})();
`;

// ── fixtures ────────────────────────────────────────────────────────────────
// One identical throwaway project per tab. Identical so that a difference
// between steps is the tab count and nothing else; throwaway and outside the
// checkout so the daemon cannot reroute them onto a registered parent.
const FIXTURE_DIR = path.join(os.tmpdir(), 'tra526-fixtures');
/* Throwaway trace-mcp home, so the daemon under test serves these fixtures
   and nothing else. On a real machine the registry holds dozens of projects
   and the daemon spends the whole run indexing them — real, and the subject of
   TRA-525, but it would drown the one variable this run is changing. */
const DATA_DIR = path.join(os.tmpdir(), 'tra526-home');
/* Both names, deliberately: the CLI and daemon resolve their home from
   TRACE_MCP_DATA_DIR (src/global.ts), while the Electron main process resolves
   the same directory from TRACE_MCP_HOME (main/daemon-lifecycle.ts). Set only
   one and the app looks for daemon.pid in ~/.trace-mcp, does not find the
   daemon this run started, concludes it is dead and restarts a healthy one —
   which is a restart loop the measurement cannot survive. TRACE_MCP_BIN points
   the app's own start/restart path at this checkout's build. */
const ENV = {
  ...process.env,
  TRACE_MCP_DATA_DIR: DATA_DIR,
  TRACE_MCP_HOME: DATA_DIR,
  TRACE_MCP_BIN: path.join(DATA_DIR, 'bin', 'trace-mcp'),
};

function installShim() {
  const bin = path.join(DATA_DIR, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'trace-mcp');
  /* A no-op, on purpose. The app's health watchdog polls :3741, which this run
     deliberately does not own, so it will decide the daemon is dead and shell
     out to this binary. Letting it start or restart anything would fight the
     other daemons on this machine for a port the measurement does not use. */
  fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(shim, 0o755);
}
function makeFixtures(n) {
  const roots = [];
  for (let i = 0; i < n; i++) {
    const root = path.join(FIXTURE_DIR, `project-${i + 1}`);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    for (let f = 0; f < 40; f++) {
      const body = Array.from(
        { length: 12 },
        (_, k) => `export function fn${f}_${k}(x: number): number {\n` +
          `  return ${k === 0 ? 'x + 1' : `fn${f}_${k - 1}(x) * 2`};\n}\n`,
      ).join('\n');
      fs.writeFileSync(path.join(root, 'src', `mod${f}.ts`), body);
    }
    roots.push(root);
  }
  return roots;
}

function cliPath() {
  const cli = path.join(repoRoot, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error(`missing ${cli} — run \`pnpm run build\` in the repo root`);
  return cli;
}

async function healthy() {
  try {
    const res = await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon() {
  if (await healthy()) return null;
  const child = spawn(process.execPath, [cliPath(), 'serve-http', '--port', String(DAEMON_PORT)], {
    stdio: 'ignore',
    env: ENV,
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await healthy()) return child;
    await sleep(500);
  }
  throw new Error('daemon never came up on 3741');
}

async function registerFixture(root) {
  execFileSync(process.execPath, [cliPath(), 'index', root], { stdio: 'ignore', env: ENV });
  await fetch(`${DAEMON}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  }).catch(() => {});
}

/** One /health round-trip as an outside client sees it — the TRA-525 symptom. */
async function healthLatency() {
  const t = performance.now();
  try {
    await fetch(`${DAEMON}/health`, { signal: AbortSignal.timeout(3000) });
    return performance.now() - t;
  } catch {
    return 3000;
  }
}

/** Hold until the daemon has stopped indexing and answers /health promptly. */
async function waitDaemonQuiet(roots) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    let served = true;
    for (const r of roots) {
      const stats = await fetch(`${DAEMON}/api/projects/stats?project=${encodeURIComponent(r)}`)
        .then((res) => res.json())
        .catch(() => null);
      if (!(stats?.files > 0)) served = false;
    }
    const lat = [await healthLatency(), await healthLatency(), await healthLatency()];
    if (served && Math.max(...lat) < 250) return;
    await sleep(3000);
  }
  process.stderr.write('daemon never went quiet — numbers below carry its load\n');
}

// ── the run ─────────────────────────────────────────────────────────────────
const roots = makeFixtures(FIXTURES);
installShim();
const ownedDaemon = await ensureDaemon();
for (const r of roots) await registerFixture(r);
await waitDaemonQuiet(roots);
let daemonPid = pidOnPort(3741);
const daemonPids = new Set([daemonPid]);
process.stderr.write(`daemon pid ${daemonPid}, ${roots.length} fixtures registered\n`);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tra526-'));
const electron = path.join(appDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
/* Visible, and deliberately so: on macOS only the selected tab's window is on
   screen, so "a background tab" only exists in a visible run. A hidden run
   backgrounds every renderer including the one being measured. */
const child = spawn(
  electron,
  [appDir, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
  { cwd: appDir, env: { ...ENV, ELECTRON_RUN_AS_NODE: '', TRACE_MCP_WINDOW_MODE: 'visible' }, stdio: 'ignore' },
);

const stop = async () => {
  child.kill('SIGKILL');
  await sleep(500);
  fs.rmSync(userData, { recursive: true, force: true });
  ownedDaemon?.kill('SIGKILL');
  // The registry lived in DATA_DIR, so nothing outside these two dirs was touched.
  if (!process.env.TRA526_KEEP) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
};

let browser;
const sessions = new Map(); // sessionId -> { targetId, url }

try {
  // Browser-level endpoint, retried — Electron opens it a beat after boot.
  const deadline = Date.now() + 60_000;
  let wsUrl = null;
  while (Date.now() < deadline && !wsUrl) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {
      await sleep(200);
    }
  }
  if (!wsUrl) throw new Error('no CDP browser endpoint');
  browser = await Cdp.connect(wsUrl);

  browser.onEvent = (msg) => {
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params;
      if (targetInfo.type !== 'page') {
        browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        return;
      }
      sessions.set(sessionId, { targetId: targetInfo.targetId, url: targetInfo.url });
      (async () => {
        /* Nothing here may be awaited before `runIfWaitingForDebugger`: a
           target paused at start does not answer `Page.enable` until it runs,
           so awaiting the setup first deadlocks the attach. */
        browser.send('Page.enable', {}, sessionId).catch(() => {});
        browser.send('HeapProfiler.enable', {}, sessionId).catch(() => {});
        browser.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE }, sessionId).catch(() => {});
        browser
          .send('Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:3741/*' }] }, sessionId)
          .catch(() => {});
        await browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        /* A target that already existed when auto-attach was turned on was never
           paused, so the probe missed its document. Reload once — a fresh
           document is the only way to see the timers its boot installs. */
        const probed = await browser
          .evaluate(sessionId, '!!window.__probe', 10_000)
          .catch(() => false);
        if (!probed) await browser.send('Page.reload', {}, sessionId).catch(() => {});
      })();
    } else if (msg.method === 'Fetch.requestPaused') {
      const { requestId, request } = msg.params;
      browser
        .send(
          'Fetch.continueRequest',
          { requestId, url: request.url.replace('127.0.0.1:3741', `127.0.0.1:${DAEMON_PORT}`) },
          msg.sessionId,
        )
        .catch(() => {});
    } else if (msg.method === 'Target.detachedFromTarget') {
      sessions.delete(msg.params.sessionId);
    }
  };
  await browser.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  /** Every attached page that has painted. */
  const readySessions = async () => {
    const out = [];
    for (const [sid] of sessions) {
      try {
        if (
          await browser.evaluate(
            sid,
            `!!(window.__probe && document.querySelector('#root') && document.querySelector('#root').firstElementChild)`,
            10_000,
          )
        )
          out.push(sid);
      } catch (e) {
        if (process.env.TRA526_DEBUG) process.stderr.write(`ready(${sid}): ${e.message}\n`);
      }
    }
    return out;
  };

  const waitFor = async (n, timeoutMs = 120_000) => {
    const dl = Date.now() + timeoutMs;
    for (;;) {
      const r = await readySessions();
      if (r.length >= n) return r;
      if (Date.now() > dl) {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        throw new Error(
          `only ${r.length}/${n} windows became ready; sessions=${sessions.size} targets=${JSON.stringify(list.map((t) => [t.type, t.url]))}`,
        );
      }
      await sleep(500);
    }
  };

  // The menu window is tab 1 and appears on its own.
  let live = await waitFor(1);
  const anySession = () => [...sessions.keys()][0];

  /* Time from "open this project" to "its Overview has content". This is the
     number a person feels when they open one more tab. */
  let lastOpenMs = null;
  let lastOpenOk = null;
  const openTab = async (root) => {
    const before = sessions.size;
    const t0 = Date.now();
    await browser.evaluate(anySession(), `window.electronAPI.openProjectTab(${JSON.stringify(root)})`);
    const dl = Date.now() + 120_000;
    while (sessions.size <= before && Date.now() < dl) await sleep(200);
    const ready = await waitFor(before + 1);
    const sid = ready[ready.length - 1];
    const contentDl = Date.now() + 60_000;
    lastOpenOk = false;
    while (Date.now() < contentDl) {
      if (await browser.evaluate(sid, '__contentReady()', 10_000).catch(() => false)) {
        lastOpenOk = true;
        break;
      }
      await sleep(250);
    }
    lastOpenMs = Date.now() - t0;
    process.stderr.write(
      `  opened tab ${before} in ${lastOpenMs} ms${lastOpenOk ? '' : ' (NO DATA — gave up at 60s)'}\n`,
    );
  };

  const closeTab = async (sid) => {
    const t = sessions.get(sid);
    if (!t) return;
    await browser.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    await sleep(500);
  };

  /**
   * One measurement at the current tab count. `frontSid` is the tab a person
   * would be looking at — the last one opened — and the only one interaction
   * latency is read from.
   */
  const measure = async (label, frontSid) => {
    const live = await readySessions();
    /* Settle: hold until the daemon answers /health promptly again, capped.
       How long that takes is itself a number worth having — it is the daemon
       work the newest tab just caused. */
    const settleStart = Date.now();
    while (Date.now() - settleStart < 180_000) {
      if ((await healthLatency()) < 250 && Date.now() - settleStart > 8000) break;
      await sleep(1000);
    }
    const settle_s = round((Date.now() - settleStart) / 1000, 1);

    const probe = async (sid) => browser.evaluate(sid, `JSON.stringify({
      intervals: window.__probe.intervals.size,
      es: window.__probe.es, ws: window.__probe.ws, sseMsgs: window.__probe.sseMsgs,
      daemonReqs: window.__probe.daemonReqs, allReqs: window.__probe.allReqs,
      reqs: window.__probe.reqs.slice(-400), vis: document.visibilityState })`).then(JSON.parse);

    const before = [];
    for (const sid of live) before.push(await probe(sid));
    const t0 = Date.now();

    // Idle window: nothing is driven, so everything counted here is work the
    // app does on its own. Health probes are interleaved rather than run first,
    // so a slow daemon cannot eat the whole window.
    const health = [];
    const cpuSamples = [];
    const daemonCpu = [];
    while (Date.now() - t0 < IDLE_S * 1000 || cpuSamples.length < 3) {
      cpuSamples.push(procStats(child.pid));
      /* Re-resolved every sample: the app restarts a daemon it cannot reach, so
         a pid captured once goes stale exactly when the numbers matter. */
      daemonPid = pidOnPort(3741) ?? daemonPid;
      daemonPids.add(daemonPid);
      if (daemonPid) daemonCpu.push(procStats(daemonPid).cpu);
      health.push(await healthLatency());
      await sleep(700);
    }
    const elapsed = (Date.now() - t0) / 1000;

    const after = [];
    for (const sid of live) after.push(await probe(sid));

    let heap = 0;
    const perWindow = [];
    for (let i = 0; i < live.length; i++) {
      const sid = live[i];
      await browser.send('HeapProfiler.collectGarbage', {}, sid, 60_000).catch(() => {});
      const { usedSize } = await browser.send('Runtime.getHeapUsage', {}, sid);
      heap += usedSize;
      const href = await browser
        .evaluate(sid, 'location.search || "menu"', 10_000)
        .catch(() => '?');
      perWindow.push({
        window: String(href).slice(0, 40),
        visibility: after[i].vis,
        heap_mb: round(usedSize / 1048576, 1),
        intervals: after[i].intervals,
        streams: after[i].es + after[i].ws,
        daemon_reqs: after[i].daemonReqs - before[i].daemonReqs,
      });
    }

    // Interaction latency in the frontmost tab only, and only once its Overview
    // has actually loaded — an empty page switches views instantly.
    const interaction = [];
    if (frontSid) {
      const dl = Date.now() + 60_000;
      while (Date.now() < dl) {
        if (await browser.evaluate(frontSid, '__contentReady()', 10_000).catch(() => false)) break;
        await sleep(500);
      }
      for (let i = 0; i < 5; i++) {
        try {
          interaction.push(await browser.evaluate(frontSid, `__switchView("Activity")`, 30_000));
          interaction.push(await browser.evaluate(frontSid, `__switchView("Overview")`, 30_000));
        } catch (e) {
          process.stderr.write(`interaction: ${e.message}\n`);
          break;
        }
      }
    }

    const proc = cpuSamples[Math.floor(cpuSamples.length / 2)] ?? { cpu: 0, rss_mb: 0, procs: 0 };
    const row = {
      step: label,
      windows: live.length,
      open_to_content_ms: lastOpenMs,
      open_content_arrived: lastOpenOk,
      settle_s,
      daemon_reqs_per_s: round(
        after.reduce((a, x) => a + x.daemonReqs, 0) - before.reduce((a, x) => a + x.daemonReqs, 0),
        0,
      ) / elapsed,
      sse_msgs_per_s: round(
        (after.reduce((a, x) => a + x.sseMsgs, 0) - before.reduce((a, x) => a + x.sseMsgs, 0)) /
          elapsed,
        2,
      ),
      live_intervals: after.reduce((a, x) => a + x.intervals, 0),
      live_streams: after.reduce((a, x) => a + x.es + x.ws, 0),
      heap_mb: round(heap / 1048576, 1),
      app_cpu_idle_pct: round(median(cpuSamples.map((s) => s.cpu))),
      app_rss_mb: round(median(cpuSamples.map((s) => s.rss_mb)), 0),
      app_procs: proc.procs,
      daemon_cpu_idle_pct: daemonCpu.length ? round(median(daemonCpu)) : null,
      health_median_ms: round(median(health), 0),
      health_p95_ms: round(p95(health), 0),
      health_timeouts: health.filter((h) => h >= 3000).length,
      daemon_pids_seen: daemonPids.size,
      interaction_median_ms: interaction.length ? round(median(interaction), 0) : null,
      interaction_p95_ms: interaction.length ? round(p95(interaction), 0) : null,
      per_window: perWindow,
      /* What the newest tab asked the daemon for while it was opening — the
         per-tab cost that a tab count multiplies. */
      newest_tab_slowest_reqs: (before[before.length - 1]?.reqs ?? [])
        .slice()
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 8),
      newest_tab_req_count: before[before.length - 1]?.reqs.length ?? 0,
      newest_tab_req_ms_total: (before[before.length - 1]?.reqs ?? []).reduce((a, r) => a + r.ms, 0),
    };
    row.daemon_reqs_per_s = round(row.daemon_reqs_per_s, 2);
    process.stderr.write(
      `${JSON.stringify({ ...row, per_window: undefined, newest_tab_slowest_reqs: undefined })}\n`,
    );
    process.stderr.write(`  newest tab: ${JSON.stringify(row.newest_tab_slowest_reqs)}\n`);
    return row;
  };

  const rows = [];
  const opened = [];
  let maxTabs = 0;
  for (const n of STEPS) {
    while (opened.length < n) {
      const before = new Set(sessions.keys());
      await openTab(roots[opened.length]);
      const sid = [...sessions.keys()].find((s) => !before.has(s));
      opened.push(sid);
    }
    maxTabs = Math.max(maxTabs, n);
    rows.push(await measure(`${n} project tab${n === 1 ? '' : 's'}`, opened[opened.length - 1]));
  }

  // Back down to one: heap and timers that do not return are a leak.
  while (opened.length > 1) await closeTab(opened.pop());
  await sleep(5000);
  rows.push(await measure(`1 tab (after ${maxTabs})`, opened[0]));

  const out = {
    date: new Date().toISOString(),
    env: { os: `macOS ${os.release()}`, arch: os.arch(), node: process.version },
    idle_seconds: IDLE_S,
    rows,
  };
  const json = JSON.stringify(out, null, 2);
  OUT ? fs.writeFileSync(OUT, `${json}\n`) : console.log(json);
} finally {
  browser?.close();
  await stop();
}
