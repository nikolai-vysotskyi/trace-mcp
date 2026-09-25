/**
 * TRA-1957 — file-projection join order.
 *
 * On a 3k-file / 49k-edge index the projection's INSERT..SELECT statements
 * planned as SCAN files × SCAN files (8.7M pairs) with the selective
 * predicate buried: one 2000-row id range measured >300 s inside a single
 * `sqlite3_step`. The event loop parked inside that promise continuation —
 * /health, timers and the TRA-1828 lag monitor died with it and the daemon
 * wedged for 30+ min on a fresh-checkout bulk index with daemon.log silent
 * after "Markdown tag edges resolved".
 *
 * Every statement here is CROSS JOIN with the driving table first
 * (edges id-range / IN list). These tests guard both the mechanism
 * (EXPLAIN plan shape: which table drives each branch) and the behaviour
 * (a 2000-file synthetic index projects in seconds, scoped runs touch only
 * the changed neighbourhood).
 */
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import type { PipelineState } from '../pipeline-state.js';
import {
  fileSymInsertSql,
  resolveFileProjectionEdges,
  symSymInsertSql,
} from '../edge-resolvers/file-projection.js';

const FILE_COUNT = 2000;
const SYMS_PER_FILE = 5;

interface Fixture {
  store: Store;
  fileIds: number[];
  importsTypeId: number;
}

function buildFixture(fileCount: number): Fixture {
  const store = new Store(initializeDatabase(':memory:'));
  for (const [name, category] of [
    ['imports', 'core'],
    ['calls', 'core'],
    ['member_of', 'core'],
    ['unresolved', 'core'],
  ] as Array<[string, string]>) {
    store.ensureEdgeType(name, category, `${name} (test)`);
  }
  const importsTypeId = (
    store.db.prepare(`SELECT id FROM edge_types WHERE name = 'imports'`).get() as { id: number }
  ).id;
  const callsTypeId = (
    store.db.prepare(`SELECT id FROM edge_types WHERE name = 'calls'`).get() as { id: number }
  ).id;

  const fileIds: number[] = [];
  const symNodeIds: number[][] = [];
  for (let i = 0; i < fileCount; i++) {
    const fileId = store.insertFile(`f${i}.ts`, 'typescript', `hash${i}`, 100, null, null);
    fileIds.push(fileId);
    const symIds = store.insertSymbols(
      fileId,
      Array.from({ length: SYMS_PER_FILE }, (_, j) => ({
        symbolId: `f${i}.ts::fn${i}_${j}#function`,
        name: `fn${i}_${j}`,
        kind: 'function',
        byteStart: j * 10,
        byteEnd: j * 10 + 8,
        lineStart: j + 1,
        lineEnd: j + 1,
      })),
    );
    symNodeIds.push(symIds.map((id) => store.getNodeId('symbol', id) as number));
  }

  // Cross-file chain with fan-out: every file reaches the next three files'
  // symbols, so every ordered file pair (i, i+1..i+3 mod N) must project.
  const insert = store.db.prepare(
    `INSERT OR IGNORE INTO edges
      (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
     VALUES (?, ?, ?, 1, NULL, 0, 'ast_resolved')`,
  );
  const insertMany = store.db.transaction(() => {
    for (let i = 0; i < fileCount; i++) {
      for (let k = 0; k < 3; k++) {
        const src = symNodeIds[i]![k % SYMS_PER_FILE]!;
        const tgt = symNodeIds[(i + 1 + k) % fileCount]![(k + 1) % SYMS_PER_FILE]!;
        insert.run(src, tgt, callsTypeId);
      }
    }
  });
  insertMany();

  return { store, fileIds, importsTypeId };
}

function importsCount(store: Store, importsTypeId: number): number {
  return (
    store.db
      .prepare(`SELECT COUNT(*) AS c FROM edges WHERE edge_type_id = ?`)
      .get(importsTypeId) as {
      c: number;
    }
  ).c;
}

interface PlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

function plan(store: Store, sql: string, params: unknown[]): PlanRow[] {
  return store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as PlanRow[];
}

/**
 * Driving (first data-access) line of one SELECT. For UNION statements, split
 * into halves first — EXPLAIN QUERY PLAN returns a MERGE tree otherwise.
 */
function drivingLine(store: Store, selectSql: string, params: unknown[]): string {
  const rows = plan(store, selectSql, params);
  const first = rows.find((r) => /^(SEARCH|SCAN) /.test(r.detail));
  expect(first, `no data-access step in plan for: ${selectSql.slice(0, 120)}…`).toBeDefined();
  return first!.detail;
}

function unionHalves(insertSql: string): [string, string] {
  const parts = insertSql.split(/\sUNION\s/);
  expect(parts).toHaveLength(2);
  return [parts[0]!, parts[1]!];
}

describe('file projection join order (TRA-1957)', () => {
  it('projects a 2000-file index in seconds, not hours', async () => {
    const { store, importsTypeId } = buildFixture(FILE_COUNT);
    const before = importsCount(store, importsTypeId);
    expect(before).toBe(0);

    const startedAt = Date.now();
    await resolveFileProjectionEdges({ store } as PipelineState, undefined);
    const elapsedMs = Date.now() - startedAt;

    // Every file reaches 3 successors (mod N wrap) — one projected imports
    // edge per ordered pair.
    expect(importsCount(store, importsTypeId) - before).toBe(FILE_COUNT * 3);
    // The 3.33.0 plan needed >300 s for a single 2000-row range; the fixed
    // plan does the whole 6000-edge table in ~1 s. 30 s is generous even
    // for a loaded CI host.
    expect(elapsedMs).toBeLessThan(30_000);
  }, 120_000);

  it('scoped runs touch only the changed neighbourhood', async () => {
    const small = 50;
    const { store, fileIds, importsTypeId } = buildFixture(small);
    const state = { store } as PipelineState;
    await resolveFileProjectionEdges(state, {
      changedFileIds: new Set([fileIds[0]!]),
      newSymbolNames: new Map(),
      deletedSymbolNames: new Map(),
    });

    const rows = store.db
      .prepare(
        `SELECT sf.path AS src, tf.path AS tgt
         FROM edges e
         JOIN nodes sn ON sn.id = e.source_node_id AND sn.node_type = 'file'
         JOIN files sf ON sf.id = sn.ref_id
         JOIN nodes tn ON tn.id = e.target_node_id AND tn.node_type = 'file'
         JOIN files tf ON tf.id = tn.ref_id
         WHERE e.edge_type_id = ?`,
      )
      .all(importsTypeId) as Array<{ src: string; tgt: string }>;
    const pairs = new Set(rows.map((r) => `${r.src}→${r.tgt}`));
    // Source branch: file0 reaches files 1..3. Target branch: file0's symbols
    // are targeted from files N-3..N-1 (mod-N wrap of the chain).
    expect(pairs).toEqual(
      new Set([
        'f0.ts→f1.ts',
        'f0.ts→f2.ts',
        'f0.ts→f3.ts',
        'f47.ts→f0.ts',
        'f48.ts→f0.ts',
        'f49.ts→f0.ts',
      ]),
    );
  }, 60_000);

  it('unscoped statements are edges-driven (SEARCH e first)', () => {
    const { store } = buildFixture(10);
    for (const sql of [symSymInsertSql(null, '5,9'), fileSymInsertSql(null, '5,9')]) {
      expect(drivingLine(store, sql, [15, 1, 2001])).toMatch(/^SEARCH e USING INTEGER PRIMARY KEY/);
    }
  }, 60_000);

  it('scoped branches are IN-list / edges-driven, never files-first', () => {
    const { store } = buildFixture(10);
    // Source-side branches drive from the changed ids; target-side branches
    // drive from edges (target fan-in defeats the symbol-driven order).
    const expectations: Array<{ sql: string; first: [RegExp, RegExp] }> = [
      { sql: symSymInsertSql('10,11,12', '5,9'), first: [/^SEARCH ss /, /^(SEARCH|SCAN) e /] },
      {
        sql: fileSymInsertSql('10,11,12', '5,9'),
        first: [/^SEARCH src_file /, /^(SEARCH|SCAN) e /],
      },
    ];
    for (const { sql, first } of expectations) {
      const [branchSrc, branchTgt] = unionHalves(sql);
      // One edge_type placeholder per branch; IN lists and exclusions are
      // literals here (driving order is what this guards, not binding).
      const srcDriving = drivingLine(store, branchSrc, [15]);
      const tgtDriving = drivingLine(store, branchTgt, [15]);
      // The 3.33.0 wedge was SCAN src_file / SCAN tgt_file as the driving
      // tables (files×files nested loops) — that shape must never come back.
      expect(srcDriving).not.toMatch(/^SCAN (src_file|tgt_file) /);
      expect(tgtDriving).not.toMatch(/^SCAN (src_file|tgt_file) /);
      expect(srcDriving).toMatch(first[0]);
      expect(tgtDriving).toMatch(first[1]);
    }
  }, 60_000);
});
