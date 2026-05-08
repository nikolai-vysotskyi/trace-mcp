/**
 * Tests for the embedding provider/model snapshot stored alongside vectors,
 * and the refuse-to-mix check derived from it.
 *
 * The lesson here is from CRG v2.3.3: an index built with provider A's
 * embeddings cannot be queried with provider B's — cosine similarity scores
 * become noise. Stamp (provider, model, dim) at write time and refuse to
 * silently mix at query time. Legacy indexes pre-dating the column accept
 * the first call and backfill in place — refusing them all would surprise
 * users coming off the previous release.
 */
import { initializeDatabase } from '../../src/db/schema.js';
import { describe, expect, it } from 'vitest';
import { BlobVectorStore, ProviderMismatchError } from '../../src/ai/vector-store.js';

describe('BlobVectorStore.setMeta with provider', () => {
  it('round-trips provider via getMeta', () => {
    const db = initializeDatabase(':memory:');
    const store = new BlobVectorStore(db);
    store.setMeta('text-embedding-3-small', 1536, 'openai');
    const meta = store.getMeta();
    expect(meta).toEqual({
      model: 'text-embedding-3-small',
      dim: 1536,
      provider: 'openai',
    });
  });

  it('preserves backwards compatibility: setMeta without provider still works', () => {
    const db = initializeDatabase(':memory:');
    const store = new BlobVectorStore(db);
    store.setMeta('nomic-embed-text', 768);
    const meta = store.getMeta();
    expect(meta?.model).toBe('nomic-embed-text');
    expect(meta?.dim).toBe(768);
    expect(meta?.provider).toBeUndefined();
  });
});

describe('BlobVectorStore.checkProviderMatch', () => {
  it('returns no_index for an unstamped store', () => {
    const db = initializeDatabase(':memory:');
    const store = new BlobVectorStore(db);
    expect(store.checkProviderMatch({ provider: 'openai', model: 'm' })).toEqual({
      kind: 'no_index',
    });
  });

  it('returns ok when provider + model match', () => {
    const db = initializeDatabase(':memory:');
    const store = new BlobVectorStore(db);
    store.setMeta('text-embedding-3-small', 1536, 'openai');
    expect(
      store.checkProviderMatch({ provider: 'openai', model: 'text-embedding-3-small' }),
    ).toEqual({ kind: 'ok' });
  });

  it('returns mismatch when provider differs', () => {
    const db = initializeDatabase(':memory:');
    const store = new BlobVectorStore(db);
    store.setMeta('text-embedding-3-small', 1536, 'openai');
    const result = store.checkProviderMatch({
      provider: 'ollama',
      model: 'text-embedding-3-small',
    });
    expect(result.kind).toBe('mismatch');
    if (result.kind === 'mismatch') {
      expect(result.stored.provider).toBe('openai');
      expect(result.active.provider).toBe('ollama');
    }
  });

  it('returns mismatch when model differs even if provider matches', () => {
    const db = initializeDatabase(':memory:');
    const store = new BlobVectorStore(db);
    store.setMeta('text-embedding-3-small', 1536, 'openai');
    const result = store.checkProviderMatch({
      provider: 'openai',
      model: 'text-embedding-3-large',
    });
    expect(result.kind).toBe('mismatch');
  });

  it('accepts legacy indexes (no provider stored) — they will be backfilled by next embed_repo', () => {
    const db = initializeDatabase(':memory:');
    const store = new BlobVectorStore(db);
    store.setMeta('legacy-model', 384); // pre-provider stamp
    expect(store.checkProviderMatch({ provider: 'ollama', model: 'legacy-model' })).toEqual({
      kind: 'ok',
    });
  });
});

describe('ProviderMismatchError', () => {
  it('carries enough context to tell the user what to do', () => {
    const err = new ProviderMismatchError(
      { provider: 'openai', model: 'text-embedding-3-small' },
      { provider: 'ollama', model: 'nomic-embed-text' },
    );
    expect(err.message).toContain('openai/text-embedding-3-small');
    expect(err.message).toContain('ollama/nomic-embed-text');
    expect(err.message).toContain('embed_repo');
    expect(err.message).toContain('force=true');
  });
});
