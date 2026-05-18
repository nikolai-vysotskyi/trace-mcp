/**
 * plan_turn — Opening-move router for AI agents.
 *
 * Combines BM25/PageRank search + session journal (negative evidence + focus signals)
 * + framework-aware insertion-point suggestions + change-risk assessment + turn-budget
 * advisor into a single routing call. Designed to be the FIRST tool an agent calls
 * on a new task, so it can decide whether to read existing code, modify it, or
 * scaffold something new — without blind grep/Read chains.
 *
 * Returns:
 *   verdict: 'exists' | 'partial' | 'missing' | 'ambiguous'
 *   confidence: 0..1
 *   targets[]: ranked symbols with `why` provenance + per-target risk
 *   insertion_points[]: framework-aware scaffold hints when verdict ∈ {missing, partial}
 *   prior_negative[]: dead-end queries from this session — don't re-search
 *   budget: turn budget level + actionable advice
 *   next_actions[]: recommended follow-up tool calls
 */

import type { EmbeddingService, RerankerService, VectorStore } from '../../ai/interfaces.js';
import type { Store } from '../../db/store.js';
import type { PluginRegistry } from '../../plugin-api/registry.js';
import type { SavingsTracker } from '../../savings.js';
import type { SessionJournal } from '../../session/journal.js';
import { assessChangeRisk } from '../analysis/predictive-intelligence.js';
import { tokenizeDescription } from './context.js';
import { type InsertionPoint, suggestInsertionPoints } from './insertion-points.js';
import { search } from './navigation.js';
import { searchText } from './search-text.js';
import { classifyIntent } from './task-context.js';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type PlanVerdict = 'exists' | 'partial' | 'missing' | 'ambiguous';

export interface PlanTurnOptions {
  task: string;
  /** Optional intent override; auto-classified from task if omitted */
  intent?: 'bugfix' | 'new_feature' | 'refactor' | 'understand';
  /** Cap on number of returned targets (default 5) */
  maxTargets?: number;
  /** Skip risk assessment even when intent would normally trigger it */
  skipRisk?: boolean;
}

export interface PlanTurnTarget {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  score: number;
  /** Provenance: which signals contributed to this ranking */
  why: string[];
  /** Source of this target — 'symbol' (default) or 'text_fallback' when surfaced via raw text search */
  source?: 'symbol' | 'text_fallback';
  /** Code snippet for text_fallback targets (matched line text) */
  snippet?: string;
  risk?: { level: 'low' | 'medium' | 'high' | 'critical'; score: number; mitigations: string[] };
}

export interface PlanTurnPriorNegative {
  query: string;
  reason: string;
}

export interface PlanTurnBudget {
  calls_used: number;
  raw_tokens: number;
  level: 'none' | 'info' | 'warning' | 'critical';
  advice: string;
}

export interface PlanTurnNextAction {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface PlanTurnResult {
  task: string;
  intent: 'bugfix' | 'new_feature' | 'refactor' | 'understand';
  verdict: PlanVerdict;
  confidence: number;
  reasoning: string;
  targets: PlanTurnTarget[];
  insertion_points: InsertionPoint[];
  prior_negative: PlanTurnPriorNegative[];
  budget: PlanTurnBudget;
  next_actions: PlanTurnNextAction[];
}

export interface PlanTurnContext {
  store: Store;
  projectRoot: string;
  journal: SessionJournal;
  savings: SavingsTracker;
  registry: PluginRegistry;
  has: (...names: string[]) => boolean;
  ai?: {
    vectorStore?: VectorStore | null;
    embeddingService?: EmbeddingService | null;
    reranker?: RerankerService | null;
  };
}

// ═══════════════════════════════════════════════════════════════════
// CORE
// ═══════════════════════════════════════════════════════════════════

const VERDICT_HIGH_THRESHOLD = 0.4;
const VERDICT_LOW_THRESHOLD = 0.15;
const AMBIGUOUS_TIE_RATIO = 0.92;
const SESSION_FOCUS_BOOST = 0.1;
const PRIOR_NEGATIVE_BOOST = -0.5;

export async function planTurn(
  ctx: PlanTurnContext,
  opts: PlanTurnOptions,
): Promise<PlanTurnResult> {
  const task = (opts.task ?? '').trim();
  const intent = opts.intent ?? classifyIntent(task);
  const maxTargets = Math.max(1, Math.min(opts.maxTargets ?? 5, 20));

  // Empty task → bail with explicit "missing" verdict
  if (!task) {
    return {
      task,
      intent,
      verdict: 'missing',
      confidence: 1,
      reasoning: 'Empty task description.',
      targets: [],
      insertion_points: [],
      prior_negative: [],
      budget: computeBudget(ctx.savings),
      next_actions: [],
    };
  }

  // 1. Search via the standard hybrid pipeline (BM25/AI + PageRank + recency)
  const searchResult = await search(
    ctx.store,
    task,
    undefined,
    Math.max(maxTargets * 4, 20),
    0,
    ctx.ai
      ? {
          vectorStore: ctx.ai.vectorStore ?? null,
          embeddingService: ctx.ai.embeddingService ?? null,
          reranker: ctx.ai.reranker ?? null,
        }
      : undefined,
  );

  // 2. Pull session signals
  const summary = ctx.journal.getSummary();
  const sessionFiles = new Set(summary.files_read);

  // 3. Prior negative evidence — zero-result searches whose tokens overlap with this task
  const taskTokens = new Set(tokenizeDescription(task).map((t) => t.toLowerCase()));
  const priorNegative: PlanTurnPriorNegative[] = [];
  let priorNegativeMatched = false;
  for (const negQuery of summary.searches_with_zero_results) {
    const negTokens = tokenizeDescription(negQuery).map((t) => t.toLowerCase());
    const overlap = negTokens.filter((t) => taskTokens.has(t)).length;
    if (overlap >= 1) {
      priorNegative.push({
        query: negQuery,
        reason: `${overlap} overlapping token(s) — already returned 0 results this session`,
      });
      // Strong overlap (>=2 tokens) is a serious negative signal
      if (overlap >= 2) priorNegativeMatched = true;
    }
  }

  // 4. Score & re-rank with session-focus boost; build targets
  const items = searchResult.items.slice(0, maxTargets * 2);
  const ranked: Array<{ item: (typeof items)[number]; score: number; why: string[] }> = [];

  for (const item of items) {
    let score = item.score;
    const why: string[] = [
      searchResult.search_mode === 'hybrid_ai' ? 'hybrid_ai' : 'bm25',
      'pagerank',
    ];
    if (sessionFiles.has(item.file.path)) {
      score += SESSION_FOCUS_BOOST;
      why.push('session_focus');
    }
    if (priorNegativeMatched) {
      score += PRIOR_NEGATIVE_BOOST;
      why.push('prior_negative_penalty');
    }
    ranked.push({ item, score, why });
  }
  ranked.sort((a, b) => b.score - a.score);

  // 5. Verdict computation
  const top = ranked[0];
  const second = ranked[1];
  const topScore = top?.score ?? 0;
  let verdict: PlanVerdict;
  let confidence: number;
  let reasoning: string;

  if (priorNegativeMatched && topScore < VERDICT_HIGH_THRESHOLD) {
    verdict = 'missing';
    confidence = 0.85;
    reasoning = 'Prior negative evidence: a similar query already returned 0 results this session.';
  } else if (ranked.length === 0 || topScore < VERDICT_LOW_THRESHOLD) {
    verdict = 'missing';
    confidence = ranked.length === 0 ? 0.9 : 0.7;
    reasoning =
      ranked.length === 0
        ? 'No symbols match this task in the indexed codebase.'
        : `Best match scored ${topScore.toFixed(2)} — below the existence threshold (${VERDICT_LOW_THRESHOLD}).`;
  } else if (topScore < VERDICT_HIGH_THRESHOLD) {
    verdict = 'partial';
    confidence = 0.5 + topScore;
    reasoning = `Weak match (top score ${topScore.toFixed(2)}). Likely related code exists but the exact target is uncertain.`;
  } else if (second && second.score / topScore >= AMBIGUOUS_TIE_RATIO) {
    verdict = 'ambiguous';
    confidence = 0.6;
    reasoning = `Top ${countTied(ranked)} candidates score within ${Math.round((1 - AMBIGUOUS_TIE_RATIO) * 100)}% of each other — disambiguation needed.`;
  } else {
    verdict = 'exists';
    confidence = Math.min(0.95, 0.5 + topScore / 2);
    reasoning = `Strong match (top score ${topScore.toFixed(2)}, ${Math.round(((topScore - (second?.score ?? 0)) / topScore) * 100)}% ahead of runner-up).`;
  }

  // 6. Build target list with optional risk assessment
  const targets: PlanTurnTarget[] = [];
  const wantRisk = !opts.skipRisk && (intent === 'bugfix' || intent === 'refactor');
  for (let i = 0; i < Math.min(ranked.length, maxTargets); i++) {
    const { item, score, why } = ranked[i];
    const target: PlanTurnTarget = {
      symbol_id: item.symbol.symbol_id,
      name: item.symbol.name,
      kind: item.symbol.kind,
      file: item.file.path,
      line: item.symbol.line_start ?? 0,
      score: round(score),
      why,
      source: 'symbol',
    };
    // Only assess risk for the top target — risk computation is expensive
    if (wantRisk && i === 0) {
      const risk = assessChangeRisk(ctx.store, ctx.projectRoot, { filePath: item.file.path });
      if (risk.isOk()) {
        target.risk = {
          level: risk.value.risk_level,
          score: risk.value.risk_score,
          mitigations: risk.value.mitigations,
        };
      }
    }
    targets.push(target);
  }

  // 6b. Text-fallback rescue — if symbol search produced no targets but a raw
  // text scan finds hits (TODO comments, doc strings, example strings, etc.),
  // demote 'missing' to 'partial' and surface the file/line/snippet evidence.
  // This breaks the false-negative loop where plan_turn tells the agent to
  // stop looking when relevant code actually exists.
  if (verdict === 'missing' && targets.length === 0) {
    const textRescue = rescueViaTextFallback(ctx, task, maxTargets);
    if (textRescue.length > 0) {
      for (const t of textRescue) targets.push(t);
      verdict = 'partial';
      confidence = Math.min(confidence, 0.5);
      reasoning = `Symbol search found no matches, but raw text scan found ${textRescue.length} reference(s). Relevant code may exist — inspect the listed file/line targets before scaffolding new code.`;
      // Compute risk for the top text-fallback target too — refactor/bugfix
      // intents benefit from a risk signal even when the target came from FTS
      // rather than the symbol graph.
      if (wantRisk && targets[0] && !targets[0].risk) {
        const risk = assessChangeRisk(ctx.store, ctx.projectRoot, {
          filePath: targets[0].file,
        });
        if (risk.isOk()) {
          targets[0].risk = {
            level: risk.value.risk_level,
            score: risk.value.risk_score,
            mitigations: risk.value.mitigations,
          };
        }
      }
    }
  }
  // Safety net: never report 'missing' while holding targets — that contradicts
  // the verdict and is the exact failure plan_turn is supposed to prevent.
  if (verdict === 'missing' && targets.length > 0) {
    verdict = 'partial';
  }

  // 7. Insertion points for missing/partial — framework-aware scaffolds
  const insertionPoints =
    (verdict === 'missing' || verdict === 'partial') && intent === 'new_feature'
      ? suggestInsertionPoints(ctx, task, targets)
      : [];

  // 8. Budget advisor
  const budget = computeBudget(ctx.savings);

  // 9. Next actions
  const nextActions = buildNextActions(verdict, intent, targets, insertionPoints);

  return {
    task,
    intent,
    verdict,
    confidence: round(confidence),
    reasoning,
    targets,
    insertion_points: insertionPoints,
    prior_negative: priorNegative.slice(0, 5),
    budget,
    next_actions: nextActions,
  };
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Stopword list used by extractKeyNouns. These are imperative-task verbs and
 * generic glue words that should never drive related-decision matching: a
 * decision about "domain classification" should NOT match the task "add a
 * webhook endpoint" just because both share the word "add" or "endpoint".
 */
const PLAN_TURN_STOPWORDS = new Set<string>([
  'a',
  'an',
  'the',
  'to',
  'for',
  'with',
  'and',
  'or',
  'of',
  'in',
  'on',
  'add',
  'remove',
  'fix',
  'create',
  'build',
  'make',
  'endpoint',
  'function',
  'method',
  'class',
  'file',
  'code',
  'new',
]);

/**
 * Lowercase the input, split on non-word chars, drop stopwords and very short
 * tokens. Returns the remaining "key nouns" — the domain words that should
 * gate related-decision matching.
 */
export function extractKeyNouns(s: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 4 && !PLAN_TURN_STOPWORDS.has(w));
}

/**
 * Filter a list of decision rows so only ones whose title+content overlaps
 * with the task's key nouns survive. Empty noun list = no filter (preserves
 * legacy behavior when the task is all stopwords).
 */
export function filterDecisionsByTaskNouns<T extends { title?: string; content?: string }>(
  decisions: T[],
  task: string,
): T[] {
  const taskNouns = extractKeyNouns(task);
  if (taskNouns.length === 0) return decisions;
  return decisions.filter((d) => {
    const haystack = `${d.title ?? ''} ${d.content ?? ''}`.toLowerCase();
    return taskNouns.some((n) => haystack.includes(n));
  });
}

/**
 * When symbol-based search returns 0 items, run a bounded raw text scan over
 * the indexed files and project the top matches into PlanTurnTarget shape.
 * Tracks the originating file/line/snippet so the agent can drill in.
 */
function rescueViaTextFallback(
  ctx: PlanTurnContext,
  task: string,
  maxTargets: number,
): PlanTurnTarget[] {
  // Use the most-specific key noun (longest) as the text-scan query. Stripping
  // stopwords avoids matching every TODO / comment that contains "add" or "fix".
  const nouns = extractKeyNouns(task);
  if (nouns.length === 0) return [];
  const query = nouns.sort((a, b) => b.length - a.length)[0];

  const res = searchText(ctx.store, ctx.projectRoot, {
    query,
    maxResults: Math.max(maxTargets, 10),
    contextLines: 1,
    caseSensitive: false,
  });
  if (res.isErr()) return [];
  const matches = res.value.matches;
  if (matches.length === 0) return [];

  const out: PlanTurnTarget[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const dedupKey = `${m.file}:${m.line}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({
      symbol_id: `${m.file}:${m.line}`,
      name: m.match || query,
      kind: 'text_match',
      file: m.file,
      line: m.line,
      score: 0.2,
      why: ['text_fallback'],
      source: 'text_fallback',
      snippet: m.match || m.context?.[Math.floor(m.context.length / 2)] || '',
    });
    if (out.length >= maxTargets) break;
  }
  return out;
}

function countTied(ranked: Array<{ score: number }>): number {
  if (ranked.length === 0) return 0;
  const top = ranked[0].score;
  let n = 0;
  for (const r of ranked) {
    if (r.score / top >= AMBIGUOUS_TIE_RATIO) n++;
    else break;
  }
  return n;
}

function computeBudget(savings: SavingsTracker): PlanTurnBudget {
  const stats = savings.getSessionStats();
  const calls = stats.total_calls;
  const tokens = stats.total_raw_tokens;
  let level: PlanTurnBudget['level'] = 'none';
  let advice = 'Budget healthy — proceed with normal exploration.';
  if (calls >= 50 || tokens >= 200_000) {
    level = 'critical';
    advice = `Critical: ${calls} calls / ~${tokens} tokens. Use only targeted get_symbol + batch from here. Avoid broad search/exploration.`;
  } else if (calls >= 30 || tokens >= 100_000) {
    level = 'warning';
    advice = `Warning: ${calls} calls / ~${tokens} tokens. Switch to batch + get_task_context to consolidate queries.`;
  } else if (calls >= 15 || tokens >= 50_000) {
    level = 'info';
    advice = `Info: ${calls} calls / ~${tokens} tokens. Consider get_task_context instead of chained search→get_symbol.`;
  }
  return { calls_used: calls, raw_tokens: tokens, level, advice };
}

function buildNextActions(
  verdict: PlanVerdict,
  intent: 'bugfix' | 'new_feature' | 'refactor' | 'understand',
  targets: PlanTurnTarget[],
  insertionPoints: InsertionPoint[],
): PlanTurnNextAction[] {
  const actions: PlanTurnNextAction[] = [];
  const top = targets[0];

  if (verdict === 'missing') {
    if (insertionPoints.length > 0) {
      const point = insertionPoints[0];
      actions.push({
        tool: 'get_outline',
        args: { path: point.file },
        reason: `Inspect insertion-point parent file before scaffolding (${point.framework})`,
      });
    } else {
      actions.push({
        tool: 'get_task_context',
        args: { task: 'where to add this feature' },
        reason: 'No clear target — use task context to find a related anchor file',
      });
    }
    return actions;
  }

  if (!top) return actions;

  if (verdict === 'ambiguous') {
    actions.push({
      tool: 'find_usages',
      args: { symbol_id: top.symbol_id },
      reason: 'Multiple candidates tied — usage patterns will reveal the right one',
    });
    actions.push({
      tool: 'get_type_hierarchy',
      args: { symbol_id: top.symbol_id },
      reason: 'Disambiguate via interface/extends relationships',
    });
    return actions;
  }

  // exists / partial
  if (intent === 'understand') {
    actions.push({
      tool: 'get_symbol',
      args: { symbol_id: top.symbol_id },
      reason: 'Read top match source',
    });
    actions.push({
      tool: 'get_call_graph',
      args: { symbol_id: top.symbol_id, direction: 'both' },
      reason: 'Understand callers and callees',
    });
  } else if (intent === 'bugfix' || intent === 'refactor') {
    actions.push({
      tool: 'get_change_impact',
      args: { symbol_id: top.symbol_id },
      reason: 'Know the blast radius before editing',
    });
    actions.push({
      tool: 'get_tests_for',
      args: { symbol_id: top.symbol_id },
      reason: 'Find existing tests to extend or run',
    });
    actions.push({
      tool: 'get_symbol',
      args: { symbol_id: top.symbol_id },
      reason: 'Read the source you intend to modify',
    });
  } else {
    // new_feature with partial match
    actions.push({
      tool: 'get_symbol',
      args: { symbol_id: top.symbol_id },
      reason: 'Read the closest existing implementation as a template',
    });
  }

  return actions;
}
