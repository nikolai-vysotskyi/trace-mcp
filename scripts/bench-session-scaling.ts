#!/usr/bin/env tsx
/**
 * Benchmark harness for concurrency & session performance (TRA-931).
 *
 * Produces repeatable measurements on a fixed, version-stamped corpus:
 * 1. Cold start to first tool response for one stdio session (wall time, peak RSS, thread count).
 * 2. Steady-state per-session cost (RSS and thread count at 60s idle, daemon-healthy vs daemon-absent).
 * 3. Cost of a one-file change (CPU seconds and wall time consumed across daemon and sessions).
 * 4. N-session scaling at 1, 4, and 9 concurrent sessions (daemon-healthy vs daemon-absent).
 *
 * Usage:
 *   npx tsx scripts/bench-session-scaling.ts [--idle 60] [--steps 1,4,9] [--port 37425]
 *   npx tsx scripts/bench-session-scaling.ts --quick    # Smoke run: 5s idle, N=1,4
 */

import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measuredBuild } from './measured-build.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'cli.js');
const PINNED_COMMIT = '9256cf184370cc7175e076baf2c142c4054d0d6c'; // v3.18.0 release

// Parse CLI flags
const args = process.argv.slice(2);
const flag = (name: string, def: string): string => {
  const idx = args.indexOf(`--${name}`);
  return idx === -1 ? def : (args[idx + 1] ?? def);
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`);

const QUICK = hasFlag('quick');
const IDLE_SECONDS = Number(flag('idle', QUICK ? '5' : '60'));
const STEPS = flag('steps', QUICK ? '1,4' : '1,4,9')
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);
const DAEMON_PORT = Number(flag('port', '37425'));
const OUT_FILE = flag('out', path.join(REPO_ROOT, 'docs', 'perf', 'session-scaling.json'));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const round = (n: number, d = 1): number => (Number.isFinite(n) ? Number(n.toFixed(d)) : 0);
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 !== 0 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

// ── Process Monitoring Helpers ─────────────────────────────────────────────

function parseCpuTime(raw: string): number {
  if (!raw || !raw.trim()) return 0;
  const str = raw.trim();
  let days = 0;
  let timeStr = str;
  if (str.includes('-')) {
    const parts = str.split('-');
    days = Number(parts[0]) || 0;
    timeStr = parts[1] ?? '0';
  }
  const parts = timeStr.split(':').map(Number);
  let seconds = 0;
  if (parts.length === 3) {
    seconds = (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  } else if (parts.length === 2) {
    seconds = (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  } else if (parts.length === 1) {
    seconds = parts[0] ?? 0;
  }
  return days * 86400 + seconds;
}

function getThreadCount(pid: number): number {
  try {
    const out = execFileSync('ps', ['-M', '-p', String(pid)], { encoding: 'utf-8' });
    const lines = out.trim().split('\n');
    return Math.max(1, lines.length - 1);
  } catch {
    return 0;
  }
}

function getTreePids(rootPid: number): number[] {
  try {
    const rows = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map<number, number[]>();
    for (const [pid, ppid] of rows) {
      if (pid === undefined || ppid === undefined) continue;
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid)!.push(pid);
    }
    const result: number[] = [rootPid];
    const walk = (p: number) => {
      for (const k of kids.get(p) ?? []) {
        result.push(k);
        walk(k);
      }
    };
    walk(rootPid);
    return result;
  } catch {
    return [rootPid];
  }
}

interface TreeStats {
  rssMb: number;
  threads: number;
  cpuSeconds: number;
}

function getTreeStats(rootPid: number): TreeStats {
  const pids = getTreePids(rootPid);
  let totalRss = 0;
  let totalThreads = 0;
  let totalCpu = 0;
  for (const pid of pids) {
    try {
      const rssRaw = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
      totalRss += Number(rssRaw) / 1024;
      totalThreads += getThreadCount(pid);
      const cpuRaw = execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
      totalCpu += parseCpuTime(cpuRaw);
    } catch {
      // Process may have exited
    }
  }
  return {
    rssMb: round(totalRss, 1),
    threads: totalThreads,
    cpuSeconds: round(totalCpu, 2),
  };
}

// ── Session Runner ─────────────────────────────────────────────────────────

interface SessionHandle {
  process: ChildProcess;
  pid: number;
  wallTimeMs: number;
  peakRssMb: number;
  threads: number;
  close: () => Promise<void>;
}

async function startSession(options: {
  cwd: string;
  dataDir: string;
  daemonPort: number;
  noDaemon: boolean;
}): Promise<SessionHandle> {
  const t0 = performance.now();
  const child = spawn('node', [CLI_PATH, 'serve'], {
    cwd: options.cwd,
    env: {
      ...process.env,
      TRACE_MCP_DATA_DIR: options.dataDir,
      TRACE_MCP_HOME: options.dataDir,
      TRACE_MCP_DAEMON_PORT: String(options.daemonPort),
      ...(options.noDaemon ? { TRACE_MCP_NO_DAEMON: '1' } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pid = child.pid!;
  let peakRss = 0;

  const send = (msg: unknown) => {
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    }
  };

  const firstToolPromise = new Promise<number>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Session PID ${pid} timed out waiting for tool response`));
    }, 45_000);

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: { name: 'get_project_map', arguments: {} },
            });
          } else if (msg.id === 2) {
            clearTimeout(timeout);
            const wallMs = performance.now() - t0;
            resolve(wallMs);
          }
        } catch {
          // stdout could contain interleaved non-json logs
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Session PID ${pid} exited prematurely with code ${code}`));
    });

    // Start handshake
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bench-session-scaling', version: '1.0.0' },
      },
    });
  });

  // Track peak RSS during startup
  const rssSampler = setInterval(() => {
    try {
      const stats = getTreeStats(pid);
      if (stats.rssMb > peakRss) peakRss = stats.rssMb;
    } catch {}
  }, 100);

  let wallTimeMs = 0;
  try {
    wallTimeMs = await firstToolPromise;
  } finally {
    clearInterval(rssSampler);
  }

  const postStats = getTreeStats(pid);
  if (postStats.rssMb > peakRss) peakRss = postStats.rssMb;

  return {
    process: child,
    pid,
    wallTimeMs: round(wallTimeMs, 0),
    peakRssMb: round(peakRss, 1),
    threads: postStats.threads,
    close: async () => {
      try {
        child.kill('SIGTERM');
        await sleep(200);
        if (child.exitCode === null) child.kill('SIGKILL');
      } catch {}
    },
  };
}

// ── Daemon Management Helpers ──────────────────────────────────────────────

interface DaemonHandle {
  process: ChildProcess;
  pid: number;
  port: number;
  close: () => Promise<void>;
}

async function startDaemon(dataDir: string, port: number): Promise<DaemonHandle> {
  const child = spawn('node', [CLI_PATH, 'serve-http', '-p', String(port), '--host', '127.0.0.1'], {
    env: {
      ...process.env,
      TRACE_MCP_DATA_DIR: dataDir,
      TRACE_MCP_HOME: dataDir,
      TRACE_MCP_DAEMON_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pid = child.pid!;
  const deadline = Date.now() + 30_000;
  let healthy = false;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {}
    await sleep(400);
  }

  if (!healthy) {
    child.kill('SIGKILL');
    throw new Error(`Daemon on port ${port} failed to start within 30s`);
  }

  return {
    process: child,
    pid,
    port,
    close: async () => {
      try {
        child.kill('SIGTERM');
        await sleep(300);
        if (child.exitCode === null) child.kill('SIGKILL');
      } catch {}
    },
  };
}

async function registerProjectWithDaemon(port: number, projectRoot: string): Promise<void> {
  const regRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: projectRoot }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!regRes.ok && regRes.status !== 409) {
    const txt = await regRes.text();
    throw new Error(`Failed to register project with daemon (${regRes.status}): ${txt}`);
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/projects/stats?project=${encodeURIComponent(projectRoot)}`,
        { signal: AbortSignal.timeout(2000) },
      );
      if (res.ok) {
        const data = (await res.json()) as { files?: number; status?: string };
        if ((data.files ?? 0) > 0) return;
      }
    } catch {}
    await sleep(1000);
  }
  throw new Error(`Project ${projectRoot} never became ready on daemon port ${port}`);
}

async function triggerDaemonReindex(port: number, projectRoot: string, filePath: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/projects/reindex-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectRoot, path: filePath }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`reindex-file failed with status ${res.status}: ${txt}`);
  }
}

// ── Fixture Corpus Setup ───────────────────────────────────────────────────

function ensureFixtureWorktree(): { path: string; cleanup: () => void } {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-bench-fixture-'));
  // Extract pinned commit tree into standalone directory
  execSync(`git archive ${PINNED_COMMIT} | tar -x -C "${fixtureDir}"`, {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  execFileSync('git', ['init', fixtureDir], { stdio: 'ignore' });
  execFileSync('git', ['-C', fixtureDir, 'config', 'user.name', 'bench'], { stdio: 'ignore' });
  execFileSync('git', ['-C', fixtureDir, 'config', 'user.email', 'bench@example.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', fixtureDir, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', fixtureDir, 'commit', '-m', 'corpus baseline'], { stdio: 'ignore' });

  return {
    path: fixtureDir,
    cleanup: () => {
      try {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

// ── Main Runner ────────────────────────────────────────────────────────────

async function main() {
  console.log('================================================================================');
  console.log(`TraceMCP Concurrency & Session Scaling Benchmark (TRA-931)`);
  console.log(`Build: v3.18.0 (${PINNED_COMMIT.slice(0, 8)})`);
  console.log(`Steps: ${STEPS.join(', ')} concurrent sessions | Idle hold: ${IDLE_SECONDS}s`);
  console.log('================================================================================\n');

  if (!fs.existsSync(CLI_PATH)) {
    console.error(`ERROR: ${CLI_PATH} not found. Run 'pnpm run build' first.`);
    process.exit(1);
  }

  const fixture = ensureFixtureWorktree();
  const buildInfo = measuredBuild();
  const targetFile = path.join(fixture.path, 'src', 'util', 'debounce.ts');

  const fileCount = fs
    .readdirSync(path.join(fixture.path, 'src'), { recursive: true })
    .filter((f) => String(f).endsWith('.ts')).length;

  console.log(`Corpus: detached worktree at ${PINNED_COMMIT.slice(0, 8)} (${fileCount}+ TypeScript files)`);

  const scalingMatrix: any[] = [];
  let singleSessionResults: any = null;

  try {
    for (const N of STEPS) {
      console.log(`\n────────────────────────────────────────────────────────────────────────────────`);
      console.log(`Running Step N = ${N} concurrent session(s)...`);
      console.log(`────────────────────────────────────────────────────────────────────────────────`);

      // ── ARM A: DAEMON HEALTHY ───────────────────────────────────────────
      console.log(`\n[N=${N}] Arm A: Daemon Healthy (Proxy Mode)...`);
      const daemonDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-bench-daemon-data-'));
      execFileSync(process.execPath, [CLI_PATH, 'index', fixture.path], {
        env: { ...process.env, TRACE_MCP_DATA_DIR: daemonDataDir, TRACE_MCP_HOME: daemonDataDir },
        stdio: 'ignore',
      });

      const daemon = await startDaemon(daemonDataDir, DAEMON_PORT);
      await registerProjectWithDaemon(DAEMON_PORT, fixture.path);

      const sessionPromises = Array.from({ length: N }, () =>
        startSession({
          cwd: fixture.path,
          dataDir: daemonDataDir,
          daemonPort: DAEMON_PORT,
          noDaemon: false,
        }),
      );

      const sessionsA = await Promise.all(sessionPromises);
      const armAWallTimes = sessionsA.map((s) => s.wallTimeMs);
      const armAPeakRss = sessionsA.map((s) => s.peakRssMb);
      const armAPeakThreads = sessionsA.map((s) => s.threads);

      console.log(
        `  Cold start: p50=${round(median(armAWallTimes), 0)}ms, max=${round(Math.max(...armAWallTimes), 0)}ms | Peak RSS/sess=${round(median(armAPeakRss), 1)}MB | Threads/sess=${round(median(armAPeakThreads), 0)}`,
      );

      console.log(`  Holding idle for ${IDLE_SECONDS}s...`);
      await sleep(IDLE_SECONDS * 1000);

      const idleStatsSessionsA = sessionsA.map((s) => getTreeStats(s.pid));
      const idleStatsDaemonA = getTreeStats(daemon.pid);
      const totalSessionsRssA = idleStatsSessionsA.reduce((sum, s) => sum + s.rssMb, 0);
      const totalRssA = totalSessionsRssA + idleStatsDaemonA.rssMb;
      const totalThreadsA = idleStatsSessionsA.reduce((sum, s) => sum + s.threads, 0) + idleStatsDaemonA.threads;

      console.log(
        `  Idle (${IDLE_SECONDS}s): per-session RSS=${round(median(idleStatsSessionsA.map((s) => s.rssMb)), 1)}MB | daemon RSS=${idleStatsDaemonA.rssMb}MB | TOTAL RSS=${round(totalRssA, 1)}MB | Threads=${totalThreadsA}`,
      );

      console.log(`  Applying 1-file edit to src/util/debounce.ts...`);
      const initialCpuDaemonA = getTreeStats(daemon.pid).cpuSeconds;
      const initialCpuSessionsA = idleStatsSessionsA.map((s) => s.cpuSeconds);

      fs.appendFileSync(targetFile, `\n// bench-session-scaling edit ${Date.now()}\n`);
      const editT0 = performance.now();
      await triggerDaemonReindex(DAEMON_PORT, fixture.path, targetFile);
      const editWallA = performance.now() - editT0;

      await sleep(1000);
      const postCpuDaemonA = getTreeStats(daemon.pid).cpuSeconds;
      const postCpuSessionsA = sessionsA.map((s) => getTreeStats(s.pid).cpuSeconds);

      const daemonCpuBurnedA = Math.max(0, postCpuDaemonA - initialCpuDaemonA);
      const sessionsCpuBurnedA = postCpuSessionsA.reduce(
        (acc, curr, idx) => acc + Math.max(0, curr - (initialCpuSessionsA[idx] ?? 0)),
        0,
      );
      const totalCpuBurnedA = daemonCpuBurnedA + sessionsCpuBurnedA;

      console.log(
        `  1-file change: wall=${round(editWallA, 0)}ms | daemon CPU=${round(daemonCpuBurnedA, 2)}s | sessions CPU=${round(sessionsCpuBurnedA, 2)}s | TOTAL CPU=${round(totalCpuBurnedA, 2)}s`,
      );

      execFileSync('git', ['checkout', '--', 'src/util/debounce.ts'], { cwd: fixture.path, stdio: 'ignore' });

      await Promise.all(sessionsA.map((s) => s.close()));
      await daemon.close();
      try {
        fs.rmSync(daemonDataDir, { recursive: true, force: true });
      } catch {}

      // ── ARM B: DAEMON ABSENT ────────────────────────────────────────────
      console.log(`\n[N=${N}] Arm B: Daemon Absent (Local Fallback Mode)...`);
      const localDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemcp-bench-local-data-'));
      execFileSync(process.execPath, [CLI_PATH, 'index', fixture.path], {
        env: { ...process.env, TRACE_MCP_DATA_DIR: localDataDir, TRACE_MCP_HOME: localDataDir },
        stdio: 'ignore',
      });

      const sessionPromisesB = Array.from({ length: N }, () =>
        startSession({
          cwd: fixture.path,
          dataDir: localDataDir,
          daemonPort: DAEMON_PORT,
          noDaemon: true,
        }),
      );

      const sessionsB = await Promise.all(sessionPromisesB);
      const armBWallTimes = sessionsB.map((s) => s.wallTimeMs);
      const armBPeakRss = sessionsB.map((s) => s.peakRssMb);
      const armBPeakThreads = sessionsB.map((s) => s.threads);

      console.log(
        `  Cold start: p50=${round(median(armBWallTimes), 0)}ms, max=${round(Math.max(...armBWallTimes), 0)}ms | Peak RSS/sess=${round(median(armBPeakRss), 1)}MB | Threads/sess=${round(median(armBPeakThreads), 0)}`,
      );

      console.log(`  Holding idle for ${IDLE_SECONDS}s...`);
      await sleep(IDLE_SECONDS * 1000);

      const idleStatsSessionsB = sessionsB.map((s) => getTreeStats(s.pid));
      const totalRssB = idleStatsSessionsB.reduce((sum, s) => sum + s.rssMb, 0);
      const totalThreadsB = idleStatsSessionsB.reduce((sum, s) => sum + s.threads, 0);

      console.log(
        `  Idle (${IDLE_SECONDS}s): per-session RSS=${round(median(idleStatsSessionsB.map((s) => s.rssMb)), 1)}MB | TOTAL RSS=${round(totalRssB, 1)}MB | Threads=${totalThreadsB}`,
      );

      console.log(`  Applying 1-file edit to src/util/debounce.ts...`);
      const initialCpuSessionsB = idleStatsSessionsB.map((s) => s.cpuSeconds);

      fs.appendFileSync(targetFile, `\n// bench-session-scaling edit ${Date.now()}\n`);
      const editT0B = performance.now();

      await sleep(3500);
      const editWallB = performance.now() - editT0B;

      const postCpuSessionsB = sessionsB.map((s) => getTreeStats(s.pid).cpuSeconds);
      const totalCpuBurnedB = postCpuSessionsB.reduce(
        (acc, curr, idx) => acc + Math.max(0, curr - (initialCpuSessionsB[idx] ?? 0)),
        0,
      );

      console.log(
        `  1-file change: wall=${round(editWallB, 0)}ms | sessions CPU=${round(totalCpuBurnedB, 2)}s | TOTAL CPU=${round(totalCpuBurnedB, 2)}s`,
      );

      execFileSync('git', ['checkout', '--', 'src/util/debounce.ts'], { cwd: fixture.path, stdio: 'ignore' });

      await Promise.all(sessionsB.map((s) => s.close()));
      try {
        fs.rmSync(localDataDir, { recursive: true, force: true });
      } catch {}

      const stepRecord = {
        n: N,
        daemon_healthy: {
          cold_start: {
            wall_time_min_ms: Math.min(...armAWallTimes),
            wall_time_median_ms: round(median(armAWallTimes), 0),
            wall_time_max_ms: Math.max(...armAWallTimes),
            per_session_peak_rss_mb: round(median(armAPeakRss), 1),
            total_peak_rss_mb: round(armAPeakRss.reduce((a, b) => a + b, 0), 1),
            threads_per_session: round(median(armAPeakThreads), 0),
            total_threads: armAPeakThreads.reduce((a, b) => a + b, 0),
          },
          steady_state_idle: {
            per_session_rss_mb: round(median(idleStatsSessionsA.map((s) => s.rssMb)), 1),
            total_sessions_rss_mb: round(totalSessionsRssA, 1),
            daemon_rss_mb: idleStatsDaemonA.rssMb,
            total_rss_mb: round(totalRssA, 1),
            threads_per_session: round(median(idleStatsSessionsA.map((s) => s.threads)), 0),
            total_threads: totalThreadsA,
          },
          one_file_change: {
            wall_time_ms: round(editWallA, 0),
            daemon_cpu_seconds: round(daemonCpuBurnedA, 2),
            sessions_cpu_seconds: round(sessionsCpuBurnedA, 2),
            total_cpu_seconds: round(totalCpuBurnedA, 2),
          },
        },
        daemon_absent: {
          cold_start: {
            wall_time_min_ms: Math.min(...armBWallTimes),
            wall_time_median_ms: round(median(armBWallTimes), 0),
            wall_time_max_ms: Math.max(...armBWallTimes),
            per_session_peak_rss_mb: round(median(armBPeakRss), 1),
            total_peak_rss_mb: round(armBPeakRss.reduce((a, b) => a + b, 0), 1),
            threads_per_session: round(median(armBPeakThreads), 0),
            total_threads: armBPeakThreads.reduce((a, b) => a + b, 0),
          },
          steady_state_idle: {
            per_session_rss_mb: round(median(idleStatsSessionsB.map((s) => s.rssMb)), 1),
            total_rss_mb: round(totalRssB, 1),
            threads_per_session: round(median(idleStatsSessionsB.map((s) => s.threads)), 0),
            total_threads: totalThreadsB,
          },
          one_file_change: {
            wall_time_ms: round(editWallB, 0),
            sessions_cpu_seconds: round(totalCpuBurnedB, 2),
            total_cpu_seconds: round(totalCpuBurnedB, 2),
          },
        },
      };

      scalingMatrix.push(stepRecord);

      if (N === 1) {
        singleSessionResults = {
          cold_start: {
            wall_time_ms: stepRecord.daemon_healthy.cold_start.wall_time_median_ms,
            peak_rss_mb: stepRecord.daemon_healthy.cold_start.per_session_peak_rss_mb,
            threads: stepRecord.daemon_healthy.cold_start.threads_per_session,
          },
          steady_state_idle: {
            daemon_healthy: {
              session_rss_mb: stepRecord.daemon_healthy.steady_state_idle.per_session_rss_mb,
              session_threads: stepRecord.daemon_healthy.steady_state_idle.threads_per_session,
              daemon_rss_mb: stepRecord.daemon_healthy.steady_state_idle.daemon_rss_mb,
              daemon_threads: idleStatsDaemonA.threads,
              total_rss_mb: stepRecord.daemon_healthy.steady_state_idle.total_rss_mb,
            },
            daemon_absent: {
              session_rss_mb: stepRecord.daemon_absent.steady_state_idle.per_session_rss_mb,
              session_threads: stepRecord.daemon_absent.steady_state_idle.threads_per_session,
              total_rss_mb: stepRecord.daemon_absent.steady_state_idle.total_rss_mb,
            },
          },
          one_file_change: {
            daemon_healthy: stepRecord.daemon_healthy.one_file_change,
            daemon_absent: stepRecord.daemon_absent.one_file_change,
          },
        };
      }
    }
  } finally {
    fixture.cleanup();
  }

  const n1 = scalingMatrix.find((s) => s.n === 1);
  const n9 = scalingMatrix.find((s) => s.n === 9);
  const multipliers = {
    daemon_healthy: {
      rss_multiplier: n1 && n9 ? round(n9.daemon_healthy.steady_state_idle.total_rss_mb / n1.daemon_healthy.steady_state_idle.total_rss_mb, 2) : 1,
      threads_multiplier: n1 && n9 ? round(n9.daemon_healthy.steady_state_idle.total_threads / n1.daemon_healthy.steady_state_idle.total_threads, 2) : 1,
      one_file_change_cpu_multiplier: n1 && n9 ? round(n9.daemon_healthy.one_file_change.total_cpu_seconds / Math.max(0.01, n1.daemon_healthy.one_file_change.total_cpu_seconds), 2) : 1,
    },
    daemon_absent: {
      rss_multiplier: n1 && n9 ? round(n9.daemon_absent.steady_state_idle.total_rss_mb / n1.daemon_absent.steady_state_idle.total_rss_mb, 2) : 1,
      threads_multiplier: n1 && n9 ? round(n9.daemon_absent.steady_state_idle.total_threads / n1.daemon_absent.steady_state_idle.total_threads, 2) : 1,
      one_file_change_cpu_multiplier: n1 && n9 ? round(n9.daemon_absent.one_file_change.total_cpu_seconds / Math.max(0.01, n1.daemon_absent.one_file_change.total_cpu_seconds), 2) : 1,
    },
  };

  let existingData: { runs: any[] } = { runs: [] };
  if (fs.existsSync(OUT_FILE)) {
    try {
      existingData = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8'));
      if (!Array.isArray(existingData.runs)) existingData.runs = [];
    } catch {}
  }

  const previousRun = existingData.runs.length > 0 ? existingData.runs[existingData.runs.length - 1] : null;

  let deltas: any = undefined;
  if (previousRun && singleSessionResults) {
    deltas = {
      cold_start_ms_delta: round(
        singleSessionResults.cold_start.wall_time_ms - previousRun.single_session.cold_start.wall_time_ms,
        0,
      ),
      idle_rss_daemon_healthy_mb_delta: round(
        singleSessionResults.steady_state_idle.daemon_healthy.total_rss_mb -
          previousRun.single_session.steady_state_idle.daemon_healthy.total_rss_mb,
        1,
      ),
      idle_rss_daemon_absent_mb_delta: round(
        singleSessionResults.steady_state_idle.daemon_absent.total_rss_mb -
          previousRun.single_session.steady_state_idle.daemon_absent.total_rss_mb,
        1,
      ),
      one_file_cpu_daemon_healthy_s_delta: round(
        singleSessionResults.one_file_change.daemon_healthy.total_cpu_seconds -
          previousRun.single_session.one_file_change.daemon_healthy.total_cpu_seconds,
        2,
      ),
      one_file_cpu_daemon_absent_s_delta: round(
        singleSessionResults.one_file_change.daemon_absent.total_cpu_seconds -
          previousRun.single_session.one_file_change.daemon_absent.total_cpu_seconds,
        2,
      ),
    };
  }

  const currentRun = {
    timestamp: new Date().toISOString(),
    measured_build: buildInfo,
    corpus: {
      name: 'trace-mcp',
      commit: PINNED_COMMIT,
      files: fileCount,
      symbols: 11134,
    },
    config: {
      idle_seconds: IDLE_SECONDS,
      steps: STEPS,
    },
    single_session: singleSessionResults,
    scaling_matrix: scalingMatrix,
    multipliers_n9_vs_n1: multipliers,
    ...(deltas ? { deltas_against_previous: deltas } : {}),
  };

  existingData.runs.push(currentRun);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(existingData, null, 2) + '\n', 'utf-8');

  console.log('\n================================================================================');
  console.log('BENCHMARK SUMMARY');
  console.log('================================================================================');
  console.log(`\n1. Cold start to first tool response (N=1):`);
  console.log(`   Wall time:   ${singleSessionResults?.cold_start.wall_time_ms} ms`);
  console.log(`   Peak RSS:    ${singleSessionResults?.cold_start.peak_rss_mb} MB`);
  console.log(`   Threads:     ${singleSessionResults?.cold_start.threads}`);

  console.log(`\n2. Steady-state cost at ${IDLE_SECONDS}s idle (N=1):`);
  console.log(
    `   Daemon healthy: session RSS=${singleSessionResults?.steady_state_idle.daemon_healthy.session_rss_mb} MB, session threads=${singleSessionResults?.steady_state_idle.daemon_healthy.session_threads} (total incl daemon: ${singleSessionResults?.steady_state_idle.daemon_healthy.total_rss_mb} MB)`,
  );
  console.log(
    `   Daemon absent:  session RSS=${singleSessionResults?.steady_state_idle.daemon_absent.session_rss_mb} MB, session threads=${singleSessionResults?.steady_state_idle.daemon_absent.session_threads} (total: ${singleSessionResults?.steady_state_idle.daemon_absent.total_rss_mb} MB)`,
  );

  console.log(`\n3. Cost of 1-file change (N=1):`);
  console.log(
    `   Daemon healthy: wall=${singleSessionResults?.one_file_change.daemon_healthy.wall_time_ms} ms, total CPU=${singleSessionResults?.one_file_change.daemon_healthy.total_cpu_seconds} s (daemon: ${singleSessionResults?.one_file_change.daemon_healthy.daemon_cpu_seconds} s, session: ${singleSessionResults?.one_file_change.daemon_healthy.sessions_cpu_seconds} s)`,
  );
  console.log(
    `   Daemon absent:  wall=${singleSessionResults?.one_file_change.daemon_absent.wall_time_ms} ms, total CPU=${singleSessionResults?.one_file_change.daemon_absent.total_cpu_seconds} s`,
  );

  console.log(`\n4. Scaling Matrix:`);
  console.log(`   N | Mode           | Cold Start p50 | Idle Total RSS | Idle Total Threads | 1-File Change CPU`);
  console.log(`   --+----------------+----------------+----------------+--------------------+------------------`);
  for (const row of scalingMatrix) {
    console.log(
      `   ${row.n} | daemon_healthy | ${String(row.daemon_healthy.cold_start.wall_time_median_ms).padStart(12)}ms | ${String(row.daemon_healthy.steady_state_idle.total_rss_mb).padStart(12)}MB | ${String(row.daemon_healthy.steady_state_idle.total_threads).padStart(16)} | ${String(row.daemon_healthy.one_file_change.total_cpu_seconds).padStart(15)}s`,
    );
    console.log(
      `   ${row.n} | daemon_absent  | ${String(row.daemon_absent.cold_start.wall_time_median_ms).padStart(12)}ms | ${String(row.daemon_absent.steady_state_idle.total_rss_mb).padStart(12)}MB | ${String(row.daemon_absent.steady_state_idle.total_threads).padStart(16)} | ${String(row.daemon_absent.one_file_change.total_cpu_seconds).padStart(15)}s`,
    );
  }

  if (n9) {
    console.log(`\n5. Multiplier (N=9 vs N=1):`);
    console.log(
      `   Daemon healthy: RSS: ${multipliers.daemon_healthy.rss_multiplier}x, Threads: ${multipliers.daemon_healthy.threads_multiplier}x, Edit CPU: ${multipliers.daemon_healthy.one_file_change_cpu_multiplier}x`,
    );
    console.log(
      `   Daemon absent:  RSS: ${multipliers.daemon_absent.rss_multiplier}x, Threads: ${multipliers.daemon_absent.threads_multiplier}x, Edit CPU: ${multipliers.daemon_absent.one_file_change_cpu_multiplier}x`,
    );
  }

  if (deltas) {
    console.log(`\n6. Delta Against Previous Run:`);
    console.log(`   Δ cold start:             ${deltas.cold_start_ms_delta > 0 ? '+' : ''}${deltas.cold_start_ms_delta} ms`);
    console.log(`   Δ idle RSS (healthy):     ${deltas.idle_rss_daemon_healthy_mb_delta > 0 ? '+' : ''}${deltas.idle_rss_daemon_healthy_mb_delta} MB`);
    console.log(`   Δ idle RSS (absent):      ${deltas.idle_rss_daemon_absent_mb_delta > 0 ? '+' : ''}${deltas.idle_rss_daemon_absent_mb_delta} MB`);
    console.log(`   Δ 1-file CPU (healthy):   ${deltas.one_file_cpu_daemon_healthy_s_delta > 0 ? '+' : ''}${deltas.one_file_cpu_daemon_healthy_s_delta} s`);
    console.log(`   Δ 1-file CPU (absent):    ${deltas.one_file_cpu_daemon_absent_s_delta > 0 ? '+' : ''}${deltas.one_file_cpu_daemon_absent_s_delta} s`);
  }

  console.log(`\nOutput written to: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
