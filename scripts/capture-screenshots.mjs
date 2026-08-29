#!/usr/bin/env node
/**
 * Regenerate every screenshot docs/ and trace-mcp.com ship, from a seeded
 * demo state, in one command:
 *
 *   node scripts/capture-screenshots.mjs          # capture, once the machine is idle
 *   node scripts/capture-screenshots.mjs --now    # capture even if somebody is using it
 *   node scripts/capture-screenshots.mjs --check  # are the committed ones stale?
 *
 * Why it drives the real Electron window and not a browser: the renderer is a
 * `file://` document that talks to the daemon on 127.0.0.1:3741 and depends on
 * `window.electronAPI`. Chrome renders it, but not as the app.
 *
 * Why the pixels come from `screencapture` and not from CDP: `Page.
 * captureScreenshot` photographs the web contents, and the window chrome is not
 * web contents. The traffic lights are AppKit buttons, the rounded corners and
 * the sidebar's vibrancy are the window server's — a CDP shot of the real
 * Electron window is indistinguishable from a browser tab, which is exactly
 * what shipped once (TRA-390). So the window is captured by its CGWindowID,
 * shadow-free, alpha-cornered, and every frame is inspected for the chrome it
 * must contain before it is allowed to become a file (`checkWindowChrome`).
 * That makes this a macOS-only script, which it already was in every way that
 * mattered.
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
 * A window capture composites the vibrancy view itself, without the desktop
 * behind it, so the sidebar photographs as real glass and still contains
 * nothing of the machine that took the shot. Reduce Transparency is therefore
 * no longer emulated — that was a workaround for a renderer-side capture, which
 * could only ever show a see-through hole where the sidebar is.
 *
 * This run owns the screen, and that is not fixable (TRA-403). Both ways of
 * capturing without one were measured on this app, and both produce exactly the
 * frame `checkWindowChrome` exists to refuse:
 *   - `webContents.capturePage()` on a window that is never shown → square,
 *     fully opaque corners and no traffic lights: a picture of a web page;
 *   - `showInactive()` + `screencapture -l` → the corners come back, but AppKit
 *     draws the buttons of a window whose app is not active in grey.
 * Coloured buttons mean the app is frontmost, so a published screenshot costs
 * one activation. What this script owes the person at the keyboard is therefore
 * not "never activate" but "never do it while they are there": it waits for the
 * machine to be idle (see `mayStartCapture`) unless told `--now`, and it
 * activates once per run rather than once per shot.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

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
/** The main process's Node inspector. Only it can name the window: the
 *  CGWindowID `screencapture -l` needs comes from `getMediaSourceId()`. */
const MAIN_INSPECT_PORT = 9334;

/** Where the window is parked while it is photographed. Off the top-left
 *  corner so the whole frame — shadowless, but still full-size — is on screen. */
const WINDOW_ORIGIN = { x: 40, y: 40 };

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

// ── Idle gate (pure — unit-tested in tests/scripts/capture-screenshots.test.ts) ──

/** How long the machine must have been untouched before a capture may start.
 *  A run takes a couple of minutes and holds the front the whole time. */
export const IDLE_REQUIRED_S = 300;
/** Nothing else on this machine can tell a capture run that a person is here. */
export const IDLE_EXIT_CODE = 75; // EX_TEMPFAIL — "not now, ask again later"

/** Seconds since the last keyboard or mouse event, out of `ioreg -c IOHIDSystem`.
 *  `HIDIdleTime` is in nanoseconds; absent on a machine with no HID at all. */
export function parseIdleSeconds(ioregOutput) {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioregOutput ?? '');
  return match ? Number(match[1]) / 1e9 : null;
}

/**
 * May this run take over the screen? Only when nobody is at the keyboard —
 * or when a human asked for it explicitly with `--now`.
 *
 * `idleSeconds` of `null` means the idle time could not be read. That is a
 * "don't know", and a capture run that does not know whether someone is
 * watching does not go ahead.
 */
export function mayStartCapture(idleSeconds, { force = false } = {}) {
  if (force) return { ok: true, reason: null };
  if (idleSeconds === null) {
    return { ok: false, reason: 'cannot tell whether anyone is at the machine — pass --now' };
  }
  if (idleSeconds < IDLE_REQUIRED_S) {
    return {
      ok: false,
      reason: `the machine was in use ${Math.round(idleSeconds)}s ago; a capture activates the app and would pull whoever is here out of what they are doing (needs ${IDLE_REQUIRED_S}s idle, or --now)`,
    };
  }
  return { ok: true, reason: null };
}

// ── Window chrome (pure — unit-tested in tests/scripts/capture-screenshots.test.ts) ──

/**
 * The strip the macOS window buttons live in, in CSS px. Deliberately a region
 * and not three coordinates: the exact offsets are `TRAFFIC_LIGHT_X/Y` in
 * `packages/app/src/shared/chrome-metrics.ts` and are allowed to move without
 * breaking this check.
 */
export const CHROME_STRIP = { width: 88, height: 44 };

/** How each button reads once the window is key. Measured off a real capture:
 *  close (236,103,101), minimise (242,202,68), zoom (44,170,47). A window that
 *  is not frontmost draws all three grey, and grey matches nothing here — which
 *  is the intent, an unfocused window is not the app at its best. */
const TRAFFIC_LIGHTS = [
  { name: 'close (red)', test: (r, g, b) => r > 170 && r - g > 70 && r - b > 70 },
  { name: 'minimise (yellow)', test: (r, g, b) => r > 170 && g > 140 && r - b > 80 && g - b > 80 },
  { name: 'zoom (green)', test: (r, g, b) => g > 120 && g - r > 60 && g - b > 60 },
];

/**
 * Refuse a frame that is not a photograph of the macOS window.
 *
 * Three times now a capture of the web contents alone — from a browser tab or
 * from CDP — has been published as "the app" (TRA-354, TRA-366, TRA-390). The
 * two things such a frame can never have are what this looks for:
 *
 *   - transparent rounded corners, which only a window capture produces;
 *   - the three traffic lights, in colour, in the top-left strip.
 *
 * `image` is `{ width, height, rgba }`; `scale` is device px per CSS px.
 */
export function checkWindowChrome(image, scale) {
  const { width, height, rgba } = image;
  const reasons = [];
  const alphaAt = (x, y) => rgba[(y * width + x) * 4 + 3];

  const inset = Math.max(1, Math.round(scale));
  const corners = [
    ['top-left', inset, inset],
    ['top-right', width - 1 - inset, inset],
    ['bottom-left', inset, height - 1 - inset],
    ['bottom-right', width - 1 - inset, height - 1 - inset],
  ].filter(([, x, y]) => alphaAt(x, y) !== 0);
  if (corners.length > 0) {
    reasons.push(
      `no rounded window corners (${corners.map(([n]) => n).join(', ')} opaque) — this is a capture of the web contents, not of the window`,
    );
  }
  if (alphaAt(width >> 1, height >> 1) !== 255) {
    reasons.push('the middle of the frame is transparent — the window did not paint');
  }

  const stripW = Math.min(width, Math.round(CHROME_STRIP.width * scale));
  const stripH = Math.min(height, Math.round(CHROME_STRIP.height * scale));
  const found = TRAFFIC_LIGHTS.map(() => 0);
  for (let y = 0; y < stripH; y++) {
    for (let x = 0; x < stripW; x++) {
      const o = (y * width + x) * 4;
      if (rgba[o + 3] !== 255) continue;
      for (let i = 0; i < TRAFFIC_LIGHTS.length; i++) {
        if (TRAFFIC_LIGHTS[i].test(rgba[o], rgba[o + 1], rgba[o + 2])) found[i]++;
      }
    }
  }
  // A 12pt circle is ~113 CSS px²; a third of one is still unmistakably a light
  // and leaves room for the gloss and the antialiased rim.
  const floor = Math.round(40 * scale * scale);
  const missing = TRAFFIC_LIGHTS.filter((_, i) => found[i] < floor).map((l) => l.name);
  if (missing.length > 0) {
    reasons.push(
      `no traffic lights in the top-left ${CHROME_STRIP.width}×${CHROME_STRIP.height} strip (${missing.join(', ')}) — the window was not captured, or was not frontmost`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Just enough PNG to inspect what `screencapture` writes: 8-bit RGB/RGBA, no
 * interlacing. Reading the pixels here rather than in the renderer keeps the
 * guard independent of the thing it is guarding.
 */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    at += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colourType, , , interlace] = body.subarray(8, 13);
      channels = { 2: 3, 6: 4 }[colourType] ?? 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) {
        throw new Error(`unsupported PNG (depth ${depth}, colour type ${colourType})`);
      }
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0, at = 0; y < height; y++) {
    const filter = raw[at++];
    const line = Uint8Array.prototype.slice.call(raw, at, at + stride);
    at += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      rgba[to] = line[from];
      rgba[to + 1] = line[from + 1];
      rgba[to + 2] = line[from + 2];
      rgba[to + 3] = channels === 4 ? line[from + 3] : 255;
    }
    prev = line;
  }
  return { width, height, rgba };
}

// ── Small helpers ──────────────────────────────────────────────────

function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/** Seconds since the last human input on this machine, or null if unknowable. */
function idleSeconds() {
  try {
    return parseIdleSeconds(
      // `-r` roots the search at IOHIDSystem itself; without it the properties
      // of the class are not printed at all and the idle time reads as unknown.
      execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-r', '-d', '1', '-w', '0'], {
        encoding: 'utf-8',
      }),
    );
  } catch {
    return null;
  }
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

/** Minimal CDP client — one target, request/response over one socket. */
async function attachTo(port, label, accept) {
  let targets = [];
  await waitFor(
    `${label} to expose a debugging target`,
    async () => {
      try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      } catch {
        return false;
      }
      return targets.some(accept);
    },
    { timeoutMs: 60_000 },
  );
  const target = targets.find(accept);
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

const attachToRenderer = (port) =>
  attachTo(port, 'the Electron renderer', (t) => t.type === 'page' && t.webSocketDebuggerUrl);

const attachToMain = (port) =>
  attachTo(port, "Electron's main process", (t) => Boolean(t.webSocketDebuggerUrl));

/**
 * Run a statement in the main process. `process.mainModule.require` is how an
 * inspector session reaches Electron's own module — the harness needs three
 * things the renderer cannot answer for: the window's size on screen, its
 * frontmost-ness, and its CGWindowID.
 */
async function mainEval(main, body) {
  const { result, exceptionDetails } = await main.send('Runtime.evaluate', {
    expression: `(() => {
      const { app, BrowserWindow, screen } = process.mainModule.require('electron');
      const win = BrowserWindow.getAllWindows()[0];
      ${body}
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(
      `main process: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
    );
  }
  return result?.value;
}

/** Put the window where the manifest wants it, and check the screen can hold it. */
async function sizeWindow(main, viewport) {
  const fits = await mainEval(
    main,
    `win.setPosition(${WINDOW_ORIGIN.x}, ${WINDOW_ORIGIN.y});
     win.setContentSize(${viewport.width}, ${viewport.height});
     win.show();
     const area = screen.getPrimaryDisplay().workAreaSize;
     const [w, h] = win.getContentSize();
     return { fits: area.width >= w + ${WINDOW_ORIGIN.x} && area.height >= h + ${WINDOW_ORIGIN.y},
              area, size: { width: w, height: h } };`,
  );
  if (!fits.fits) {
    throw new Error(
      `the ${fits.size.width}×${fits.size.height} window does not fit the ${fits.area.width}×${fits.area.height} work area — a clipped window is not a screenshot`,
    );
  }
}

/**
 * Make the window key and frontmost, and name it. Both matter: a window that is
 * not key draws its traffic lights grey, and Chromium stops compositing an
 * occluded one — `screencapture` would then photograph a stale frame.
 *
 * Only when it is not already: the run takes the front once and keeps it, so
 * the machine is grabbed a single time rather than once per shot (TRA-403).
 */
async function frontWindowId(main) {
  const id = await mainEval(
    main,
    `if (!win.isFocused()) {
       app.focus({ steal: true });
       win.moveTop();
       win.focus();
     }
     return win.getMediaSourceId();`,
  );
  const windowId = Number(String(id).split(':')[1]);
  if (!Number.isInteger(windowId)) throw new Error(`Electron gave no window id (got ${id})`);
  return windowId;
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

/**
 * Photograph one window by its CGWindowID. `-o` drops the drop shadow (it would
 * bake the desktop behind the window into the frame's edges); the rounded
 * corners come back as alpha, which is what `checkWindowChrome` looks for.
 */
function captureWindow(windowId, outPath) {
  fs.rmSync(outPath, { force: true });
  execFileSync('/usr/sbin/screencapture', ['-x', '-o', '-t', 'png', `-l${windowId}`, outPath]);
  if (!fs.existsSync(outPath)) {
    throw new Error(
      `screencapture wrote nothing for window ${windowId} — grant Screen Recording to the terminal running this`,
    );
  }
  return fs.readFileSync(outPath);
}

/**
 * PNG in, WebP out, at the manifest's scale. The renderer is the only encoder
 * on hand that speaks WebP, so it does the resample too — and being a canvas
 * op, the window's transparent corners survive it.
 */
async function toWebp(cdp, png, { width, height, quality }) {
  const encoded = await evaluate(
    cdp,
    `(async () => {
      const bin = atob(${JSON.stringify(png.toString('base64'))});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(${width}, ${height});
      canvas.getContext('2d').drawImage(bitmap, 0, 0, ${width}, ${height});
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: ${quality / 100} });
      const out = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < out.length; i += 8192) s += String.fromCharCode(...out.subarray(i, i + 8192));
      return btoa(s);
    })()`,
  );
  if (typeof encoded !== 'string') throw new Error('the renderer returned no WebP data');
  return Buffer.from(encoded, 'base64');
}

async function captureShot(cdp, main, shot, ctx) {
  const { manifest, projectsByName, tmpDir } = ctx;
  const { viewport, deviceScaleFactor, format, quality } = manifest.capture;

  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: shot.theme },
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

  const windowId = await frontWindowId(main);
  // The window server needs a beat to raise and re-key the window; capturing
  // into that beat photographs grey traffic lights.
  await sleep(600);
  const raw = captureWindow(windowId, path.join(tmpDir, `${shot.name}.png`));
  const png = decodePng(raw);

  const scale = png.width / viewport.width;
  if (png.height !== Math.round(viewport.height * scale) || scale < deviceScaleFactor) {
    throw new Error(
      `${shot.name}: captured ${png.width}×${png.height} for a ${viewport.width}×${viewport.height} window — wrong window, or a display below ${deviceScaleFactor}×`,
    );
  }
  const verdict = checkWindowChrome(png, scale);
  if (!verdict.ok) throw new Error(`${shot.name}: ${verdict.reasons.join('; ')}`);

  const width = Math.round(viewport.width * deviceScaleFactor);
  const height = Math.round(viewport.height * deviceScaleFactor);
  const bytes = await toWebp(cdp, raw, { width, height, quality });
  const file = `${shot.name}.${format}`;
  fs.writeFileSync(path.join(IMAGES_DIR, file), bytes);
  log(`${file} — ${Math.round(bytes.length / 1024)} KB, window chrome verified`);
  return {
    name: shot.name,
    file,
    surface:
      shot.view === 'project'
        ? `project · ${shot.clicks?.[0] ?? 'overview'}`
        : `menu · ${shot.tab}`,
    theme: shot.theme,
    width,
    height,
    bytes: bytes.length,
    alt: shot.alt,
  };
}

// ── Orchestration ──────────────────────────────────────────────────

async function capture(manifest, only) {
  if (os.platform() !== 'darwin') {
    throw new Error(
      'the screenshots are photographs of a macOS window — traffic lights, rounded corners and vibrancy do not exist to capture anywhere else',
    );
  }
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
  for (const port of [DEMO_DAEMON_PORT, DEBUG_PORT, MAIN_INSPECT_PORT]) {
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
  const tmpDir = path.join(sandbox, 'frames');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

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
    [
      '.',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--inspect=${MAIN_INSPECT_PORT}`,
      `--user-data-dir=${profile}`,
    ],
    // Always-on-top for the same reason the flag exists: Chromium stops
    // compositing an occluded window, and a window capture of one is a stale
    // frame. Nothing else may cover the window while it is being photographed.
    // `visible` opts this unpackaged run out of the accessory default (TRA-407):
    // a window whose app is not active draws grey traffic lights, and the
    // publication capture refuses those.
    {
      cwd: path.join(REPO_ROOT, 'packages/app'),
      env: { ...env, TRACE_MCP_DEV_ALWAYS_ON_TOP: '1', TRACE_MCP_WINDOW_MODE: 'visible' },
      stdio: 'ignore',
    },
  );
  let cdp = null;
  let main = null;
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
    main = await attachToMain(MAIN_INSPECT_PORT);
    await main.send('Runtime.enable');
    // The window is sized once, for real: the frame is a photograph of it, so
    // an emulated viewport would only render the app at a size the window is
    // not, and the capture would come back letterboxed.
    await sizeWindow(main, manifest.capture.viewport);

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
      images.push(await captureShot(cdp, main, shot, { manifest, projectsByName, tmpDir }));
    }
    return images;
  } finally {
    main?.close();
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
  // The marker is committed, so `biome ci` formats it like any other JSON in
  // the repo. Handing it to Biome here keeps a capture from failing CI on
  // whitespace nobody wrote.
  try {
    execFileSync('pnpm', ['exec', 'biome', 'format', '--write', MARKER_PATH], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
  } catch {
    log('biome not available — format docs/images/screenshots.json before committing');
  }
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

  // The run activates the app to photograph it, so it waits for the machine to
  // be free rather than taking it from somebody (TRA-403).
  const gate = mayStartCapture(idleSeconds(), { force: argv.includes('--now') });
  if (!gate.ok) {
    log(`deferred — ${gate.reason}`);
    process.exit(IDLE_EXIT_CODE);
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
