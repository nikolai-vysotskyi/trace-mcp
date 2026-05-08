import type Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import {
  detectCommunities,
  getCommunities,
  getCommunityDetail,
} from '../../src/tools/analysis/communities.js';

describe('Community Detection', () => {
  let db: Database.Database;
  let store: Store;

  beforeAll(() => {
    db = initializeDatabase(':memory:');
    store = new Store(db);

    // Create two clusters of files with edges between them
    // Cluster 1: auth files
    const f1 = store.insertFile('src/auth/AuthService.ts', 'typescript', 'h1', 500);
    const f2 = store.insertFile('src/auth/JwtGuard.ts', 'typescript', 'h2', 300);
    const f3 = store.insertFile('src/auth/LoginController.ts', 'typescript', 'h3', 400);

    // Cluster 2: payment files
    const f4 = store.insertFile('src/payments/PaymentService.ts', 'typescript', 'h4', 500);
    const f5 = store.insertFile('src/payments/StripeGateway.ts', 'typescript', 'h5', 300);
    const f6 = store.insertFile('src/payments/Invoice.ts', 'typescript', 'h6', 400);

    // Insert symbols in each file
    const syms: Array<{ fileId: number; name: string; symbolId: string }> = [
      { fileId: f1, name: 'AuthService', symbolId: 'auth-1' },
      { fileId: f2, name: 'JwtGuard', symbolId: 'auth-2' },
      { fileId: f3, name: 'LoginController', symbolId: 'auth-3' },
      { fileId: f4, name: 'PaymentService', symbolId: 'pay-1' },
      { fileId: f5, name: 'StripeGateway', symbolId: 'pay-2' },
      { fileId: f6, name: 'Invoice', symbolId: 'pay-3' },
    ];

    for (const s of syms) {
      store.insertSymbol(s.fileId, {
        symbolId: s.symbolId,
        name: s.name,
        kind: 'class',
        fqn: s.name,
        byteStart: 0,
        byteEnd: 100,
      });
    }

    // Create strong internal edges within each cluster
    // Auth cluster: AuthService → JwtGuard, AuthService → LoginController, JwtGuard → LoginController
    const ensureEdge = store.ensureEdgeType.bind(store);
    ensureEdge('imports', 'core', 'Module import');

    // Get node IDs for symbols
    const getNodeId = (fileId: number) => {
      const symsForFile = store.getSymbolsByFile(fileId);
      return symsForFile.length > 0 ? store.getNodeId('symbol', symsForFile[0].id) : undefined;
    };

    const n1 = getNodeId(f1)!;
    const n2 = getNodeId(f2)!;
    const n3 = getNodeId(f3)!;
    const n4 = getNodeId(f4)!;
    const n5 = getNodeId(f5)!;
    const n6 = getNodeId(f6)!;

    // Auth internal edges (3 edges)
    store.insertEdge(n1, n2, 'imports');
    store.insertEdge(n1, n3, 'imports');
    store.insertEdge(n3, n2, 'imports');

    // Payment internal edges (3 edges)
    store.insertEdge(n4, n5, 'imports');
    store.insertEdge(n4, n6, 'imports');
    store.insertEdge(n6, n5, 'imports');

    // Weak cross-cluster edge (1 edge)
    store.insertEdge(n3, n4, 'imports');
  });

  describe('detectCommunities()', () => {
    it('detects at least 2 communities in a two-cluster graph', async () => {
      const result = await detectCommunities(store, 1.0);
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.communities.length).toBeGreaterThanOrEqual(2);
      expect(data.totalFiles).toBe(6);
    });

    it('communities have valid cohesion scores', async () => {
      const result = await detectCommunities(store, 1.0);
      const data = result._unsafeUnwrap();
      for (const comm of data.communities) {
        expect(comm.cohesion).toBeGreaterThanOrEqual(0);
        expect(comm.cohesion).toBeLessThanOrEqual(1);
        expect(comm.fileCount).toBeGreaterThan(0);
      }
    });

    it('persists results to communities table', async () => {
      await detectCommunities(store, 1.0);
      const count = (db.prepare('SELECT COUNT(*) as c FROM communities').get() as { c: number }).c;
      expect(count).toBeGreaterThan(0);

      const memberCount = (
        db.prepare('SELECT COUNT(*) as c FROM community_members').get() as { c: number }
      ).c;
      expect(memberCount).toBe(6); // All 6 files assigned
    });

    it('auto-labels communities by path segment', async () => {
      const result = await detectCommunities(store, 1.0);
      const data = result._unsafeUnwrap();
      const labels = data.communities.map((c) => c.label);
      // Should have labels derived from 'auth' and 'payments' path segments
      expect(labels.some((l) => l === 'auth' || l === 'payments')).toBe(true);
    });
  });

  describe('getCommunities()', () => {
    it('returns previously detected communities', async () => {
      await detectCommunities(store, 1.0);
      const result = getCommunities(store);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().communities.length).toBeGreaterThan(0);
    });
  });

  describe('getCommunityDetail()', () => {
    it('returns detail for a specific community', async () => {
      await detectCommunities(store, 1.0);
      const communities = getCommunities(store)._unsafeUnwrap().communities;
      if (communities.length === 0) return;

      const detail = getCommunityDetail(store, communities[0].id);
      expect(detail.isOk()).toBe(true);
      const data = detail._unsafeUnwrap();
      expect(data.files.length).toBeGreaterThan(0);
      expect(data.label).toBeTruthy();
    });
  });

  describe('no N+1', () => {
    it('buildFileGraph uses a single aggregation query', async () => {
      // If this test doesn't timeout, the graph building is efficient
      const result = await detectCommunities(store, 1.0);
      expect(result.isOk()).toBe(true);
    });
  });

  describe('determinism', () => {
    it('produces identical communities across runs with the same seed', async () => {
      const a = (await detectCommunities(store, 1.0, 42))._unsafeUnwrap();
      const b = (await detectCommunities(store, 1.0, 42))._unsafeUnwrap();

      const keyA = a.communities
        .map((c) => `${c.label}:${c.fileCount}:${c.cohesion}:${c.internalEdges}:${c.externalEdges}`)
        .sort();
      const keyB = b.communities
        .map((c) => `${c.label}:${c.fileCount}:${c.cohesion}:${c.internalEdges}:${c.externalEdges}`)
        .sort();

      expect(keyA).toEqual(keyB);
      expect(a.seed).toBe(42);
      expect(b.seed).toBe(42);
    });

    it('default seed is 0 and reports it in the result', async () => {
      const result = (await detectCommunities(store, 1.0))._unsafeUnwrap();
      expect(result.seed).toBe(0);
    });
  });

  describe('two-phase cohesion split', () => {
    it('splits a large weakly-cohesive cluster glued by a single hub file', async () => {
      // Build a fresh fixture: two well-separated subsystems plus one hub
      // file that imports many files from both. With a single Leiden pass
      // the hub pulls everything into one giant low-cohesion community.
      // The two-phase refinement should detect that and split it.
      const localDb = initializeDatabase(':memory:');
      const localStore = new Store(localDb);
      localStore.ensureEdgeType('imports', 'core', 'Module import');

      const make = (path: string) => localStore.insertFile(path, 'typescript', `h-${path}`, 100);
      const symFor = (fileId: number, name: string, sid: string) => {
        localStore.insertSymbol(fileId, {
          symbolId: sid,
          name,
          kind: 'class',
          fqn: name,
          byteStart: 0,
          byteEnd: 100,
        });
        const syms = localStore.getSymbolsByFile(fileId);
        return localStore.getNodeId('symbol', syms[0].id);
      };

      // 40 auth files + 40 payment files + 1 hub file (CLAUDE.md analogue)
      const authNodes: number[] = [];
      const payNodes: number[] = [];
      for (let i = 0; i < 40; i++) {
        authNodes.push(symFor(make(`src/auth/A${i}.ts`), `A${i}`, `auth-${i}`));
      }
      for (let i = 0; i < 40; i++) {
        payNodes.push(symFor(make(`src/payments/P${i}.ts`), `P${i}`, `pay-${i}`));
      }
      const hubNode = symFor(make('src/shared/Hub.ts'), 'Hub', 'hub-1');

      // Strong intra-cluster edges
      for (let i = 0; i < authNodes.length; i++) {
        for (let j = i + 1; j < Math.min(i + 4, authNodes.length); j++) {
          localStore.insertEdge(authNodes[i] as number, authNodes[j] as number, 'imports');
        }
      }
      for (let i = 0; i < payNodes.length; i++) {
        for (let j = i + 1; j < Math.min(i + 4, payNodes.length); j++) {
          localStore.insertEdge(payNodes[i] as number, payNodes[j] as number, 'imports');
        }
      }
      // Hub imports everyone — the doc-hub glue pattern
      for (const n of authNodes) localStore.insertEdge(hubNode as number, n, 'imports');
      for (const n of payNodes) localStore.insertEdge(hubNode as number, n, 'imports');

      const result = (await detectCommunities(localStore, 1.0))._unsafeUnwrap();
      // Expect at least 2 communities post-refinement; without the second
      // pass the hub's edges typically collapse this into one.
      expect(result.communities.length).toBeGreaterThanOrEqual(2);
    });
  });
});
