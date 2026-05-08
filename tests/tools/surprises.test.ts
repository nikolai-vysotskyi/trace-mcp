import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { detectCommunities } from '../../src/tools/analysis/communities.js';
import { getSurprises } from '../../src/tools/analysis/surprises.js';

describe('getSurprises', () => {
  it('returns an unavailable hint when no communities have been detected', () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const result = getSurprises(store);
    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.edges).toEqual([]);
    expect(data.unavailable).toMatch(/detect_communities/);
  });

  it('flags a single cross-module edge into a popular target as the most surprising', async () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    store.ensureEdgeType('imports', 'core', 'Module import');

    const make = (path: string) => store.insertFile(path, 'typescript', `h-${path}`, 100);
    const symFor = (fileId: number, name: string, sid: string) => {
      store.insertSymbol(fileId, {
        symbolId: sid,
        name,
        kind: 'class',
        fqn: name,
        byteStart: 0,
        byteEnd: 100,
      });
      const syms = store.getSymbolsByFile(fileId);
      return store.getNodeId('symbol', syms[0].id);
    };

    // Two distinct subsystems
    const auth: number[] = [];
    const billing: number[] = [];
    for (let i = 0; i < 6; i++)
      auth.push(symFor(make(`src/auth/A${i}.ts`), `A${i}`, `a-${i}`) as number);
    for (let i = 0; i < 6; i++)
      billing.push(symFor(make(`src/billing/B${i}.ts`), `B${i}`, `b-${i}`) as number);

    // Strong intra-cluster edges
    for (let i = 0; i < auth.length; i++) {
      for (let j = i + 1; j < auth.length; j++) store.insertEdge(auth[i], auth[j], 'imports');
    }
    for (let i = 0; i < billing.length; i++) {
      for (let j = i + 1; j < billing.length; j++)
        store.insertEdge(billing[i], billing[j], 'imports');
    }

    // Make B0 highly popular within billing — many imports point at it
    for (let i = 1; i < billing.length; i++) store.insertEdge(billing[i], billing[0], 'imports');

    // The single cross-cluster edge — A2 → B0 — should win on surprise
    store.insertEdge(auth[2], billing[0], 'imports');

    await detectCommunities(store, 1.0);
    const result = getSurprises(store, { topN: 5 })._unsafeUnwrap();

    expect(result.edges.length).toBeGreaterThan(0);
    const top = result.edges[0];
    expect(top.sourceFile).toBe('src/auth/A2.ts');
    expect(top.targetFile).toBe('src/billing/B0.ts');
    expect(top.sourceCommunity).not.toBe(top.targetCommunity);
    expect(top.surpriseScore).toBeGreaterThan(0);
  });
});
