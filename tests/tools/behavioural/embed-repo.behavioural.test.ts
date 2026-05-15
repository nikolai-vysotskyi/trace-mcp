/**
 * Behavioural coverage for the `embed_repo` MCP tool.
 *
 * IMPL NOTE: `embed_repo` is inline-registered in
 * `src/tools/register/core.ts` (lines 109+). The wrapper constructs an
 * `EmbeddingPipeline` from an `EmbeddingService` + `VectorStore` + `Store`,
 * acquires a file lock, then calls either:
 *   - `pipeline.indexUnembedded(batch_size)` (default — incremental)
 *   - `pipeline.reindexAll()` (when `force=true`)
 *
 * The pipeline machinery is what we cover here. We use fake in-memory
 * implementations of `EmbeddingService` and `VectorStore` so the test runs
 * without an AI provider — same shape as the live registration would use
 * when an AI provider is configured.
 *
 * Contract under test:
 *   - indexUnembedded() returns the count of newly-embedded symbols
 *   - indexUnembedded() is idempotent — running twice returns 0 the second time
 *   - reindexAll() (force=true path) re-embeds existing symbols
 *   - dimensions()==0 (no-op service) short-circuits with zero work
 *   - batch_size argument is forwarded — service sees batches of that size
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmbeddingPipeline } from '../../../src/ai/embedding-pipeline.js';
import type { EmbeddingService, VectorStore } from '../../../src/ai/interfaces.js';
import type { Store } from '../../../src/db/store.js';
import { createTestStore } from '../../test-utils.js';

class FakeEmbeddingService implements EmbeddingService {
  public batchSizes: number[] = [];
  public callCount = 0;

  constructor(
    private dim: number = 4,
    private model: string = 'fake-model',
    private provider: string = 'fake',
  ) {}

  async embed(_text: string): Promise<number[]> {
    this.callCount++;
    return new Array(this.dim).fill(0).map((_, i) => (i + 1) * 0.1);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.batchSizes.push(texts.length);
    this.callCount += texts.length;
    return texts.map(() => new Array(this.dim).fill(0).map((_, i) => (i + 1) * 0.1));
  }

  dimensions(): number {
    return this.dim;
  }

  modelName(): string {
    return this.model;
  }

  providerName(): string {
    return this.provider;
  }
}

class FakeVectorStore implements VectorStore {
  private vecs = new Map<number, number[]>();
  private meta: { model: string; dim: number; provider?: string } | null = null;

  insert(id: number, vector: number[]): void {
    this.vecs.set(id, vector);
  }

  search(_query: number[], limit: number): { id: number; score: number }[] {
    return [...this.vecs.keys()].slice(0, limit).map((id) => ({ id, score: 1 }));
  }

  delete(id: number): void {
    this.vecs.delete(id);
  }

  clear(): void {
    this.vecs.clear();
  }

  setMeta(model: string, dim: number, provider?: string): void {
    this.meta = { model, dim, provider };
  }

  getMeta(): { model: string; dim: number; provider?: string } | null {
    return this.meta;
  }

  size(): number {
    return this.vecs.size;
  }

  has(id: number): boolean {
    return this.vecs.has(id);
  }
}

function seedSymbols(store: Store, count: number): number[] {
  const ids: number[] = [];
  const fileId = store.insertFile('src/seed.ts', 'typescript', 4000, '0xseed');
  for (let i = 0; i < count; i++) {
    const id = store.insertSymbol(fileId, {
      name: `sym${i}`,
      kind: 'function',
      fqn: `src/seed.ts::sym${i}`,
      signature: `sym${i}()`,
      summary: null,
      byte_start: i * 100,
      byte_end: i * 100 + 50,
      line_start: i + 1,
      line_end: i + 2,
      visibility: 'public',
      exported: true,
    } as any);
    ids.push(id);
  }
  return ids;
}

describe('embed_repo — EmbeddingPipeline behavioural contract', () => {
  let store: Store;
  let vec: FakeVectorStore;
  let svc: FakeEmbeddingService;

  beforeEach(() => {
    store = createTestStore();
    vec = new FakeVectorStore();
    svc = new FakeEmbeddingService(4);
  });

  afterEach(() => {
    store.db.close();
  });

  it('indexUnembedded() embeds every unembedded symbol and returns the count', async () => {
    seedSymbols(store, 3);
    const pipeline = new EmbeddingPipeline(store, svc, vec);
    const indexed = await pipeline.indexUnembedded(50);
    expect(indexed).toBe(3);
    expect(vec.size()).toBe(3);
    // Meta is stamped after first successful pass.
    const meta = vec.getMeta();
    expect(meta).not.toBeNull();
    expect(meta?.dim).toBe(4);
    expect(meta?.provider).toBe('fake');
    expect(meta?.model).toBe('fake-model');
  });

  it('indexUnembedded() is idempotent — second invocation returns 0', async () => {
    seedSymbols(store, 2);
    const pipeline = new EmbeddingPipeline(store, svc, vec);
    const first = await pipeline.indexUnembedded(50);
    expect(first).toBe(2);
    const second = await pipeline.indexUnembedded(50);
    expect(second).toBe(0);
    expect(vec.size()).toBe(2);
  });

  it('reindexAll() (force=true path) clears the vector store and re-embeds everything', async () => {
    seedSymbols(store, 2);
    const pipeline = new EmbeddingPipeline(store, svc, vec);
    await pipeline.indexUnembedded(50);
    expect(vec.size()).toBe(2);

    // Drop a vector to simulate a stale store, then reindexAll should restore.
    vec.delete(1);
    const reindexed = await pipeline.reindexAll();
    expect(reindexed).toBe(2);
    expect(vec.size()).toBe(2);
  });

  it('dimensions()==0 (disabled provider) short-circuits to zero work', async () => {
    seedSymbols(store, 3);
    const noopSvc = new FakeEmbeddingService(0, '', '');
    const pipeline = new EmbeddingPipeline(store, noopSvc, vec);
    const indexed = await pipeline.indexUnembedded(50);
    // The pipeline still runs the embed loop but the vectorStore.insert is
    // gated on `embedding.length > 0` per embedBatch — with dim=0 no vectors
    // are inserted.
    expect(vec.size()).toBe(0);
    expect(indexed).toBe(0);
  });

  it('batch_size argument is forwarded to the embedding service', async () => {
    seedSymbols(store, 7);
    const pipeline = new EmbeddingPipeline(store, svc, vec);
    const indexed = await pipeline.indexUnembedded(3);
    expect(indexed).toBe(7);
    // Loop processes 3 + 3 + 1 — every observed batch is ≤ batchSize.
    expect(svc.batchSizes.length).toBeGreaterThanOrEqual(3);
    for (const sz of svc.batchSizes) {
      expect(sz).toBeLessThanOrEqual(3);
    }
    // Total embedded across batches must equal symbol count.
    const totalAcrossBatches = svc.batchSizes.reduce((s, n) => s + n, 0);
    expect(totalAcrossBatches).toBe(7);
  });
});
