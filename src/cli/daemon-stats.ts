import fs from 'node:fs';
import path from 'node:path';
import { TRACE_MCP_HOME } from '../global.js';

export interface HookStatLine {
  ts: number;
  path: 'daemon' | 'cli' | 'skipped';
  reason: string;
  wallclock_ms: number;
}

export interface PathStats {
  count: number;
  share: number;
  p50: number;
  p95: number;
}

export interface HookAggregate {
  total: number;
  daemon: PathStats;
  cli: PathStats;
  skipped: PathStats;
  reasons: Record<string, number>;
  sinceMs: number | null;
  untilMs: number;
}

export const HOOK_STATS_PATH = path.join(TRACE_MCP_HOME, 'hook-stats.jsonl');

export function parseDuration(input: string): number | null {
  const match = /^(\d+)([smhd]?)$/.exec(input.trim());
  if (!match) return null;
  const n = parseInt(match[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2] || 'h';
  const mult = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

export function readHookStatsFile(filePath: string = HOOK_STATS_PATH): HookStatLine[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseHookStats(raw);
}

export function parseHookStats(text: string): HookStatLine[] {
  const out: HookStatLine[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.ts !== 'number') continue;
      if (obj.path !== 'daemon' && obj.path !== 'cli' && obj.path !== 'skipped') continue;
      if (typeof obj.reason !== 'string') continue;
      if (typeof obj.wallclock_ms !== 'number') continue;
      out.push({
        ts: obj.ts,
        path: obj.path,
        reason: obj.reason,
        wallclock_ms: obj.wallclock_ms,
      });
    } catch {
      // Skip malformed lines — JSONL tolerates them.
    }
  }
  return out;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

export function aggregateHookStats(
  lines: HookStatLine[],
  opts: { sinceMs?: number | null; nowMs?: number } = {},
): HookAggregate {
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = opts.sinceMs ?? null;
  const filtered = sinceMs !== null ? lines.filter((l) => l.ts >= sinceMs) : lines;

  const buckets: Record<'daemon' | 'cli' | 'skipped', number[]> = {
    daemon: [],
    cli: [],
    skipped: [],
  };
  const reasons: Record<string, number> = {};

  for (const l of filtered) {
    buckets[l.path].push(l.wallclock_ms);
    if (l.path !== 'daemon') {
      reasons[l.reason] = (reasons[l.reason] ?? 0) + 1;
    }
  }

  const total = filtered.length;
  const mkStats = (vals: number[]): PathStats => {
    const sorted = [...vals].sort((a, b) => a - b);
    return {
      count: vals.length,
      share: total === 0 ? 0 : vals.length / total,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
    };
  };

  return {
    total,
    daemon: mkStats(buckets.daemon),
    cli: mkStats(buckets.cli),
    skipped: mkStats(buckets.skipped),
    reasons,
    sinceMs,
    untilMs: nowMs,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

export function renderHookStats(agg: HookAggregate, windowLabel: string): string {
  const lines: string[] = [];
  lines.push(
    `=== Hook dispatch (last ${windowLabel}, from ${HOOK_STATS_PATH.replace(process.env.HOME ?? '', '~')}) ===`,
  );
  lines.push(`  total invocations: ${agg.total}`);
  if (agg.total === 0) {
    lines.push('  (no hook invocations recorded in this window)');
    return lines.join('\n');
  }
  const fmt = (label: string, s: PathStats): string =>
    `  ${label}: ${pad(String(s.count), 6)} (${pad(pct(s.share), 5)}) p50=${pad(s.p50 + 'ms', 6)} p95=${pad(s.p95 + 'ms', 6)}`;
  lines.push(fmt('daemon path  ', agg.daemon));
  lines.push(fmt('cli fallback ', agg.cli));
  lines.push(fmt('skipped      ', agg.skipped));
  const reasonKeys = Object.keys(agg.reasons).sort();
  if (reasonKeys.length > 0) {
    const parts = reasonKeys.map((k) => `"${k}": ${agg.reasons[k]}`);
    lines.push(`  failure reasons: { ${parts.join(', ')} }`);
  }
  return lines.join('\n');
}

export interface DaemonEventStats {
  total: number;
  fast_skipped_recent: number;
  fast_skipped_hash: number;
  indexed: number;
  p50_ms: number;
  p95_ms: number;
}

export function renderDaemonEvents(s: DaemonEventStats): string {
  const lines: string[] = [];
  lines.push('=== Daemon reindex events (since startup, from journal) ===');
  lines.push(`  total: ${s.total}`);
  if (s.total === 0) {
    lines.push('  (no reindex-file events recorded since daemon start)');
    return lines.join('\n');
  }
  const pctOf = (n: number) => pct(n / s.total);
  lines.push(`  fast (skipped_recent): ${s.fast_skipped_recent} (${pctOf(s.fast_skipped_recent)})`);
  lines.push(`  fast (skipped_hash):   ${s.fast_skipped_hash} (${pctOf(s.fast_skipped_hash)})`);
  lines.push(`  indexed:               ${s.indexed} (${pctOf(s.indexed)})`);
  lines.push(`  per-call: p50=${s.p50_ms}ms p95=${s.p95_ms}ms`);
  return lines.join('\n');
}

export async function fetchDaemonStats(port: number): Promise<DaemonEventStats | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/stats`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<DaemonEventStats> | null;
    if (!body) return null;
    return {
      total: body.total ?? 0,
      fast_skipped_recent: body.fast_skipped_recent ?? 0,
      fast_skipped_hash: body.fast_skipped_hash ?? 0,
      indexed: body.indexed ?? 0,
      p50_ms: body.p50_ms ?? 0,
      p95_ms: body.p95_ms ?? 0,
    };
  } catch {
    return null;
  }
}
