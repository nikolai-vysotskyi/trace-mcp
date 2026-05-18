/**
 * stages.ts — pure async functions that advance one rung of the memory
 * pyramid for a single project. Easy to unit-test against fake stores +
 * fake providers; the background scheduler glues them together.
 *
 * Each stage returns a small structured result so the scheduler can log
 * usefully and drive the threshold-based triggers. Failures NEVER throw
 * past these functions — they return `{ ok: false, error }` so the
 * scheduler's serial queue stays alive.
 */

import path from 'node:path';
import type { AIProvider, InferenceService } from '../../ai/interfaces.js';
import { logger } from '../../logger.js';
import { clusterDecisions, type ClusterCandidate } from '../decision-clusterer.js';
import { mineSessions, type LlmMiningContext, type MineStrategy } from '../conversation-miner.js';
import type { DecisionRow, DecisionStore } from '../decision-store.js';
import { generateProjectMemo } from '../project-memo.js';

// ════════════════════════════════════════════════════════════════════════
// SHARED TYPES
// ════════════════════════════════════════════════════════════════════════

export interface StageBase {
  decisionStore: DecisionStore;
  projectRoot: string;
}

export interface StageAiAvailable {
  /**
   * Cached AI provider for this project. When omitted the stage that
   * requires an LLM is treated as unavailable and skipped (returns
   * `{ ok: false, skipped: 'no-ai-provider' }`).
   */
  aiProvider?: AIProvider | null;
  /** Model identifier passed to the inference service. */
  inferenceModel?: string;
  /** Optional abort signal forwarded to the inference call. */
  abortSignal?: AbortSignal;
}

export interface StageResult {
  ok: boolean;
  skipped?: string;
  error?: string;
  durationMs: number;
}

// ════════════════════════════════════════════════════════════════════════
// STAGE A — MINE
// ════════════════════════════════════════════════════════════════════════

export interface MineStageOptions extends StageBase, StageAiAvailable {
  /** Strategy resolved from config.memory.mining.strategy. Defaults to 'regex'. */
  strategy?: MineStrategy;
}

export interface MineStageResult extends StageResult {
  /** Sessions scanned/mined/skipped. Surfaced for diagnostics. */
  scanned?: number;
  mined?: number;
  /** Decisions persisted by this run (auto-approved + queued for review). */
  added?: number;
}

/**
 * Stage A — mine session logs for new decisions.
 *
 * Always callable, even without an AI provider: the regex strategy is the
 * default and works offline. When `strategy='llm'` or `'hybrid'` and the
 * AI provider is missing, `mineSessions` itself falls back to regex with
 * a warning — we honour that behaviour.
 */
export async function runMineStage(opts: MineStageOptions): Promise<MineStageResult> {
  const start = Date.now();
  const strategy: MineStrategy = opts.strategy ?? 'regex';
  let llmContext: LlmMiningContext | undefined;
  if ((strategy === 'llm' || strategy === 'hybrid') && opts.aiProvider) {
    try {
      const inference = opts.aiProvider.inference();
      if (inference) {
        llmContext = {
          inference,
          model: opts.inferenceModel ?? 'default',
        };
      }
    } catch (err) {
      logger.warn(
        { projectRoot: opts.projectRoot, err: (err as Error)?.message ?? String(err) },
        'memory-scheduler: failed to resolve inference for mine stage — falling back to regex',
      );
    }
  }
  try {
    const result = await mineSessions(opts.decisionStore, {
      projectRoot: opts.projectRoot,
      strategy,
      llmContext,
      signal: opts.abortSignal,
    });
    return {
      ok: true,
      scanned: result.sessions_scanned,
      mined: result.sessions_mined,
      added: result.decisions_extracted,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    logger.warn({ projectRoot: opts.projectRoot, error }, 'memory-scheduler: mine stage failed');
    return { ok: false, error, durationMs: Date.now() - start };
  }
}

// ════════════════════════════════════════════════════════════════════════
// STAGE B — CLUSTER
// ════════════════════════════════════════════════════════════════════════

export interface ClusterStageOptions extends StageBase, StageAiAvailable {
  /** Max decisions to feed the clusterer in one call. Default 200. */
  maxDecisionsPerRun?: number;
}

export interface ClusterStageResult extends StageResult {
  /** Number of new + updated clusters produced. */
  created?: number;
  updated?: number;
  /** Total clusters returned by the LLM after filtering. */
  candidates?: number;
}

/**
 * Stage B — cluster recent decisions into thematic groups.
 *
 * Requires an AI provider; skipped (with `skipped: 'no-ai-provider'`) when
 * unavailable. Merges into existing clusters when a recomputed cluster
 * shares ≥50% of its decision ids with an existing one — otherwise creates
 * a fresh cluster.
 */
export async function runClusterStage(opts: ClusterStageOptions): Promise<ClusterStageResult> {
  const start = Date.now();
  if (!opts.aiProvider) {
    return { ok: false, skipped: 'no-ai-provider', durationMs: Date.now() - start };
  }
  let inference: InferenceService;
  try {
    inference = opts.aiProvider.inference();
  } catch (err) {
    return {
      ok: false,
      skipped: 'no-ai-provider',
      error: (err as Error)?.message ?? String(err),
      durationMs: Date.now() - start,
    };
  }
  if (!inference) {
    return { ok: false, skipped: 'no-ai-provider', durationMs: Date.now() - start };
  }

  // Pull active, recent decisions for the project. Cap input to keep
  // prompt size bounded — the clusterer also has its own caps.
  const maxDecisions = Math.max(10, Math.min(opts.maxDecisionsPerRun ?? 200, 500));
  let decisions: DecisionRow[];
  try {
    decisions = opts.decisionStore.queryDecisions({
      project_root: opts.projectRoot,
      include_invalidated: false,
      limit: maxDecisions,
    });
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    logger.warn(
      { projectRoot: opts.projectRoot, error },
      'memory-scheduler: cluster stage — failed to query decisions',
    );
    return { ok: false, error, durationMs: Date.now() - start };
  }
  if (decisions.length === 0) {
    return { ok: true, created: 0, updated: 0, candidates: 0, durationMs: Date.now() - start };
  }

  let candidates: ClusterCandidate[];
  try {
    candidates = await clusterDecisions({
      decisions,
      provider: inference,
      model: opts.inferenceModel ?? 'default',
      signal: opts.abortSignal,
    });
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    logger.warn(
      { projectRoot: opts.projectRoot, error },
      'memory-scheduler: cluster stage — clusterDecisions failed',
    );
    return { ok: false, error, durationMs: Date.now() - start };
  }

  // Persist: try to merge each candidate into an overlapping existing
  // cluster, otherwise create new. Cluster persistence is a small write
  // surface — any single failure is logged and the rest still apply.
  let created = 0;
  let updated = 0;
  let existing: Awaited<ReturnType<DecisionStore['listClusters']>> = [];
  try {
    existing = opts.decisionStore.listClusters({ project_root: opts.projectRoot });
  } catch (err) {
    logger.warn(
      { projectRoot: opts.projectRoot, err: (err as Error)?.message ?? String(err) },
      'memory-scheduler: cluster stage — listClusters failed; treating as empty',
    );
  }

  for (const cand of candidates) {
    if (cand.decision_ids.length === 0) continue;
    const candIds = new Set(cand.decision_ids);
    let mergeTarget: (typeof existing)[number] | undefined;
    let bestOverlap = 0;
    for (const ex of existing) {
      let memberIds: number[] = [];
      try {
        const members = opts.decisionStore.getClusterDecisions(ex.id);
        memberIds = members.map((m) => m.id);
      } catch {
        continue;
      }
      const intersection = memberIds.filter((id) => candIds.has(id)).length;
      const denom = Math.max(memberIds.length, cand.decision_ids.length);
      if (denom === 0) continue;
      const overlap = intersection / denom;
      if (overlap >= 0.5 && overlap > bestOverlap) {
        bestOverlap = overlap;
        mergeTarget = ex;
      }
    }
    try {
      if (mergeTarget) {
        opts.decisionStore.updateCluster(mergeTarget.id, {
          title: cand.title,
          summary: cand.summary,
          tags: cand.tags,
          primary_type: cand.primary_type ?? null,
          decision_ids: cand.decision_ids,
        });
        updated++;
      } else {
        opts.decisionStore.createCluster({
          project_root: opts.projectRoot,
          title: cand.title,
          summary: cand.summary,
          tags: cand.tags,
          primary_type: cand.primary_type,
          decision_ids: cand.decision_ids,
        });
        created++;
      }
    } catch (err) {
      logger.warn(
        { projectRoot: opts.projectRoot, err: (err as Error)?.message ?? String(err) },
        'memory-scheduler: cluster stage — persist failed for one cluster',
      );
    }
  }

  return {
    ok: true,
    created,
    updated,
    candidates: candidates.length,
    durationMs: Date.now() - start,
  };
}

// ════════════════════════════════════════════════════════════════════════
// STAGE C — MEMO
// ════════════════════════════════════════════════════════════════════════

export interface MemoStageOptions extends StageBase, StageAiAvailable {
  /** Project memo target length. Defaults to memory.memo.targetTokens. */
  targetTokens?: number;
}

export interface MemoStageResult extends StageResult {
  /** True when a fresh memo was generated and persisted. */
  regenerated?: boolean;
  /** Token estimate of the persisted memo. */
  tokens?: number;
}

/**
 * Stage C — regenerate the project memo.
 *
 * Skipped when no AI provider. Pulls the freshest decisions + top
 * clusters in scope, generates the memo, and saves it. The threshold
 * trigger lives in the scheduler — this function is unconditional.
 */
export async function runMemoStage(opts: MemoStageOptions): Promise<MemoStageResult> {
  const start = Date.now();
  if (!opts.aiProvider) {
    return { ok: false, skipped: 'no-ai-provider', durationMs: Date.now() - start };
  }
  let inference: InferenceService;
  try {
    inference = opts.aiProvider.inference();
  } catch (err) {
    return {
      ok: false,
      skipped: 'no-ai-provider',
      error: (err as Error)?.message ?? String(err),
      durationMs: Date.now() - start,
    };
  }
  if (!inference) {
    return { ok: false, skipped: 'no-ai-provider', durationMs: Date.now() - start };
  }

  let decisions: DecisionRow[];
  try {
    decisions = opts.decisionStore.queryDecisions({
      project_root: opts.projectRoot,
      include_invalidated: false,
      limit: 200,
    });
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    return { ok: false, error, durationMs: Date.now() - start };
  }
  const clusters = (() => {
    try {
      return opts.decisionStore.listClusters({ project_root: opts.projectRoot });
    } catch {
      return [];
    }
  })();

  if (decisions.length === 0) {
    // Nothing to memo. Treat as "skip, not failure" so consecutive
    // failure counters don't trip on empty projects.
    return { ok: true, regenerated: false, durationMs: Date.now() - start };
  }

  const projectName = path.basename(opts.projectRoot) || opts.projectRoot;

  let memoResult: { memo_md: string; estimated_tokens: number };
  try {
    memoResult = await generateProjectMemo(
      {
        decisions,
        clusters,
        project_name: projectName,
      },
      {
        provider: inference,
        model: opts.inferenceModel ?? 'default',
        targetTokens: opts.targetTokens,
        abortSignal: opts.abortSignal,
      },
    );
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    logger.warn(
      { projectRoot: opts.projectRoot, error },
      'memory-scheduler: memo stage — generateProjectMemo failed',
    );
    return { ok: false, error, durationMs: Date.now() - start };
  }

  if (!memoResult.memo_md.trim()) {
    // Provider returned empty — treat as a skip, not a hard failure.
    return { ok: true, regenerated: false, durationMs: Date.now() - start };
  }

  try {
    // Latest decision id helps countDecisionsSinceLastMemo on the next
    // tick. Decisions came back ordered by created_at desc by default —
    // pick the max id to be safe regardless of ordering.
    const lastDecisionId = decisions.reduce((max, d) => (d.id > max ? d.id : max), 0);
    opts.decisionStore.saveProjectMemo({
      project_root: opts.projectRoot,
      memo_md: memoResult.memo_md,
      model: opts.inferenceModel ?? 'default',
      last_decision_id: lastDecisionId || undefined,
      decisions_at_generation: decisions.length,
      clusters_at_generation: clusters.length,
      estimated_tokens: memoResult.estimated_tokens,
    });
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    logger.warn(
      { projectRoot: opts.projectRoot, error },
      'memory-scheduler: memo stage — saveProjectMemo failed',
    );
    return { ok: false, error, durationMs: Date.now() - start };
  }

  return {
    ok: true,
    regenerated: true,
    tokens: memoResult.estimated_tokens,
    durationMs: Date.now() - start,
  };
}
