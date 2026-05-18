/**
 * Wake-Up Context — assembles a compact context payload (~300 tokens) that
 * gives an AI agent immediate orientation at session start.
 *
 * Layers:
 *   L0: Project identity (name, frameworks, key stats)
 *   L1: Active decisions (top-N most recent, code-linked)
 *   L2: Session context (hot files, dead ends from recent sessions)
 *
 * Inspired by MemPalace's layered memory stack, but code-aware:
 * decisions are linked to symbols/files, not just text.
 */

import * as path from 'node:path';
import type { DecisionRow, DecisionStore, DecisionType } from './decision-store.js';
import { computeHeat } from './heat.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface WakeUpContext {
  /** L0: Project identity */
  project: {
    name: string;
    root: string;
  };
  /** L1: Active decisions (most recent, code-linked) */
  decisions: {
    total_active: number;
    recent: Array<{
      id: number;
      title: string;
      type: string;
      /** Linked symbol (if any) */
      symbol?: string;
      /** Linked file (if any) */
      file?: string;
      /** When this decision was made */
      when: string;
    }>;
  };
  /** L2: Session memory stats */
  memory: {
    total_decisions: number;
    sessions_mined: number;
    sessions_indexed: number;
    by_type: Record<string, number>;
  };
  /** Approximate token count */
  estimated_tokens: number;
}

// ════════════════════════════════════════════════════════════════════════
// ASSEMBLY
// ════════════════════════════════════════════════════════════════════════

function compactDecision(d: DecisionRow): WakeUpContext['decisions']['recent'][0] {
  const entry: WakeUpContext['decisions']['recent'][0] = {
    id: d.id,
    title: d.title,
    type: d.type,
    when: d.valid_from,
  };
  if (d.symbol_id) entry.symbol = d.symbol_id;
  if (d.file_path) entry.file = d.file_path;
  return entry;
}

/**
 * Assemble wake-up context for a project.
 * Returns ~300 tokens of critical orientation data.
 */
export function assembleWakeUp(
  decisionStore: DecisionStore,
  projectRoot: string,
  opts: {
    maxDecisions?: number;
  } = {},
): WakeUpContext {
  const maxDecisions = opts.maxDecisions ?? 10;

  // L1: Recent active decisions
  const recentDecisions = decisionStore.queryDecisions({
    project_root: projectRoot,
    limit: maxDecisions,
  });

  const activeCount = decisionStore.getStats(projectRoot).active;

  // L2: Memory stats
  const stats = decisionStore.getStats(projectRoot);
  const minedCount = decisionStore.getMinedSessionCount();
  const indexedSessions = decisionStore.getIndexedSessionIds(projectRoot);

  const result: WakeUpContext = {
    project: {
      name: path.basename(projectRoot),
      root: projectRoot,
    },
    decisions: {
      total_active: activeCount,
      recent: recentDecisions.map(compactDecision),
    },
    memory: {
      total_decisions: stats.total,
      sessions_mined: minedCount,
      sessions_indexed: indexedSessions.length,
      by_type: stats.by_type,
    },
    estimated_tokens: 0,
  };

  // Rough token estimation (1 token ≈ 4 chars of JSON)
  const jsonSize = JSON.stringify(result).length;
  result.estimated_tokens = Math.ceil(jsonSize / 4);

  return result;
}

// ════════════════════════════════════════════════════════════════════════
// SPLIT SHAPE (P1.4 — prompt-cache friendliness)
// ════════════════════════════════════════════════════════════════════════
//
// Clients that inject wake-up output into the system_prompt break their
// provider prompt cache on every turn, because `decisions.recent` rotates
// turn-to-turn. To fix that, expose the same data in two clearly-labelled
// regions:
//
//   stable  — project identity, conventions, architecture decisions, stats
//             (changes rarely; safe to put into the cacheable system slot)
//   dynamic — recent activity and work-in-progress signals
//             (changes per-turn; route into the user message instead)
//
// The legacy flat `WakeUpContext` is still produced by `assembleWakeUp`
// for back-compat. `assembleWakeUpSplit` is additive.

/** Compact decision entry shared by stable + dynamic regions. */
export interface WakeUpDecisionEntry {
  id: number;
  title: string;
  type: string;
  /** Linked symbol (if any) */
  symbol?: string;
  /** Linked file (if any) */
  file?: string;
  /** ISO timestamp when this decision became valid */
  when: string;
}

export interface WakeUpSplit {
  /**
   * Stable region — provider-cacheable. Inject into the system prompt slot.
   * Contents change rarely across turns within a session.
   */
  stable: {
    project: {
      name: string;
      root: string;
    };
    /** Top conventions (type='convention'). Long-lived guidance. */
    conventions: WakeUpDecisionEntry[];
    /** Top architecture decisions (type='architecture_decision'). Semi-stable. */
    architecture: WakeUpDecisionEntry[];
    /** Aggregate counts; do not vary per-turn. */
    stats: {
      total_active: number;
      total_decisions: number;
      sessions_mined: number;
      sessions_indexed: number;
      by_type: Record<string, number>;
    };
    /**
     * Top decision clusters (P1.1) — thematic L2 overlay over the decision
     * store. Surfaced in the stable region because cluster titles are
     * slow-moving topical labels that change only when the user re-runs
     * `build_decision_clusters`. Key is omitted entirely when no clusters
     * exist so the wake-up payload stays minimal for fresh projects.
     */
    topics?: Array<{ id: number; title: string; decision_count: number }>;
  };
  /**
   * Dynamic region — changes per-turn. Route into the user message slot so
   * it never busts the cached system prompt.
   */
  dynamic: {
    /**
     * Most-recent active decisions MINUS anything already surfaced in
     * `stable.conventions` or `stable.architecture` (no duplicates).
     */
    recent_decisions: WakeUpDecisionEntry[];
    /**
     * Active discoveries / tradeoffs / bug root causes from the last week —
     * the "work in flight" signal.
     */
    in_progress: WakeUpDecisionEntry[];
  };
  /** Approximate total token count across both regions. */
  estimated_tokens: number;
  /** Hint for downstream prompt assemblers. */
  _cache_hint: {
    inject_stable_into: 'system_prompt';
    inject_dynamic_into: 'user_message';
    rationale: string;
  };
}

/** Internal: per-section item caps for the split shape. */
const SPLIT_LIMITS = {
  conventions: 5,
  architecture: 5,
  recent: 5,
  in_progress: 5,
} as const;

/** Internal: window for the in_progress dynamic region. */
const IN_PROGRESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const IN_PROGRESS_TYPES: readonly DecisionType[] = ['discovery', 'tradeoff', 'bug_root_cause'];

/**
 * Assemble wake-up context split into stable + dynamic regions for
 * prompt-cache friendliness. See `WakeUpSplit` for the contract.
 *
 * No new database tables; this regroups what `assembleWakeUp` already
 * computes, just sliced into cache-friendly regions and de-duplicated
 * across sections.
 */
export function assembleWakeUpSplit(
  decisionStore: DecisionStore,
  projectRoot: string,
  opts: {
    maxRecent?: number;
    /**
     * Heat-aware ordering for the dynamic regions. When enabled,
     * `recent_decisions` and `in_progress` are sorted by computed heat (DESC)
     * before being capped. Stable regions are NOT reordered — they remain
     * type-grouped and recency-sorted to keep the cache stable.
     */
    heatEnabled?: boolean;
    heatHalfLifeDays?: number;
    heatFreshnessDays?: number;
  } = {},
): WakeUpSplit {
  const recentLimit = Math.min(opts.maxRecent ?? SPLIT_LIMITS.recent, 30);
  const heatEnabled = opts.heatEnabled === true;
  const heatNow = new Date();
  const heatParams = {
    now: heatNow,
    halfLifeDays: opts.heatHalfLifeDays,
    freshnessDays: opts.heatFreshnessDays,
  };
  const byHeatDesc = (a: DecisionRow, b: DecisionRow) => {
    const ha = computeHeat(
      { hit_count: a.hit_count ?? 0, last_hit_at: a.last_hit_at, created_at: a.created_at },
      heatParams,
    );
    const hb = computeHeat(
      { hit_count: b.hit_count ?? 0, last_hit_at: b.last_hit_at, created_at: b.created_at },
      heatParams,
    );
    if (hb !== ha) return hb - ha;
    return a.valid_from < b.valid_from ? 1 : a.valid_from > b.valid_from ? -1 : 0;
  };

  // Stable: conventions + architecture (high-signal, slow-moving).
  const conventionRows = decisionStore.queryDecisions({
    project_root: projectRoot,
    type: 'convention',
    limit: SPLIT_LIMITS.conventions,
  });
  const architectureRows = decisionStore.queryDecisions({
    project_root: projectRoot,
    type: 'architecture_decision',
    limit: SPLIT_LIMITS.architecture,
  });

  const conventions = conventionRows.map(compactDecision);
  const architecture = architectureRows.map(compactDecision);

  // Track IDs already surfaced in stable to avoid duplication in dynamic.
  const stableIds = new Set<number>();
  for (const d of conventionRows) stableIds.add(d.id);
  for (const d of architectureRows) stableIds.add(d.id);

  // Dynamic: in-progress — discovery/tradeoff/bug_root_cause from last 7d.
  // The store filters `as_of` to active rows; we additionally clamp by
  // valid_from on the client side because there is no created-since filter.
  // Compute in_progress first so we can also exclude its IDs from recent.
  const sinceIso = new Date(Date.now() - IN_PROGRESS_WINDOW_MS).toISOString();
  const inProgressRows: DecisionRow[] = [];
  for (const t of IN_PROGRESS_TYPES) {
    const rows = decisionStore.queryDecisions({
      project_root: projectRoot,
      type: t,
      limit: SPLIT_LIMITS.in_progress * 2,
    });
    for (const r of rows) {
      if (r.valid_from < sinceIso) continue;
      if (stableIds.has(r.id)) continue;
      inProgressRows.push(r);
    }
  }
  // When heat is enabled, dynamic regions surface by recall heat (DESC).
  // Otherwise keep the existing valid_from-DESC behaviour so older clients
  // see no change.
  if (heatEnabled) {
    inProgressRows.sort(byHeatDesc);
  } else {
    inProgressRows.sort((a, b) =>
      a.valid_from < b.valid_from ? 1 : a.valid_from > b.valid_from ? -1 : 0,
    );
  }
  const inProgressCapped = inProgressRows.slice(0, SPLIT_LIMITS.in_progress);
  const in_progress = inProgressCapped.map(compactDecision);

  // Recent now excludes both stable and in_progress IDs so each decision
  // surfaces in exactly one place.
  const dynamicSeen = new Set<number>(stableIds);
  for (const r of inProgressCapped) dynamicSeen.add(r.id);

  // Fetch a generous pool so the heat re-sort has room to reorder, then
  // filter + cap. When heat is enabled we pull a bigger pool because the
  // valid_from-ordered DB rows may not be the heat-ordered ones.
  const poolMultiplier = heatEnabled ? 5 : 1;
  const recentPool = decisionStore.queryDecisions({
    project_root: projectRoot,
    limit: Math.max(recentLimit + dynamicSeen.size, recentLimit * poolMultiplier),
  });
  const recentCandidates = recentPool.filter((d) => !dynamicSeen.has(d.id));
  if (heatEnabled) recentCandidates.sort(byHeatDesc);
  const recent_decisions: WakeUpDecisionEntry[] = recentCandidates
    .slice(0, recentLimit)
    .map(compactDecision);

  // Stable: stats (aggregate counters, do not move per-turn).
  const stats = decisionStore.getStats(projectRoot);
  const minedCount = decisionStore.getMinedSessionCount();
  const indexedSessions = decisionStore.getIndexedSessionIds(projectRoot);

  // Stable: top topics (P1.1 cluster overlay). Slow-moving topical labels —
  // safe for the cacheable region. Best-effort: if the cluster store is
  // unavailable (older databases on disk), silently skip.
  let topics: Array<{ id: number; title: string; decision_count: number }> | undefined;
  try {
    const clusters = decisionStore.listClusters({
      project_root: projectRoot,
      order_by: 'decision_count',
      limit: 5,
    });
    if (clusters.length > 0) {
      topics = clusters.map((c) => ({
        id: c.id,
        title: c.title,
        decision_count: c.decision_count,
      }));
    }
  } catch {
    /* cluster tables missing on legacy DB — silently skip */
  }

  // Token budget for the stable region: ~350 tokens is the soft ceiling.
  // When topics push us over, drop lowest-priority conventions one at a
  // time. We never drop architecture/stats/project — those are the always-
  // cacheable identity bits.
  const STABLE_TOKEN_CEILING = 350;
  const stableConventions = [...conventions];
  const buildStable = () => ({
    project: {
      name: path.basename(projectRoot),
      root: projectRoot,
    },
    conventions: stableConventions,
    architecture,
    stats: {
      total_active: stats.active,
      total_decisions: stats.total,
      sessions_mined: minedCount,
      sessions_indexed: indexedSessions.length,
      by_type: stats.by_type,
    },
    ...(topics ? { topics } : {}),
  });
  const stableTokens = () => Math.ceil(JSON.stringify(buildStable()).length / 4);
  while (stableTokens() > STABLE_TOKEN_CEILING && stableConventions.length > 0) {
    stableConventions.pop();
  }

  const result: WakeUpSplit = {
    stable: buildStable(),
    dynamic: {
      recent_decisions,
      in_progress,
    },
    estimated_tokens: 0,
    _cache_hint: {
      inject_stable_into: 'system_prompt',
      inject_dynamic_into: 'user_message',
      rationale:
        'Stable content is provider-cacheable; dynamic content changes per-turn and must not bust the system-prompt cache.',
    },
  };

  // Rough token estimation (1 token ≈ 4 chars of JSON).
  const jsonSize = JSON.stringify(result).length;
  result.estimated_tokens = Math.ceil(jsonSize / 4);

  return result;
}
