/**
 * LLM-based reranker — uses a fast inference model to re-score search results.
 * Falls back to original order on parse failure.
 */

import { logger } from '../logger.js';
import type { InferenceService, RerankerService } from './interfaces.js';
import { PROMPTS } from './prompts.js';

export class LLMReranker implements RerankerService {
  constructor(
    private inference: InferenceService,
    /**
     * Output-token budget per rerank call. Wired from
     * `ai.rerank_max_tokens` (default 200); reasoning models need headroom
     * or they return an empty body and every search degrades to RRF order
     * while still paying full rerank latency (GH#1423).
     */
    private maxTokens: number = PROMPTS.rerank.maxTokens,
  ) {}

  async rerank(
    query: string,
    documents: { id: number; text: string }[],
    topK: number,
  ): Promise<{ id: number; score: number }[]> {
    if (documents.length === 0) return [];
    if (documents.length <= 1) return documents.map((d) => ({ id: d.id, score: 1 }));

    try {
      const docsText = documents.map((d, i) => `[${i + 1}] ${d.text.slice(0, 200)}`).join('\n');

      const prompt = PROMPTS.rerank.build({
        query,
        documents: docsText,
      });

      const response = await this.inference.generate(prompt, {
        maxTokens: this.maxTokens,
        temperature: PROMPTS.rerank.temperature,
      });

      const scores = this.parseScores(response, documents.length);
      if (!scores) {
        // Warn, not debug: an empty/unparseable rerank response means every
        // semantic search just paid full LLM latency for an RRF fallback.
        // The classic cause is a reasoning model burning the output budget —
        // see ai.rerank_max_tokens (GH#1423).
        logger.warn(
          { responseLength: response.length, expectedScores: documents.length },
          'Reranker: failed to parse scores, keeping original order',
        );
        return documents.slice(0, topK).map((d, i) => ({
          id: d.id,
          score: documents.length - i,
        }));
      }

      const scored = documents.map((d, i) => ({
        id: d.id,
        score: scores[i] ?? 0,
      }));

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    } catch (e) {
      logger.warn({ error: e }, 'Reranker failed, keeping original order');
      return documents.slice(0, topK).map((d, i) => ({
        id: d.id,
        score: documents.length - i,
      }));
    }
  }

  private parseScores(response: string, expectedCount: number): number[] | null {
    const lines = response
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const scores: number[] = [];

    for (const line of lines) {
      const match = line.match(/(\d+(?:\.\d+)?)/);
      if (match) {
        scores.push(parseFloat(match[1]));
      }
      if (scores.length >= expectedCount) break;
    }

    if (scores.length !== expectedCount) return null;
    return scores;
  }
}
