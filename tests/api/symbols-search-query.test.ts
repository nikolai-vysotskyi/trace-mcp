/**
 * Contract test for the `GET /api/projects/symbols` query (TRA-1064): it
 * filtered on `s.fqn`, a column that is NULL for the overwhelming majority of
 * symbols (real index: 10,695 of 10,715 rows). The query builder is run
 * against a real Store, exactly as cli.ts's route uses it — no re-typed SQL
 * string here to drift out of sync with the route.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSymbolsSearchQuery } from '../../src/api/symbols-search-query.js';
import { createTestStore } from '../test-utils.js';
import type { Store } from '../../src/db/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wireDir = path.resolve(here, '../fixtures/wire');

function seedSymbol(
  store: Store,
  opts: { fileId: number; symbolId: string; name: string; kind: string; fqn?: string | null },
) {
  store.db
    .prepare(
      `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end)
       VALUES (?, ?, ?, ?, ?, 0, 0, 1, 1)`,
    )
    .run(opts.fileId, opts.symbolId, opts.name, opts.kind, opts.fqn ?? null);
}

function seedFile(store: Store, path: string): number {
  const info = store.db
    .prepare(`INSERT INTO files (path, indexed_at) VALUES (?, datetime('now'))`)
    .run(path);
  return Number(info.lastInsertRowid);
}

describe('buildSymbolsSearchQuery', () => {
  it('finds a symbol by name when fqn is NULL — the real-world shape for ordinary symbols', () => {
    const store = createTestStore();
    const fileId = seedFile(store, 'src/daemon/project-manager.ts');
    seedSymbol(store, {
      fileId,
      symbolId: 'src/daemon/project-manager.ts::ProjectManager#class',
      name: 'ProjectManager',
      kind: 'class',
      fqn: null,
    });

    const { sql, params } = buildSymbolsSearchQuery('ProjectManager', '', 50, false);
    const rows = store.db.prepare(sql).all(...params) as Array<{
      name: string;
      fqn: string | null;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('ProjectManager');
  });

  it('still matches on fqn for the minority of symbols that have one', () => {
    const store = createTestStore();
    const fileId = seedFile(store, 'src/foo.ts');
    seedSymbol(store, {
      fileId,
      symbolId: 'src/foo.ts::Foo#class',
      name: 'Foo',
      kind: 'class',
      fqn: 'app.foo.Foo',
    });

    const { sql, params } = buildSymbolsSearchQuery('app.foo', '', 50, false);
    const rows = store.db.prepare(sql).all(...params) as Array<{ name: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Foo');
  });

  it('selects `name` so the caller has something to display even on an fqn hit', () => {
    const { sql } = buildSymbolsSearchQuery('x', '', 50, false);
    expect(sql).toMatch(/s\.name/);
  });

  it('matches the shape recorded from a live daemon (tests/fixtures/wire/symbols_search.json)', () => {
    const recorded = JSON.parse(
      readFileSync(path.join(wireDir, 'symbols_search.json'), 'utf-8'),
    ) as { symbols: Array<{ name?: string; fqn: string | null }>; count: number };
    expect(recorded.symbols.length).toBeGreaterThan(0);
    for (const s of recorded.symbols) {
      expect(typeof s.name).toBe('string');
    }
  });
});
