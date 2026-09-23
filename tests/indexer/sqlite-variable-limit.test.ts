/**
 * Regression guard for TRA-1005: unbounded `IN (?, ?, ...)` lists against
 * SQLite on large indexes (>16k files / >32k symbols).
 *
 * Two ceilings conspired here:
 *  - SQLITE_MAX_VARIABLE_NUMBER (32 766): `WHERE id IN (${placeholders})`
 *    throws `SqliteError: too many SQL variables` past ~32k ids — and at
 *    ~16k when the same array feeds TWO `IN` lists in one statement
 *    (`getAllOrmAssociations` spread `...fileIds, ...fileIds`).
 *  - V8's argument ceiling (~65k): `.all(...ids)` over the whole array
 *    throws `RangeError: Maximum call stack size exceeded`.
 *
 * Every case below passes an index-sized id list (35 000 / 18 000 — just
 * past each ceiling) and asserts no throw. Repository cases additionally
 * assert the real rows still come back, proving chunk accumulation neither
 * drops nor duplicates rows. The fake ids (1 000 000+) match no file, so
 * these run in milliseconds against an in-memory DB: the crash fired at
 * bind time, long before any row was read.
 */
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/db/store.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { EdgeResolver } from '../../src/indexer/edge-resolver.js';
import { resolveMemberOfEdges } from '../../src/indexer/edge-resolvers/member-of.js';
import { resolveTypeScriptCallEdges } from '../../src/indexer/edge-resolvers/typescript-calls.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import type { ChangeScope, RawEdge } from '../../src/plugin-api/types.js';

// Just past SQLITE_MAX_VARIABLE_NUMBER (32 766).
const N_IDS = 35_000;
// Just past the double-fed ceiling (2 x 16 384 > 32 766).
const N_ORM_IDS = 18_000;

function testStore(): Store {
  return new Store(initializeDatabase(':memory:'));
}

function fakeIds(n: number): number[] {
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = 1_000_000 + i;
  return out;
}

function scopeWith(extra: number[] = [], n = N_IDS): ChangeScope {
  return { changedFileIds: new Set([...extra, ...fakeIds(n)]) } as ChangeScope;
}

function stateFor(store: Store, workspaces: PipelineState['workspaces'] = []): PipelineState {
  return { store, workspaces } as unknown as PipelineState;
}

function edgeTypeId(store: Store, name: string): number {
  const row = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get(name) as
    | { id: number }
    | undefined;
  expect(
    row,
    `seed edge_types row '${name}' must exist (else the resolver early-returns)`,
  ).toBeTruthy();
  return row!.id;
}

describe('SQLite variable / V8 spread limits (TRA-1005)', () => {
  it('resolveTypeScriptCallEdges survives a 35 000-file scope', () => {
    const store = testStore();
    edgeTypeId(store, 'calls');
    edgeTypeId(store, 'imports');

    const fileId = store.insertFile('src/a.ts', 'typescript', 'h1', 10, null, null);
    store.insertSymbol(fileId, {
      name: 'caller',
      kind: 'function',
      metadata: { callSites: [{ name: 'missing', line: 1 }] },
    });

    // Must not throw SqliteError (too many SQL variables) or RangeError.
    // The target is missing on purpose — resolution misses are orthogonal;
    // this guards the scoped source SELECT + the scoped import-map lookup.
    expect(() => resolveTypeScriptCallEdges(stateFor(store), scopeWith([fileId]))).not.toThrow();
  });

  it('resolveMemberOfEdges survives a 35 000-file scope and still links members', () => {
    const store = testStore();
    const memberOfId = edgeTypeId(store, 'member_of');

    const fileId = store.insertFile('src/c.ts', 'typescript', 'h1', 10, null, null);
    store.insertSymbols(fileId, [
      { name: 'C', kind: 'class', symbolId: 't1005::C#class' },
      { name: 'm', kind: 'method', symbolId: 't1005::m#method', parentSymbolId: 't1005::C#class' },
    ]);

    expect(() => resolveMemberOfEdges(stateFor(store), scopeWith([fileId]))).not.toThrow();

    const n = (
      store.db
        .prepare(`SELECT COUNT(*) AS c FROM edges WHERE edge_type_id = ?`)
        .get(memberOfId) as {
        c: number;
      }
    ).c;
    expect(n).toBe(1);
  });

  it('getSymbolsWithHeritage survives 35 000 file ids and returns every heritage row', () => {
    const store = testStore();

    const wanted: string[] = [];
    for (const [path, cls] of [
      ['src/a.ts', 'A'],
      ['src/b.ts', 'B'],
    ] as const) {
      const fileId = store.insertFile(path, 'typescript', `h-${path}`, 10, null, null);
      store.insertSymbol(fileId, {
        name: cls,
        kind: 'class',
        metadata: { extends: 'Base' },
      });
      wanted.push(path);
    }

    const rows = store.getSymbolsWithHeritage([
      ...store.db
        .prepare(`SELECT id FROM files`)
        .all()
        .map((r) => (r as { id: number }).id),
      ...fakeIds(N_IDS),
    ]);

    expect(rows.map((r) => r.file_path).sort()).toEqual(wanted);
  });

  it('getAllOrmAssociations survives 18 000 file ids (double-fed IN lists)', () => {
    const store = testStore();

    const fileId = store.insertFile('src/models.ts', 'typescript', 'h1', 10, null, null);
    const modelId = store.insertOrmModel({ name: 'User', orm: 'prisma' }, fileId);
    store.insertOrmAssociation(modelId, modelId, 'User', 'belongsTo', undefined, fileId);
    // Unresolved-by-construction row (target_model_id NULL): exercises the
    // second IN list (target names of models in the changed files).
    store.insertOrmAssociation(modelId, null, 'User', 'hasMany', undefined, fileId);

    const rows = store.getAllOrmAssociations([fileId, ...fakeIds(N_ORM_IDS)]);
    expect(rows).toHaveLength(2);
  });

  it('getAllOrmAssociations dedupes rows matched in two chunks (cross-chunk file_id + target-name)', () => {
    const store = testStore();

    const a = store.insertFile('src/a.ts', 'typescript', 'h1', 10, null, null);
    const b = store.insertFile('src/b.ts', 'typescript', 'h2', 10, null, null);
    const source = store.insertOrmModel({ name: 'Source', orm: 'prisma' }, a);
    store.insertOrmModel({ name: 'Target', orm: 'prisma' }, b);
    store.insertOrmAssociation(source, null, 'Target', 'hasMany', undefined, a);

    // CHUNK = 500: chunk 1 holds A (+ 499 phantoms) and matches the row via
    // `file_id`; chunk 2 holds B and matches the SAME row via the
    // target-model-name branch. The single-statement original returned it
    // once — chunk accumulation must too.
    const ids = [a, ...fakeIds(499), b];
    expect(ids).toHaveLength(501);
    const ph = ids.map(() => '?').join(',');
    const original = store.db
      .prepare(
        `SELECT * FROM orm_associations WHERE file_id IN (${ph}) OR (target_model_id IS NULL AND target_model_name IN (SELECT name FROM orm_models WHERE file_id IN (${ph})))`,
      )
      .all(...ids, ...ids);
    expect(original).toHaveLength(1);
    expect(store.getAllOrmAssociations(ids)).toHaveLength(1);
  });

  it('EdgeResolver.storeRawEdges survives multi-chunk symbol/node batches', () => {
    const store = testStore();
    edgeTypeId(store, 'calls');

    // 1 200 symbols > CHUNK (900): the symbol_id pre-load runs 2 chunks.
    const fileId = store.insertFile('src/big.ts', 'typescript', 'h1', 10, null, null);
    const syms = Array.from({ length: 1200 }, (_, i) => ({
      name: `fn${i}`,
      kind: 'function' as const,
      symbolId: `t1005::fn${i}#function`,
    }));
    store.insertSymbols(fileId, syms);

    // 2 000 edges over 1 200 distinct symbols + node workspace pre-load with
    // workspaces set: both chunked lookups run multiple chunks.
    const edges: RawEdge[] = Array.from({ length: 2000 }, (_, i) => ({
      sourceSymbolId: `t1005::fn${i % 1200}#function`,
      targetSymbolId: `t1005::fn${(i + 1) % 1200}#function`,
      edgeType: 'calls',
    }));
    const resolver = new EdgeResolver(stateFor(store, [{ name: 'ws', path: '' }]));
    expect(() => resolver.storeRawEdges(edges)).not.toThrow();

    const callsId = edgeTypeId(store, 'calls');
    const n = (
      store.db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE edge_type_id = ?`).get(callsId) as {
        c: number;
      }
    ).c;
    // 2 000 input edges collapse to 1 200 distinct (source, target) pairs;
    // INSERT OR IGNORE dedups the rest. The point is every distinct pair
    // survived chunked resolution (pre-fix this threw before inserting any).
    expect(n).toBe(1200);
  });

  it('EdgeResolver.storeRawEdges survives 35 000 phantom symbol refs', () => {
    const store = testStore();
    edgeTypeId(store, 'calls');

    // 35 000 distinct symbol_id strings with no matching rows: the bind
    // itself threw `SqliteError: too many SQL variables` pre-fix (and would
    // throw RangeError past ~65k). Post-fix the chunked pre-loads simply
    // resolve nothing and every edge is skipped.
    const edges: RawEdge[] = Array.from({ length: N_IDS }, (_, i) => ({
      sourceSymbolId: `ghost::fn${i}#function`,
      targetSymbolId: `ghost::fn${i}#function`,
      edgeType: 'calls',
    }));
    const resolver = new EdgeResolver(stateFor(store, [{ name: 'ws', path: '' }]));
    expect(() => resolver.storeRawEdges(edges)).not.toThrow();

    const callsId = edgeTypeId(store, 'calls');
    const phantomCount = (
      store.db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE edge_type_id = ?`).get(callsId) as {
        c: number;
      }
    ).c;
    expect(phantomCount).toBe(0);
  });
});
