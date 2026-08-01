/**
 * Workspace tab — shared types & merge rules.
 *
 * The Workspace tab unifies the old "Projects" (Indexes.tsx) and "Dashboard"
 * (Dashboard.tsx) tabs. Two data sources feed it:
 *
 *  1. `useDaemon()` — live SSE feed of registered projects (push, no cache).
 *     Source of truth for: live status, indexing progress, errors.
 *
 *  2. `GET /api/dashboard/projects` — server-aggregated health snapshot
 *     (5-min cache + manual invalidate). Source of truth for: metrics
 *     (files, symbols, dead exports, untested, grade, security findings),
 *     last-indexed timestamp, project display name.
 *
 * The merge produces one `ProjectViewModel` per known project; `root` is the
 * stable key. Components consume the merged shape and never look at either
 * source directly.
 *
 * Field-level precedence (see {@link mergeIntoViewModel}):
 *  - status / progress / error → daemon (push, freshest)
 *  - name / metrics / lastIndexed → dashboard (cached)
 *
 * If a project appears in only one source, that side fills the model and the
 * other side is marked absent via `hasMetrics` / `inDaemon`. UI renders
 * missing numeric cells as "—" and disables mutation actions when
 * `inDaemon === false` (the daemon is the only thing that can act on it).
 */

import type { ProgressSnapshot, ProjectState } from '../hooks/useDaemon';

// ── Canonical enums (mirror Dashboard.tsx / server schema) ──────────────────

export type ProjectHealthStatus =
  | 'ok'
  | 'error'
  | 'indexing'
  | 'not_loaded'
  | 'computing';

export type TechDebtGrade = 'A' | 'B' | 'C' | 'D' | 'F';

// ── Source shapes ──────────────────────────────────────────────────────────

/**
 * Server-aggregated health row. Mirrors the row shape returned from
 * `GET /api/dashboard/projects` (see Dashboard.tsx ProjectHealth). Re-declared
 * here so the merge layer doesn't reach into a sibling tab module.
 */
export interface ProjectHealthMetrics {
  root: string;
  name: string;
  status: ProjectHealthStatus;
  lastIndexed: string | null;
  totalFiles: number;
  totalSymbols: number;
  totalEdges: number;
  deadExports: number;
  untestedSymbols: number;
  techDebtGrade?: TechDebtGrade;
  securityFindings: number;
  error?: string;
}

// ── Merged view model ──────────────────────────────────────────────────────

/**
 * The single shape every Workspace view component reads from.
 *
 * Always present:
 *  - `root`, `displayStatus`, `name` (derived from basename if dashboard is silent)
 *  - `hasMetrics`, `inDaemon` flags so UI can degrade gracefully
 *
 * Conditionally present:
 *  - `progress` only while a pipeline is running (daemon)
 *  - `liveStatus` carries the raw daemon status string ("embedding",
 *    "pending", ...) when it's finer-grained than `displayStatus`
 *  - All numeric metrics undefined when `hasMetrics === false`
 */
export interface ProjectViewModel {
  /** Absolute project root — stable key. */
  root: string;

  /** Display name. Falls back to basename(root) when dashboard has no row. */
  name: string;

  /** Canonical status for filters / sort / badges. */
  displayStatus: ProjectHealthStatus;

  /** Raw daemon status when it carries extra nuance (e.g. "embedding"). */
  liveStatus?: string;

  /** Last error message from either source (daemon wins if both set). */
  error?: string;

  /** Live indexing/embedding progress. Daemon-only. */
  progress?: ProgressSnapshot;

  // ── Metrics (dashboard cache; absent when hasMetrics === false) ──
  lastIndexed: string | null;
  totalFiles?: number;
  totalSymbols?: number;
  totalEdges?: number;
  deadExports?: number;
  untestedSymbols?: number;
  techDebtGrade?: TechDebtGrade;
  securityFindings?: number;

  /** True when this project has a row in the dashboard cache. */
  hasMetrics: boolean;

  /** True when this project is registered with the daemon. */
  inDaemon: boolean;
}

// ── Filter / sort / view-mode primitives ───────────────────────────────────

export type ViewMode = 'table' | 'compact' | 'cards';

export type SortDir = 'asc' | 'desc';

export type SortKey =
  | 'name'
  | 'status'
  | 'lastIndexed'
  | 'totalFiles'
  | 'totalSymbols'
  | 'deadExports'
  | 'untestedSymbols'
  | 'techDebtGrade'
  | 'securityFindings';

/**
 * Smart-preset filters. `null` = no preset active (manual filter combo only).
 * Each preset is also expressible via the granular fields below; the preset
 * tag exists for UI / persistence and to drive the KPI strip click handlers.
 */
export type WorkspaceFilterPreset =
  | 'all'
  | 'needs_attention'
  | 'healthy'
  | 'indexing'
  | 'failing';

export interface WorkspaceFilter {
  /** Free-text search over name + root. Case-insensitive. */
  query: string;
  /** Status whitelist; `null` = any. */
  statuses: ProjectHealthStatus[] | null;
  /** Tech-debt grade whitelist; `null` = any (incl. ungraded). */
  grades: TechDebtGrade[] | null;
  /** `true` = only with critical+high security findings; `null` = any. */
  hasSecurityFindings: boolean | null;
  /** `true` = only with deadExports > 0; `null` = any. */
  hasDeadExports: boolean | null;
  /** Active preset, if any. Mutually composes with manual filters. */
  preset: WorkspaceFilterPreset | null;
}

export const EMPTY_FILTER: WorkspaceFilter = {
  query: '',
  statuses: null,
  grades: null,
  hasSecurityFindings: null,
  hasDeadExports: null,
  preset: null,
};

// ── KPI strip ──────────────────────────────────────────────────────────────

export interface WorkspaceKpis {
  totalProjects: number;
  totalFiles: number;
  totalSymbols: number;
  healthy: number; // grade A or B and 0 security findings
  needsAttention: number; // grade D/F OR security > 0 OR deadExports >= 10
  indexing: number; // displayStatus === 'indexing' || 'computing'
}

// ── Status mapping ─────────────────────────────────────────────────────────

/**
 * Coerce the loose daemon status string into a canonical
 * {@link ProjectHealthStatus}. Daemon emits "ready", "indexing", "embedding",
 * "pending", "error", and occasionally other transient values — we collapse
 * those to the closed set the dashboard uses so a single switch handles
 * status colour / badge / sort everywhere.
 */
export function canonicalizeDaemonStatus(raw: string): ProjectHealthStatus {
  switch (raw) {
    case 'ready':
    case 'ok':
      return 'ok';
    case 'indexing':
    case 'embedding':
      return 'indexing';
    case 'pending':
    case 'computing':
      return 'computing';
    case 'error':
      return 'error';
    default:
      return 'not_loaded';
  }
}

// ── Merge ──────────────────────────────────────────────────────────────────

/**
 * Build the merged list. Both inputs may be empty; output is the union
 * keyed by `root`, sorted nowhere (caller sorts).
 *
 * Precedence inside a single project's view model:
 *   - daemon wins for: status (after canonicalization), progress, error
 *     (when set), liveStatus, inDaemon
 *   - dashboard wins for: name, all numeric metrics, lastIndexed,
 *     techDebtGrade, hasMetrics
 *
 * When daemon reports `indexing`/`embedding`/`pending` AND dashboard has a
 * row, the live status overrides the dashboard's possibly-stale `status`.
 * When daemon reports `ready` AND dashboard says `error`, we trust the
 * dashboard (it just finished computing metrics on the latest index).
 */
export function mergeIntoViewModel(
  daemonProjects: ProjectState[],
  metrics: ProjectHealthMetrics[],
): ProjectViewModel[] {
  const byRoot = new Map<string, ProjectViewModel>();

  // Seed from dashboard metrics — gives us the canonical name + numbers.
  for (const m of metrics) {
    byRoot.set(m.root, {
      root: m.root,
      name: m.name,
      displayStatus: m.status,
      error: m.error,
      lastIndexed: m.lastIndexed,
      totalFiles: m.totalFiles,
      totalSymbols: m.totalSymbols,
      totalEdges: m.totalEdges,
      deadExports: m.deadExports,
      untestedSymbols: m.untestedSymbols,
      techDebtGrade: m.techDebtGrade,
      securityFindings: m.securityFindings,
      hasMetrics: true,
      inDaemon: false,
    });
  }

  // Overlay live daemon state.
  for (const p of daemonProjects) {
    const existing = byRoot.get(p.root);
    const liveCanonical = canonicalizeDaemonStatus(p.status);
    const liveIsTransient =
      liveCanonical === 'indexing' || liveCanonical === 'computing';

    if (existing) {
      // Live status overrides cached status when daemon is in a transient
      // pipeline state OR when dashboard hasn't decided yet ('not_loaded').
      const displayStatus =
        liveIsTransient || existing.displayStatus === 'not_loaded'
          ? liveCanonical
          : existing.displayStatus;
      byRoot.set(p.root, {
        ...existing,
        displayStatus,
        liveStatus: p.status,
        progress: p.progress,
        error: p.error ?? existing.error,
        inDaemon: true,
      });
    } else {
      // Daemon knows about a project the dashboard cache hasn't seen yet.
      byRoot.set(p.root, {
        root: p.root,
        name: basename(p.root),
        displayStatus: liveCanonical,
        liveStatus: p.status,
        error: p.error,
        progress: p.progress,
        lastIndexed: null,
        hasMetrics: false,
        inDaemon: true,
      });
    }
  }

  return [...byRoot.values()];
}

// ── KPI derivation ─────────────────────────────────────────────────────────

export function deriveKpis(projects: ProjectViewModel[]): WorkspaceKpis {
  let healthy = 0;
  let needsAttention = 0;
  let indexing = 0;
  let totalFiles = 0;
  let totalSymbols = 0;

  for (const p of projects) {
    if (p.displayStatus === 'indexing' || p.displayStatus === 'computing') {
      indexing++;
    }
    if (p.hasMetrics) {
      totalFiles += p.totalFiles ?? 0;
      totalSymbols += p.totalSymbols ?? 0;
      const grade = p.techDebtGrade;
      const sec = p.securityFindings ?? 0;
      const dead = p.deadExports ?? 0;
      const goodGrade = grade === 'A' || grade === 'B';
      const badGrade = grade === 'D' || grade === 'F';
      if (goodGrade && sec === 0) healthy++;
      if (badGrade || sec > 0 || dead >= 10) needsAttention++;
    }
  }

  return {
    totalProjects: projects.length,
    totalFiles,
    totalSymbols,
    healthy,
    needsAttention,
    indexing,
  };
}

// ── Filter application ─────────────────────────────────────────────────────

/**
 * Apply a {@link WorkspaceFilter} to the list. Pure, no side effects.
 *
 * Combination semantics:
 *   - `preset` is folded in as additional constraints (AND with the rest).
 *   - Each granular field is AND'd; within a list (statuses, grades) it's OR.
 *   - `query` is matched case-insensitively against name + root.
 */
export function applyFilter(
  projects: ProjectViewModel[],
  filter: WorkspaceFilter,
): ProjectViewModel[] {
  const q = filter.query.trim().toLowerCase();
  return projects.filter((p) => {
    if (q) {
      const hay = `${p.name}\n${p.root}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter.statuses && !filter.statuses.includes(p.displayStatus)) return false;
    if (filter.grades) {
      if (!p.techDebtGrade || !filter.grades.includes(p.techDebtGrade)) return false;
    }
    if (filter.hasSecurityFindings === true && !((p.securityFindings ?? 0) > 0)) {
      return false;
    }
    if (filter.hasDeadExports === true && !((p.deadExports ?? 0) > 0)) {
      return false;
    }
    if (filter.preset) {
      if (!matchesPreset(p, filter.preset)) return false;
    }
    return true;
  });
}

function matchesPreset(p: ProjectViewModel, preset: WorkspaceFilterPreset): boolean {
  switch (preset) {
    case 'all':
      return true;
    case 'healthy':
      return (
        (p.techDebtGrade === 'A' || p.techDebtGrade === 'B') &&
        (p.securityFindings ?? 0) === 0
      );
    case 'needs_attention':
      return (
        p.techDebtGrade === 'D' ||
        p.techDebtGrade === 'F' ||
        (p.securityFindings ?? 0) > 0 ||
        (p.deadExports ?? 0) >= 10
      );
    case 'indexing':
      return p.displayStatus === 'indexing' || p.displayStatus === 'computing';
    case 'failing':
      return p.displayStatus === 'error';
  }
}

// ── Sorting ────────────────────────────────────────────────────────────────

const GRADE_ORDER: Record<TechDebtGrade, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };
const STATUS_ORDER: Record<ProjectHealthStatus, number> = {
  ok: 0,
  indexing: 1,
  computing: 2,
  error: 3,
  not_loaded: 4,
};

export function compareViewModels(
  a: ProjectViewModel,
  b: ProjectViewModel,
  key: SortKey,
  dir: SortDir,
): number {
  let result = 0;
  if (key === 'name') {
    result = a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0;
  } else if (key === 'status') {
    result = STATUS_ORDER[a.displayStatus] - STATUS_ORDER[b.displayStatus];
  } else if (key === 'lastIndexed') {
    const ta = a.lastIndexed ?? '';
    const tb = b.lastIndexed ?? '';
    result = ta < tb ? -1 : ta > tb ? 1 : 0;
  } else if (key === 'techDebtGrade') {
    const ga = a.techDebtGrade ? GRADE_ORDER[a.techDebtGrade] : 5;
    const gb = b.techDebtGrade ? GRADE_ORDER[b.techDebtGrade] : 5;
    result = ga - gb;
  } else {
    // Numeric metric. Undefined sinks to the bottom on asc, top on desc.
    const va = (a[key] as number | undefined) ?? -1;
    const vb = (b[key] as number | undefined) ?? -1;
    result = va - vb;
  }
  return dir === 'asc' ? result : -result;
}

// ── StatusDot bridge ───────────────────────────────────────────────────────

/**
 * Map canonical status → StatusDot palette. Kept here so every view renders
 * the dot the same way.
 */
export function statusToDot(
  status: ProjectHealthStatus,
): 'active' | 'idle' | 'error' | 'disconnected' {
  switch (status) {
    case 'ok':
      return 'active';
    case 'indexing':
    case 'computing':
      return 'idle';
    case 'error':
      return 'error';
    case 'not_loaded':
      return 'disconnected';
  }
}

export function statusLabel(status: ProjectHealthStatus): string {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'indexing':
      return 'Indexing';
    case 'computing':
      return 'Computing';
    case 'error':
      return 'Error';
    case 'not_loaded':
      return 'Not loaded';
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
