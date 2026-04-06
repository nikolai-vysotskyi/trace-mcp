/**
 * AI-powered summarization pipeline.
 * Runs after indexing to populate the symbols.summary column using the fast inference model.
 * Uses CachedInferenceService to avoid redundant LLM calls across re-indexes.
 */
import type { InferenceService } from './interfaces.js';
import type { Store } from '../db/store.js';
import { PROMPTS } from './prompts.js';
import { logger } from '../logger.js';
import fs from 'node:fs';
import path from 'node:path';

interface SummarizationConfig {
  batchSize: number;
  kinds: string[];
  /** Max parallel inference requests (default 1 = sequential). */
  concurrency: number;
}

const MAX_SOURCE_LINES = 80;

export class SummarizationPipeline {
  constructor(
    private store: Store,
    private inferenceService: InferenceService,
    private rootPath: string,
    private config: SummarizationConfig,
  ) {}

  async summarizeUnsummarized(): Promise<number> {
    let totalSummarized = 0;
    let batch: ReturnType<Store['getUnsummarizedSymbols']>;

    do {
      batch = this.store.getUnsummarizedSymbols(this.config.kinds, this.config.batchSize);
      if (batch.length === 0) break;

      const results = await this.summarizeBatch(batch);
      for (const { id, summary } of results) {
        this.store.updateSymbolSummary(id, summary);
        totalSummarized++;
      }

      logger.debug({ batch: batch.length, total: totalSummarized }, 'Summarization batch complete');
    } while (batch.length === this.config.batchSize);

    if (totalSummarized > 0) {
      logger.info({ totalSummarized }, 'Symbol summarization complete');
    }
    return totalSummarized;
  }

  private async summarizeBatch(
    symbols: ReturnType<Store['getUnsummarizedSymbols']>,
  ): Promise<{ id: number; summary: string }[]> {
    const results: { id: number; summary: string }[] = [];
    const template = PROMPTS.summarize_symbol;
    const concurrency = this.config.concurrency;

    const summarizeOne = async (sym: (typeof symbols)[number]): Promise<void> => {
      try {
        const source = this.readSource(sym.file_path, sym.byte_start, sym.byte_end);
        const prompt = template.build({
          kind: sym.kind,
          name: sym.name,
          fqn: sym.fqn ?? '',
          signature: sym.signature ?? '',
          source: source ?? '',
        });

        const summary = await this.inferenceService.generate(prompt, {
          maxTokens: template.maxTokens,
          temperature: template.temperature,
        });

        const cleaned = summary.trim();
        if (cleaned) {
          results.push({ id: sym.id, summary: cleaned });
        }
      } catch (e) {
        logger.warn({ symbolId: sym.id, name: sym.name, error: e }, 'Failed to summarize symbol');
      }
    };

    if (concurrency <= 1) {
      for (const sym of symbols) {
        await summarizeOne(sym);
      }
    } else {
      for (let i = 0; i < symbols.length; i += concurrency) {
        const chunk = symbols.slice(i, i + concurrency);
        await Promise.all(chunk.map(summarizeOne));
      }
    }

    return results;
  }

  private readSource(filePath: string, byteStart: number, byteEnd: number): string | null {
    try {
      const absPath = path.resolve(this.rootPath, filePath);
      const content = fs.readFileSync(absPath, 'utf-8');
      const slice = content.slice(byteStart, byteEnd);
      const lines = slice.split('\n');
      if (lines.length > MAX_SOURCE_LINES) {
        return lines.slice(0, MAX_SOURCE_LINES).join('\n') + '\n// ... truncated';
      }
      return slice;
    } catch {
      return null;
    }
  }
}
