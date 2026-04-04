/**
 * Tests that BM25 field weighting ranks name matches above summary matches.
 */
import { describe, it, expect } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { searchFts } from '../../src/db/fts.js';

function createStoreWithSymbols() {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);

  const fA = store.insertFile('src/a.ts', 'typescript', 'h1', 100);
  const fB = store.insertFile('src/b.ts', 'typescript', 'h2', 100);

  // Symbol A: name = "validator" (direct name match)
  store.insertSymbol(fA, {
    symbolId: 'sym:validator',
    name: 'validator',
    kind: 'function',
    fqn: null,
    byteStart: 0,
    byteEnd: 100,
    signature: 'function validator(input: string): boolean',
  });

  // Symbol B: name = "processor", but summary mentions "validator"
  store.insertSymbol(fB, {
    symbolId: 'sym:processor',
    name: 'processor',
    kind: 'function',
    fqn: null,
    byteStart: 0,
    byteEnd: 100,
    signature: 'function processor(data: Data): Result',
  });

  // Set summary for B to mention "validator"
  db.prepare(
    "UPDATE symbols SET summary = 'Processes data using a validator pattern for safety checks' WHERE symbol_id = 'sym:processor'",
  ).run();
  db.prepare("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')").run();

  return { store, db };
}

describe('BM25 field weighting', () => {
  it('ranks name match higher than summary-only match', () => {
    const { db } = createStoreWithSymbols();

    const results = searchFts(db, 'validator', 10);
    expect(results.length).toBe(2);

    // "validator" appears in sym A's name (weight 10x) AND signature (3x)
    // "validator" appears in sym B's summary only (weight 1x)
    // So A should rank first
    expect(results[0].name).toBe('validator');
    expect(results[1].name).toBe('processor');

    // Name-matched result has a better (more negative) BM25 score
    expect(results[0].rank).toBeLessThan(results[1].rank);
  });

  it('bm25 scores reflect field weight differences', () => {
    const { db } = createStoreWithSymbols();

    const results = searchFts(db, 'validator', 10);
    expect(results.length).toBe(2);

    // Both results have negative BM25 scores (lower = better)
    // The name-matched result has a much more negative score than the summary-only match
    expect(results[0].rank).toBeLessThan(0);
    expect(results[1].rank).toBeLessThan(0);
    // Score gap should exist due to field weighting (name=10 vs summary=1)
    expect(results[0].rank).toBeLessThan(results[1].rank);
  });
});
