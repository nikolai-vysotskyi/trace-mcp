/**
 * Lexical retriever — golden test against the direct `searchFts` path.
 *
 * The adapter MUST return the same top-K result set as calling
 * `searchFts` directly. If this drifts, the adapter has introduced
 * behavioural difference that callers of the eventual migration would
 * notice.
 */
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { searchFts } from '../../db/fts.js';
import { runRetriever } from '../types.js';
import { LexicalRetriever, createLexicalRetriever } from '../retrievers/lexical-retriever.js';

function createTestStore(): Store {
  return new Store(initializeDatabase(':memory:'));
}

function seedSymbols() {
  const store = createTestStore();
  const fId = store.insertFile('src/example.ts', 'typescript', 'h1', 200);

  store.insertSymbol(fId, {
    symbolId: 'sym:validator',
    name: 'validator',
    kind: 'function',
    fqn: 'src/example.ts::validator',
    byteStart: 0,
    byteEnd: 50,
    signature: 'function validator(input: string): boolean',
  });
  store.insertSymbol(fId, {
    symbolId: 'sym:Validator',
    name: 'Validator',
    kind: 'class',
    fqn: 'src/example.ts::Validator',
    byteStart: 60,
    byteEnd: 120,
    signature: 'class Validator',
  });
  store.insertSymbol(fId, {
    symbolId: 'sym:processor',
    name: 'processor',
    kind: 'function',
    fqn: 'src/example.ts::processor',
    byteStart: 130,
    byteEnd: 180,
    signature: 'function processor(data: Data): Result',
  });

  return store;
}

describe('LexicalRetriever (adapter over searchFts)', () => {
  it('top-3 results match searchFts directly (golden equivalence)', async () => {
    const store = seedSymbols();
    const retriever = new LexicalRetriever(store);

    // Reference: call searchFts directly.
    const direct = searchFts(store.db, 'validator', 3);

    // Adapter: same query through the protocol.
    const viaProtocol = await runRetriever(retriever, { text: 'validator', limit: 3 });

    // Same number of hits.
    expect(viaProtocol.length).toBe(direct.length);
    expect(viaProtocol.length).toBeGreaterThan(0);

    // Same ordering by symbolIdStr.
    expect(viaProtocol.map((r) => r.id)).toEqual(direct.map((r) => r.symbolIdStr));

    // Score sign-flip preserved: adapter score = -row.rank.
    for (let i = 0; i < viaProtocol.length; i++) {
      expect(viaProtocol[i].score).toBeCloseTo(-direct[i].rank, 10);
    }
  });

  it('returns empty list for empty query', async () => {
    const store = seedSymbols();
    const retriever = createLexicalRetriever(store);
    const out = await runRetriever(retriever, { text: '' });
    expect(out).toEqual([]);
  });

  it('respects the limit knob', async () => {
    const store = seedSymbols();
    const retriever = new LexicalRetriever(store);
    const out = await runRetriever(retriever, { text: 'validator', limit: 1 });
    expect(out.length).toBe(1);
  });

  it('exposes name "lexical" for registry routing', () => {
    const store = seedSymbols();
    expect(new LexicalRetriever(store).name).toBe('lexical');
  });

  it('applies filters (kind=function should drop the class)', async () => {
    const store = seedSymbols();
    const retriever = new LexicalRetriever(store);
    const out = await runRetriever(retriever, {
      text: 'validator',
      filters: { kind: 'function' },
    });
    expect(out.length).toBe(1);
    expect(out[0].id).toBe('sym:validator');
  });
});
