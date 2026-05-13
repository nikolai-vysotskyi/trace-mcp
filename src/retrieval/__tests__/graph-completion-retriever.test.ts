/**
 * Tests for GraphCompletionRetriever (P12 vertical slice).
 *
 * The retriever is a pure composition over `LexicalRetriever` (P01 adapter)
 * and `traverseGraph` (existing 1-hop walker). These tests cover the
 * composition contract: provenance tagging, dedup across overlapping
 * neighbourhoods, hop_limit=0 degeneration, empty input, and the
 * no-edges case.
 */
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { runRetriever } from '../types.js';
import {
  GraphCompletionRetriever,
  createGraphCompletionRetriever,
  type GraphCompletionPayload,
} from '../retrievers/graph-completion-retriever.js';

function createTestStore(): Store {
  return new Store(initializeDatabase(':memory:'));
}

/**
 * Seed a fixture store with a single "seedSymbol" that calls two outgoing
 * neighbours "neighbourA" and "neighbourB". The seed name is rare so the
 * lexical search resolves to it deterministically.
 */
function seedWithTwoNeighbours(): { store: Store; seedId: string; aId: string; bId: string } {
  const store = createTestStore();
  const fileId = store.insertFile('src/example.ts', 'typescript', 'h1', 200);

  const seedId = 'src/example.ts::seedSymbol#function';
  const aId = 'src/example.ts::neighbourA#function';
  const bId = 'src/example.ts::neighbourB#function';

  store.insertSymbol(fileId, {
    symbolId: seedId,
    name: 'seedSymbol',
    kind: 'function',
    fqn: seedId,
    byteStart: 0,
    byteEnd: 50,
    signature: 'function seedSymbol(): void',
  });
  store.insertSymbol(fileId, {
    symbolId: aId,
    name: 'neighbourA',
    kind: 'function',
    fqn: aId,
    byteStart: 60,
    byteEnd: 90,
    signature: 'function neighbourA(): void',
  });
  store.insertSymbol(fileId, {
    symbolId: bId,
    name: 'neighbourB',
    kind: 'function',
    fqn: bId,
    byteStart: 100,
    byteEnd: 130,
    signature: 'function neighbourB(): void',
  });

  store.ensureEdgeType('calls', 'core', 'Call edge');

  const seedNode = store.getNodeId('symbol', store.getSymbolBySymbolId(seedId)!.id)!;
  const aNode = store.getNodeId('symbol', store.getSymbolBySymbolId(aId)!.id)!;
  const bNode = store.getNodeId('symbol', store.getSymbolBySymbolId(bId)!.id)!;

  store.insertEdge(seedNode, aNode, 'calls');
  store.insertEdge(seedNode, bNode, 'calls');

  return { store, seedId, aId, bId };
}

/**
 * Seed two distinct top-level symbols that both call the SAME neighbour.
 * Used to exercise the dedup path.
 *
 * Layout:
 *   alphaWidget  → sharedDependency
 *   betaWidget   → sharedDependency
 *
 * Both seed names contain "widget" so the lexical search picks both up.
 */
function seedSharedNeighbour(): {
  store: Store;
  alphaId: string;
  betaId: string;
  sharedId: string;
} {
  const store = createTestStore();
  const fileId = store.insertFile('src/widgets.ts', 'typescript', 'h2', 300);

  // Names use snake_case so the default FTS5 tokenizer (unicode61) splits
  // on the underscore — both seeds then share the "widget" token.
  const alphaId = 'src/widgets.ts::alpha_widget#function';
  const betaId = 'src/widgets.ts::beta_widget#function';
  const sharedId = 'src/widgets.ts::shared_dependency#function';

  store.insertSymbol(fileId, {
    symbolId: alphaId,
    name: 'alpha_widget',
    kind: 'function',
    fqn: alphaId,
    byteStart: 0,
    byteEnd: 50,
    signature: 'function alpha_widget(): void',
  });
  store.insertSymbol(fileId, {
    symbolId: betaId,
    name: 'beta_widget',
    kind: 'function',
    fqn: betaId,
    byteStart: 60,
    byteEnd: 110,
    signature: 'function beta_widget(): void',
  });
  store.insertSymbol(fileId, {
    symbolId: sharedId,
    name: 'shared_dependency',
    kind: 'function',
    fqn: sharedId,
    byteStart: 120,
    byteEnd: 170,
    signature: 'function shared_dependency(): void',
  });

  store.ensureEdgeType('calls', 'core', 'Call edge');

  const alphaNode = store.getNodeId('symbol', store.getSymbolBySymbolId(alphaId)!.id)!;
  const betaNode = store.getNodeId('symbol', store.getSymbolBySymbolId(betaId)!.id)!;
  const sharedNode = store.getNodeId('symbol', store.getSymbolBySymbolId(sharedId)!.id)!;

  store.insertEdge(alphaNode, sharedNode, 'calls');
  store.insertEdge(betaNode, sharedNode, 'calls');

  return { store, alphaId, betaId, sharedId };
}

/** Seed a single symbol with NO outgoing edges. Used to exercise no-edges. */
function seedIsolated(): { store: Store; loneId: string } {
  const store = createTestStore();
  const fileId = store.insertFile('src/lonely.ts', 'typescript', 'h3', 100);
  const loneId = 'src/lonely.ts::loneFunction#function';
  store.insertSymbol(fileId, {
    symbolId: loneId,
    name: 'loneFunction',
    kind: 'function',
    fqn: loneId,
    byteStart: 0,
    byteEnd: 50,
    signature: 'function loneFunction(): void',
  });
  return { store, loneId };
}

describe('GraphCompletionRetriever', () => {
  it('provenance: returns 1 seed + 2 expanded items for a seed with 2 outgoing edges', async () => {
    const { store, seedId, aId, bId } = seedWithTwoNeighbours();
    const retriever = new GraphCompletionRetriever(store);

    const results = await runRetriever(retriever, {
      query: 'seedSymbol',
      seed_k: 1,
      expand_per_seed: 5,
    });

    const byProvenance = results.reduce<Record<string, GraphCompletionPayload[]>>((acc, r) => {
      (acc[r.payload.provenance] ??= []).push(r.payload);
      return acc;
    }, {});

    expect(byProvenance.seed?.length).toBe(1);
    expect(byProvenance.seed?.[0].symbol_id).toBe(seedId);
    expect(byProvenance.expanded?.length).toBe(2);
    const expandedIds = byProvenance.expanded!.map((p) => p.symbol_id).sort();
    expect(expandedIds).toEqual([aId, bId].sort());
    // Every expanded item should know which seed it came from.
    for (const p of byProvenance.expanded ?? []) {
      expect(p.seed_id).toBe(seedId);
    }
    // The seed must rank above its expansions (blend math: score * 0.5).
    const seedScore = results.find((r) => r.id === seedId)!.score;
    const expandedScore = results.find((r) => r.id === aId)!.score;
    expect(seedScore).toBeGreaterThan(expandedScore);
    expect(expandedScore).toBeCloseTo(seedScore * 0.5, 10);
  });

  it('dedup: a neighbour reached from two seeds appears once with the best blended score', async () => {
    const { store, alphaId, betaId, sharedId } = seedSharedNeighbour();
    const retriever = createGraphCompletionRetriever(store);

    const results = await runRetriever(retriever, {
      query: 'widget',
      seed_k: 5,
      expand_per_seed: 5,
    });

    // shared should appear exactly once in the final list.
    const sharedHits = results.filter((r) => r.id === sharedId);
    expect(sharedHits.length).toBe(1);

    // The blended score for the shared neighbour must equal the higher of
    // the two contributing seed scores * 0.5.
    const alphaSeed = results.find((r) => r.id === alphaId)!;
    const betaSeed = results.find((r) => r.id === betaId)!;
    const bestSeedScore = Math.max(alphaSeed.score, betaSeed.score);
    expect(sharedHits[0].score).toBeCloseTo(bestSeedScore * 0.5, 10);
    expect(sharedHits[0].payload.provenance).toBe('expanded');
  });

  it('hop_limit=0 degenerates to lexical-only — no expanded items', async () => {
    const { store, seedId } = seedWithTwoNeighbours();
    const retriever = new GraphCompletionRetriever(store);

    const results = await runRetriever(retriever, {
      query: 'seedSymbol',
      seed_k: 1,
      hop_limit: 0,
      expand_per_seed: 5,
    });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe(seedId);
    expect(results[0].payload.provenance).toBe('seed');
  });

  it('empty query returns []', async () => {
    const { store } = seedWithTwoNeighbours();
    const retriever = new GraphCompletionRetriever(store);

    const results = await runRetriever(retriever, { query: '' });
    expect(results).toEqual([]);

    const whitespaceOnly = await runRetriever(retriever, { query: '   ' });
    expect(whitespaceOnly).toEqual([]);
  });

  it('no graph edges: returns only the seed, no expansion attempted', async () => {
    const { store, loneId } = seedIsolated();
    const retriever = new GraphCompletionRetriever(store);

    const results = await runRetriever(retriever, {
      query: 'loneFunction',
      seed_k: 1,
      expand_per_seed: 5,
    });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe(loneId);
    expect(results[0].payload.provenance).toBe('seed');
  });

  it('exposes name "graph_completion" for registry routing', () => {
    const { store } = seedWithTwoNeighbours();
    expect(new GraphCompletionRetriever(store).name).toBe('graph_completion');
  });
});
