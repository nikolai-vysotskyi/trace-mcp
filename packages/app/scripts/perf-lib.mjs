/**
 * Helpers shared by the perf scripts in this directory (perf-measure.mjs,
 * tabs-scale.mjs). Pure functions plus two `ps` readers — kept here so the two
 * harnesses cannot drift into reporting the same metric two different ways.
 */
import { execFileSync } from 'node:child_process';

export const round = (n, d = 1) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Nearest-rank p95 — with N<20 this is just the max, which is the honest answer. */
export const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
};

/** Least-squares slope of heap over time, in MB/hour. */
export function fitGrowth(series) {
  if (series.length < 3) return null;
  const xs = series.map((s) => s.t_min / 60);
  const ys = series.map((s) => s.heap_mb);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den === 0 ? null : round(num / den, 2);
}

/**
 * Evenly spaced subset of at most `max` items, always keeping the first and, if
 * anything was dropped, the last. Series go into a committed baseline file, so
 * the shape has to survive while the row count stays readable — a 30-minute run
 * now produces hundreds of cycles.
 */
export function thin(items, max) {
  if (items.length <= max) return items;
  const step = Math.ceil(items.length / max);
  const out = items.filter((_, i) => i % step === 0);
  const last = items[items.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** %CPU and RSS for a pid and every descendant, via ps. */
export function procStats(rootPid) {
  if (!rootPid) return { cpu: 0, rss_mb: 0, procs: 0 };
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,%cpu=,rss='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid, cpu, rss] of rows) {
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push({ pid, cpu, rss });
  }
  let cpu = 0;
  let rss = 0;
  let n = 0;
  const walk = (pid) => {
    n++;
    for (const c of kids.get(pid) ?? []) {
      cpu += c.cpu;
      rss += c.rss;
      walk(c.pid);
    }
  };
  const self = rows.find((r) => r[0] === rootPid);
  if (self) {
    cpu += self[2];
    rss += self[3];
  }
  walk(rootPid);
  return { cpu, rss_mb: rss / 1024, procs: n };
}

/** A pid and every descendant, as a Set — for "is this process ours?" checks. */
export function pidsInTree(rootPid) {
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid] of rows) {
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const out = new Set([rootPid]);
  const walk = (pid) => {
    for (const c of kids.get(pid) ?? []) {
      if (out.has(c)) continue;
      out.add(c);
      walk(c);
    }
  };
  walk(rootPid);
  return out;
}

/** The renderer helper belonging to one Electron main process. */
export function rendererPid(mainPid) {
  const raw = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m && Number(m[2]) === mainPid && m[3].includes('--type=renderer')) return Number(m[1]);
  }
  return null;
}

/**
 * `ps` cputime — `[dd-]hh:mm:ss.ss` — as seconds. The day field is separated by
 * `-` and carries 24, not 60: splitting on both punctuation marks at once reads
 * `1-02:00:00` as 62 hours.
 */
export function parseCpuTime(raw) {
  const [days, clock] = raw.includes('-') ? raw.split('-') : ['0', raw];
  const seconds = clock.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
  return Number(days) * 86_400 + seconds;
}

/** Total CPU seconds a process has burned since it started. */
export function cpuSeconds(pid) {
  return parseCpuTime(
    execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
  );
}

/**
 * CPU actually burned over a window, as a percentage of one core.
 *
 * `ps -o %cpu` is a decaying lifetime average and cannot answer "is this busy
 * *now*": a renderer that spun for ten minutes still reads high after it stops,
 * and one that has just started spinning reads low. Two `cputime` readings a
 * fixed interval apart can.
 */
export async function cpuOverWindow(pid, seconds, sleep) {
  const before = cpuSeconds(pid);
  await sleep(seconds * 1000);
  return ((cpuSeconds(pid) - before) / seconds) * 100;
}

export function pidOnPort(port) {
  try {
    return Number(
      execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
        .trim()
        .split('\n')[0],
    );
  } catch {
    return null;
  }
}

/**
 * The completion detector the CDP driver runs inside the renderer (TRA-835).
 *
 * It lives here, as source text, for one reason: it is the only part of
 * `scripts/perf-measure.mjs` whose correctness is not obvious by reading it, and
 * the harness itself takes 55 minutes so nothing in CI ever runs it. Exported as
 * a string because it is injected into the page, not imported by it —
 * `__tests__/perf-driver.test.ts` evaluates this same text against jsdom.
 */
export const MEASURE_SRC = String.raw`
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
  // The observer is armed BEFORE the action fires, not after. React dispatches
  // discrete events (a click, an input) synchronously: by the time an
  // 'act(); settled(t)' sequence gets to attach an observer, the whole render
  // that the action caused has already been committed and there is nothing left
  // to see. That is why 42.5% of searches measured exactly 0 ms on 2026-09-04
  // while the same query measured 500 ms on the next cycle — the metric was
  // timing only the part of the update React happened to defer.
  const measure = (act) =>
    new Promise((resolve, reject) => {
      let last = null;
      const obs = new MutationObserver((recs) => {
        if (recs.every(ignorable)) return;
        last = performance.now();
      });
      obs.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
      });
      let start;
      try {
        start = performance.now();
        act();
      } catch (e) {
        obs.disconnect();
        return reject(e);
      }
      // Nothing can have observed yet — MutationObserver callbacks are
      // microtasks and this is still the same synchronous block — so the
      // quiet window starts at the action, and a synchronous commit lands on
      // 'last' before the first tick 16 ms from now.
      last = start;
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
`;
