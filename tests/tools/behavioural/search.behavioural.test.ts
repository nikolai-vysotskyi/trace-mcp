/**
 * Behavioural coverage for the canonical `search()` lexical+fusion tool.
 * Focuses on input/output contract: filters, ranking shape, empty-result
 * behaviour. Uses in-memory Store fixtures rather than the MCP wire.
 *
 * NOTE on shape: the raw `SearchResult.items[]` returned by `search()` carries
 * `{ symbol: SymbolRow, file: FileRow, score: number }` — the projected/flat
 * `{ symbol_id, name, kind, file, line, score }` shape is applied by the MCP
 * register layer. Behavioural tests run against the raw call so they assert
 * the underlying shape.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { indexTrigramsBatch } from '../../../src/db/fuzzy.js';
import { Store } from '../../../src/db/store.js';
import { search } from '../../../src/tools/navigation/navigation.js';
import { createTestStore } from '../../test-utils.js';

function seed(store: Store): void {
  // typescript file
  const tsFileId = store.insertFile('src/services/auth.ts', 'typescript', 'h1', 500);
  const sym1 = store.insertSymbol(tsFileId, {
    symbolId: 'src/services/auth.ts::AuthService#class',
    name: 'AuthService',
    kind: 'class',
    fqn: 'AuthService',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 20,
  });
  const sym2 = store.insertSymbol(tsFileId, {
    symbolId: 'src/services/auth.ts::login#method',
    name: 'login',
    kind: 'method',
    fqn: 'AuthService.login',
    byteStart: 110,
    byteEnd: 200,
    lineStart: 22,
    lineEnd: 30,
  });

  // python file with a similarly-named symbol (class, different language)
  const pyFileId = store.insertFile('src/auth_service.py', 'python', 'h2', 400);
  const sym3 = store.insertSymbol(pyFileId, {
    symbolId: 'src/auth_service.py::AuthService#class',
    name: 'AuthService',
    kind: 'class',
    fqn: 'auth_service.AuthService',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 15,
  });

  // unrelated function in another file
  const utilFileId = store.insertFile('src/utils/format.ts', 'typescript', 'h3', 300);
  const sym4 = store.insertSymbol(utilFileId, {
    symbolId: 'src/utils/format.ts::formatCurrency#function',
    name: 'formatCurrency',
    kind: 'function',
    fqn: 'formatCurrency',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
  });

  indexTrigramsBatch(store.db, [
    { id: sym1, name: 'AuthService', fqn: 'AuthService' },
    { id: sym2, name: 'login', fqn: 'AuthService.login' },
    { id: sym3, name: 'AuthService', fqn: 'auth_service.AuthService' },
    { id: sym4, name: 'formatCurrency', fqn: 'formatCurrency' },
  ]);
}

describe('search() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
    seed(store);
  });

  it('returns hits with raw item shape { symbol, file, score }', async () => {
    const result = await search(store, 'AuthService');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);

    for (const item of result.items) {
      expect(item.symbol).toBeDefined();
      expect(typeof item.symbol.name).toBe('string');
      expect(typeof item.symbol.kind).toBe('string');
      expect(item.file).toBeDefined();
      expect(typeof item.file.path).toBe('string');
      expect(typeof item.score).toBe('number');
    }
  });

  it('results are sorted by score descending', async () => {
    const result = await search(store, 'AuthService');
    expect(result.items.length).toBeGreaterThan(1);
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].score).toBeGreaterThanOrEqual(result.items[i].score);
    }
  });

  it('respects `kind` filter', async () => {
    const result = await search(store, 'AuthService', { kind: 'class' });
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.symbol.kind).toBe('class');
    }
  });

  it('respects `language` filter', async () => {
    const result = await search(store, 'AuthService', { language: 'python' });
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.file.language).toBe('python');
      expect(item.file.path.endsWith('.py')).toBe(true);
    }
  });

  it('respects `filePattern` filter', async () => {
    const result = await search(store, 'AuthService', { filePattern: 'src/services/' });
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.file.path).toContain('src/services/');
    }
  });

  it('fuzzy=true on misspelling still hits an indexed symbol', async () => {
    const result = await search(
      store,
      'AuthServce', // missing 'i'
      undefined,
      20,
      0,
      undefined,
      { fuzzy: true },
    );
    expect(result.items.length).toBeGreaterThan(0);
    const names = result.items.map((i) => i.symbol.name);
    expect(names).toContain('AuthService');
  });

  it('no-match query returns empty items + total=0 (does not throw)', async () => {
    const result = await search(store, 'thisStringDefinitelyDoesNotExistAnywhere');
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(0);
    expect(result.total).toBe(0);
  });
});
