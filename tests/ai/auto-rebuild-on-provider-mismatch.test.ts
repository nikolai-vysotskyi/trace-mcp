/**
 * P0.1 — auto-rebuild on embedding provider/model mismatch.
 *
 * The on-disk vector index is stamped with the (provider, model) that built
 * it. When the active embedding service disagrees, EmbeddingPipeline can:
 *   - silently rebuild (default; ai.autoRebuildOnProviderMismatch = true), or
 *   - throw ProviderMismatchError (when the operator wants a hard gate).
 *
 * These tests cover both branches plus the legacy-index back-compat path
 * (indexes that pre-date the provider column must never throw, never
 * trigger a rebuild — they get backfilled silently).
 */
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { EmbeddingPipeline } from '../../src/ai/embedding-pipeline.js';
import type { EmbeddingService } from '../../src/ai/interfaces.js';
import { BlobVectorStore, ProviderMismatchError } from '../../src/ai/vector-store.js';
import type { Store } from '../../src/db/store.js';
import { verifyIndex } from '../../src/db/verify.js';
import { createTestStore } from '../test-utils.js';

function mkEmbed(dims: number, model: string, provider: string): EmbeddingService {
  return {
    async embed() {
      return Array.from({ length: dims }, (_, i) => (i + 1) * 0.1);
    },
    async embedBatch(texts) {
      return texts.map(() => Array.from({ length: dims }, (_, i) => (i + 1) * 0.1));
    },
    dimensions() {
      return dims;
    },
    modelName() {
      return model;
    },
    providerName() {
      return provider;
    },
  };
}

function seedThreeSymbols(db: Database.Database): void {
  db.exec(`
    INSERT INTO files (id, path, language, indexed_at) VALUES (1, 'f.ts', 'ts', datetime('now'));
    INSERT INTO symbols (id, file_id, symbol_id, name, kind, fqn, signature, byte_start, byte_end)
      VALUES (1, 1, 's1', 'Foo', 'class', 'Foo', 'class Foo', 0, 10);
    INSERT INTO symbols (id, file_id, symbol_id, name, kind, fqn, signature, byte_start, byte_end)
      VALUES (2, 1, 's2', 'Bar', 'class', 'Bar', 'class Bar', 10, 20);
    INSERT INTO symbols (id, file_id, symbol_id, name, kind, fqn, signature, byte_start, byte_end)
      VALUES (3, 1, 's3', 'Baz', 'function', 'Baz', 'fn baz', 20, 30);
  `);
}

describe('EmbeddingPipeline — auto-rebuild on provider mismatch', () => {
  let store: Store;
  let db: Database.Database;
  let vectorStore: BlobVectorStore;

  beforeEach(() => {
    store = createTestStore();
    db = store.db;
    vectorStore = new BlobVectorStore(db);
    seedThreeSymbols(db);
  });

  it('default (no options) silently drops and re-embeds when provider changes', async () => {
    // Build index under openai
    const p1 = new EmbeddingPipeline(store, mkEmbed(3, 'shared-model', 'openai'), vectorStore);
    await p1.indexUnembedded();
    expect(vectorStore.getMeta()).toEqual({
      model: 'shared-model',
      dim: 3,
      provider: 'openai',
    });

    // Swap to ollama (same model name, different provider) — should rebuild
    const p2 = new EmbeddingPipeline(store, mkEmbed(3, 'shared-model', 'ollama'), vectorStore);
    await p2.indexUnembedded();

    expect(vectorStore.getMeta()).toEqual({
      model: 'shared-model',
      dim: 3,
      provider: 'ollama',
    });
    expect(vectorStore.count()).toBe(3);
  });

  it('explicit autoRebuildOnProviderMismatch=true rebuilds (matches default)', async () => {
    const p1 = new EmbeddingPipeline(store, mkEmbed(3, 'm', 'openai'), vectorStore);
    await p1.indexUnembedded();

    const p2 = new EmbeddingPipeline(store, mkEmbed(3, 'm', 'ollama'), vectorStore, undefined, {
      autoRebuildOnProviderMismatch: true,
    });
    await expect(p2.indexUnembedded()).resolves.toBeGreaterThanOrEqual(0);
    expect(vectorStore.getMeta()?.provider).toBe('ollama');
  });

  it('autoRebuildOnProviderMismatch=false throws ProviderMismatchError on provider drift', async () => {
    const p1 = new EmbeddingPipeline(store, mkEmbed(3, 'm', 'openai'), vectorStore);
    await p1.indexUnembedded();
    expect(vectorStore.count()).toBe(3);

    const p2 = new EmbeddingPipeline(store, mkEmbed(3, 'm', 'ollama'), vectorStore, undefined, {
      autoRebuildOnProviderMismatch: false,
    });

    await expect(p2.indexUnembedded()).rejects.toThrow(ProviderMismatchError);
    // Index is left intact — caller decides what to do next.
    expect(vectorStore.getMeta()?.provider).toBe('openai');
    expect(vectorStore.count()).toBe(3);
  });

  it('autoRebuildOnProviderMismatch=false throws on model drift (same provider)', async () => {
    const p1 = new EmbeddingPipeline(store, mkEmbed(3, 'small', 'openai'), vectorStore);
    await p1.indexUnembedded();

    const p2 = new EmbeddingPipeline(store, mkEmbed(3, 'large', 'openai'), vectorStore, undefined, {
      autoRebuildOnProviderMismatch: false,
    });

    await expect(p2.indexUnembedded()).rejects.toThrow(ProviderMismatchError);
    const err = await p2.indexUnembedded().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderMismatchError);
    expect((err as Error).message).toContain('openai/small');
    expect((err as Error).message).toContain('openai/large');
  });

  it('legacy index (no provider column) is accepted regardless of config — never throws', async () => {
    // Manually stamp meta without provider, mimicking a pre-P0.1 index.
    vectorStore.setMeta('legacy-model', 3);
    expect(vectorStore.getMeta()).toEqual({ model: 'legacy-model', dim: 3 });

    // Pretend a few rows existed
    vectorStore.insert(1, [0.1, 0.2, 0.3]);
    vectorStore.insert(2, [0.4, 0.5, 0.6]);
    expect(vectorStore.count()).toBe(2);

    // Strict mode — must NOT throw, must backfill provider column in place.
    const p = new EmbeddingPipeline(
      store,
      mkEmbed(3, 'legacy-model', 'ollama'),
      vectorStore,
      undefined,
      { autoRebuildOnProviderMismatch: false },
    );
    await expect(p.indexUnembedded()).resolves.toBeGreaterThanOrEqual(0);
    // Provider stamped; existing vectors preserved (no clear()).
    expect(vectorStore.getMeta()).toEqual({
      model: 'legacy-model',
      dim: 3,
      provider: 'ollama',
    });
  });

  it('strict mode still works on first run (no_index → stamp without throw)', async () => {
    expect(vectorStore.getMeta()).toBeNull();
    const p = new EmbeddingPipeline(store, mkEmbed(3, 'm', 'openai'), vectorStore, undefined, {
      autoRebuildOnProviderMismatch: false,
    });
    await expect(p.indexUnembedded()).resolves.toBeGreaterThan(0);
    expect(vectorStore.getMeta()?.provider).toBe('openai');
  });
});

describe('verifyIndex — embedding_provider_match check', () => {
  let store: Store;
  let db: Database.Database;
  let vectorStore: BlobVectorStore;

  beforeEach(() => {
    store = createTestStore();
    db = store.db;
    vectorStore = new BlobVectorStore(db);
    seedThreeSymbols(db);
  });

  it('reports ok when active provider/model matches the stamp', async () => {
    const p = new EmbeddingPipeline(store, mkEmbed(3, 'm', 'openai'), vectorStore);
    await p.indexUnembedded();

    const report = verifyIndex(db, {
      activeEmbedding: { provider: 'openai', model: 'm' },
    });
    const check = report.checks.find((c) => c.name === 'embedding_provider_match');
    expect(check?.status).toBe('ok');
  });

  it('emits a warn check on provider drift with suggested_repair=drop-vec', async () => {
    const p = new EmbeddingPipeline(store, mkEmbed(3, 'm', 'openai'), vectorStore);
    await p.indexUnembedded();

    const report = verifyIndex(db, {
      activeEmbedding: { provider: 'ollama', model: 'm' },
    });
    const check = report.checks.find((c) => c.name === 'embedding_provider_match');
    expect(check?.status).toBe('warn');
    expect(check?.suggested_repair).toBe('drop-vec');
    expect(check?.detail).toContain('openai/m');
    expect(check?.detail).toContain('ollama/m');
    expect(report.status).toBe('warn');
  });

  it('skips the check entirely when activeEmbedding is omitted (back-compat)', async () => {
    const p = new EmbeddingPipeline(store, mkEmbed(3, 'm', 'openai'), vectorStore);
    await p.indexUnembedded();

    const report = verifyIndex(db);
    const check = report.checks.find((c) => c.name === 'embedding_provider_match');
    expect(check).toBeUndefined();
  });

  it('treats legacy index (no provider stamp) as ok', () => {
    // No embeddings stamped — just rows with the old key/value meta minus provider.
    vectorStore.setMeta('legacy-model', 3);
    vectorStore.insert(1, [0.1, 0.2, 0.3]);

    const report = verifyIndex(db, {
      activeEmbedding: { provider: 'ollama', model: 'legacy-model' },
    });
    const check = report.checks.find((c) => c.name === 'embedding_provider_match');
    expect(check?.status).toBe('ok');
    expect(check?.detail).toContain('Legacy index');
  });
});
