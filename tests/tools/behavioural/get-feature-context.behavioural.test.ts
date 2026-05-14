/**
 * Behavioural coverage for `getFeatureContext()`. Uses an in-memory Store with
 * hand-built file + symbol fixtures so we can assert the output contract
 * ({ description, items, totalTokens, truncated }) without relying on the
 * indexing pipeline.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getFeatureContext } from '../../../src/tools/navigation/context.js';
import { createTestStore } from '../../test-utils.js';

function seed(store: Store): void {
  const authFile = store.insertFile('src/services/auth.ts', 'typescript', 'h-auth', 500);
  store.insertSymbol(authFile, {
    symbolId: 'src/services/auth.ts::AuthService#class',
    name: 'AuthService',
    kind: 'class',
    fqn: 'AuthService',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 10,
    signature: 'class AuthService',
  });
  store.insertSymbol(authFile, {
    symbolId: 'src/services/auth.ts::login#method',
    name: 'login',
    kind: 'method',
    fqn: 'AuthService.login',
    byteStart: 90,
    byteEnd: 180,
    lineStart: 12,
    lineEnd: 20,
    signature: 'login(user: string, password: string): Promise<Token>',
  });

  const utilFile = store.insertFile('src/utils/format.ts', 'typescript', 'h-fmt', 300);
  store.insertSymbol(utilFile, {
    symbolId: 'src/utils/format.ts::formatCurrency#function',
    name: 'formatCurrency',
    kind: 'function',
    fqn: 'formatCurrency',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
    signature: 'function formatCurrency(amount: number): string',
  });
}

describe('getFeatureContext() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seed(store);
  });

  it('returns shape { description, items, totalTokens, truncated } for a hit', () => {
    const result = getFeatureContext(store, process.cwd(), 'auth service login');
    expect(result.description).toBe('auth service login');
    expect(Array.isArray(result.items)).toBe(true);
    expect(typeof result.totalTokens).toBe('number');
    expect(typeof result.truncated).toBe('boolean');
  });

  it('finds relevant symbols by NL description', () => {
    const result = getFeatureContext(store, process.cwd(), 'authentication login service');
    expect(result.items.length).toBeGreaterThan(0);
    const names = result.items.map((i) => i.name);
    // At least one of the AuthService symbols should be surfaced
    expect(names.some((n) => n === 'AuthService' || n === 'login')).toBe(true);
  });

  it('items carry the documented per-item shape', () => {
    const result = getFeatureContext(store, process.cwd(), 'login formatCurrency');
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(typeof item.symbolId).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(typeof item.kind).toBe('string');
      expect(typeof item.filePath).toBe('string');
      expect(typeof item.score).toBe('number');
      expect(['full', 'no_source', 'signature_only']).toContain(item.detail);
      expect(typeof item.content).toBe('string');
      expect(typeof item.tokens).toBe('number');
    }
  });

  it('empty / no-match description returns { items: [], totalTokens: 0, truncated: false }', () => {
    const result = getFeatureContext(
      store,
      process.cwd(),
      'totallyNonexistentSymbolNameNoneShouldMatch',
    );
    expect(result.items).toEqual([]);
    expect(result.totalTokens).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('description with only stopwords yields empty items (tokenizer drops them)', () => {
    const result = getFeatureContext(store, process.cwd(), 'the a an is of in for');
    expect(result.items).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  it('respects tokenBudget (totalTokens does not exceed budget)', () => {
    const tight = getFeatureContext(store, process.cwd(), 'AuthService login format', 200);
    expect(tight.totalTokens).toBeLessThanOrEqual(200);
  });
});
