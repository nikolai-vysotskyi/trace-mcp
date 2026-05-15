/**
 * Behavioural coverage for `suggestQueries()` in
 * `src/tools/navigation/suggest.ts` (the implementation behind the
 * `suggest_queries` MCP tool). The onboarding helper returns project stats,
 * languages, top imported files (by in-degree), top symbols (by PageRank),
 * and a list of example queries derived from the index.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { suggestQueries } from '../../../src/tools/navigation/suggest.js';
import { createTestStore } from '../../test-utils.js';

function seedRich(store: Store): void {
  // 3 TypeScript files, 1 Python file — language stats should reflect this.
  const a = store.insertFile('src/server.ts', 'typescript', 'h-a', 400);
  store.insertSymbol(a, {
    symbolId: 'src/server.ts::startServer#function',
    name: 'startServer',
    kind: 'function',
    byteStart: 0,
    byteEnd: 80,
    lineStart: 1,
    lineEnd: 10,
    signature: 'function startServer()',
  });

  const b = store.insertFile('src/router.ts', 'typescript', 'h-b', 300);
  store.insertSymbol(b, {
    symbolId: 'src/router.ts::Router#class',
    name: 'Router',
    kind: 'class',
    byteStart: 0,
    byteEnd: 60,
    lineStart: 1,
    lineEnd: 8,
    signature: 'class Router',
  });

  const c = store.insertFile('src/db.ts', 'typescript', 'h-c', 200);
  store.insertSymbol(c, {
    symbolId: 'src/db.ts::connectDB#function',
    name: 'connectDB',
    kind: 'function',
    byteStart: 0,
    byteEnd: 40,
    lineStart: 1,
    lineEnd: 5,
    signature: 'function connectDB()',
  });

  const py = store.insertFile('scripts/build.py', 'python', 'h-py', 100);
  store.insertSymbol(py, {
    symbolId: 'scripts/build.py::main#function',
    name: 'main',
    kind: 'function',
    byteStart: 0,
    byteEnd: 30,
    lineStart: 1,
    lineEnd: 5,
    signature: 'def main()',
  });

  // Wire some imports so the in-degree (top_imported_files) is non-trivial:
  //   server -> router, router -> db, server -> db
  const aNode = store.getNodeId('file', a)!;
  const bNode = store.getNodeId('file', b)!;
  const cNode = store.getNodeId('file', c)!;
  store.insertEdge(aNode, bNode, 'imports', true);
  store.insertEdge(bNode, cNode, 'imports', true);
  store.insertEdge(aNode, cNode, 'imports', true);
}

describe('suggestQueries() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('empty index returns a fully-populated empty envelope', () => {
    const result = suggestQueries(store);

    expect(result.stats).toMatchObject({
      files: 0,
      symbols: 0,
    });
    expect(result.languages).toEqual([]);
    expect(result.symbol_kinds).toEqual([]);
    expect(result.top_imported_files).toEqual([]);
    expect(result.top_symbols).toEqual([]);
    // example_queries always seeded with at least the generic context entry
    expect(Array.isArray(result.example_queries)).toBe(true);
  });

  it('envelope shape: { stats, languages, symbol_kinds, top_imported_files, top_symbols, example_queries }', () => {
    seedRich(store);
    const result = suggestQueries(store);

    expect(result.stats).toMatchObject({
      files: expect.any(Number),
      symbols: expect.any(Number),
      edges: expect.any(Number),
    });
    expect(Array.isArray(result.languages)).toBe(true);
    expect(Array.isArray(result.symbol_kinds)).toBe(true);
    expect(Array.isArray(result.top_imported_files)).toBe(true);
    expect(Array.isArray(result.top_symbols)).toBe(true);
    expect(Array.isArray(result.example_queries)).toBe(true);
  });

  it('languages reflects the indexed file languages and is sorted desc by file count', () => {
    seedRich(store);
    const result = suggestQueries(store);

    const langs = result.languages.map((l) => l.language);
    expect(langs).toContain('typescript');
    expect(langs).toContain('python');
    // TypeScript (3 files) should outrank Python (1 file).
    const tsIdx = langs.indexOf('typescript');
    const pyIdx = langs.indexOf('python');
    expect(tsIdx).toBeLessThan(pyIdx);
  });

  it('top_imported_files reflects in-degree (db.ts has 2 importers → ranks first)', () => {
    seedRich(store);
    const result = suggestQueries(store);

    expect(result.top_imported_files.length).toBeGreaterThan(0);
    // Highest in-degree is src/db.ts (imported by server.ts and router.ts).
    const topPath = result.top_imported_files[0].path;
    expect(topPath).toBe('src/db.ts');
    expect(result.top_imported_files[0].importers).toBeGreaterThanOrEqual(2);
  });

  it('top_symbols rows carry symbol_id/name/kind/file/pagerank shape', () => {
    seedRich(store);
    const result = suggestQueries(store);

    // PageRank may surface zero, one, or more symbol nodes — assert shape when present.
    for (const s of result.top_symbols) {
      expect(typeof s.symbol_id).toBe('string');
      expect(typeof s.name).toBe('string');
      expect(typeof s.kind).toBe('string');
      expect(typeof s.file).toBe('string');
      expect(typeof s.pagerank).toBe('number');
    }
  });

  it('example_queries entries each have { tool, description, params }', () => {
    seedRich(store);
    const result = suggestQueries(store);

    expect(result.example_queries.length).toBeGreaterThan(0);
    for (const q of result.example_queries) {
      expect(typeof q.tool).toBe('string');
      expect(typeof q.description).toBe('string');
      expect(typeof q.params).toBe('object');
    }
  });
});
