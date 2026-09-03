// Generates the README header images — see docs/DESIGN-WEB.md §10.
//
// GitHub renders README images in an isolated context: an SVG's @font-face
// never loads there, so Space Grotesk silently falls back to a system font and
// the layout shifts. These are therefore PNGs at 2× rendered in headless
// Chrome, which does load the self-hosted woff2 files in docs/fonts.
//
// Every number in the banner is read from the same sources the site uses —
// docs/_data/counts.yml and docs/_data/pr_context_bench.json — so a release
// that moves the tool count cannot leave a stale figure baked into a picture.
// Re-run after either file changes:
//
//   node scripts/gen-readme-banner.mjs
//
// Output: docs/images/readme/*.png, two themes, referenced from README.md
// through <picture media="(prefers-color-scheme: light)">.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(REPO_ROOT, 'docs');
const OUT_DIR = path.join(DOCS, 'images', 'readme');

// Override with CHROME_BIN on Linux or a non-standard install.
const CHROME =
  process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ── Data ────────────────────────────────────────────────────────────────────
// counts.yml is three scalars; a YAML parser would be a dependency for that.
// ponytail: regex read of `key: number`, swap for `yaml` if the file grows nesting.
function readCounts() {
  const src = fs.readFileSync(path.join(DOCS, '_data', 'counts.yml'), 'utf8');
  const pick = (key) => {
    const m = src.match(new RegExp(`^${key}:\\s*(\\d+)\\s*$`, 'm'));
    if (!m) throw new Error(`counts.yml has no \`${key}\``);
    return Number(m[1]);
  };
  return { tools: pick('tools'), languages: pick('languages'), frameworks: pick('frameworks') };
}

const counts = readCounts();
const bench = JSON.parse(
  fs.readFileSync(path.join(DOCS, '_data', 'pr_context_bench.json'), 'utf8'),
);

const fmt = (n) => n.toLocaleString('en-US');

// ── Palette ─────────────────────────────────────────────────────────────────
// Mirrors docs/index.html §1. Red appears here only on the "without" figure,
// which is the thing that is bad; the accent is cobalt.
const THEMES = {
  dark: {
    bg: '#000000',
    surface: '#111111',
    border: '#222222',
    display: '#FFFFFF',
    primary: '#E8E8E8',
    secondary: '#999999',
    disabled: '#848484',
    accent: '#5B8CFF',
    accentSolid: '#2B5FE3',
    onAccent: '#FFFFFF',
    negative: '#E54047',
    success: '#4A9E5C',
    dot: '#1E1E1E',
  },
  light: {
    bg: '#F5F5F5',
    surface: '#FFFFFF',
    border: '#E8E8E8',
    display: '#000000',
    primary: '#1A1A1A',
    secondary: '#595959',
    disabled: '#6D6D6D',
    accent: '#1E4FCB',
    accentSolid: '#2B5FE3',
    onAccent: '#FFFFFF',
    negative: '#B3151C',
    success: '#2E7D3E',
    dot: '#E2E2E2',
  },
};

const LOGO = fs
  .readFileSync(path.join(REPO_ROOT, 'packages/app/build/icon-256.png'))
  .toString('base64');

const BANNER_W = 1200;
const BUTTON_W = 400;
const BUTTON_H = 108;

function css(t) {
  return `
    @font-face { font-family: 'Space Grotesk'; src: url('../fonts/space-grotesk-variable-latin.woff2') format('woff2'); font-weight: 300 700; font-display: block; }
    @font-face { font-family: 'Space Mono'; src: url('../fonts/space-mono-400-latin.woff2') format('woff2'); font-weight: 400; font-display: block; }
    @font-face { font-family: 'Space Mono'; src: url('../fonts/space-mono-700-latin.woff2') format('woff2'); font-weight: 700; font-display: block; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: ${t.bg}; font-family: 'Space Grotesk', sans-serif; -webkit-font-smoothing: antialiased; }
    .label { font-family: 'Space Mono', monospace; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }

    /* The dot lattice, same 24px pitch as the site. */
    .banner {
      width: ${BANNER_W}px; height: 340px; background: ${t.bg};
      background-image: radial-gradient(circle, ${t.dot} 1px, transparent 1px);
      background-size: 24px 24px;
      padding: 44px 64px 36px; display: flex; flex-direction: column; justify-content: space-between;
    }
    .top { display: flex; gap: 56px; align-items: flex-start; }
    .brandcol { flex: 1 1 auto; min-width: 0; }
    .lockup { display: flex; align-items: center; gap: 16px; margin-bottom: 22px; }
    .lockup img { width: 52px; height: 52px; display: block; }
    .wordmark { font-size: 38px; font-weight: 500; letter-spacing: -0.03em; color: ${t.display}; }
    .tagline { font-size: 25px; line-height: 1.3; font-weight: 300; letter-spacing: -0.02em; color: ${t.primary}; max-width: 560px; }
    .tagline b { font-weight: 600; color: ${t.display}; }

    .receipt {
      flex: 0 0 400px; border: 1px solid ${t.border}; background: ${t.surface};
      border-radius: 14px; padding: 22px 24px 18px;
    }
    .receipt .head { color: ${t.disabled}; margin-bottom: 16px; }
    .row { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    .row + .row { margin-top: 10px; }
    .row .k { font-family: 'Space Mono', monospace; font-size: 13px; color: ${t.secondary}; }
    .row .v { font-family: 'Space Mono', monospace; font-size: 22px; font-weight: 700; }
    .row.bad .v { color: ${t.negative}; }
    .row.good .k { color: ${t.primary}; }
    .row.good .v { color: ${t.success}; }
    .rule { height: 1px; background: ${t.border}; margin: 14px 0; }
    .foot { color: ${t.disabled}; line-height: 1.5; font-family: 'Space Mono', monospace; font-size: 10px; letter-spacing: 0.04em; }
    .save { color: ${t.display}; font-weight: 700; }

    .stats { display: flex; align-items: center; gap: 14px; color: ${t.disabled}; }
    .stats b { color: ${t.primary}; font-weight: 700; }
    .stats .sep { width: 3px; height: 3px; border-radius: 50%; background: ${t.border}; }

    /* One plate per button so the three sit flush against each other and the
       banner above, instead of floating on GitHub's own canvas. */
    .plate {
      width: ${BUTTON_W}px; height: ${BUTTON_H}px; background: ${t.bg};
      display: flex; align-items: center; justify-content: center;
    }
    .btn {
      display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 4px; width: 344px; height: 64px; border-radius: 999px;
    }
    /* The label is body type, not a service label. Monospaced caps at this size
       is the least readable pair there is: a monospace has no per-letter width
       and caps removes the ascenders and descenders, so both cues a reader
       recognises a word by are gone. 10px technical sub-labels get away with
       it; the thing you click does not. */
    .btn .t {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 17px; font-weight: 600; letter-spacing: -0.01em;
    }
    .btn .s {
      font-family: 'Space Mono', monospace;
      font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
    }
    /* A shell command is never set in caps: \`-G\` and \`-g\` are different npm
       flags, so anyone retyping an upper-cased command from a picture gets an
       error. Lowercase, no tracking — exactly how it looks in a terminal. */
    .btn .s.cmd { text-transform: none; letter-spacing: 0; }
    .btn.solid { background: ${t.accentSolid}; }
    .btn.solid .t { color: ${t.onAccent}; }
    .btn.solid .s { color: ${t.onAccent}; } /* full white: 5.46:1, the tinted version was 4.34 */
    .btn.ghost { border: 1px solid ${t.border}; background: ${t.surface}; }
    .btn.ghost .t { color: ${t.display}; }
    .btn.ghost .s { color: ${t.disabled}; }
  `;
}

function bannerHtml(t) {
  return `<div class="banner" id="shot">
    <div class="top">
      <div class="brandcol">
        <div class="lockup">
          <img src="data:image/png;base64,${LOGO}" alt="" />
          <span class="wordmark">trace-mcp</span>
        </div>
        <div class="tagline">Precomputed code intelligence for AI coding agents. Index the repo once so the agent <b>stops re-reading the same files</b>.</div>
      </div>
      <div class="receipt">
        <div class="label head">Context to review one pull request</div>
        <div class="row bad"><span class="k">without</span><span class="v">${fmt(bench.baseline_median_tokens)} tok</span></div>
        <div class="row good"><span class="k">with trace-mcp</span><span class="v">${fmt(bench.trace_median_tokens)} tok</span></div>
        <div class="rule"></div>
        <div class="foot"><span class="save">${bench.median_savings_pct}% less</span> &mdash; median over ${bench.pr_count} merged PRs<br />in ${bench.repo_count} open-source repos that are not ours</div>
      </div>
    </div>
    <div class="stats label">
      <span><b>${counts.tools}</b> tools</span><span class="sep"></span>
      <span><b>${counts.languages}</b> languages</span><span class="sep"></span>
      <span><b>${counts.frameworks}</b> framework integrations</span><span class="sep"></span>
      <span><b>100%</b> local</span><span class="sep"></span>
      <span><b>MIT</b></span>
    </div>
  </div>`;
}

const BUTTONS = [
  {
    name: 'macos',
    style: 'solid',
    title: 'Download for macOS',
    sub: 'Apple Silicon · Intel · .dmg',
  },
  { name: 'windows', style: 'ghost', title: 'Download for Windows', sub: '.exe installer' },
  {
    name: 'npm',
    style: 'ghost',
    title: 'Install via npm',
    sub: 'npm install -g trace-mcp',
    subIsCommand: true,
  },
];

function buttonHtml(b) {
  return `<div class="plate" id="shot"><div class="btn ${b.style}">
    <span class="t">${b.title}</span><span class="s${b.subIsCommand ? ' cmd' : ''}">${b.sub}</span>
  </div></div>`;
}

// ── Chrome ──────────────────────────────────────────────────────────────────
async function withChrome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'banner-chrome-'));
  const port = 9700 + Math.floor(Math.random() * 200);
  const chrome = spawn(CHROME, [
    '--headless',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${tmp}`,
    '--allow-file-access-from-files',
    '--hide-scrollbars',
    '--disable-gpu',
    '--no-first-run',
    'about:blank',
  ]);
  try {
    let wsUrl = null;
    for (let i = 0; i < 100 && !wsUrl; i++) {
      try {
        const list = await new Promise((res, rej) => {
          http
            .get(`http://127.0.0.1:${port}/json/list`, (r) => {
              let b = '';
              r.on('data', (d) => (b += d));
              r.on('end', () => res(b));
            })
            .on('error', rej);
        });
        wsUrl = JSON.parse(list).find(
          (t) => t.type === 'page' && t.webSocketDebuggerUrl,
        )?.webSocketDebuggerUrl;
      } catch {
        /* not listening yet */
      }
      if (!wsUrl) await new Promise((r) => setTimeout(r, 200));
    }
    if (!wsUrl) throw new Error('Could not connect to Chrome CDP');

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    let id = 1;
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const mid = id++;
        const handler = (e) => {
          const r = JSON.parse(e.data);
          if (r.id === mid) {
            ws.removeEventListener('message', handler);
            r.error ? reject(new Error(r.error.message)) : resolve(r.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    await send('Page.enable');
    await send('Runtime.enable');
    const out = await fn(send);
    ws.close();
    return out;
  } finally {
    // If Chrome already died — port clash, bad binary path, crash during the
    // CDP wait — `close` has fired and will never fire again, so awaiting it
    // hangs the script forever and the temp profile is never removed. Only
    // wait when the process is still alive, and cap that wait.
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill('SIGTERM');
      await Promise.race([
        new Promise((r) => chrome.on('close', r)),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The dot lattice costs most of the file size and quantises to a palette with
// no visible loss. Optional on purpose: pngquant is a brew/apt install, and a
// contributor without it should still be able to regenerate the header.
// ponytail: shells out rather than pulling in an image dependency.
function quantise(file) {
  const r = spawnSync('pngquant', [
    '--force',
    '--skip-if-larger',
    '--quality',
    '70-95',
    '--output',
    file,
    '--',
    file,
  ]);
  if (r.error) return null;
  return Math.round(fs.statSync(file).size / 1024);
}

async function shoot(send, { file, body, theme, width, height }) {
  const t = THEMES[theme];
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css(t)}</style></head><body>${body}</body></html>`;
  // Written inside docs/ so the relative ../fonts/*.woff2 URLs resolve; a
  // data: URL would be same-origin-less and the fonts would not load.
  const tmpHtml = path.join(DOCS, 'images', `.banner-tmp-${theme}.html`);
  fs.writeFileSync(tmpHtml, html);
  try {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await send('Page.navigate', { url: `file://${tmpHtml}` });
    await new Promise((r) => setTimeout(r, 600));
    await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });
    const box = await send('Runtime.evaluate', {
      expression: `JSON.stringify((r=>({x:r.x,y:r.y,width:r.width,height:r.height}))(document.getElementById('shot').getBoundingClientRect()))`,
      returnByValue: true,
    });
    const clip = { ...JSON.parse(box.result.value), scale: 2 };
    const shot = await send('Page.captureScreenshot', { format: 'png', clip, fromSurface: true });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const raw = fs.statSync(file).size;
    const kb = quantise(file);
    console.log(
      `  ${path.relative(REPO_ROOT, file)}  ${clip.width}×${clip.height} @2x  ${Math.round(raw / 1024)} KB${kb === null ? ' (pngquant not installed — committed unoptimised)' : ` → ${kb} KB`}`,
    );
  } finally {
    fs.rmSync(tmpHtml, { force: true });
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log(
  `trace-mcp README header — ${counts.tools} tools, ${fmt(bench.baseline_median_tokens)} → ${fmt(bench.trace_median_tokens)} tok`,
);
await withChrome(async (send) => {
  for (const theme of ['dark', 'light']) {
    await shoot(send, {
      file: path.join(OUT_DIR, `banner-${theme}.png`),
      body: bannerHtml(THEMES[theme]),
      theme,
      width: BANNER_W,
      height: 400,
    });
    for (const b of BUTTONS) {
      await shoot(send, {
        file: path.join(OUT_DIR, `btn-${b.name}-${theme}.png`),
        body: buttonHtml(b),
        theme,
        width: BUTTON_W,
        height: BUTTON_H,
      });
    }
  }
});
