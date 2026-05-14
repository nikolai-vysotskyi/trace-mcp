/**
 * Behavioural coverage for `getDomainMap()` — the read view over the
 * `domains` taxonomy. We seed `domains` rows directly via DomainStore and
 * assert:
 *   - returns a hierarchical tree with name + children + symbol_count
 *   - depth parameter truncates the tree (depth=1 returns roots only with empty
 *     children, depth>=tree height returns the full nesting)
 *   - stats payload reports totalDomains + mappedSymbols + unmappedSymbols
 *   - empty index attempts auto-build; with no symbols the tree stays empty
 *     and does not throw
 *   - every tree node carries id, name, description, confidence, children,
 *     symbol_count
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { DomainStore, type DomainTreeNode } from '../../../src/intent/domain-store.js';
import { getDomainMap } from '../../../src/tools/advanced/intent.js';
import { createTestStore } from '../../test-utils.js';

/**
 * LATENT BUG WORKAROUND: src/db/schema.ts DDL omits the domains/symbol_domains
 * tables introduced in migration v11. Fresh `:memory:` DBs run DDL once and
 * mark every migration as already applied, so the domain tables never get
 * created. We re-apply the v11 SQL manually here to keep the test
 * representative of a real index. If this is fixed in DDL the workaround
 * becomes a no-op.
 */
function ensureDomainTables(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS domains (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        parent_id   INTEGER REFERENCES domains(id) ON DELETE SET NULL,
        description TEXT,
        path_hints  TEXT,
        confidence  REAL NOT NULL DEFAULT 1.0,
        is_manual   INTEGER NOT NULL DEFAULT 0,
        metadata    TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(name, parent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_domains_parent ON domains(parent_id);

    CREATE TABLE IF NOT EXISTS symbol_domains (
        id          INTEGER PRIMARY KEY,
        symbol_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        relevance   REAL NOT NULL DEFAULT 1.0,
        is_manual   INTEGER NOT NULL DEFAULT 0,
        inferred_by TEXT NOT NULL DEFAULT 'heuristic',
        metadata    TEXT,
        UNIQUE(symbol_id, domain_id)
    );
    CREATE INDEX IF NOT EXISTS idx_symbol_domains_symbol ON symbol_domains(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_domains_domain ON symbol_domains(domain_id);

    CREATE TABLE IF NOT EXISTS file_domains (
        id          INTEGER PRIMARY KEY,
        file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        domain_id   INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        relevance   REAL NOT NULL DEFAULT 1.0,
        is_manual   INTEGER NOT NULL DEFAULT 0,
        inferred_by TEXT NOT NULL DEFAULT 'heuristic',
        UNIQUE(file_id, domain_id)
    );
    CREATE INDEX IF NOT EXISTS idx_file_domains_file ON file_domains(file_id);
    CREATE INDEX IF NOT EXISTS idx_file_domains_domain ON file_domains(domain_id);

    CREATE TABLE IF NOT EXISTS domain_embeddings (
        domain_id   INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
        embedding   BLOB NOT NULL
    );
  `);
}

interface Fixture {
  store: Store;
  domainStore: DomainStore;
  paymentsId: number;
  refundsId: number;
  taxId: number;
  shippingId: number;
}

/**
 * Build a 3-level taxonomy:
 *   payments (root)
 *     refunds
 *       tax           ← depth 3
 *   shipping (root)
 */
function seed(): Fixture {
  const store = createTestStore();
  ensureDomainTables(store);
  const domainStore = new DomainStore(store.db);

  const paymentsId = domainStore.upsertDomain({
    name: 'payments',
    description: 'Money in',
    confidence: 0.9,
  });
  const refundsId = domainStore.upsertDomain({
    name: 'refunds',
    parentId: paymentsId,
    description: 'Money out',
    confidence: 0.8,
  });
  const taxId = domainStore.upsertDomain({
    name: 'tax',
    parentId: refundsId,
    description: 'Government cut',
    confidence: 0.7,
  });
  const shippingId = domainStore.upsertDomain({
    name: 'shipping',
    description: 'Atoms',
    confidence: 0.85,
  });

  // Insert a file + a couple of symbols so DomainBuilder.buildAll (which only
  // fires on empty trees) does not mutate the tree we just built.
  const fid = store.insertFile('src/payments/index.ts', 'typescript', 'h-p', 100);
  store.insertSymbol(fid, {
    symbolId: 'src/payments/index.ts::chargeFn#function',
    name: 'chargeFn',
    kind: 'function',
    fqn: 'chargeFn',
    byteStart: 0,
    byteEnd: 30,
    lineStart: 1,
    lineEnd: 4,
  });

  return { store, domainStore, paymentsId, refundsId, taxId, shippingId };
}

function findNode(tree: DomainTreeNode[], name: string): DomainTreeNode | undefined {
  for (const node of tree) {
    if (node.name === name) return node;
    const inChild = findNode(node.children, name);
    if (inChild) return inChild;
  }
  return undefined;
}

describe('getDomainMap() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('returns a hierarchical tree with two roots and nested children', async () => {
    const result = await getDomainMap(ctx.store);
    expect(result.isOk()).toBe(true);
    const payload = result._unsafeUnwrap();
    expect(Array.isArray(payload.domains)).toBe(true);

    // Two roots: payments + shipping.
    const rootNames = new Set(payload.domains.map((d) => d.name));
    expect(rootNames.has('payments')).toBe(true);
    expect(rootNames.has('shipping')).toBe(true);

    // payments contains refunds, refunds contains tax.
    const payments = findNode(payload.domains, 'payments')!;
    expect(payments.children.map((c) => c.name)).toContain('refunds');
    const refunds = findNode(payload.domains, 'refunds')!;
    expect(refunds.children.map((c) => c.name)).toContain('tax');
  });

  it('every tree node carries id, name, description, confidence, children, symbol_count', async () => {
    const result = await getDomainMap(ctx.store);
    const tree = result._unsafeUnwrap().domains;
    function walk(nodes: DomainTreeNode[]): void {
      for (const n of nodes) {
        expect(typeof n.id).toBe('number');
        expect(typeof n.name).toBe('string');
        expect(typeof n.confidence).toBe('number');
        expect(Array.isArray(n.children)).toBe(true);
        expect(typeof n.symbol_count).toBe('number');
        // description may be null but the field must be present on the row.
        expect('description' in n).toBe(true);
        walk(n.children);
      }
    }
    walk(tree);
  });

  it('depth=1 trims the tree to root-only (children arrays empty)', async () => {
    const shallow = await getDomainMap(ctx.store, { depth: 1 });
    expect(shallow.isOk()).toBe(true);
    const tree = shallow._unsafeUnwrap().domains;
    expect(tree.length).toBeGreaterThan(0);
    for (const root of tree) {
      expect(root.children).toEqual([]);
    }
  });

  it('depth=3 surfaces grandchild nodes (tax under refunds under payments)', async () => {
    const deep = await getDomainMap(ctx.store, { depth: 3 });
    expect(deep.isOk()).toBe(true);
    const tree = deep._unsafeUnwrap().domains;
    const payments = findNode(tree, 'payments')!;
    expect(payments.children.length).toBeGreaterThan(0);
    const refunds = payments.children.find((c) => c.name === 'refunds')!;
    expect(refunds).toBeDefined();
    expect(refunds.children.map((c) => c.name)).toContain('tax');
  });

  it('stats payload reports totalDomains + mappedSymbols + unmappedSymbols', async () => {
    const result = await getDomainMap(ctx.store);
    const stats = result._unsafeUnwrap().stats;
    expect(typeof stats.totalDomains).toBe('number');
    expect(typeof stats.mappedSymbols).toBe('number');
    expect(typeof stats.unmappedSymbols).toBe('number');
    // We seeded 4 domains directly.
    expect(stats.totalDomains).toBe(4);
  });

  it('empty index with no symbols returns empty tree without throwing', async () => {
    const empty = createTestStore();
    ensureDomainTables(empty);
    const result = await getDomainMap(empty);
    expect(result.isOk()).toBe(true);
    const payload = result._unsafeUnwrap();
    // No domains, no symbols → empty tree, stats all zero (or near zero).
    expect(payload.domains).toEqual([]);
    expect(payload.stats.totalDomains).toBe(0);
  });
});
