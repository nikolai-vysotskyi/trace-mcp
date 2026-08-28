#!/usr/bin/env node
/**
 * Desktop-app performance harness (TRA-257).
 *
 * Launches the built Electron app against a throwaway user-data dir, drives it
 * over CDP, and prints one `runs[]` entry for `docs/perf/baseline.json`.
 *
 * Usage:
 *   node scripts/perf-measure.mjs [--samples 3] [--idle-seconds 300] [--json out.json]
 *
 * Requires `pnpm run build` first — it measures the production bundle, not dev.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round = (n, d = 1) => Number(n.toFixed(d));

/** Minimal CDP client over the Node 22 global WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
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
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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

async function runSample({ idleSeconds }) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-perf-'));
  const electron = path.join(appDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
  const t0 = Date.now();
  const child = spawn(electron, [appDir, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], {
    cwd: appDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: 'ignore',
  });

  try {
    const target = await rendererTarget(t0 + 60_000);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

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
    child.kill('SIGKILL');
    await sleep(500);
    fs.rmSync(userData, { recursive: true, force: true });
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

const samples = [];
for (let i = 0; i < SAMPLES; i++) {
  // Only the last sample pays the idle-hold cost; cold start is what needs N.
  samples.push(await runSample({ idleSeconds: i === SAMPLES - 1 ? IDLE_SECONDS : 0 }));
  process.stderr.write(`sample ${i + 1}/${SAMPLES}: ${JSON.stringify(samples[i])}\n`);
}

const last = samples[samples.length - 1];
const entry = {
  date: new Date().toISOString(),
  app_version: JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version,
  commit: process.env.PERF_COMMIT ?? null,
  env: { os: `macOS ${os.release()}`, arch: os.arch(), node: process.version.slice(1) },
  samples: SAMPLES,
  metrics: {
    cold_start_ms: median(samples.map((s) => s.cold_start_ms)),
    window_interactive_ms: median(samples.map((s) => s.window_interactive_ms)),
    heap_idle_mb: last.heap_idle_mb ?? null,
    main_cpu_idle_pct: last.main_cpu_idle_pct ?? null,
    renderer_bundle_kb: bundleSizes(),
    artifact_mb: artifactMb(),
  },
  raw_samples: samples,
};

const json = JSON.stringify(entry, null, 2);
OUT ? fs.writeFileSync(OUT, `${json}\n`) : console.log(json);
