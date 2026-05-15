/**
 * Behavioural coverage for `queryByIntent()` in
 * `src/tools/advanced/intent.ts` (the implementation behind the
 * `query_by_intent` MCP tool). Maps a NL business question to
 * symbols + their (heuristic) domain assignment.
 *
 * Output envelope: { query, symbols: [{ symbol_id, name, kind, file,
 * domain, relevance }], domains_touched }
 *
 * Without a built domain taxonomy, the FTS path runs and returns
 * symbols with domain="uncategorized" and relevance=0.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { queryByIntent } from '../../../src/tools/advanced/intent.js';
import { createTestStore } from '../../test-utils.js';

function seedPaymentsCode(store: Store): void {
  const paymentsFile = store.insertFile('src/payments/processor.ts', 'typescript', 'h-pay', 500);
  store.insertSymbol(paymentsFile, {
    symbolId: 'src/payments/processor.ts::processPayment#function',
    name: 'processPayment',
    kind: 'function',
    fqn: 'processPayment',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 10,
    signature: 'function processPayment(amount: number, currency: string): Promise<void>',
  });
  store.insertSymbol(paymentsFile, {
    symbolId: 'src/payments/processor.ts::refund#function',
    name: 'refund',
    kind: 'function',
    fqn: 'refund',
    byteStart: 100,
    byteEnd: 180,
    lineStart: 12,
    lineEnd: 20,
    signature: 'function refund(transactionId: string): Promise<void>',
  });

  const userFile = store.insertFile('src/users/service.ts', 'typescript', 'h-usr', 400);
  store.insertSymbol(userFile, {
    symbolId: 'src/users/service.ts::createUser#function',
    name: 'createUser',
    kind: 'function',
    fqn: 'createUser',
    byteStart: 0,
    byteEnd: 60,
    lineStart: 1,
    lineEnd: 6,
    signature: 'function createUser(email: string): Promise<User>',
  });
}

describe('queryByIntent() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns envelope shape { query, symbols, domains_touched } on hit', () => {
    seedPaymentsCode(store);
    const result = queryByIntent(store, 'process payment');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.query).toBe('process payment');
    expect(Array.isArray(result.value.symbols)).toBe(true);
    expect(Array.isArray(result.value.domains_touched)).toBe(true);
  });

  it('each symbol carries { symbol_id, name, kind, file, domain, relevance }', () => {
    seedPaymentsCode(store);
    const result = queryByIntent(store, 'processPayment');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.symbols.length).toBeGreaterThan(0);
    for (const s of result.value.symbols) {
      expect(typeof s.symbol_id).toBe('string');
      expect(typeof s.name).toBe('string');
      expect(typeof s.kind).toBe('string');
      expect(typeof s.file).toBe('string');
      expect(typeof s.domain).toBe('string');
      expect(typeof s.relevance).toBe('number');
    }
  });

  it('honors the limit option', () => {
    seedPaymentsCode(store);
    const result = queryByIntent(store, 'function user payment', { limit: 1 });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.symbols.length).toBeLessThanOrEqual(1);
  });

  it('default limit caps results at 15', () => {
    // Seed 25 symbols so we can verify the default cap.
    const f = store.insertFile('src/many.ts', 'typescript', 'h-many', 3000);
    for (let i = 0; i < 25; i++) {
      store.insertSymbol(f, {
        symbolId: `src/many.ts::helper${i}#function`,
        name: `helper${i}`,
        kind: 'function',
        byteStart: i * 50,
        byteEnd: i * 50 + 50,
        lineStart: i + 1,
        lineEnd: i + 1,
        signature: `function helper${i}()`,
      });
    }
    const result = queryByIntent(store, 'helper');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.symbols.length).toBeLessThanOrEqual(15);
  });

  it('empty index returns empty symbols + empty domains_touched', () => {
    const result = queryByIntent(store, 'anything at all');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.symbols).toEqual([]);
    expect(result.value.domains_touched).toEqual([]);
  });

  it('unknown query against seeded index returns 0 symbols (FTS miss)', () => {
    seedPaymentsCode(store);
    const result = queryByIntent(store, 'totallyUnrelatedTermXyzzy');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.symbols).toEqual([]);
  });
});
