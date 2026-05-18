/**
 * Decision Consolidator (P2.2) — LLM-driven semantic dedup over the active
 * decision store.
 *
 * The L0 mining pipeline (regex + LLM) protects against exact-duplicate
 * captures via a sha256 dedup hash over title|content|type|symbol|file. Two
 * different phrasings of the same decision survive as separate rows. This
 * module pulls top-K similar candidates for each subject decision and asks
 * the LLM to decide store / merge / replace / drop — Tencent-style L1
 * deduplication adapted to a knowledge graph rather than a chat session.
 *
 * Privacy
 * ───────
 * The LLM input is a SANITISED projection of each decision: id + title +
 * type + first 300 chars of `content` + tags. Per-row PII fields like
 * `session_id`, `project_root`, `created_by`, and `git_branch` never leave
 * this process.
 *
 * Robustness
 * ──────────
 * - LLM output is parsed as strict JSON; malformed entries are dropped
 *   individually. Whole-call failures (network, malformed top-level) fall
 *   back to `{kind:'keep_separate'}` so the consolidator is non-destructive
 *   on degraded LLM responses.
 * - Each returned `existing_id` is intersected with the candidate id set —
 *   the LLM cannot invent ids.
 * - The verdict is shaped to match exactly one candidate; a subject + N
 *   candidates produces up to N verdicts (often fewer when the LLM judges
 *   most as `keep_separate` by omission).
 */

import { logger } from '../logger.js';
import type { InferenceService } from '../ai/interfaces.js';
import type { DecisionRow, DecisionType } from './decision-store.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

/**
 * The privacy-stripped view of a decision sent to the LLM. Keep this in
 * sync with `projectCandidate` below — schema drift between the two would
 * silently break id validation.
 */
export interface ConsolidationCandidate {
  decision_id: number;
  title: string;
  type: DecisionType;
  /** First 200 chars of content; full body never sent. */
  content_excerpt: string;
  tags: string[];
}

/**
 * What the LLM decided for a single (subject, candidate) pair.
 *
 * - `keep_separate`        — they're genuinely different; no action.
 * - `merge_into_existing`  — subject restates the candidate; merge content
 *                            into the existing row, invalidate the subject.
 * - `replace_existing`     — subject is a clear refinement; invalidate the
 *                            existing, keep the subject as-is.
 * - `invalidate_existing`  — the candidate is obsoleted by the subject and
 *                            the subject also lacks lasting value. Rare.
 */
export type ConsolidationVerdict =
  | { kind: 'keep_separate' }
  | { kind: 'merge_into_existing'; existing_id: number; merged_content_hint?: string }
  | { kind: 'replace_existing'; existing_id: number }
  | { kind: 'invalidate_existing'; existing_id: number };

export interface DecisionConsolidationInput {
  /** The "subject" decision being evaluated. */
  subject: DecisionRow;
  /** Pre-fetched candidates (top-K similar via FTS + title trigram). */
  candidates: DecisionRow[];
}

export interface ConsolidateOptions {
  provider: InferenceService;
  model: string;
  /** Hard cap on the LLM response token budget. Default 1500. */
  maxTokens?: number;
  /** Forwarded to `provider.generate` — lets the caller race a timeout. */
  abortSignal?: AbortSignal;
}

// ════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════

/** Cap on candidates per LLM call. Keeps prompt size bounded and reduces
 *  the chance the model invents ids. */
export const MAX_CANDIDATES_PER_CALL = 5;

/** Per-candidate content slice sent to the LLM (privacy + prompt size). */
const CANDIDATE_CONTENT_CHARS = 200;

/** Per-subject content slice. Slightly larger than candidates because the
 *  subject is the focal row and the LLM benefits from more context. */
const SUBJECT_CONTENT_CHARS = 300;

const SYSTEM_PROMPT = `You are deduplicating a knowledge base of architectural decisions. Compare a SUBJECT decision against CANDIDATES that are similar by full-text search / title trigram. For each candidate, decide the relationship to the subject.

Verdicts:
- keep_separate: they're genuinely different decisions, even if related.
- merge_into_existing: the subject restates the candidate with no new info OR adds a small refinement. Merge the subject's content into the existing candidate; invalidate the subject.
- replace_existing: the subject is a clear refinement / correction of the candidate. Invalidate the candidate, keep the subject.
- invalidate_existing: the candidate is clearly obsoleted by the subject AND the subject also lacks lasting value. Rare.
- When unsure, choose keep_separate.

Output STRICT JSON: an array of { existing_id, verdict, rationale_short } objects. Only include candidates that need an action (merge / replace / invalidate). Omit candidates you'd keep separate — they default to keep_separate. Empty array means no merges warranted.`;

// ════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════

/**
 * Evaluate one subject decision against its candidate set via the LLM and
 * return per-candidate verdicts.
 *
 * Returns an array (one entry per candidate the LLM picked an action for).
 * Candidates the LLM omits implicitly default to `{kind:'keep_separate'}`.
 *
 * Never throws — on LLM call failure, malformed JSON, or empty candidate
 * set, returns an empty array (= "nothing to consolidate").
 */
export async function consolidateOne(
  input: DecisionConsolidationInput,
  opts: ConsolidateOptions,
): Promise<ConsolidationVerdict[]> {
  if (input.candidates.length === 0) return [];

  const cappedCandidates = input.candidates.slice(0, MAX_CANDIDATES_PER_CALL);
  const validIds = new Set<number>();
  for (const c of cappedCandidates) validIds.add(c.id);
  // Defensive: never let the LLM merge a decision into itself.
  validIds.delete(input.subject.id);

  const projectedSubject = projectSubject(input.subject);
  const projectedCandidates = cappedCandidates
    .filter((c) => c.id !== input.subject.id)
    .map(projectCandidate);

  if (projectedCandidates.length === 0) return [];

  const prompt = buildPrompt(projectedSubject, projectedCandidates);

  let response: string;
  try {
    response = await opts.provider.generate(prompt, {
      maxTokens: opts.maxTokens ?? 1500,
      temperature: 0.1,
      signal: opts.abortSignal,
    });
  } catch (err) {
    logger.warn(
      {
        subject_id: input.subject.id,
        candidate_count: projectedCandidates.length,
        err: (err as Error)?.message ?? String(err),
      },
      'decision-consolidator: provider.generate failed — no verdicts emitted',
    );
    return [];
  }

  return parseVerdicts(response, validIds);
}

/**
 * Apply per-row content merging when the LLM picked `merge_into_existing`.
 * Exposed so the orchestrator can produce a final content string before
 * calling DecisionStore.updateDecision. Always returns a non-empty string.
 */
export function mergeContents(existingContent: string, subjectContent: string): string {
  const a = (existingContent ?? '').trim();
  const b = (subjectContent ?? '').trim();
  if (!b) return a || '';
  if (!a) return b;
  // Avoid duplicate text when the subject is a near-substring of existing.
  if (a.includes(b)) return a;
  return `${a}\n\n[merged] ${b}`;
}

/**
 * Union two tag arrays, preserving the order of the first then appending
 * unseen tags from the second. Caps at 20 tags total to match the schema.
 */
export function mergeTags(a: string[] | undefined, b: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of [...(a ?? []), ...(b ?? [])]) {
    if (typeof tag !== 'string') continue;
    const t = tag.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// INTERNAL
// ════════════════════════════════════════════════════════════════════════

function projectSubject(d: DecisionRow): ConsolidationCandidate {
  return {
    decision_id: d.id,
    title: d.title,
    type: d.type,
    content_excerpt: (d.content ?? '').slice(0, SUBJECT_CONTENT_CHARS),
    tags: parseTags(d.tags),
  };
}

function projectCandidate(d: DecisionRow): ConsolidationCandidate {
  return {
    decision_id: d.id,
    title: d.title,
    type: d.type,
    content_excerpt: (d.content ?? '').slice(0, CANDIDATE_CONTENT_CHARS),
    tags: parseTags(d.tags),
  };
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string').slice(0, 10);
  } catch {
    return [];
  }
}

function buildPrompt(
  subject: ConsolidationCandidate,
  candidates: ConsolidationCandidate[],
): string {
  const subjectBlock = [
    `id=${subject.decision_id}`,
    `title=${subject.title}`,
    `type=${subject.type}`,
    `tags=${JSON.stringify(subject.tags)}`,
    `content=${subject.content_excerpt}`,
  ].join('\n');

  const candidateBlocks = candidates
    .map(
      (c, i) =>
        `[${i + 1}] id=${c.decision_id} | title=${c.title} | type=${c.type} | tags=${JSON.stringify(
          c.tags,
        )} | content=${c.content_excerpt}`,
    )
    .join('\n');

  return `${SYSTEM_PROMPT}\n\nSUBJECT:\n${subjectBlock}\n\nCANDIDATES:\n${candidateBlocks}\n\nJSON:`;
}

const VERDICT_KINDS = new Set<ConsolidationVerdict['kind']>([
  'keep_separate',
  'merge_into_existing',
  'replace_existing',
  'invalidate_existing',
]);

/**
 * Parse the LLM response into validated verdicts. Each row must reference
 * an id from `validIds`; rows with unknown ids or unknown verdict kinds
 * are dropped silently. Duplicate ids in the response keep only the first
 * verdict — the LLM should never emit two opinions on the same candidate.
 */
export function parseVerdicts(response: string, validIds: Set<number>): ConsolidationVerdict[] {
  const raw = safeParseArray(response);
  const out: ConsolidationVerdict[] = [];
  const seenIds = new Set<number>();

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;

    const verdictStr = typeof rec.verdict === 'string' ? rec.verdict.trim() : '';
    if (!verdictStr) continue;
    if (!VERDICT_KINDS.has(verdictStr as ConsolidationVerdict['kind'])) continue;

    // keep_separate carries no id; just skip it (the default).
    if (verdictStr === 'keep_separate') continue;

    const idRaw = rec.existing_id;
    const id = typeof idRaw === 'number' ? idRaw : Number(idRaw);
    if (!Number.isInteger(id)) continue;
    if (!validIds.has(id)) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    if (verdictStr === 'merge_into_existing') {
      const hint =
        typeof rec.merged_content_hint === 'string' ? rec.merged_content_hint.trim() : undefined;
      out.push({
        kind: 'merge_into_existing',
        existing_id: id,
        merged_content_hint: hint && hint.length > 0 ? hint.slice(0, 5000) : undefined,
      });
    } else if (verdictStr === 'replace_existing') {
      out.push({ kind: 'replace_existing', existing_id: id });
    } else if (verdictStr === 'invalidate_existing') {
      out.push({ kind: 'invalidate_existing', existing_id: id });
    }
  }

  return out;
}

/**
 * Extract a JSON array from an LLM response. Tolerant of fenced code
 * blocks and trailing prose. Returns an empty array on unrecoverable
 * input — mirrors decision-clusterer's helper for output consistency.
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
