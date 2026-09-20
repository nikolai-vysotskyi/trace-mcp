/**
 * Process inventory for the single-daemon audit (TRA-1607).
 *
 * Answers "how many trace-mcp processes are on this machine right now, what
 * are they, and which of them should not be here": every trace-mcp PID with
 * its role (daemon / stdio session / one-shot CLI), RSS, age and parent PID,
 * plus duplicate-daemon and orphan detection.
 *
 * Two rules shape the classification:
 *
 * - A `serve-http` daemon supervised by launchd legitimately has ppid 1, and
 *   so does a detached-spawn daemon whose spawner already exited — ppid 1
 *   alone never marks a daemon as an orphan. A daemon is a *stray* only when
 *   it is not the registered one (daemon.pid / launchd job names someone
 *   else) while another daemon is also present.
 * - A stdio `serve` session is meant to live exactly as long as its host.
 *   One reparented to init (ppid 1) with no supervisor is an orphan —
 *   `startParentDeathWatch` should have reaped it
 *   (src/server/parent-death-watch.ts).
 *
 * All listing is best-effort and never throws: doctor must report "could not
 * list processes" rather than crash when `ps` is unavailable.
 */

import { execFileSync } from 'node:child_process';

export type TraceMcpProcessRole = 'daemon' | 'stdio-session' | 'desktop-app' | 'cli' | 'unknown';

export interface TraceMcpProcess {
  pid: number;
  /** Parent PID; null when unknown (Windows tasklist fallback). */
  ppid: number | null;
  /** Resident set size in bytes; null when unknown. */
  rssBytes: number | null;
  /** Process age in seconds; null when unknown. */
  ageSec: number | null;
  command: string;
  role: TraceMcpProcessRole;
  /** Daemon listen port parsed from `serve-http --port N`; absent otherwise. */
  port?: number;
  /** True for the process calling into this module (e.g. `doctor` itself). */
  isSelf: boolean;
}

export interface DaemonProcessReport {
  processes: TraceMcpProcess[];
  daemons: TraceMcpProcess[];
  /** Second-and-later daemons: the single-instance violation (PROC-3). */
  duplicates: TraceMcpProcess[];
  /** Stdio sessions reparented to init with nobody consuming them. */
  orphans: TraceMcpProcess[];
  /** PID the registration (daemon.pid) names, when readable. */
  registeredPid: number | null;
  /** True when `ps` (or the platform fallback) could not run at all. */
  listFailed: boolean;
}

/**
 * Classify one command line. Exported for tests.
 *
 * `serve-http` wins over `serve`: a daemon command line always contains the
 * longer token, and a naive `includes('serve')` would mislabel every daemon
 * as a session.
 */
export function classifyTraceMcpCommand(command: string): {
  role: TraceMcpProcessRole;
  port?: number;
} {
  // Daemon first: its command line contains `serve-http`, which also contains
  // the substring `serve` — a naive serve check would mislabel every daemon.
  if (/(^|[\s/\\])serve-http([\s=]|$)/.test(command)) {
    const portMatch = command.match(/--port[=\s]+(\d+)/);
    const port = portMatch?.[1] ? parseInt(portMatch[1], 10) : undefined;
    return { role: 'daemon', port: Number.isInteger(port) ? port : undefined };
  }
  if (!isTraceMcpCommand(command)) return { role: 'unknown' };
  // Stdio sessions: `trace-mcp serve` and the thin proxy entry (TRA-970,
  // `dist/proxy.js`) — both live exactly as long as their MCP host.
  if (/(^|[\s/\\:])serve([\s]|$)/.test(command) || /proxy(-entry)?\.js/.test(command)) {
    return { role: 'stdio-session' };
  }
  // The Electron desktop app (main + Helper/GPU/renderer children). Checked
  // after daemon/session: the staged server it ships also runs cli.js, but a
  // process serving HTTP or stdio is that role first.
  if (/\.app\/Contents\//.test(command) || / --type=/.test(command)) {
    return { role: 'desktop-app' };
  }
  return { role: 'cli' };
}

/** True when the command line belongs to a trace-mcp binary at all. */
export function isTraceMcpCommand(command: string): boolean {
  return (
    command.includes('trace-mcp') ||
    command.includes('trace_mcp') ||
    /(^|[/\\ ])cli\.js(\s|$)/.test(command) ||
    command.includes('serve-http') ||
    // The thin proxy entry ships as dist/proxy.js next to cli.js and is what
    // the launcher shim execs (TRA-970) — including the staged server inside
    // the desktop app, whose path carries no trace-mcp marker. Scoped to
    // dist/ so an unrelated project file named proxy.js never matches.
    /dist[/\\]proxy\.js/.test(command) ||
    /[/\\]bin[/\\]trace(\s|$)/.test(` ${command} `)
  );
}

/**
 * Parse `ps -ax -o pid=,ppid=,rss=,etime=,command=` output. Exported for
 * tests — the format differs across macOS/Linux, so every field is optional
 * and a garbage line is skipped, never fatal.
 *
 * `ps` prints RSS in KiB on both macOS and Linux.
 */
export function parsePsOutput(output: string): TraceMcpProcess[] {
  const out: TraceMcpProcess[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // pid, ppid, rss, etime, then the free-form command.
    const m = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/);
    if (!m) continue;
    const command = m[5];
    if (!isTraceMcpCommand(command)) continue;
    const pid = parseInt(m[1], 10);
    // Never report the listing process itself — nor the parent that spawned
    // it (the shim/shell whose command line is our own invocation, e.g. the
    // `trace-mcp doctor` being read right now). Otherwise doctor always
    // reports one phantom `cli` process: itself.
    if (pid === process.pid || pid === process.ppid) continue;
    const { role, port } = classifyTraceMcpCommand(command);
    if (role === 'unknown') continue;
    out.push({
      pid,
      ppid: parseInt(m[2], 10),
      rssBytes: parseInt(m[3], 10) * 1024,
      ageSec: parseEtime(m[4]),
      command: truncateCommand(command),
      role,
      ...(port !== undefined ? { port } : {}),
      isSelf: false,
    });
  }
  return out;
}

/**
 * Parse `ps` ETIME (`[[D-]HH:]MM:SS`). Returns null when unparseable —
 * never throws, it runs on doctor's output path.
 */
export function parseEtime(etime: string): number | null {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const days = m[1] ? parseInt(m[1], 10) : 0;
  const hours = m[2] ? parseInt(m[2], 10) : 0;
  const minutes = parseInt(m[3], 10);
  const seconds = parseInt(m[4], 10);
  if ([days, hours, minutes, seconds].some((n) => !Number.isFinite(n))) return null;
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function truncateCommand(command: string, max = 220): string {
  return command.length > max ? `${command.slice(0, max)}…` : command;
}

function runPs(): TraceMcpProcess[] | null {
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,rss=,etime=,command='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return parsePsOutput(out);
  } catch {
    return null;
  }
}

/**
 * Windows fallback: no `ps` on a stock machine. PowerShell's CIM query
 * returns the same shape (WorkingSetSize is already bytes).
 */
function runWindowsFallback(): TraceMcpProcess[] | null {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "trace-mcp|serve-http|cli\\.js" } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize) $($_.CommandLine)" }',
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 },
    );
    const found: TraceMcpProcess[] = [];
    for (const rawLine of out.split('\n')) {
      const m = rawLine.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*\S)\s*$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      if (pid === process.pid || pid === process.ppid) continue;
      const { role, port } = classifyTraceMcpCommand(m[4]);
      if (role === 'unknown') continue;
      found.push({
        pid,
        ppid: parseInt(m[2], 10),
        rssBytes: parseInt(m[3], 10),
        ageSec: null,
        command: truncateCommand(m[4]),
        role,
        ...(port !== undefined ? { port } : {}),
        isSelf: false,
      });
    }
    return found;
  } catch {
    return null;
  }
}

/** List every trace-mcp process on this machine. Never throws. */
export function listTraceMcpProcesses(): { processes: TraceMcpProcess[]; listFailed: boolean } {
  const fromPs = runPs();
  if (fromPs !== null) return { processes: fromPs, listFailed: false };
  if (process.platform === 'win32') {
    const fromFallback = runWindowsFallback();
    if (fromFallback !== null) return { processes: fromFallback, listFailed: false };
  }
  return { processes: [], listFailed: true };
}

export interface DiagnoseProcessesOptions {
  /** PID the daemon.pid registration names (null when unreadable/absent). */
  registeredPid?: number | null;
  /**
   * Whether the launchd job is loaded (macOS). A ppid-1 daemon under a loaded
   * job is supervised, not orphaned. Null/undefined = unknown → daemons are
   * never reported as orphans on that basis alone.
   */
  launchdLoaded?: boolean | null;
}

/**
 * Split an inventory into duplicates and orphans. Pure — exported for tests.
 *
 * Duplicate rule: more than one `serve-http` process means the single-daemon
 * invariant is broken right now, regardless of ports. (Two daemons on
 * different ports still double watchers, ONNX and SQLite handles for the same
 * registered projects — the cost PROC-3 exists to remove.) The registered PID
 * (when known) is treated as the keeper; every other daemon is the duplicate.
 * Without a registration, the oldest daemon is the keeper.
 */
export function diagnoseProcesses(
  processes: TraceMcpProcess[],
  opts: DiagnoseProcessesOptions = {},
): DaemonProcessReport {
  const daemons = processes.filter((p) => p.role === 'daemon');
  let duplicates: TraceMcpProcess[] = [];
  if (daemons.length > 1) {
    const keeper =
      opts.registeredPid != null && daemons.some((d) => d.pid === opts.registeredPid)
        ? opts.registeredPid
        : oldestFirst(daemons)[0]?.pid;
    duplicates = daemons.filter((d) => d.pid !== keeper);
  }

  const orphans = processes.filter((p) => {
    if (p.ppid !== 1) return false;
    if (p.role === 'stdio-session') return true;
    // A ppid-1 daemon with no supervising launchd job and no registration is
    // a leftover detached/manual spawn — but only worth flagging alongside a
    // duplicate (a lone healthy detached daemon on Linux also has ppid 1).
    if (p.role === 'daemon' && daemons.length > 1 && opts.launchdLoaded === false) return true;
    return false;
  });

  return {
    processes,
    daemons,
    duplicates,
    orphans,
    registeredPid: opts.registeredPid ?? null,
    listFailed: false,
  };
}

function oldestFirst(daemons: TraceMcpProcess[]): TraceMcpProcess[] {
  return [...daemons].sort((a, b) => (b.ageSec ?? 0) - (a.ageSec ?? 0));
}

/**
 * SIGTERM every `serve-http` daemon except ourselves. Returns the signalled
 * PIDs. Best-effort — a kill that fails (already dead, EPERM) is skipped, and
 * this never throws: it runs on the `daemon stop` path.
 */
export function signalDaemons(signal: NodeJS.Signals = 'SIGTERM'): number[] {
  const { processes } = listTraceMcpProcesses();
  const signalled: number[] = [];
  for (const p of processes) {
    if (p.role !== 'daemon' || p.pid === process.pid) continue;
    try {
      process.kill(p.pid, signal);
      signalled.push(p.pid);
    } catch {
      /* already dead or not ours — the platform stop path owns those */
    }
  }
  return signalled;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return 'unknown RSS';
  return `${Math.round(bytes / 1048576)} MB`;
}

function formatAge(ageSec: number | null): string {
  if (ageSec == null) return 'age unknown';
  if (ageSec < 90) return `${ageSec}s`;
  if (ageSec < 5400) return `${Math.floor(ageSec / 60)}m`;
  return `${Math.floor(ageSec / 3600)}h${Math.floor((ageSec % 3600) / 60)}m`;
}

/** Human-readable lines for `doctor` and `daemon status`. */
export function formatProcessReport(r: DaemonProcessReport): string[] {
  const lines: string[] = [];
  if (r.listFailed) {
    return ['Processes: could not list processes on this machine (ps unavailable).'];
  }
  if (r.processes.length === 0) {
    return ['Processes: no other trace-mcp processes running.'];
  }
  const dupePids = new Set(r.duplicates.map((d) => d.pid));
  const orphanPids = new Set(r.orphans.map((o) => o.pid));
  lines.push(
    `Processes: ${r.processes.length} trace-mcp process(es), ${r.daemons.length} daemon(s).`,
  );
  for (const p of r.processes) {
    const tags: string[] = [p.role];
    if (p.role === 'daemon' && p.port !== undefined) tags.push(`port ${p.port}`);
    if (dupePids.has(p.pid)) tags.push('DUPLICATE daemon');
    if (orphanPids.has(p.pid)) tags.push('ORPHAN');
    if (r.registeredPid === p.pid) tags.push('registered');
    lines.push(
      `  pid ${p.pid} [${tags.join(', ')}] ${formatBytes(p.rssBytes)}, ${formatAge(p.ageSec)}, ppid ${p.ppid ?? '?'} — ${p.command}`,
    );
  }
  if (r.duplicates.length > 0) {
    lines.push(
      `  WARNING: ${r.duplicates.length + 1} daemons running — single-daemon invariant broken. ` +
        'Stop the extras with `trace-mcp daemon stop` (now kills all daemons, TRA-1607).',
    );
  }
  if (r.orphans.length > 0) {
    lines.push(
      `  WARNING: ${r.orphans.length} orphaned session(s) (parent gone, ppid 1) — ` +
        'these burn watchers + CPU with nobody consuming the results.',
    );
  }
  return lines;
}
