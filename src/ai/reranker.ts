/**
 * LLM-based reranker — uses a fast inference model to re-score search results.
 * Falls back to original order on parse failure.
 */

import { logger } from '../logger.js';
import type { InferenceService, RerankerService } from './interfaces.js';
import { PROMPTS } from './prompts.js';

/** How many parse-failure warns fire before the reranker drops to debug. */
const MAX_PARSE_FAILURE_WARNS = 3;

/**
 * Output tokens budgeted per scored document (`N: score` ≈ up to ~6 tokens
 * with a safety margin) plus a fixed overhead for prompt framing.
 * A fixed 200-token budget fits ~28 docs; a `limit: 50` search sends
 * `limit*2 = 100` candidates and needs ≈ 632 tokens (GH#1442).
 */
export const RERANK_TOKENS_PER_DOC = 6;
export const RERANK_TOKENS_OVERHEAD = 32;

/** Default cap on documents sent to the LLM per rerank call (GH#1442). */
export const DEFAULT_RERANK_MAX_CANDIDATES = 100;

/**
 * Effective output-token budget for `docCount` documents: the configured
 * floor, scaled up when the candidate list needs more room. Pure —
 * unit-tested.
 */
export function resolveRerankMaxTokens(baseMaxTokens: number, docCount: number): number {
  const scaled = docCount * RERANK_TOKENS_PER_DOC + RERANK_TOKENS_OVERHEAD;
  return Math.max(baseMaxTokens, scaled);
}

export class LLMReranker implements RerankerService {
  /**
   * Parse-failure warns already emitted. The dead-reranker condition persists
   * for the life of the process, so warn loudly a few times and then drop to
   * debug — a 200-search session must not produce 200 identical lines.
   */
  private parseFailureWarns = 0;

  constructor(
    private inference: InferenceService,
    /**
     * Output-token budget per rerank call. Wired from
     * `ai.rerank_max_tokens` (default 200); reasoning models need headroom
     * or they return an empty body and every search degrades to RRF order
     * while still paying full rerank latency (GH#1423). Scaled up
     * automatically when the candidate list needs more room (GH#1442) —
     * see `resolveRerankMaxTokens`.
     */
    private maxTokens: number = PROMPTS.rerank.maxTokens,
    /**
     * Max documents sent to the LLM per rerank call. Wired from
     * `ai.rerank_max_candidates` (default 100). The fused RRF order puts
     * the best candidates first, so truncating to the head bounds LLM
     * cost without losing the top hits (GH#1442).
     */
    private maxCandidates: number = DEFAULT_RERANK_MAX_CANDIDATES,
  ) {}

  async rerank(
    query: string,
    documents: { id: number; text: string }[],
    topK: number,
  ): Promise<{ id: number; score: number }[]> {
    if (documents.length === 0) return [];
    if (documents.length <= 1) return documents.map((d) => ({ id: d.id, score: 1 }));

    // Cap candidates before prompting: the RRF-fused head holds the best
    // candidates, so the tail beyond the cap would only burn tokens (GH#1442).
    const docs =
      documents.length > this.maxCandidates ? documents.slice(0, this.maxCandidates) : documents;

    try {
      const docsText = docs.map((d, i) => `[${i + 1}] ${d.text.slice(0, 200)}`).join('\n');

      const prompt = PROMPTS.rerank.build({
        query,
        documents: docsText,
      });

      const response = await this.inference.generate(prompt, {
        maxTokens: resolveRerankMaxTokens(this.maxTokens, docs.length),
        temperature: PROMPTS.rerank.temperature,
      });

      const scores = this.parseScores(response, docs.length);
      if (!scores) {
        // Warn, not debug: an empty/unparseable rerank response means every
        // semantic search just paid full LLM latency for an RRF fallback.
        // The classic cause is a reasoning model burning the output budget —
        // hence the actionable hint (GH#1423). Throttled: the condition
        // persists per process, so only the first few are loud.
        this.parseFailureWarns++;
        if (this.parseFailureWarns <= MAX_PARSE_FAILURE_WARNS) {
          logger.warn(
            {
              responseLength: response.length,
              expectedScores: docs.length,
              hint: 'raise ai.rerank_max_tokens',
            },
            'Reranker: failed to parse scores, keeping original order',
          );
        } else {
          logger.debug(
            { responseLength: response.length, expectedScores: docs.length },
            'Reranker: failed to parse scores, keeping original order',
          );
        }
        return documents.slice(0, topK).map((d, i) => ({
          id: d.id,
          score: documents.length - i,
        }));
      }

      const scored = docs.map((d, i) => ({
        id: d.id,
        score: scores[i] ?? 0,
      }));

      scored.sort((a, b) => b.score - a.score);
      const head = scored.slice(0, topK);
      if (head.length >= topK || documents.length <= docs.length) return head;
      // Truncated tail: fill up to topK with the unranked RRF remainder in
      // original order so a large `limit` still returns `limit` rows (GH#1442).
      const seen = new Set(head.map((r) => r.id));
      const tail = documents
        .filter((d) => !seen.has(d.id))
        .slice(0, topK - head.length)
        .map((d) => ({ id: d.id, score: 0 }));
      return [...head, ...tail];
    } catch (e) {
      logger.warn({ error: e }, 'Reranker failed, keeping original order');
      return documents.slice(0, topK).map((d, i) => ({
        id: d.id,
        score: documents.length - i,
      }));
    }
  }

  /**
   * Parse one score per line, mapped by the leading `N:` index (GH#1442).
   *
   * Numbered lines (`1: 8`, `1. 8`, `[1] 8`, `1 - 8`) assign by number, so
   * stray lines (reasoning traces, echoes) no longer shift every later
   * score, and a short response still yields the scores it did return
   * (missing → 0) instead of a full RRF fallback after paying full latency.
   * Unnumbered lines fall back to legacy ordered assignment for
   * backwards compatibility with the v1 prompt.
   *
   * Returns null only when no score could be parsed at all.
   */
  private parseScores(response: string, expectedCount: number): number[] | null {
    const lines = response
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;

    const byNumber: (number | null)[] = new Array(expectedCount).fill(null);
    const ordered: number[] = [];
    let hasNumbered = false;

    // `1: 8` / `1. 8` / `1 - 8` / `[1] 8` / `[1]: 8` — number first, score second.
    const NUMBERED_RE = /^\[?\s*(\d+)\s*\]?\s*[:.\-)]\s*(-?\d+(?:\.\d+)?)/;

    for (const line of lines) {
      const numbered = line.match(NUMBERED_RE);
      if (numbered) {
        hasNumbered = true;
        const idx = parseInt(numbered[1], 10) - 1;
        if (idx >= 0 && idx < expectedCount && byNumber[idx] === null) {
          const v = parseFloat(numbered[2]);
          if (Number.isFinite(v)) byNumber[idx] = v;
        }
        continue;
      }
      const match = line.match(/(-?\d+(?:\.\d+)?)/);
      if (match) {
        const v = parseFloat(match[1]);
        if (Number.isFinite(v)) ordered.push(v);
      }
    }

    if (hasNumbered) {
      if (byNumber.every((v) => v === null) && ordered.length === 0) return null;
      // Fill gaps: numbered wins; unnumbered lines fill the remaining slots
      // in order (mixed responses from a model mid-migration).
      let oi = 0;
      const result = byNumber.map((v) => {
        if (v !== null) return v;
        while (oi < ordered.length) {
          const fallback = ordered[oi++];
          if (fallback !== undefined) return fallback;
        }
        return 0;
      });
      // Any leftover ordered scores beyond the gaps are ignored — the
      // numbered mapping is authoritative.
      if (result.every((v) => v === 0) && ordered.length === 0) {
        // All numbers parsed as explicit zeros is a valid (if useless)
        // response — keep it; only the no-scores case above returns null.
      }
      return result;
    }

    if (ordered.length === 0) return null;
    // Legacy unnumbered path: exact output as before; a short-but-nonempty
    // response pads with 0 instead of discarding everything (GH#1442).
    // Extra lines beyond expectedCount are ignored.
    const result = ordered.slice(0, expectedCount);
    while (result.length < expectedCount) result.push(0);
    return result;
  }
}
