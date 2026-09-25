/**
 * Benchmark Lab persistence (TRA-1951).
 *
 * Runs land as flat JSON under `<home>/benchmark-runs/` — the same home
 * pattern as `savings.json` (resolved via TRACE_MCP_HOME, so the
 * `~/.trace-mcp` → `~/.trace` migration and TRACE_MCP_DATA_DIR overrides
 * apply here too), written atomically. JSON, not SQLite: runs are
 * append-only artifacts the docs export reads back, and a migration buys
 * nothing for that.
 */

import fs from 'node:fs';
import path from 'node:path';
import { TRACE_MCP_HOME } from '../global.js';
import { atomicWriteJson } from '../utils/atomic-write.js';
import type { LabRun } from './runner.js';

export const BENCHMARK_RUNS_DIRNAME = 'benchmark-runs';

export function benchmarkRunsDir(home: string = TRACE_MCP_HOME): string {
  return path.join(home, BENCHMARK_RUNS_DIRNAME);
}

function runFile(runId: string, home: string = TRACE_MCP_HOME): string {
  const safe = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(benchmarkRunsDir(home), `${safe}.json`);
}

function isLabRun(value: unknown): value is LabRun {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r['schema_version'] === 1 &&
    typeof r['run_id'] === 'string' &&
    Array.isArray(r['results']) &&
    Array.isArray(r['aggregates'])
  );
}

/** Persist a run, returning the filename it was saved under. */
export function saveLabRun(run: LabRun, home: string = TRACE_MCP_HOME): string {
  fs.mkdirSync(benchmarkRunsDir(home), { recursive: true });
  const file = runFile(run.run_id, home);
  atomicWriteJson(file, run);
  return path.basename(file);
}

export interface LabRunSummary {
  run_id: string;
  file: string;
  started_at: string;
  project_root: string;
  fixture_count: number;
  fixtures_sha: string;
  arms: string[];
  build: string;
  aggregates: LabRun['aggregates'];
}

export function summarizeLabRun(run: LabRun, file: string): LabRunSummary {
  return {
    run_id: run.run_id,
    file,
    started_at: run.started_at,
    project_root: run.project_root,
    fixture_count: run.battery.fixture_count,
    fixtures_sha: run.battery.fixtures_sha,
    arms: run.arms,
    build: `${run.measured_build.version}@${run.measured_build.commit}`,
    aggregates: run.aggregates,
  };
}

/** Newest first. Skips files that fail to parse or fail the shape check. */
export function listLabRuns(home: string = TRACE_MCP_HOME): LabRunSummary[] {
  const dir = benchmarkRunsDir(home);
  if (!fs.existsSync(dir)) return [];
  const out: LabRunSummary[] = [];
  for (const f of fs
    .readdirSync(dir)
    .filter((x) => x.endsWith('.json'))
    .sort()
    .reverse()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as unknown;
      if (isLabRun(parsed)) out.push(summarizeLabRun(parsed, f));
    } catch {
      // A half-written or foreign file must not break the run list.
    }
  }
  return out;
}

/** Full record by run id (or saved filename). Null when absent or invalid. */
export function getLabRun(id: string, home: string = TRACE_MCP_HOME): LabRun | null {
  const direct = path.join(benchmarkRunsDir(home), id);
  const candidates = id.endsWith('.json') ? [direct] : [runFile(id, home), direct];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      if (isLabRun(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}
