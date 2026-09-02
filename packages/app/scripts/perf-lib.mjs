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
