/**
 * Behavioural coverage for `getFileOutline()` (the `get_outline` MCP tool).
 * Asserts ordering, scoping to the requested file, and contract for
 * non-existent paths.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getFileOutline } from '../../../src/tools/navigation/navigation.js';
import { createTestStore } from '../../test-utils.js';

function seed(store: Store): void {
  const fileA = store.insertFile('src/services/auth.ts', 'typescript', 'h1', 500);
  // Insert deliberately out of line order to exercise the "ordered by line_start" assertion.
  store.insertSymbol(fileA, {
    symbolId: 'src/services/auth.ts::logout#method',
    name: 'logout',
    kind: 'method',
    fqn: 'AuthService.logout',
    byteStart: 200,
    byteEnd: 250,
    lineStart: 40,
    lineEnd: 50,
  });
  store.insertSymbol(fileA, {
    symbolId: 'src/services/auth.ts::AuthService#class',
    name: 'AuthService',
    kind: 'class',
    fqn: 'AuthService',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 30,
  });
  store.insertSymbol(fileA, {
    symbolId: 'src/services/auth.ts::login#method',
    name: 'login',
    kind: 'method',
    fqn: 'AuthService.login',
    byteStart: 60,
    byteEnd: 120,
    lineStart: 10,
    lineEnd: 20,
  });

  // Second file — outline of fileA must not leak symbols from fileB.
  const fileB = store.insertFile('src/utils/format.ts', 'typescript', 'h2', 300);
  store.insertSymbol(fileB, {
    symbolId: 'src/utils/format.ts::formatCurrency#function',
    name: 'formatCurrency',
    kind: 'function',
    fqn: 'formatCurrency',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
  });
}

describe('getFileOutline() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seed(store);
  });

  it('returns symbols ordered by lineStart ascending', () => {
    const result = getFileOutline(store, 'src/services/auth.ts');
    expect(result.isOk()).toBe(true);
    const outline = result._unsafeUnwrap();
    expect(outline.symbols.length).toBeGreaterThanOrEqual(3);

    const linesNotNull = outline.symbols
      .map((s) => s.lineStart)
      .filter((n): n is number => typeof n === 'number');
    expect(linesNotNull.length).toBeGreaterThan(0);
    for (let i = 1; i < linesNotNull.length; i++) {
      expect(linesNotNull[i - 1]).toBeLessThanOrEqual(linesNotNull[i]);
    }
  });

  it('returns the `path` that was queried', () => {
    const result = getFileOutline(store, 'src/services/auth.ts');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().path).toBe('src/services/auth.ts');
  });

  it('returns NOT_FOUND error for a non-existent path', () => {
    const result = getFileOutline(store, 'src/does/not/exist.ts');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });

  it('only returns symbols belonging to the queried file', () => {
    const result = getFileOutline(store, 'src/services/auth.ts');
    expect(result.isOk()).toBe(true);
    const names = result._unsafeUnwrap().symbols.map((s) => s.name);
    // formatCurrency belongs to a different file and must not leak in.
    expect(names).not.toContain('formatCurrency');
    expect(names).toContain('AuthService');
  });

  it('each symbol carries name + kind + lineStart', () => {
    const result = getFileOutline(store, 'src/services/auth.ts');
    expect(result.isOk()).toBe(true);
    for (const sym of result._unsafeUnwrap().symbols) {
      expect(typeof sym.name).toBe('string');
      expect(typeof sym.kind).toBe('string');
      // lineStart may be null for some plugin emissions but for our fixture
      // we always supply it.
      expect(typeof sym.lineStart).toBe('number');
    }
  });
});
