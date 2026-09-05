#!/usr/bin/env node
/**
 * Idle cost of the running trace-mcp processes — TRA-935.
 *
 * "An app that costs nothing when nothing is happening" is only a claim until
 * someone reads the number. This samples every live trace-mcp process for a
 * window during which you touch nothing, and reports the two quantities that
 * decide the user's battery and fan: CPU seconds consumed, and RSS growth.
 * Both should be approximately flat. Watchers, poll loops, revalidation timers
 * and telemetry flushes are all inside the measurement by construction — it
 * reads the OS's accounting, not ours.
 *
 * Usage:
 *   node scripts/perf/idle-cost.mjs [--seconds 300] [--interval 15]
 *                                   [--pattern trace-mcp] [--json out.json]
 *
 * Reads only; starts and kills nothing.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const seconds = Number(arg('seconds', 300));
const intervalSec = Number(arg('interval', 15));
const pattern = arg('pattern', 'trace-mcp');
const jsonOut = arg('json', null);

/** CPU time as reported by ps: [[dd-]hh:]mm:ss[.ff] → seconds. */
function cpuSeconds(t) {
  const [head, frac = '0'] = t.split('.');
  const parts = head.replace('-', ':').split(':').map(Number);
  const secs = parts.reduce((acc, n) => acc * 60 + n, 0);
  return secs + Number(`0.${frac}`);
}

function sample() {
  let out = '';
  try {
    // -ww: never truncate the command, or the pattern match misses long paths.
    out = execFileSync('ps', ['-axo', 'pid=,rss=,time=,command=', '-ww'], {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return new Map();
  }
  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, rssKb, time, command] = m;
    if (!command.includes(pattern)) continue;
    // Don't measure ourselves, or the shell that launched us.
    if (Number(pid) === process.pid || command.includes('idle-cost.mjs')) continue;
    procs.set(Number(pid), {
      pid: Number(pid),
      rssMb: Number(rssKb) / 1024,
      cpuSec: cpuSeconds(time),
      command: command.slice(0, 120),
    });
  }
  return procs;
}

const first = sample();
if (first.size === 0) {
  console.error(`No process matching ${JSON.stringify(pattern)} is running — nothing to measure.`);
  process.exit(1);
}
console.error(`Watching ${first.size} process(es) for ${seconds}s. Touch nothing.`);

const started = Date.now();
const series = [];
while ((Date.now() - started) / 1000 < seconds) {
  const now = sample();
  series.push({ tSec: Math.round((Date.now() - started) / 1000), procs: [...now.values()] });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalSec * 1000);
}
const last = sample();

const elapsedSec = (Date.now() - started) / 1000;
const perProc = [];
for (const [pid, a] of first) {
  const b = last.get(pid);
  // Gone mid-window: report it rather than silently dropping a process whose
  // exit is itself a finding.
  if (!b) {
    perProc.push({ pid, command: a.command, exitedDuringWindow: true });
    continue;
  }
  perProc.push({
    pid,
    command: a.command,
    cpuSecondsConsumed: Math.round((b.cpuSec - a.cpuSec) * 100) / 100,
    cpuPercentOfOneCore: Math.round(((b.cpuSec - a.cpuSec) / elapsedSec) * 1000) / 10,
    rssStartMb: Math.round(a.rssMb),
    rssEndMb: Math.round(b.rssMb),
    rssGrowthMb: Math.round(b.rssMb - a.rssMb),
  });
}
perProc.sort((x, y) => (y.cpuSecondsConsumed ?? 0) - (x.cpuSecondsConsumed ?? 0));

const report = {
  measuredAt: new Date().toISOString(),
  windowSeconds: Math.round(elapsedSec),
  intervalSeconds: intervalSec,
  pattern,
  totals: {
    processes: perProc.length,
    cpuSecondsConsumed:
      Math.round(perProc.reduce((s, p) => s + (p.cpuSecondsConsumed ?? 0), 0) * 100) / 100,
    rssStartMb: perProc.reduce((s, p) => s + (p.rssStartMb ?? 0), 0),
    rssEndMb: perProc.reduce((s, p) => s + (p.rssEndMb ?? 0), 0),
  },
  processes: perProc,
  series,
};

if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, series: undefined }, null, 2));
