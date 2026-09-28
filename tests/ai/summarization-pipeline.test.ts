import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceService } from '../../src/ai/interfaces.js';
import { PROMPTS } from '../../src/ai/prompts.js';
import { SummarizationPipeline } from '../../src/ai/summarization-pipeline.js';
import type { Store } from '../../src/db/store.js';
import { logger } from '../../src/logger.js';
import { createTestStore } from '../test-utils.js';

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
    store = createTestStore();
    // The empty/error paths log warns by design — silence them here; the
    // GH#1423 block below asserts on them explicitly with its own spy.
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('retries errored symbols within the run instead of abandoning them', async () => {
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
    // First symbol fails transiently, second succeeds; the failed one is
    // retried in-run (errored ids stay out of `attempted`) and then succeeds.
    expect(count).toBe(2);
    expect(inference.generate).toHaveBeenCalledTimes(3);
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

// GH#1423: with a reasoning model burning the output budget, every response
// is HTTP 200 with an empty body. Pre-fix the loop re-fetched the identical
// batch forever (batch.length === batchSize with zero stored summaries),
// re-billing the same symbols without end and never reaching the degradation
// warning. These tests pin the fail-fast behavior with a real Store.
describe('SummarizationPipeline — empty-batch termination (GH#1423)', () => {
  let store: Store;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  function seedFunctions(n: number): void {
    const fileId = store.insertFile('src/a.ts', 'typescript', 'h1', 100);
    for (let i = 0; i < n; i++) {
      store.insertSymbol(fileId, {
        symbolId: `src/a.ts::fn${i}#function`,
        name: `fn${i}`,
        kind: 'function',
        byteStart: 0,
        byteEnd: 10,
      });
    }
  }

  /** Symbol names billed, in call order (each prompt carries `Name: <name>`). */
  function billedNames(inference: InferenceService): string[] {
    const calls = vi.mocked(inference.generate).mock.calls;
    return calls.map((c) => /Name: (\S+)/.exec(String(c[0]))?.[1] ?? '?');
  }

  beforeEach(() => {
    store = createTestStore();
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('stops after the first batch that stores nothing (batchSize < total)', async () => {
    seedFunctions(5);
    const inference = createMockInference('');
    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 2,
      kinds: ['function'],
      concurrency: 1,
    });

    const count = await pipeline.summarizeUnsummarized();
    expect(count).toBe(0);
    // Exactly one batch billed — the next fetch would have been identical.
    expect(inference.generate).toHaveBeenCalledTimes(2);
  });

  it('never bills the same symbol twice within one run', async () => {
    seedFunctions(4);
    // Batch 1 (2 rows): first empty, second healthy. Batch 2 re-selects the
    // empty row alongside a fresh one — the empty row must not be re-billed.
    const replies = ['', 'Real summary.', '', 'Real summary.'];
    let i = 0;
    const inference: InferenceService = {
      generate: vi.fn(async () => replies[i++] ?? 'Real summary.'),
    };
    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 2,
      kinds: ['function'],
      concurrency: 1,
    });

    const count = await pipeline.summarizeUnsummarized();
    expect(count).toBe(1);
    expect(inference.generate).toHaveBeenCalledTimes(3);
    const names = billedNames(inference);
    expect(new Set(names).size).toBe(names.length);
  });

  it('fires the degradation warning on the early-stop path', async () => {
    seedFunctions(3);
    const inference = createMockInference('');
    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 2,
      kinds: ['function'],
      concurrency: 1,
    });

    await pipeline.summarizeUnsummarized();

    const messages = warnSpy.mock.calls.map((c) => JSON.stringify(c));
    // The stop itself is logged…
    expect(messages.some((m) => m.includes('no stored summaries'))).toBe(true);
    // …and the silent-degradation diagnosis (previously unreachable here)
    // names the real config key as the remedy.
    const diagnosis = messages.find((m) => m.includes('no usable summary for most symbols'));
    expect(diagnosis).toBeDefined();
    expect(diagnosis).toContain('ai.summarize_max_tokens');
    expect(diagnosis).not.toContain('ai.summarize max tokens');
  });

  it('passes configured maxTokens to the provider', async () => {
    seedSymbols(store);
    const seen: (number | undefined)[] = [];
    const inference: InferenceService = {
      generate: vi.fn(async (_prompt: string, options) => {
        seen.push(options?.maxTokens);
        return 'A summary.';
      }),
    };
    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 10,
      kinds: ['class', 'method'],
      concurrency: 1,
      maxTokens: 1024,
    });

    await pipeline.summarizeUnsummarized();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === 1024)).toBe(true);
  });

  it('defaults to the prompt template budget when maxTokens is unset', async () => {
    seedSymbols(store);
    const seen: (number | undefined)[] = [];
    const inference: InferenceService = {
      generate: vi.fn(async (_prompt: string, options) => {
        seen.push(options?.maxTokens);
        return 'A summary.';
      }),
    };
    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 10,
      kinds: ['class', 'method'],
      concurrency: 1,
    });

    await pipeline.summarizeUnsummarized();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === PROMPTS.summarize_symbol.maxTokens)).toBe(true);
  });

  it('recovers from a transient whole-batch failure (review TRA-2026 finding 1)', async () => {
    // Reviewer's A/B: batchSize 1, first call throws HTTP 429, provider
    // healthy after — must summarize 5/5 in 6 calls, not 0/5 in 1.
    seedFunctions(5);
    let calls = 0;
    const inference: InferenceService = {
      generate: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('HTTP 429 Too Many Requests');
        return 'Real summary.';
      }),
    };
    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 1,
      kinds: ['function'],
      concurrency: 1,
    });

    const count = await pipeline.summarizeUnsummarized();
    expect(count).toBe(5);
    expect(inference.generate).toHaveBeenCalledTimes(6);
  });

  it('aborts loudly after persistent whole-batch failures (no silent completed-at-0)', async () => {
    seedFunctions(3);
    const inference: InferenceService = {
      generate: vi.fn(async () => {
        throw new Error('HTTP 500 provider down');
      }),
    };
    const progressUpdates: { phase?: string }[] = [];
    const pipeline = new SummarizationPipeline(
      store,
      inference,
      '/tmp/fake',
      { batchSize: 2, kinds: ['function'], concurrency: 1 },
      { update: (_t: string, s: { phase?: string }) => progressUpdates.push(s) } as never,
    );

    await expect(pipeline.summarizeUnsummarized()).rejects.toThrow(/after 3 attempts/);
    // Initial try + 2 retries of the same 2-row batch, then abort — bounded.
    expect(inference.generate).toHaveBeenCalledTimes(6);
    // The run reports error, never a quiet `completed` at zero progress.
    expect(progressUpdates.at(-1)?.phase).toBe('error');
    expect(progressUpdates.some((u) => u.phase === 'completed')).toBe(false);
  });

  it('keeps progress on a poison-pill symbol instead of failing the run (review round 2)', async () => {
    // 60 symbols, batchSize 20, fn0 always throws (e.g. provider content
    // filter on its prompt), the other 59 healthy: the run must resolve
    // with 59 stored — not reject with phase `error` on a 98% done run.
    seedFunctions(60);
    const inference: InferenceService = {
      generate: vi.fn(async (prompt: string) => {
        if (/Name: fn0\b/.exec(prompt)) throw new Error('content filter');
        return 'Real summary.';
      }),
    };
    const progressUpdates: { phase?: string }[] = [];
    const pipeline = new SummarizationPipeline(
      store,
      inference,
      '/tmp/fake',
      { batchSize: 20, kinds: ['function'], concurrency: 1 },
      { update: (_t: string, s: { phase?: string }) => progressUpdates.push(s) } as never,
    );

    const count = await pipeline.summarizeUnsummarized();
    expect(count).toBe(59);
    // Every symbol billed once; the poison id billed on each attempt.
    expect(inference.generate).toHaveBeenCalledTimes(66);
    expect(progressUpdates.at(-1)?.phase).toBe('completed');
    const messages = warnSpy.mock.calls.map((c) => JSON.stringify(c));
    expect(messages.some((m) => m.includes('errored persistently'))).toBe(true);
  });

  it('retries only the errored ids of a mixed batch', async () => {
    seedFunctions(2);
    // fn0 throws once then recovers; fn1 is silent-empty.
    const seen = new Map<string, number>();
    const inference: InferenceService = {
      generate: vi.fn(async (prompt: string) => {
        const name = /Name: (\S+)/.exec(prompt)?.[1] ?? '?';
        const n = (seen.get(name) ?? 0) + 1;
        seen.set(name, n);
        if (name === 'fn0' && n === 1) throw new Error('HTTP 429');
        if (name === 'fn0') return 'Recovered summary.';
        return '';
      }),
    };
    const pipeline = new SummarizationPipeline(store, inference, '/tmp/fake', {
      batchSize: 2,
      kinds: ['function'],
      concurrency: 1,
    });

    const count = await pipeline.summarizeUnsummarized();
    expect(count).toBe(1);
    // Batch 1 bills fn0 (error) + fn1 (empty); retry bills fn0 only
    // (fn1 is attempted); the leftover fn1 then trips the fresh-empty tail.
    expect(inference.generate).toHaveBeenCalledTimes(3);
    expect(billedNames(inference)).toEqual(['fn0', 'fn1', 'fn0']);
  });
});
