/**
 * Decision Clusterer — LLM-driven thematic grouping over the decision store.
 *
 * The L1 layer (raw decisions) becomes unhelpful past a few hundred rows: a
 * flat `query_decisions` returns walls of titles with no topical structure.
 * Clusters add an L2 thematic layer: short noun-phrase labels + 1-3 sentence
 * summaries that turn a flat list into a navigable map ("what do we have on
 * auth?", "what's our deployment thinking?").
 *
 * Privacy
 * ───────
 * The LLM input is a SANITISED projection of each decision: id + title + type
 * + tags + first line of `content`. Full content (which can carry code
 * references / file paths / PII) is never sent. The clustering output never
 * fabricates new content — it only re-organises titles into topical groups.
 *
 * Robustness
 * ──────────
 * - Output parsed as strict JSON; malformed entries are dropped individually
 *   without sinking the whole call.
 * - Each cluster's `decision_ids` is intersected with the input id set; the
 *   LLM cannot invent ids that didn't exist.
 * - Clusters whose intersected member set falls below
 *   `minDecisionsPerCluster` are dropped (singletons stay uncategorised).
 * - `clusterDecisions` never throws on a bad LLM response; it returns an
 *   empty array.
 */

import { logger } from '../logger.js';
import type { InferenceService } from '../ai/interfaces.js';
import type { DecisionRow, DecisionType } from './decision-types.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

const DECISION_TYPE_SET = new Set<DecisionType>([
  'architecture_decision',
  'tech_choice',
  'bug_root_cause',
  'preference',
  'tradeoff',
  'discovery',
  'convention',
]);

export interface ClusterCandidate {
  /** Short noun phrase, 3-8 words. */
  title: string;
  /** 1-3 sentences describing the cluster's thrust. */
  summary: string;
  /** 2-5 kebab-case topical labels. */
  tags: string[];
  /** Decision ids that belong in this cluster. Always a subset of the input. */
  decision_ids: number[];
  /** Most common DecisionType inside the cluster, when one dominates. */
  primary_type?: DecisionType;
}

export interface ClusterDecisionsOptions {
  /** Input set to cluster — caller is responsible for filtering / paginating. */
  decisions: DecisionRow[];
  /** Active inference service — usually `ctx.aiProvider.inference()`. */
  provider: InferenceService;
  /** Model identifier, used for structured logging. */
  model: string;
  /** Hard cap on returned clusters. Default 8. */
  maxClusters?: number;
  /** Minimum members per cluster; smaller groups are dropped. Default 2. */
  minDecisionsPerCluster?: number;
  /** Optional abort signal forwarded to the inference call. */
  signal?: AbortSignal;
}

// ════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════

/** Hard cap on how many decisions we'll send to the LLM in a single shot.
 *  Beyond this we pre-group by `type` and cluster within each type so the
 *  prompt stays bounded. */
const SINGLE_SHOT_MAX = 20;

/** Absolute upper bound on input rows per provider call after pre-grouping.
 *  Protects against runaway prompts in projects with massive decision stores. */
const PER_CALL_MAX = 100;

/** Truncate per-decision `content` projection at this many chars. Privacy +
 *  prompt size guard — full bodies never reach the LLM. */
const CONTENT_PREVIEW_CHARS = 160;

const SYSTEM_PROMPT = `You are organising architectural decisions into topical clusters.

Input is a JSON array of {id, title, type, tags, summary} objects. Group decisions that share a topical concern (e.g. "authentication", "deployment", "data modelling").

Rules:
- Produce at most {{MAX_CLUSTERS}} non-overlapping clusters. Each decision belongs to exactly one cluster, or to none (do not list singletons below {{MIN_PER_CLUSTER}} members).
- title: short noun phrase, 3-8 words. No trailing punctuation.
- summary: 1-3 sentences describing what this cluster covers and any common thrust. <=400 chars.
- tags: 2-5 kebab-case topical labels.
- decision_ids: integer array, only ids that appear in the input.
- primary_type: the most common decision type inside the cluster, if one dominates; omit otherwise. One of: architecture_decision, tech_choice, bug_root_cause, preference, tradeoff, discovery, convention.
- Return STRICT JSON: an array of cluster objects only, no prose. Empty array if no clusters are warranted.`;

// ════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════

/**
 * Cluster a set of decisions into thematic groups via the configured LLM.
 *
 * Returns an empty array — never throws — on:
 *   - empty input
 *   - inference call failing
 *   - LLM output not being parseable JSON
 *   - all clusters falling below `minDecisionsPerCluster`
 */
export async function clusterDecisions(opts: ClusterDecisionsOptions): Promise<ClusterCandidate[]> {
  const { decisions, provider, model, signal } = opts;
  const maxClusters = Math.max(1, Math.min(opts.maxClusters ?? 8, 20));
  const minPerCluster = Math.max(2, Math.min(opts.minDecisionsPerCluster ?? 2, 10));

  if (decisions.length === 0) return [];

  // Build the id-validity set once; the LLM might hallucinate ids and we
  // intersect against this on parse.
  const validIds = new Set<number>();
  for (const d of decisions) validIds.add(d.id);

  // Single-shot path: small input set, one provider call.
  if (decisions.length <= SINGLE_SHOT_MAX) {
    return runOne(decisions, provider, model, maxClusters, minPerCluster, validIds, signal);
  }

  // Pre-group by type so each provider call stays bounded. We share the
  // maxClusters budget across types proportionally to type size.
  const byType = new Map<DecisionType, DecisionRow[]>();
  for (const d of decisions) {
    const bucket = byType.get(d.type) ?? [];
    bucket.push(d);
    byType.set(d.type, bucket);
  }

  const aggregated: ClusterCandidate[] = [];
  // At least 1 per type so a single decision-type doesn't squeeze others out.
  const perTypeBudget = Math.max(1, Math.floor(maxClusters / Math.max(1, byType.size)));

  for (const [type, rows] of byType.entries()) {
    if (rows.length < minPerCluster) continue;
    const slice = rows.slice(0, PER_CALL_MAX);
    const typeIds = new Set<number>();
    for (const r of slice) typeIds.add(r.id);
    const clusters = await runOne(
      slice,
      provider,
      model,
      perTypeBudget,
      minPerCluster,
      typeIds,
      signal,
    );
    // Stamp the dominant type when the LLM omitted primary_type.
    for (const c of clusters) {
      if (!c.primary_type) c.primary_type = type;
      aggregated.push(c);
    }
    if (aggregated.length >= maxClusters) break;
  }

  return aggregated.slice(0, maxClusters);
}

// ════════════════════════════════════════════════════════════════════════
// INTERNAL
// ════════════════════════════════════════════════════════════════════════

async function runOne(
  decisions: DecisionRow[],
  provider: InferenceService,
  model: string,
  maxClusters: number,
  minPerCluster: number,
  validIds: Set<number>,
  signal: AbortSignal | undefined,
): Promise<ClusterCandidate[]> {
  const projected = decisions.map(projectDecision);
  const systemPrompt = SYSTEM_PROMPT.replace('{{MAX_CLUSTERS}}', String(maxClusters)).replace(
    '{{MIN_PER_CLUSTER}}',
    String(minPerCluster),
  );
  const prompt = `${systemPrompt}\n\nInput:\n${JSON.stringify(projected)}\n\nJSON:`;

  let response: string;
  try {
    response = await provider.generate(prompt, {
      maxTokens: 2048,
      temperature: 0.1,
      signal,
    });
  } catch (err) {
    logger.warn(
      { model, err: (err as Error)?.message ?? String(err) },
      'decision-clusterer: provider.generate failed — returning no clusters',
    );
    return [];
  }

  return parseClusters(response, validIds, minPerCluster);
}

/**
 * Build the privacy-stripped projection of a decision sent to the LLM.
 * Full `content` (which can include code refs/paths/PII) is NOT included —
 * only the first line, truncated, as a topical hint.
 */
function projectDecision(d: DecisionRow): {
  id: number;
  title: string;
  type: string;
  tags: string[];
  summary: string;
} {
  let tags: string[] = [];
  if (d.tags) {
    try {
      const parsed = JSON.parse(d.tags);
      if (Array.isArray(parsed)) {
        tags = parsed.filter((t): t is string => typeof t === 'string').slice(0, 10);
      }
    } catch {
      /* malformed tags JSON — ignore */
    }
  }
  // First line of content as a topical hint, hard-capped.
  const firstLine = (d.content ?? '').split(/\r?\n/, 1)[0]?.trim() ?? '';
  const summary = firstLine.slice(0, CONTENT_PREVIEW_CHARS);
  return {
    id: d.id,
    title: d.title,
    type: d.type,
    tags,
    summary,
  };
}

/**
 * Parse + validate the LLM response. Drops malformed entries individually.
 * Each cluster's decision_ids is intersected with `validIds` so the LLM
 * cannot invent ids.
 */
export function parseClusters(
  response: string,
  validIds: Set<number>,
  minPerCluster: number,
): ClusterCandidate[] {
  const raw = safeParseArray(response);
  const out: ClusterCandidate[] = [];

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;

    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    const summary = typeof rec.summary === 'string' ? rec.summary.trim() : '';
    if (!title || !summary) continue;

    const rawIds = Array.isArray(rec.decision_ids) ? rec.decision_ids : [];
    const decision_ids: number[] = [];
    for (const v of rawIds) {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n)) continue;
      if (!validIds.has(n)) continue;
      // De-duplicate within the cluster.
      if (!decision_ids.includes(n)) decision_ids.push(n);
    }
    if (decision_ids.length < minPerCluster) continue;

    const tags = Array.isArray(rec.tags)
      ? rec.tags
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .slice(0, 10)
      : [];

    let primary_type: DecisionType | undefined;
    if (typeof rec.primary_type === 'string') {
      const candidate = rec.primary_type as DecisionType;
      if (DECISION_TYPE_SET.has(candidate)) primary_type = candidate;
    }

    out.push({
      title: title.slice(0, 200),
      summary: summary.slice(0, 1000),
      tags,
      decision_ids,
      primary_type,
    });
  }

  return out;
}

/**
 * Extract a JSON array from an LLM response. Tolerant of fenced code blocks
 * and trailing prose. Returns an empty array on unrecoverable input.
 */
function safeParseArray(response: string): unknown[] {
  if (!response) return [];
  const trimmed = response.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = fenced ? fenced[1].trim() : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const start = body.indexOf('[');
    const end = body.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return [];
    try {
      parsed = JSON.parse(body.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed : [];
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS — title similarity for merge-on-rerun
// ════════════════════════════════════════════════════════════════════════

/**
 * Cheap trigram Jaccard similarity over normalised cluster titles. Used by
 * `build_decision_clusters` to merge a freshly-computed cluster with an
 * existing one when their titles agree (≥0.8 similarity after lowercase +
 * whitespace trim). Keeps cluster IDs stable across re-runs so callers can
 * reference them in UI.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = trigrams(normaliseTitle(a));
  const tb = trigrams(normaliseTitle(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect++;
  const union = ta.size + tb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function normaliseTitle(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length < 3) {
    if (s.length > 0) out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - 3; i++) out.add(s.slice(i, i + 3));
  return out;
}
