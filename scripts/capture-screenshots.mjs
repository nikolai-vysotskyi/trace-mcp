#!/usr/bin/env node
/**
 * Regenerate every screenshot docs/ and trace-mcp.com ship, from a seeded
 * demo state, in one command:
 *
 *   node scripts/capture-screenshots.mjs          # capture
 *   node scripts/capture-screenshots.mjs --check  # are the committed ones stale?
 *
 * Why it drives the real Electron window and not a browser: the renderer is a
 * `file://` document that talks to the daemon on 127.0.0.1:3741 and depends on
 * `window.electronAPI`. Chrome renders it, but not as the app.
 *
 * Reproducibility — two runs a month apart must produce comparable images, so
 * nothing about the machine may leak into the frame:
 *   - a sandbox `TRACE_MCP_DATA_DIR` holds the registry, index and settings, so
 *     the developer's own projects are neither read nor written;
 *   - the demo projects are `git archive` extracts of THIS repo at HEAD, placed
 *     under a neutral root (no home directory, no user name, no agent workdir);
 *   - `TRACE_MCP_BIN` points at a no-op shim so the app's `ensureDaemon()`
 *     cannot install a launchd agent or spawn a second daemon;
 *   - appearance, sidebar width, viewport and scale come from the manifest, not
 *     from system settings.
 *
 * Reduce Transparency is emulated for every shot. It is a real product state,
 * and it is the one that renders the sidebar opaque — the macOS vibrancy behind
 * the window is native, so a renderer-side capture would otherwise show a
 * see-through hole where the sidebar is.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'screenshots.manifest.json');
export const IMAGES_DIR = path.join(REPO_ROOT, 'docs', 'images');
export const MARKER_PATH = path.join(IMAGES_DIR, 'screenshots.json');

/** Directories whose changes invalidate a capture. */
export const UI_PATHS = ['packages/app/src/renderer', 'packages/app/src/main'];

/** The port the renderer is hard-coded to call. */
const RENDERER_DAEMON_PORT = 3741;
/** Where the seeded daemon actually listens. The renderer's calls are rewritten
 *  onto it (see `redirectDaemonTraffic`), so a capture never disturbs — and is
 *  never contaminated by — the daemon the developer already has running. */
const DEMO_DAEMON_PORT = 3799;
const DEBUG_PORT = 9333;

// ── Freshness (pure — unit-tested in tests/scripts/capture-screenshots.test.ts) ──

/**
 * Compare a committed capture marker against the state of the repo now.
 * `current.presentFiles` is the list of files actually in docs/images.
 */
export function checkFreshness(marker, current) {
  if (!marker) {
    return { fresh: false, reasons: ['no capture marker — run scripts/capture-screenshots.mjs'] };
  }
  const reasons = [];
  if (marker.uiCommit !== current.uiCommit) {
    reasons.push(
      `the app UI changed since these were captured (${short(marker.uiCommit)} → ${short(current.uiCommit)})`,
    );
  }
  if (marker.appVersion !== current.appVersion) {
    reasons.push(
      `the app version changed since capture (${marker.appVersion} → ${current.appVersion})`,
    );
  }
  const expected = (marker.images ?? []).map((i) => i.file);
  const missing = expected.filter((f) => !current.presentFiles.includes(f));
  if (missing.length > 0) reasons.push(`missing image files: ${missing.join(', ')}`);
  return { fresh: reasons.length === 0, reasons };
}

export function short(sha) {
  return typeof sha === 'string' ? sha.slice(0, 8) : String(sha);
}

/** The commit that last touched anything the screenshots show. */
export function uiCommit(repo = REPO_ROOT) {
  return git(['log', '-1', '--format=%H', '--', ...UI_PATHS], repo);
}

export function readMarker(markerPath = MARKER_PATH) {
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ── Small helpers ──────────────────────────────────────────────────

function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function log(msg) {
  process.stderr.write(`[screenshots] ${msg}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, { timeoutMs = 120_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

async function portIsFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch (err) {
    // A refused connection is what "free" looks like; anything else answered.
    return /refused|ECONNREFUSED|fetch failed/i.test(String(err));
  }
}

// ── Seeding ────────────────────────────────────────────────────────

/**
 * Demo projects are subtrees of this repo at HEAD, extracted to a neutral
 * root. Real code, recognisable name, no path that identifies a machine.
 */
function seedDemoProjects(manifest, demoRoot) {
  fs.rmSync(demoRoot, { recursive: true, force: true });
  fs.mkdirSync(demoRoot, { recursive: true });
  const roots = [];
  for (const p of manifest.demoProjects) {
    const dest = path.join(demoRoot, p.name);
    fs.mkdirSync(dest, { recursive: true });
    const treeish = p.subtree === '.' ? 'HEAD' : `HEAD:${p.subtree}`;
    execFileSync('sh', ['-c', `git archive --format=tar ${treeish} | tar -x -C '${dest}'`], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    // Test fixtures are 44 miniature apps. Indexed, they dominate the graph's
    // labels and the dead-export count with scaffolding nobody wants to look at.
    for (const ex of p.exclude ?? [])
      fs.rmSync(path.join(dest, ex), { recursive: true, force: true });
    roots.push({ ...p, root: dest });
  }
  return roots;
}

/**
 * Make the daemon's project list exactly the demo set. The daemon registers its
 * own working directory on startup, and a leftover registry would put a
 * developer's checkout in the frame — so this both adds what belongs and
 * removes what doesn't.
 */
async function registerDemoProjects(projects) {
  const api = `http://127.0.0.1:${DEMO_DAEMON_PORT}/api/projects`;
  const wanted = new Set(projects.map((p) => p.root));
  for (const root of wanted) {
    await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    });
  }
  const { projects: listed = [] } = await (await fetch(api)).json();
  for (const p of listed) {
    if (!wanted.has(p.root))
      await fetch(`${api}?project=${encodeURIComponent(p.root)}`, { method: 'DELETE' });
  }
  await waitFor('the demo projects to finish indexing', async () => {
    const { projects: now = [] } = await (await fetch(api)).json();
    return now.length === wanted.size && now.every((p) => p.status === 'ready');
  });

  // The Workspace dashboard reads a separate, lazily-computed health cache. Warm
  // it here: the KPI strip renders skeletons until it lands, and a screenshot of
  // six grey placeholders is exactly the failure this pipeline exists to avoid.
  const dashboard = `http://127.0.0.1:${DEMO_DAEMON_PORT}/api/dashboard`;
  await fetch(`${dashboard}/refresh`, { method: 'POST' });
  await waitFor('the dashboard health metrics', async () => {
    const res = await fetch(`${dashboard}/projects`);
    if (!res.ok) return false;
    const { projects: metrics = [] } = await res.json();
    return metrics.length === wanted.size && metrics.every((m) => (m.totalFiles ?? 0) > 0);
  });
}

/**
 * The guard's health comes from a heartbeat an attached agent session writes.
 * A capture has no agent, so without this the showcase screenshot ships a red
 * "Not running" badge — a state a configured install does not sit in. Seeded
 * like the index itself: representative, reproducible, declared in the
 * manifest, and confined to the sandbox.
 */
function seedGuardSession(projects, session) {
  if (!session) return;
  const now = new Date().toISOString();
  for (const p of projects) {
    const dir = path.join(p.root, '.trace-mcp');
    fs.mkdirSync(dir, { recursive: true });
    // strict, not coach: coach renders a "switches to strict on <date>" row,
    // and a date that moves every run is not a reproducible screenshot.
    fs.writeFileSync(path.join(dir, 'guard-mode'), 'strict\n');
    const hash = createHash('sha256').update(p.root).digest('hex').slice(0, 12);
    fs.writeFileSync(
      path.join(os.tmpdir(), `trace-mcp-status-${hash}.json`),
      `${JSON.stringify(
        {
          pid: process.pid,
          last_heartbeat_at: now,
          last_successful_tool_call_at: now,
          tool_calls_total: session.toolCalls,
          tool_calls_failed: 0,
        },
        null,
        2,
      )}\n`,
    );
  }
}

function writeSandboxHome(home) {
  fs.mkdirSync(home, { recursive: true });
  // No auto-update: the daemon must not replace itself mid-capture, and the
  // registry check is a network round-trip we neither need nor want.
  fs.writeFileSync(
    path.join(home, '.config.json'),
    `${JSON.stringify({ auto_update: false }, null, 2)}\n`,
  );
  // The app shells out to `$TRACE_MCP_BIN daemon start` on launch. This script
  // already owns the daemon, so the shim answers "done" and does nothing —
  // without it the app would install a launchd agent pointed at the sandbox.
  const shim = path.join(home, 'noop-trace-mcp');
  fs.writeFileSync(shim, '#!/bin/sh\n# capture harness owns the daemon lifecycle\nexit 0\n');
  fs.chmodSync(shim, 0o755);
  return shim;
}

// ── CDP ────────────────────────────────────────────────────────────

/** Minimal CDP client — one page target, request/response over one socket. */
async function attachToRenderer(port) {
  let targets = [];
  await waitFor(
    'the Electron renderer to expose a debugging target',
    async () => {
      try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      } catch {
        return false;
      }
      return targets.some((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    },
    { timeoutMs: 60_000 },
  );
  const target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const events = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (!entry) return;
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    } else {
      for (const fn of events.get(msg.method) ?? []) fn(msg.params);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, fn) => events.set(method, [...(events.get(method) ?? []), fn]);
  const once = (method) =>
    new Promise((resolve) => {
      const fn = (params) => {
        events.set(
          method,
          (events.get(method) ?? []).filter((f) => f !== fn),
        );
        resolve(params);
      };
      on(method, fn);
    });

  return { send, on, once, close: () => ws.close() };
}

/**
 * Send the renderer's daemon calls to the seeded daemon instead of the one on
 * the well-known port. The port lives in the renderer as a constant, so this is
 * a transport-level rewrite rather than a change to the app being photographed.
 */
async function redirectDaemonTraffic(cdp) {
  cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
    const url = request.url.replace(
      `127.0.0.1:${RENDERER_DAEMON_PORT}`,
      `127.0.0.1:${DEMO_DAEMON_PORT}`,
    );
    cdp.send('Fetch.continueRequest', { requestId, url }).catch(() => {
      // The request may already be gone (navigation cancelled it) — harmless.
    });
  });
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: `http://127.0.0.1:${RENDERER_DAEMON_PORT}/*` }],
  });
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(cdp, expression) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.value;
}

/**
 * Navigate from inside the page rather than with `Page.navigate`. A CDP-issued
 * navigation to a `file://` URL arrives with an opaque initiator, and Chromium
 * then refuses to load the bundle's own scripts ("origin 'null' blocked by CORS
 * policy") — the window comes up blank. Assigning `location.href` inside the
 * document keeps the app's own file origin, exactly as the main process does.
 */
async function navigate(cdp, url) {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(url)}` });
  await loaded;
}

/**
 * Hold until the surface has real content: no skeleton rows, no `aria-busy`
 * region, no "Loading…" placeholder. A screenshot of a skeleton is worse than
 * no screenshot.
 */
async function waitForContent(cdp) {
  await waitFor(
    'the surface to finish loading',
    async () =>
      (await evaluate(
        cdp,
        `document.querySelectorAll('.ws-sb-skeleton, .ws-skel, [aria-busy="true"], [aria-label^="Loading"]').length === 0`,
      )) === true,
    { timeoutMs: 45_000 },
  );
}

// ── Capture ────────────────────────────────────────────────────────

function rendererUrl(shot, projectsByName) {
  const base = `file://${path.join(REPO_ROOT, 'packages/app/dist/renderer/index.html')}`;
  const params = new URLSearchParams({ view: shot.view });
  if (shot.view === 'project') params.set('root', projectsByName.get(shot.project).root);
  if (shot.tab) params.set('tab', shot.tab);
  return `${base}?${params}`;
}

async function captureShot(cdp, shot, ctx) {
  const { manifest, projectsByName } = ctx;
  const { viewport, deviceScaleFactor, format, quality } = manifest.capture;

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor,
    mobile: false,
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: shot.theme },
      // The window's vibrancy is native and invisible to a renderer capture;
      // this is the product's own opaque-sidebar path.
      { name: 'prefers-reduced-transparency', value: 'reduce' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });

  // The appearance the app itself stores. Emulated media alone only drives CSS;
  // the renderer's own `data-mode` attribute comes from this key.
  await evaluate(cdp, `localStorage.setItem('trace-mcp-theme', ${JSON.stringify(shot.theme)})`);
  await navigate(cdp, rendererUrl(shot, projectsByName));

  // Every step is a control the user would click, addressed by its own label:
  // a sidebar row ("Graph"), a toolbar button ("Fit"). React mounts after the
  // load event, so each one is polled for rather than assumed present.
  for (const step of shot.clicks ?? []) {
    const label = typeof step === 'string' ? step : step.label;
    await waitFor(
      `the "${label}" control (${shot.name})`,
      async () =>
        (await evaluate(
          cdp,
          `(() => {
            const el = [...document.querySelectorAll('button')]
              .find(b => b.textContent.trim() === ${JSON.stringify(label)});
            if (!el) return false;
            el.click();
            return true;
          })()`,
        )) === true,
      { timeoutMs: 30_000 },
    );
    await sleep(typeof step === 'string' ? 1200 : (step.afterMs ?? 1200));
  }

  await waitForContent(cdp);
  await sleep(shot.settleMs ?? 1500);

  const { data } = await cdp.send('Page.captureScreenshot', {
    format,
    quality,
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const file = `${shot.name}.${format}`;
  const bytes = Buffer.from(data, 'base64');
  fs.writeFileSync(path.join(IMAGES_DIR, file), bytes);
  log(`${file} — ${Math.round(bytes.length / 1024)} KB`);
  return {
    name: shot.name,
    file,
    surface:
      shot.view === 'project'
        ? `project · ${shot.clicks?.[0] ?? 'overview'}`
        : `menu · ${shot.tab}`,
    theme: shot.theme,
    width: Math.round(viewport.width * deviceScaleFactor),
    height: Math.round(viewport.height * deviceScaleFactor),
    bytes: bytes.length,
    alt: shot.alt,
  };
}

// ── Orchestration ──────────────────────────────────────────────────

async function capture(manifest, only) {
  const cliEntry = path.join(REPO_ROOT, 'dist', 'cli.js');
  // The real binary, not the `.bin/electron` shim: killing the shim leaves the
  // Electron process behind, holding the debugging port for the next run.
  const electronDir = path.join(REPO_ROOT, 'packages/app/node_modules/electron');
  const electronBin = fs.existsSync(path.join(electronDir, 'path.txt'))
    ? path.join(
        electronDir,
        'dist',
        fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf-8').trim(),
      )
    : path.join(electronDir, '../.bin/electron');
  for (const [what, p] of [
    ['the CLI bundle (run `pnpm run build`)', cliEntry],
    [
      'the app bundle (run `pnpm --dir packages/app run build`)',
      path.join(REPO_ROOT, 'packages/app/dist/renderer/index.html'),
    ],
    ['Electron (run `pnpm --dir packages/app install`)', electronBin],
  ]) {
    if (!fs.existsSync(p)) throw new Error(`missing ${what}`);
  }
  for (const port of [DEMO_DAEMON_PORT, DEBUG_PORT]) {
    if (!(await portIsFree(port))) {
      throw new Error(`port ${port} is busy — a previous capture may still be running`);
    }
  }

  const sandbox = path.join(os.tmpdir(), 'trace-mcp-screenshots');
  const home = path.join(sandbox, 'home');
  // Neutral, stable, and visible in the frame: the Workspace table prints the
  // project's absolute path. Nothing here identifies a machine or a person.
  const demoRoot = path.join(path.sep, 'tmp', 'trace-mcp-demo');
  fs.rmSync(home, { recursive: true, force: true });
  const shim = writeSandboxHome(home);
  const env = { ...process.env, TRACE_MCP_DATA_DIR: home, TRACE_MCP_BIN: shim };
  delete env.ELECTRON_RUN_AS_NODE;

  log(`seeding demo projects in ${demoRoot}`);
  const projects = seedDemoProjects(manifest, demoRoot);
  for (const p of projects) {
    log(`indexing ${p.name}…`);
    execFileSync(process.execPath, [cliEntry, 'index', p.root], { env, stdio: 'inherit' });
  }
  const projectsByName = new Map(projects.map((p) => [p.name, p]));

  seedGuardSession(projects, manifest.demoGuardSession);

  const daemon = spawn(
    process.execPath,
    [cliEntry, 'serve-http', '--port', String(DEMO_DAEMON_PORT)],
    // Inside the demo root: the daemon registers its own working directory on
    // startup, and this repo's checkout path must never end up in the frame.
    { cwd: demoRoot, env, stdio: 'ignore' },
  );
  // Its own Chromium profile, wiped every run. Without it this instance shares
  // the installed app's user-data directory, loses the singleton lock to it and
  // exits before painting — and localStorage from an earlier run would leak
  // into the frame.
  const profile = path.join(sandbox, 'electron-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const electron = spawn(
    electronBin,
    ['.', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`],
    { cwd: path.join(REPO_ROOT, 'packages/app'), env, stdio: 'ignore' },
  );
  let cdp = null;
  try {
    await waitFor(
      'the daemon to answer /health',
      async () => !(await portIsFree(DEMO_DAEMON_PORT)),
    );
    await registerDemoProjects(projects);
    cdp = await attachToRenderer(DEBUG_PORT);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await redirectDaemonTraffic(cdp);

    // One-time renderer state, written into the window the app opened for
    // itself: the onboarding sheet is dismissed, the recent list is populated,
    // the sidebar is at the manifest width.
    const recent = projects.filter((p) => p.recent).map((p) => p.root);
    await evaluate(
      cdp,
      `localStorage.setItem('trace-mcp.onboarded.v1', '1');
       localStorage.setItem('trace-mcp:recent-projects', ${JSON.stringify(JSON.stringify(recent))});
       localStorage.setItem('trace-mcp-sidebar-width', '${manifest.capture.sidebarWidth}');
       localStorage.setItem('trace-mcp-sidebar-collapsed', '0');`,
    );

    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    const images = [];
    for (const shot of manifest.shots) {
      if (only.length > 0 && !only.includes(shot.name)) continue;
      images.push(await captureShot(cdp, shot, { manifest, projectsByName }));
    }
    return images;
  } finally {
    cdp?.close();
    for (const child of [electron, daemon]) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

function writeMarker(images) {
  const marker = {
    $comment: 'Written by scripts/capture-screenshots.mjs. `--check` compares it against HEAD.',
    generatedAt: new Date().toISOString(),
    appVersion: JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'packages/app/package.json'), 'utf-8'),
    ).version,
    commit: git(['rev-parse', 'HEAD']),
    uiCommit: uiCommit(),
    uiPaths: UI_PATHS,
    images,
  };
  fs.writeFileSync(MARKER_PATH, `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

function currentState() {
  return {
    uiCommit: uiCommit(),
    appVersion: JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'packages/app/package.json'), 'utf-8'),
    ).version,
    presentFiles: fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR) : [],
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

  if (argv.includes('--check')) {
    const result = checkFreshness(readMarker(), currentState());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.fresh ? 0 : 1);
  }

  const only = argv.filter((a) => !a.startsWith('-'));
  const images = await capture(manifest, only);
  if (only.length > 0) {
    // A partial run must not claim the whole set is current.
    log('partial run — capture marker left untouched');
    return;
  }
  const marker = writeMarker(images);
  log(`captured ${images.length} images at ${short(marker.uiCommit)} (app v${marker.appVersion})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    log(`failed: ${err.message}`);
    process.exit(1);
  });
}
