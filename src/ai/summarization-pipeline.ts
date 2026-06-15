/**
 * AI-powered summarization pipeline.
 * Runs after indexing to populate the symbols.summary column using the fast inference model.
 * Uses CachedInferenceService to avoid redundant LLM calls across re-indexes.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../db/store.js';
import { logger } from '../logger.js';
import type { ProgressState } from '../progress.js';
import type { InferenceService, VectorStore } from './interfaces.js';
import { PROMPTS, sanitizeGeneratedSummary, stripLeadingDocstrings } from './prompts.js';

interface SummarizationConfig {
  batchSize: number;
  kinds: string[];
  /** Max parallel inference requests (default 1 = sequential). */
  concurrency: number;
  /**
   * When false, leading docstrings / comment blocks are stripped from the
   * source before it is sent to the summarizer (IPI hardening — docstrings are
   * the highest-risk injection surface). Defaults to true, preserving the
   * original behavior of summarizing from full source including docstrings.
   */
  summarizeFromDocstrings?: boolean;
}

const MAX_SOURCE_LINES = 80;

/**
 * Fraction of (provider-succeeded) symbols that may fall back to a generic
 * signature-derived summary before we emit a degradation warning. Above this
 * the provider is almost certainly returning HTTP 200 with no usable text —
 * typically a "thinking" model burning the output budget on reasoning tokens.
 */
const DEGRADATION_WARN_FRACTION = 0.5;

export class SummarizationPipeline {
  constructor(
    private store: Store,
    private inferenceService: InferenceService,
    private rootPath: string,
    private config: SummarizationConfig,
    private progress?: ProgressState,
    /** When provided, stale embeddings are invalidated on summary rewrite so
     *  the next EmbeddingPipeline run picks them up. */
    private vectorStore?: VectorStore | null,
  ) {}

  /**
   * Per-run tally of symbols where the provider returned a successful
   * (non-error) response but produced no usable summary, so we stored a generic
   * signature-derived one instead. Reset at the start of each
   * `summarizeUnsummarized` run. Used for silent-degradation detection.
   */
  private silentFallbacks = 0;
  /** Per-run count of symbols whose provider call did not throw. */
  private providerSuccesses = 0;

  async summarizeUnsummarized(signal?: AbortSignal): Promise<number> {
    let totalSummarized = 0;
    let batch: ReturnType<Store['getUnsummarizedSymbols']>;

    // Reset run-scoped degradation counters.
    this.silentFallbacks = 0;
    this.providerSuccesses = 0;

    const total = this.store.countUnsummarizedSymbols(this.config.kinds);
    if (total === 0) return 0;

    this.progress?.update('summarization', {
      phase: 'running',
      processed: 0,
      total,
      startedAt: Date.now(),
      completedAt: 0,
    });

    try {
      do {
        // Cooperative cancellation: bail out at batch boundaries instead of
        // running to completion when the owning project was already disposed.
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('Summarization aborted');
        }

        batch = this.store.getUnsummarizedSymbols(this.config.kinds, this.config.batchSize);
        if (batch.length === 0) break;

        const results = await this.summarizeBatch(batch, signal);
        for (const { id, summary } of results) {
          this.store.updateSymbolSummary(id, summary);
          // Summary feeds buildEmbeddingText — drop any stale vector so the
          // next indexUnembedded cycle re-embeds this symbol.
          this.vectorStore?.delete(id);
          totalSummarized++;
        }

        this.progress?.update('summarization', { processed: totalSummarized });
        logger.debug(
          { batch: batch.length, total: totalSummarized },
          'Summarization batch complete',
        );
      } while (batch.length === this.config.batchSize);

      this.maybeWarnSilentDegradation();

      this.progress?.update('summarization', {
        phase: 'completed',
        processed: totalSummarized,
        completedAt: Date.now(),
      });
    } catch (e) {
      this.progress?.update('summarization', {
        phase: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    return totalSummarized;
  }

  private async summarizeBatch(
    symbols: ReturnType<Store['getUnsummarizedSymbols']>,
    signal?: AbortSignal,
  ): Promise<{ id: number; summary: string }[]> {
    const results: { id: number; summary: string }[] = [];
    const template = PROMPTS.summarize_symbol;
    const concurrency = this.config.concurrency;

    // Default true preserves the original behavior (summarize from full source).
    const fromDocstrings = this.config.summarizeFromDocstrings !== false;

    const summarizeOne = async (sym: (typeof symbols)[number]): Promise<void> => {
      // Per-symbol abort check — stop scheduling fresh fetches once the owner
      // signalled cancellation.
      if (signal?.aborted) return;
      try {
        let source = this.readSource(sym.file_path, sym.byte_start, sym.byte_end) ?? '';
        // IPI opt-out: drop leading docstrings/comment blocks (the highest-risk
        // injection surface) so only signature + structural body reaches the LLM.
        if (!fromDocstrings && source) {
          source = stripLeadingDocstrings(source);
        }

        const prompt = template.build({
          kind: sym.kind,
          name: sym.name,
          fqn: sym.fqn ?? '',
          signature: sym.signature ?? '',
          source,
        });

        const summary = await this.inferenceService.generate(prompt, {
          maxTokens: template.maxTokens,
          temperature: template.temperature,
          signal,
        });

        // The provider call returned without throwing — count it as a success
        // for degradation-rate math regardless of whether the body was usable.
        this.providerSuccesses++;

        // Sanitize the model output before it is stored / surfaced into an
        // agent context (the input was untrusted code).
        const cleaned = sanitizeGeneratedSummary(summary);
        if (cleaned) {
          results.push({ id: sym.id, summary: cleaned });
          return;
        }

        // HTTP 200 but no usable summary — typically a thinking model that spent
        // the output budget on reasoning. Record the silent degradation for the
        // warning, but do NOT store a placeholder: leaving the symbol
        // unsummarized means it is retried on the next run once the model is
        // fixed, instead of being masked by a low-value signature restatement
        // that search can already derive from the stored signature.
        this.silentFallbacks++;
      } catch (e) {
        logger.warn({ symbolId: sym.id, name: sym.name, error: e }, 'Failed to summarize symbol');
      }
    };

    if (concurrency <= 1) {
      for (const sym of symbols) {
        if (signal?.aborted) break;
        await summarizeOne(sym);
      }
    } else {
      for (let i = 0; i < symbols.length; i += concurrency) {
        if (signal?.aborted) break;
        const chunk = symbols.slice(i, i + concurrency);
        await Promise.all(chunk.map(summarizeOne));
      }
    }

    return results;
  }

  /**
   * Emit ONE warning per run when the share of provider-succeeded symbols that
   * fell back to a generic summary exceeds DEGRADATION_WARN_FRACTION. This
   * surfaces "HTTP 200 with empty body" silent degradation — naming the likely
   * cause (a thinking model consuming the output budget) and the remedy.
   */
  private maybeWarnSilentDegradation(): void {
    if (this.providerSuccesses === 0) return;
    const fraction = this.silentFallbacks / this.providerSuccesses;
    if (fraction <= DEGRADATION_WARN_FRACTION) return;

    logger.warn(
      {
        silentFallbacks: this.silentFallbacks,
        providerSuccesses: this.providerSuccesses,
        fallbackFraction: Number(fraction.toFixed(2)),
        threshold: DEGRADATION_WARN_FRACTION,
      },
      'AI summarizer returned successful responses with no usable summary for most symbols — ' +
        'likely a "thinking" model consuming the entire output budget on reasoning tokens. ' +
        'Remedy: raise ai.summarize max tokens, or set ai.openaiExtraBody to disable thinking ' +
        '(e.g. { "reasoning_effort": "none" } / { "chat_template_kwargs": { "enable_thinking": false } }).',
    );
  }

  private readSource(filePath: string, byteStart: number, byteEnd: number): string | null {
    try {
      const absPath = path.resolve(this.rootPath, filePath);
      const content = fs.readFileSync(absPath, 'utf-8');
      const slice = content.slice(byteStart, byteEnd);
      const lines = slice.split('\n');
      if (lines.length > MAX_SOURCE_LINES) {
        return `${lines.slice(0, MAX_SOURCE_LINES).join('\n')}\n// ... truncated`;
      }
      return slice;
    } catch {
      return null;
    }
  }
}
