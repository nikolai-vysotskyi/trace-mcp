/**
 * KPI baselines — the "compared to what?" behind every dashboard number.
 *
 * A bare count is decoration, not a dashboard. We keep no metrics history
 * server-side, so the cheapest honest baseline is the user's own previous
 * reading: snapshot the KPIs in localStorage, roll that snapshot at most once
 * a day, and show today's numbers against it.
 *
 * ponytail: one snapshot, not a series — enough for a delta chip. Store a
 * ring buffer here if we ever want sparklines.
 */
import type { WorkspaceKpis } from './types';

export interface KpiBaseline {
  /** ISO timestamp of the snapshot. */
  at: string;
  kpis: WorkspaceKpis;
}

export const LS_BASELINE_KEY = 'trace-mcp.workspace.kpi-baseline';
export const BASELINE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface BaselineRoll {
  /** Snapshot to compare today's numbers against; null when we have none yet. */
  previous: KpiBaseline | null;
  /** Snapshot to persist; null means keep what is already stored. */
  next: KpiBaseline | null;
}

/**
 * Decide which baseline to show and which to store.
 *
 *  - nothing stored → start tracking now, show no delta yet
 *  - stored today   → compare against it, keep it
 *  - stored earlier → compare against it, then replace it with today's reading
 */
export function rollBaseline(
  nowMs: number,
  stored: KpiBaseline | null,
  current: WorkspaceKpis,
): BaselineRoll {
  const fresh: KpiBaseline = { at: new Date(nowMs).toISOString(), kpis: current };
  if (!stored) return { previous: null, next: fresh };
  const age = nowMs - Date.parse(stored.at);
  if (!Number.isFinite(age) || age < 0) return { previous: null, next: fresh };
  if (age >= BASELINE_MAX_AGE_MS) return { previous: stored, next: fresh };
  return { previous: stored, next: null };
}

function isKpis(v: unknown): v is WorkspaceKpis {
  const k = v as Partial<WorkspaceKpis> | null;
  return !!k && typeof k.totalProjects === 'number' && typeof k.totalFiles === 'number';
}

export function loadBaseline(): KpiBaseline | null {
  try {
    const raw = localStorage.getItem(LS_BASELINE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KpiBaseline>;
    if (typeof parsed?.at !== 'string' || !isKpis(parsed.kpis)) return null;
    return { at: parsed.at, kpis: parsed.kpis };
  } catch {
    return null;
  }
}

export function saveBaseline(baseline: KpiBaseline): void {
  try {
    localStorage.setItem(LS_BASELINE_KEY, JSON.stringify(baseline));
  } catch {
    /* private mode / quota — deltas are a nicety, never block the dashboard */
  }
}
