/**
 * LLM-driven decision extraction — complements the regex-based pipeline in
 * `conversation-miner.ts`.
 *
 * The regex pipeline matches ~8 trigger patterns and misses the majority of
 * real architectural decisions buried in conversation prose. When the user has
 * an AI provider configured we can run a second pass that reads each session
 * transcript and extracts decisions the regex can't see.
 *
 * Privacy
 * ───────
 * - `stripPrivacyTags` is run on every turn BEFORE concatenation, so
 *   `<private>`, `<persisted-output>`, `<system-reminder>`, `<ide_selection>`,
 *   `<task-notification>`, `<local-command-stdout>` blocks never reach an
 *   external API.
 * - Turns that collapse to empty (per `isInternalProtocolPayload`) are
 *   skipped before the transcript is built.
 *
 * Cost guard
 * ──────────
 * - Sessions shorter than `minSessionLength` chars are skipped without
 *   calling the LLM at all — a token-cheap no-op.
 * - Sessions whose transcript exceeds the per-call token budget (estimated
 *   as `chars / 4`) are chunked along turn boundaries. We never split a
 *   single turn in half. Up to `MAX_CHUNKS_PER_SESSION` chunks total.
 * - (session_id, content_sha, model) cache prevents re-paying tokens on
 *   re-mining.
 *
 * Robustness
 * ──────────
 * - LLM output is parsed as strict JSON; malformed entries are dropped
 *   individually, the call as a whole never throws on bad output.
 * - Each entry is validated against the 7 DecisionType enum values; unknown
 *   types are dropped.
 */

import crypto from 'node:crypto';
import { logger } from '../logger.js';
import type { InferenceService } from '../ai/interfaces.js';
import {
  type ConversationTurn,
  isInternalProtocolPayload,
  stripPrivacyTags,
} from './conversation-miner-types.js';
import type { DecisionType } from './decision-types.js';

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

export interface LlmExtractedDecision {
  title: string;
  type: DecisionType;
  content: string;
  tags?: string[];
  /** LLM self-estimated 0..1 likelihood that this is a real, lasting decision. */
  confidence: number;
}

export interface LlmExtractionCache {
  get(sessionId: string, contentSha: string, model: string): string | null;
  put(sessionId: string, contentSha: string, model: string, extractedJson: string): void;
}

export interface LlmExtractorOptions {
  /** Active inference service — usually `ctx.aiProvider.inference()`. */
  provider: InferenceService;
  /** Model identifier used for cache keying. */
  model: string;
  /**
   * Soft per-call token budget. We estimate chars/4 ≈ tokens and chunk the
   * transcript along turn boundaries when the estimate exceeds the budget.
   */
  maxTokens: number;
  /**
   * Skip the LLM entirely for transcripts below this character count.
   * Sessions this short rarely contain durable architectural decisions and
   * still cost tokens to process.
   */
  minSessionLength: number;
  /** Session id (used for cache key and structured logging). */
  sessionId: string;
  /** Optional cache backend; pass DecisionStore's helpers when wired in. */
  cache?: LlmExtractionCache;
  /** Inherits the recall timeout so the call never pins the agent turn. */
  signal?: AbortSignal;
}

// ════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════

/** Hard cap on how many chunks we'll send for one session. Protects against
 *  pathologically long transcripts that could explode token cost. */
export const MAX_CHUNKS_PER_SESSION = 4;

/** Chars → tokens heuristic (English prose ≈ 4 chars / token). */
const CHARS_PER_TOKEN = 4;

const SYSTEM_PROMPT = `You are analyzing a development session transcript. Extract architectural decisions, technical choices, bug root causes, discoveries, tradeoffs, conventions, and explicit preferences that were made or established.

Rules:
- Only extract things that are clearly DECISIONS or DISCOVERIES with lasting relevance. Skip routine task work, tool calls, file edits.
- Each decision needs a short imperative title (<=100 chars).
- Each decision needs body content explaining WHAT was decided and WHY (<=500 chars).
- Tag with one of: architecture_decision, tech_choice, bug_root_cause, preference, tradeoff, discovery, convention.
- Optional tags: short kebab-case topical labels (e.g. ["auth", "security"]).
- confidence: your own 0..1 estimate that this is a real, lasting decision vs. throwaway commentary.
- Return STRICT JSON: an array of objects only, no prose. Empty array if no decisions.`;

// ════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════

/**
 * Extract decisions from a single session's conversation turns via LLM.
 *
 * Returns an empty array — never throws — on:
 *   - transcript below `minSessionLength` after privacy stripping
 *   - all turns being internal protocol payloads
 *   - LLM call failing
 *   - LLM output not being parseable JSON
 *
 * Returns the cached extraction (without calling the LLM) when a cache entry
 * exists for (sessionId, content_sha, model).
 */
export async function extractDecisionsWithLlm(
  turns: ConversationTurn[],
  opts: LlmExtractorOptions,
): Promise<LlmExtractedDecision[]> {
  // 1. Build a privacy-stripped transcript.
  const cleanTurns: Array<{ role: string; text: string }> = [];
  for (const turn of turns) {
    if (isInternalProtocolPayload(turn.text)) continue;
    const text = stripPrivacyTags(turn.text).trim();
    if (!text) continue;
    cleanTurns.push({ role: turn.role, text });
  }

  if (cleanTurns.length === 0) return [];

  const transcript = cleanTurns.map((t) => `[${t.role}] ${t.text}`).join('\n\n');
  if (transcript.length < opts.minSessionLength) {
    logger.debug?.(
      { sessionId: opts.sessionId, length: transcript.length, min: opts.minSessionLength },
      'llm-extractor: skipping short session',
    );
    return [];
  }

  // 2. Cache lookup keyed on (session_id, content_sha, model).
  const contentSha = sha256(transcript);
  if (opts.cache) {
    const cached = opts.cache.get(opts.sessionId, contentSha, opts.model);
    if (cached !== null) {
      logger.debug?.(
        { sessionId: opts.sessionId, model: opts.model },
        'llm-extractor: cache hit, skipping LLM call',
      );
      return safeParseDecisions(cached);
    }
  }

  // 3. Chunk if the transcript exceeds the per-call budget.
  const budgetChars = Math.max(500, opts.maxTokens * CHARS_PER_TOKEN);
  const chunks =
    transcript.length <= budgetChars
      ? [transcript]
      : chunkByTurnBoundary(cleanTurns, budgetChars).slice(0, MAX_CHUNKS_PER_SESSION);

  // 4. Run the LLM (once per chunk) and aggregate.
  const aggregated: LlmExtractedDecision[] = [];
  const aggregatedRaw: unknown[] = [];

  for (const chunk of chunks) {
    const prompt = `${SYSTEM_PROMPT}\n\nTranscript:\n---\n${chunk}\n---\n\nJSON:`;
    let response: string;
    try {
      response = await opts.provider.generate(prompt, {
        maxTokens: 2048,
        temperature: 0.1,
        signal: opts.signal,
      });
    } catch (err) {
      logger.warn(
        { sessionId: opts.sessionId, err: (err as Error)?.message ?? String(err) },
        'llm-extractor: provider.generate failed — returning partial results',
      );
      break;
    }

    const parsed = safeParseDecisions(response);
    for (const d of parsed) aggregated.push(d);
    // Keep raw JSON for cache fidelity — we cache the model's actual output,
    // not our re-serialization, so the cache survives validation changes.
    aggregatedRaw.push(...safeParseRaw(response));
  }

  // 5. Cache write — store the merged validated array (small + deterministic).
  if (opts.cache) {
    try {
      opts.cache.put(opts.sessionId, contentSha, opts.model, JSON.stringify(aggregated));
    } catch (err) {
      logger.debug?.(
        { sessionId: opts.sessionId, err: (err as Error)?.message ?? String(err) },
        'llm-extractor: cache write failed (non-fatal)',
      );
    }
  }

  return aggregated;
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Split the conversation along turn boundaries so a single turn is never
 * fractured across chunks. A turn that on its own exceeds the budget lives
 * in its own chunk — better to overshoot once than to lose half a decision.
 */
export function chunkByTurnBoundary(
  turns: Array<{ role: string; text: string }>,
  budgetChars: number,
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const turn of turns) {
    const piece = `[${turn.role}] ${turn.text}`;
    const pieceLen = piece.length + 2; // accounts for the '\n\n' separator
    if (currentLen > 0 && currentLen + pieceLen > budgetChars) {
      chunks.push(current.join('\n\n'));
      current = [piece];
      currentLen = pieceLen;
    } else {
      current.push(piece);
      currentLen += pieceLen;
    }
  }
  if (current.length > 0) chunks.push(current.join('\n\n'));
  return chunks;
}

/**
 * Extract the JSON array from the LLM response. Tolerant of fenced
 * code blocks ("```json\n[...]\n```") and trailing prose. Returns an empty
 * array when the response is unrecoverable.
 */
function safeParseRaw(response: string): unknown[] {
  if (!response) return [];
  const trimmed = response.trim();
  // Strip Markdown fences if present.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = fenced ? fenced[1].trim() : trimmed;

  // Try direct parse first, then a substring fallback if the model wrapped
  // the array in prose.
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

/**
 * Parse + validate each entry against the DecisionType enum and shape
 * requirements. Malformed entries are dropped silently — one bad row never
 * sinks the whole extraction.
 */
export function safeParseDecisions(response: string): LlmExtractedDecision[] {
  const raw = safeParseRaw(response);
  const out: LlmExtractedDecision[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title.trim() : '';
    const content = typeof rec.content === 'string' ? rec.content.trim() : '';
    const type = typeof rec.type === 'string' ? (rec.type as DecisionType) : null;
    const tags = Array.isArray(rec.tags)
      ? rec.tags.filter((t): t is string => typeof t === 'string').slice(0, 20)
      : undefined;
    const rawConfidence = typeof rec.confidence === 'number' ? rec.confidence : 0.5;
    const confidence = clamp01(rawConfidence);

    if (!title || !content || !type) continue;
    if (!DECISION_TYPE_SET.has(type)) continue;

    out.push({
      title: title.slice(0, 200),
      content: content.slice(0, 5000),
      type,
      tags,
      confidence,
    });
  }
  return out;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
