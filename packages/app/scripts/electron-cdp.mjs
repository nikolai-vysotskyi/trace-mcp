#!/usr/bin/env node
/**
 * Drive the real Electron window over the Chrome DevTools Protocol.
 *
 * Design work has to be judged in the Electron window, not in `vite dev` in a
 * browser: the window is `titleBarStyle: 'hiddenInset'` with real traffic
 * lights and a native vibrancy view behind the sidebar, none of which a browser
 * tab has. This script is the launch path for that.
 *
 *   node scripts/electron-cdp.mjs launch            # build + run with CDP on :9222
 *   node scripts/electron-cdp.mjs launch --visible  # …and put it on screen
 *   node scripts/electron-cdp.mjs shot out.png      # screenshot the current page
 *   node scripts/electron-cdp.mjs shot out.png --view=project --tab=graph --dark
 *
 * `launch` uses its own --user-data-dir so it does not fight the installed
 * trace-mcp.app for Electron's single-instance lock. Once it is up, an external
 * CDP client can attach to http://127.0.0.1:9222 — including chrome-devtools
 * MCP, which takes `--browser-url http://127.0.0.1:9222`.
 *
 * The window is never shown unless you ask for it. Everything here drives the
 * app over CDP, which does not care whether the window is on screen — and the
 * person at the keyboard does (TRA-403).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.TRACE_MCP_CDP_PORT ?? 9222);
const USER_DATA_DIR = process.env.TRACE_MCP_CDP_PROFILE ?? '/tmp/trace-mcp-cdp-profile';
const ORIGIN = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`${ORIGIN}/json/list`);
  return res.json();
}

/** First page target, retried — Electron opens its window a beat after boot. */
async function waitForPage(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const page = (await targets()).find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      // endpoint not up yet
    }
    if (Date.now() > deadline) throw new Error(`no page target on ${ORIGIN} after ${timeoutMs}ms`);
    await sleep(500);
  }
}

/** Minimal CDP session over the built-in WebSocket (Node >= 22). */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), {
      once: true,
    });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  });
  return {
    send(method, params) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => ws.close(),
  };
}

function launch(visible) {
  mkdirSync(USER_DATA_DIR, { recursive: true });
  const electron = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
  /* Nothing on screen by default. A review run happens while somebody is using
     the machine, and macOS follows an app activation to that app's Space — a
     visible window pulls them out of whatever they were in (TRA-403). The
     renderer paints either way, and a CDP screenshot of an unmapped window is a
     real frame, so `shot` loses nothing.
     `--visible` is for the one case that needs eyes on the running window; it
     then has to stay on top, or Chromium stops compositing an occluded window
     and the shot comes back as the frame it painted minutes ago. */
  const env = { ...process.env };
  if (visible) {
    env.TRACE_MCP_DEV_ALWAYS_ON_TOP = '1';
    /* An unpackaged build is accessory by default (TRA-407); the one run that
       wants eyes on the window wants a normal foreground app too. */
    env.TRACE_MCP_WINDOW_MODE = 'visible';
  } else env.TRACE_MCP_WINDOW_MODE = 'hidden';
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electron,
    ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`],
    { cwd: APP_DIR, env, stdio: 'inherit' },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function shot(outFile, opts) {
  const page = await waitForPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  if (opts.url) {
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: opts.url });
    await sleep(opts.settleMs);
  }
  /* Drive the app's OWN appearance control, not `Emulation.setEmulatedMedia`.
     The sidebar is transparent over a native vibrancy view that follows
     nativeTheme, and emulated media never reaches it — an "emulated dark" shot
     is dark content behind a light sidebar, which is not a state the app has. */
  if (opts.appearance) {
    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem('trace-mcp-theme', ${JSON.stringify(opts.appearance)});
        location.reload();`,
    });
    await sleep(opts.settleMs);
  }
  /* Accessibility settings the material has to survive. */
  if (opts.media?.length) {
    await cdp.send('Emulation.setEmulatedMedia', { features: opts.media });
    await sleep(400);
  }
  /* Which surface is on screen is React state, not a URL — so reach it the way
     a user does, by clicking its sidebar row. */
  if (opts.click) {
    await cdp.send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('.ws-sb-row')]
        .find((r) => r.textContent.trim() === ${JSON.stringify(opts.click)})?.click()`,
    });
    await sleep(opts.settleMs);
  }
  mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  /* Works on the unmapped window `launch` opens — an unshown window is not an
     occluded one, and Chromium keeps painting it. (An occluded *visible* window
     is the stale-pixel case, which is why `--visible` implies always-on-top.) */
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outFile, Buffer.from(data, 'base64'));
  cdp.close();
  console.log(`wrote ${outFile}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'launch') {
  launch(rest.includes('--visible'));
} else if (cmd === 'shot') {
  const out = rest.find((a) => !a.startsWith('--'));
  if (!out) throw new Error('usage: electron-cdp.mjs shot <out.png> [--url=…] [--dark|--light]');
  const flag = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const media = [];
  if (rest.includes('--reduce-transparency'))
    media.push({ name: 'prefers-reduced-transparency', value: 'reduce' });
  if (rest.includes('--increase-contrast')) media.push({ name: 'prefers-contrast', value: 'more' });
  await shot(out, {
    url: flag('url'),
    appearance: rest.includes('--dark') ? 'dark' : rest.includes('--light') ? 'light' : undefined,
    media,
    settleMs: Number(flag('settle') ?? 1500),
    click: flag('click'),
  });
} else {
  console.error(
    'usage: electron-cdp.mjs launch [--visible] | shot <out.png> [--url=…] [--dark|--light]',
  );
  process.exit(1);
}
