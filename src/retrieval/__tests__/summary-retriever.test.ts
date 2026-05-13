/**
 * Summary retriever — verifies it augments lexical hits with the symbol's
 * stored summary text.
 */
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { runRetriever } from '../types.js';
import { createLexicalRetriever } from '../retrievers/lexical-retriever.js';
import { SummaryRetriever } from '../retrievers/summary-retriever.js';

function seedStoreWithSummaries(): Store {
  const store = new Store(initializeDatabase(':memory:'));
  const fId = store.insertFile('src/auth.ts', 'typescript', 'h1', 200);

  const ids = store.insertSymbols(fId, [
    {
      symbolId: 'sym:login',
      name: 'login',
      kind: 'function',
      fqn: 'src/auth.ts::login',
      byteStart: 0,
      byteEnd: 50,
      signature: 'function login(user: string): Token',
    },
    {
      symbolId: 'sym:logout',
      name: 'logout',
      kind: 'function',
      fqn: 'src/auth.ts::logout',
      byteStart: 60,
      byteEnd: 120,
      signature: 'function logout(): void',
    },
  ]);

  // Attach a summary to the first symbol only — the second has none, so we
  // can verify the retriever handles the `summary: null` case cleanly.
  store.updateSymbolSummary(ids[0], 'Authenticates a user and returns a token.');

  return store;
}

describe('SummaryRetriever', () => {
  it('augments lexical hits with stored summary text', async () => {
    const store = seedStoreWithSummaries();
    const lexical = createLexicalRetriever(store);
    const retriever = new SummaryRetriever(lexical, store);

    const out = await runRetriever(retriever, { text: 'login' });
    expect(out.length).toBeGreaterThan(0);

    const hit = out.find((r) => r.id === 'sym:login');
    expect(hit).toBeDefined();
    expect(hit!.payload.summary).toBe('Authenticates a user and returns a token.');
    expect(hit!.payload.name).toBe('login');
    expect(hit!.payload.kind).toBe('function');
    expect(hit!.source).toBe('summary');
  });

  it('returns `summary: null` when the symbol has no stored summary', async () => {
    const store = seedStoreWithSummaries();
    const lexical = createLexicalRetriever(store);
    const retriever = new SummaryRetriever(lexical, store);

    const out = await runRetriever(retriever, { text: 'logout' });
    const hit = out.find((r) => r.id === 'sym:logout');
    expect(hit).toBeDefined();
    expect(hit!.payload.summary).toBeNull();
  });

  it('empty query → []', async () => {
    const store = seedStoreWithSummaries();
    const lexical = createLexicalRetriever(store);
    const retriever = new SummaryRetriever(lexical, store);
    const out = await runRetriever(retriever, { text: '' });
    expect(out).toEqual([]);
  });

  it('exposes name "summary"', () => {
    const store = seedStoreWithSummaries();
    const lexical = createLexicalRetriever(store);
    expect(new SummaryRetriever(lexical, store).name).toBe('summary');
  });
});
