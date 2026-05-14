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
    const result = await getDomainMap(empty);
    expect(result.isOk()).toBe(true);
    const payload = result._unsafeUnwrap();
    // No domains, no symbols → empty tree, stats all zero (or near zero).
    expect(payload.domains).toEqual([]);
    expect(payload.stats.totalDomains).toBe(0);
  });
});
