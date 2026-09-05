#!/usr/bin/env node
/**
 * Time to first *useful* paint, per screen (TRA-934).
 *
 * `scripts/perf-measure.mjs` answers "when did the shell appear". This answers
 * the question the user actually asks — "when could I read something" — for
 * every screen the app has, and it answers it separately from "when was the
 * data complete", because those are different products.
 *
 * The renderer marks its own screens (`src/renderer/perf.ts`); this script only
 * navigates and reads `window.__traceUseful`. Two numbers per screen:
 *
 *   cold_ms  — fresh window, fresh profile: navigation → useful. This is the
 *              number that includes bundle parse, React boot and the first
 *              daemon read, and it is the one most evaluators will ever see.
 *   warm_ms  — the same screen reached by clicking the sidebar in a window that
 *              is already up. Pure data latency.
 *
 * Usage:
 *   node scripts/perf-screens.mjs [--samples 3] [--project <root>]
 *                                 [--daemon http://127.0.0.1:3741]
 *                                 [--wedged] [--json out.json]
 *
 * `--wedged` is the important mode. It points the renderer at a socket that
 * accepts connections and never answers — the daemon's observed failure shape
 * (TRA-922) — and reports how long each screen stays unreadable. A screen whose
 * `wedged_ms` is `null` never became useful at all: an unbounded wait, which is
 * a hung screen with no way out.
 *
 * Requires `pnpm run build` first — it measures the production bundle.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './electron-cdp.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const SAMPLES = Number(flag('samples', 3));
const OUT = flag('json', null);
const WEDGED = args.includes('--wedged');
const DAEMON = flag('daemon', 'http://127.0.0.1:3741');
const PROJECT = flag('project', null);
/* Reuse a profile across samples instead of a fresh one each time. This is the
   cold/warm distinction that matters for this app: a warm profile has the
   localStorage snapshots, so the screens that keep one can paint before the
   daemon answers, and a screen whose warm number equals its cold number is a
   screen that keeps nothing. */
const PROFILE = flag('profile', null);
/* Same reasoning as perf-measure.mjs: a fixed CDP port collides with whatever
   chrome-devtools-mcp left running and the harness then measures a Chrome tab. */
const PORT_RANGE = [9354, 9374];
/** How long a screen gets to become useful before we call it hung. */
const USEFUL_DEADLINE_MS = 30_000;

/** Screens reachable in the menu window, in sidebar order. */
const MENU_SCREENS = ['workspace', 'clients'];
/** Screens reachable in a project window. `graph` is excluded: it needs a GPU
    context the harness's unmapped window does not always get, and its own
    settle time is a different measurement (renderer_cpu_idle_pct). */
const PROJECT_SCREENS = ['overview', 'ask', 'activity', 'memory', 'notebook', 'insights'];

// ── ports ───────────────────────────────────────────────────────────

async function freePort([lo, hi]) {
  for (let p = lo; p <= hi; p++) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  throw new Error('no free CDP port');
}

/**
 * Make the daemon look wedged to this window: pause every request to
 * 127.0.0.1:3741 and never resume it. The TCP handshake succeeds, the response
 * never arrives — the daemon's observed failure shape (TRA-922), and the only
 * one that matters, since a *refused* connection fails in microseconds and
 * every screen already handles that.
 *
 * There is deliberately no `Fetch.requestPaused` handler. A bounded fetch still
 * aborts on its own AbortSignal; an unbounded one hangs forever. That is
 * exactly the difference this mode is here to measure.
 */
async function wedgeDaemon(cdp) {
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:3741/*' }] });
}

// ── app ─────────────────────────────────────────────────────────────

async function rendererTarget(port, pid, deadline) {
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`no renderer target for pid ${pid}`);
    await sleep(50);
  }
}

async function launchApp(env) {
  const userData = PROFILE ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-screens-'));
  fs.mkdirSync(userData, { recursive: true });
  const electron = path.join(
    appDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron',
  );
  const port = await freePort(PORT_RANGE);
  const child = spawn(
    electron,
    [appDir, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
    {
      cwd: appDir,
      // TRACE_MCP_AGENT_RUN keeps the window unmapped so a measurement run
      // cannot drag the person at the keyboard off their Space.
      env: { ...env, ELECTRON_RUN_AS_NODE: '', TRACE_MCP_AGENT_RUN: '1' },
      stdio: 'ignore',
    },
  );
  /* SIGTERM, not SIGKILL. Chromium flushes localStorage on the way out, and a
     kill -9 drops whatever a screen wrote in its last second — which is exactly
     the snapshot the *next* sample is supposed to open on. Measured: a
     SIGKILLed sample left no `trace-mcp.overview.stats:*` key at all, so the
     warm run was silently measuring a cold profile. */
  const stop = async () => {
    child.kill('SIGTERM');
    await sleep(1200);
    if (!child.killed) child.kill('SIGKILL');
    if (!PROFILE) fs.rmSync(userData, { recursive: true, force: true });
  };
  try {
    const target = await rendererTarget(port, child.pid, Date.now() + 60_000);
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    return { child, cdp, stop, baseUrl: target.url.split('?')[0] };
  } catch (e) {
    await stop();
    throw e;
  }
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  return r.result?.value;
}

/** Wait until `screen` reports a useful paint; return its renderer timestamp. */
async function waitUseful(cdp, screen, startedAt) {
  const deadline = Date.now() + USEFUL_DEADLINE_MS;
  for (;;) {
    const at = await evaluate(cdp, `window.__traceUseful?.[${JSON.stringify(screen)}] ?? null`);
    if (typeof at === 'number') return Math.round(at - startedAt);
    if (Date.now() > deadline) return null; // never became useful
    await sleep(25);
  }
}

/** Navigate a window to `params` and measure the named screen from timeOrigin. */
async function coldScreen(cdp, baseUrl, params, screen) {
  const qs = new URLSearchParams(params).toString();
  await cdp.send('Page.navigate', { url: `${baseUrl}?${qs}` });
  const useful_ms = await waitUseful(cdp, screen, 0);
  /* The shell's own share, so a slow screen can be attributed: bundle parse
     and React boot (`app-first-content`) versus waiting on data. */
  const shell_ms = await evaluate(
    cdp,
    `Math.round(performance.getEntriesByName('app-first-content')[0]?.startTime ?? -1)`,
  );
  return { cold_ms: useful_ms, cold_shell_ms: shell_ms >= 0 ? shell_ms : null };
}

/** Click a sidebar section in the current window and measure the delta. */
async function warmScreen(cdp, screen) {
  const clickedAt = await evaluate(
    cdp,
    `(() => {
       const el = document.querySelector('[data-nav=${JSON.stringify(screen)}]');
       if (!el) return null;
       const t = performance.now();
       el.click();
       return t;
     })()`,
  );
  if (clickedAt === null) return { warm_ms: null, note: 'no nav row' };
  return { warm_ms: await waitUseful(cdp, screen, clickedAt) };
}

// ── one sample ──────────────────────────────────────────────────────

async function runSample() {
  const env = { ...process.env };
  const { cdp, stop, baseUrl } = await launchApp(env);
  const screens = {};
  try {
    if (WEDGED) await wedgeDaemon(cdp);

    // Menu window, cold.
    screens.workspace = await coldScreen(cdp, baseUrl, { view: 'menu', tab: 'workspace' }, 'workspace');
    for (const s of MENU_SCREENS.slice(1)) {
      screens[s] = await warmScreen(cdp, s);
    }

    if (PROJECT) {
      // Project window, cold on Overview, then warm through the rest.
      screens.overview = await coldScreen(cdp, baseUrl, { view: 'project', root: PROJECT }, 'overview');
      for (const s of PROJECT_SCREENS.slice(1)) {
        screens[s] = await warmScreen(cdp, s);
      }
    }
    return screens;
  } finally {
    cdp.close();
    await stop();
  }
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};

async function main() {
  if (!fs.existsSync(path.join(appDir, 'dist', 'renderer', 'index.html'))) {
    throw new Error('run `pnpm run build` first — this measures the production bundle');
  }

  const samples = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(await runSample());

  const names = [...new Set(samples.flatMap((s) => Object.keys(s)))];
  const metrics = {};
  for (const n of names) {
    const cold = samples.map((s) => s[n]?.cold_ms);
    const warm = samples.map((s) => s[n]?.warm_ms);
    /* Samples in which this screen never produced a useful frame inside
       USEFUL_DEADLINE_MS. Non-zero here is the headline, not the medians. */
    const hung = samples.filter(
      (s) => n in s && (s[n].cold_ms ?? s[n].warm_ms ?? null) === null,
    ).length;
    metrics[n] = {
      cold_ms: median(cold),
      cold_shell_ms: median(samples.map((s) => s[n]?.cold_shell_ms)),
      warm_ms: median(warm),
      never_useful: hung,
    };
  }

  const report = {
    date: new Date().toISOString(),
    mode: WEDGED ? 'wedged-daemon' : 'live-daemon',
    daemon: WEDGED ? 'intercepted: accepts, never answers' : DAEMON,
    project: PROJECT,
    profile: PROFILE ? 'warm (reused)' : 'cold (fresh per sample)',
    samples: SAMPLES,
    deadline_ms: USEFUL_DEADLINE_MS,
    env: { os: `${os.platform()} ${os.release()}`, arch: os.arch(), node: process.version },
    metrics,
  };
  const json = JSON.stringify(report, null, 2);
  if (OUT) fs.writeFileSync(OUT, `${json}\n`);
  console.log(json);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
