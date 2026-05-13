/**
 * SearchBundlesRetriever ↔ direct-call equivalence tests.
 *
 * Migration slice 2 of the search-tool migration arc. Behaviour-preserving
 * refactor — the new retriever returns the exact same list as a direct
 * `searchBundles()` call. The bundle handles are constructed in-memory
 * here so the tests stay hermetic (no on-disk manifest required).
 *
 * Coverage matrix:
 *   1. literal query matches multiple bundles
 *   2. kind filter (class only)
 *   3. limit caps the result set
 *   4. empty result when query matches nothing
 *   5. no bundles installed → empty result
 *   6. retriever exposes a stable `name`
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchBundles } from '../../bundles.js';
import {
  createSearchBundlesRetriever,
  type SearchBundlesQuery,
} from '../retrievers/search-bundles-retriever.js';
import { runRetriever } from '../types.js';

interface LoadedBundle {
  package: string;
  version: string;
  db: Database.Database;
}

/**
 * Build the minimal subset of the bundle schema `searchBundles` queries
 * against. Mirrors what `exportBundle` emits in `src/bundles.ts`.
 */
function createInMemoryBundle(
  pkg: string,
  version: string,
  symbols: Array<{
    symbol_id: string;
    name: string;
    kind: string;
    fqn: string | null;
    signature: string | null;
    file: string;
    line: number | null;
  }>,
): LoadedBundle {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT);
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY,
      file_id INTEGER REFERENCES files(id),
      symbol_id TEXT,
      name TEXT,
      kind TEXT,
      fqn TEXT,
      signature TEXT,
      line_start INTEGER
    );
  `);
  const insertFile = db.prepare('INSERT INTO files (path) VALUES (?)');
  const insertSymbol = db.prepare(
    'INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, signature, line_start) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const fileIdCache = new Map<string, number>();
  for (const s of symbols) {
    let fileId = fileIdCache.get(s.file);
    if (fileId === undefined) {
      const r = insertFile.run(s.file);
      fileId = Number(r.lastInsertRowid);
      fileIdCache.set(s.file, fileId);
    }
    insertSymbol.run(fileId, s.symbol_id, s.name, s.kind, s.fqn, s.signature, s.line);
  }
  return { package: pkg, version, db };
}

function seedBundles(): LoadedBundle[] {
  return [
    createInMemoryBundle('react', '18.2.0', [
      {
        symbol_id: 'react::useState',
        name: 'useState',
        kind: 'function',
        fqn: 'react::useState',
        signature: 'function useState<S>(...)',
        file: 'react/index.d.ts',
        line: 100,
      },
      {
        symbol_id: 'react::Component',
        name: 'Component',
        kind: 'class',
        fqn: 'react::Component',
        signature: 'class Component',
        file: 'react/index.d.ts',
        line: 200,
      },
    ]),
    createInMemoryBundle('react-dom', '18.2.0', [
      {
        symbol_id: 'react-dom::createRoot',
        name: 'createRoot',
        kind: 'function',
        fqn: 'react-dom::createRoot',
        signature: 'function createRoot(container)',
        file: 'react-dom/client.d.ts',
        line: 10,
      },
    ]),
  ];
}

async function runViaRetriever(bundles: LoadedBundle[], q: SearchBundlesQuery): Promise<unknown[]> {
  const retriever = createSearchBundlesRetriever({ bundles });
  const [out] = await runRetriever(retriever, q);
  return out ?? [];
}

describe('SearchBundlesRetriever ↔ direct-call equivalence', () => {
  let bundles: LoadedBundle[];

  beforeEach(() => {
    bundles = seedBundles();
  });

  afterEach(() => {
    for (const b of bundles) b.db.close();
  });

  it('case 1: literal query — same matches as direct call', async () => {
    const direct = searchBundles(bundles, 'use');
    const via = await runViaRetriever(bundles, { query: 'use' });
    expect(via).toEqual(direct);
    expect(direct.length).toBeGreaterThan(0);
  });

  it('case 2: kind filter (class only)', async () => {
    const direct = searchBundles(bundles, 'Component', { kind: 'class' });
    const via = await runViaRetriever(bundles, { query: 'Component', kind: 'class' });
    expect(via).toEqual(direct);
    for (const item of direct) expect(item.kind).toBe('class');
  });

  it('case 3: limit caps the result set', async () => {
    const direct = searchBundles(bundles, 'e', { limit: 1 });
    const via = await runViaRetriever(bundles, { query: 'e', limit: 1 });
    expect(via).toEqual(direct);
    expect(direct.length).toBeLessThanOrEqual(1);
  });

  it('case 4: empty result on unmatched query', async () => {
    const direct = searchBundles(bundles, 'zzz-no-such-symbol');
    const via = await runViaRetriever(bundles, { query: 'zzz-no-such-symbol' });
    expect(via).toEqual(direct);
    expect(direct).toEqual([]);
  });

  it('case 5: no bundles installed → empty result', async () => {
    const direct = searchBundles([], 'anything');
    const via = await runViaRetriever([], { query: 'anything' });
    expect(via).toEqual(direct);
    expect(direct).toEqual([]);
  });

  it('exposes name "search_bundles_tool" for registry routing', () => {
    const retriever = createSearchBundlesRetriever({ bundles });
    expect(retriever.name).toBe('search_bundles_tool');
  });
});
