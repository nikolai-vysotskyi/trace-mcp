import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import type { InferenceService } from '../../src/ai/interfaces.js';
import { SummarizationPipeline } from '../../src/ai/summarization-pipeline.js';

function createMockInference(response = 'Manages user authentication.'): InferenceService {
  return {
    generate: vi.fn(async () => response),
  };
}

function seedSymbols(store: Store): void {
  const fileId = store.insertFile('src/auth.ts', 'typescript', 'abc123', 100);
  store.insertSymbol(fileId, {
    symbolId: 'src/auth.ts::AuthService#class',
    name: 'AuthService',
    kind: 'class',
    byteStart: 0,
    byteEnd: 50,
    signature: 'class AuthService',
  });
  store.insertSymbol(fileId, {
    symbolId: 'src/auth.ts::login#method',
    name: 'login',
    kind: 'method',
    byteStart: 10,
    byteEnd: 40,
    signature: 'async login(email: string, password: string): Promise<User>',
  });
  // This kind should be skipped (not in default kinds list)
  store.insertSymbol(fileId, {
    symbolId: 'src/auth.ts::MAX_RETRIES#constant',
    name: 'MAX_RETRIES',
    kind: 'constant',
    byteStart: 0,
    byteEnd: 20,
  });
}

describe('SummarizationPipeline', () => {
  let store: Store;

  beforeEach(() => {
    const db = initializeDatabase(':memory:');
    store = new Store(db);
  });

  it('summarizes unsummarized symbols matching configured kinds', async () => {
    seedSymbols(store);
    const inference = createMockInference();
    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 10,
      kinds: ['class', 'method'],
      concurrency: 1,
    });

    const count = await pipeline.summarizeUnsummarized();
    expect(count).toBe(2);
    expect(inference.generate).toHaveBeenCalledTimes(2);

    // Verify summaries written to DB
    const sym1 = store.getSymbolBySymbolId('src/auth.ts::AuthService#class');
    expect(sym1?.summary).toBe('Manages user authentication.');

    const sym2 = store.getSymbolBySymbolId('src/auth.ts::login#method');
    expect(sym2?.summary).toBe('Manages user authentication.');

    // constant should NOT be summarized
    const sym3 = store.getSymbolBySymbolId('src/auth.ts::MAX_RETRIES#constant');
    expect(sym3?.summary).toBeNull();
  });

  it('skips symbols when inference returns empty', async () => {
    seedSymbols(store);
    const inference = createMockInference('');
    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 10,
      kinds: ['class', 'method'],
      concurrency: 1,
    });

    const count = await pipeline.summarizeUnsummarized();
    expect(count).toBe(0);
  });

  it('handles inference errors gracefully per symbol', async () => {
    seedSymbols(store);
    let callCount = 0;
    const inference: InferenceService = {
      generate: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('network error');
        return 'A summary.';
      }),
    };

    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 10,
      kinds: ['class', 'method'],
      concurrency: 1,
    });

    const count = await pipeline.summarizeUnsummarized();
    // First symbol fails, second succeeds
    expect(count).toBe(1);
  });

  it('returns 0 when no unsummarized symbols exist', async () => {
    const inference = createMockInference();
    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 10,
      kinds: ['class'],
      concurrency: 1,
    });

    const count = await pipeline.summarizeUnsummarized();
    expect(count).toBe(0);
    expect(inference.generate).not.toHaveBeenCalled();
  });

  it('does not re-summarize already summarized symbols', async () => {
    seedSymbols(store);
    const inference = createMockInference('First summary.');
    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 10,
      kinds: ['class', 'method'],
      concurrency: 1,
    });

    await pipeline.summarizeUnsummarized();
    expect(inference.generate).toHaveBeenCalledTimes(2);

    // Run again — should find nothing to summarize
    const count2 = await pipeline.summarizeUnsummarized();
    expect(count2).toBe(0);
    expect(inference.generate).toHaveBeenCalledTimes(2); // no new calls
  });

  it('summarizes in parallel when concurrency > 1', async () => {
    seedSymbols(store);
    const inference = createMockInference();
    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 10,
      kinds: ['class', 'method'],
      concurrency: 4,
    });

    const count = await pipeline.summarizeUnsummarized();
    expect(count).toBe(2);
    expect(inference.generate).toHaveBeenCalledTimes(2);
  });
});
