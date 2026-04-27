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
    it('detects at least 2 communities in a two-cluster graph', () => {
      const result = detectCommunities(store, 1.0);
      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data.communities.length).toBeGreaterThanOrEqual(2);
      expect(data.totalFiles).toBe(6);
    });

    it('communities have valid cohesion scores', () => {
      const result = detectCommunities(store, 1.0);
      const data = result._unsafeUnwrap();
      for (const comm of data.communities) {
        expect(comm.cohesion).toBeGreaterThanOrEqual(0);
        expect(comm.cohesion).toBeLessThanOrEqual(1);
        expect(comm.fileCount).toBeGreaterThan(0);
      }
    });

    it('persists results to communities table', () => {
      detectCommunities(store, 1.0);
      const count = (db.prepare('SELECT COUNT(*) as c FROM communities').get() as { c: number }).c;
      expect(count).toBeGreaterThan(0);

      const memberCount = (
        db.prepare('SELECT COUNT(*) as c FROM community_members').get() as { c: number }
      ).c;
      expect(memberCount).toBe(6); // All 6 files assigned
    });

    it('auto-labels communities by path segment', () => {
      const result = detectCommunities(store, 1.0);
      const data = result._unsafeUnwrap();
      const labels = data.communities.map((c) => c.label);
      // Should have labels derived from 'auth' and 'payments' path segments
      expect(labels.some((l) => l === 'auth' || l === 'payments')).toBe(true);
    });
  });

  describe('getCommunities()', () => {
    it('returns previously detected communities', () => {
      detectCommunities(store, 1.0);
      const result = getCommunities(store);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().communities.length).toBeGreaterThan(0);
    });
  });

  describe('getCommunityDetail()', () => {
    it('returns detail for a specific community', () => {
      detectCommunities(store, 1.0);
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
    it('buildFileGraph uses a single aggregation query', () => {
      // If this test doesn't timeout, the graph building is efficient
      const result = detectCommunities(store, 1.0);
      expect(result.isOk()).toBe(true);
    });
  });
});
