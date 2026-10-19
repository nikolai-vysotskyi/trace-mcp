import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveSqlReadEdges } from '../../src/indexer/edge-resolvers/sql-reads.js';
import { SqlLanguagePlugin } from '../../src/indexer/plugins/language/sql/index.js';
import { createTestHarness } from '../../src/plugin-api/test-harness.js';
import { fixtureFile } from './fixture-paths.js';

const plugin = new SqlLanguagePlugin();

function countEdgesByType(
  db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } },
  name: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM edges e
       JOIN edge_types t ON t.id = e.edge_type_id
       WHERE t.name = ?`,
    )
    .get(name) as { n: number };
  return row.n;
}

describe('sql_reads resolver', () => {
  it('two_cte_join_sample: scoped CTE reads app.demo and template schema; emp_age reads hr.employees', async () => {
    const rel = 'etl/two_cte_join_sample.sql';
    const harness = createTestHarness(plugin);
    await harness.indexFile(rel, fs.readFileSync(fixtureFile(rel)!, 'utf8'));

    const fileId = harness.getFileId(rel);
    expect(fileId).toBeDefined();
    harness.store.createNode('file', fileId!);

    resolveSqlReadEdges({ store: harness.store });

    const reads = countEdgesByType(harness.store.db, 'sql_reads');
    expect(reads).toBeGreaterThanOrEqual(3);

    const relations = harness.store.db
      .prepare(
        `SELECT DISTINCT json_extract(s.metadata, '$.relation') AS relation
         FROM edges e
         JOIN edge_types t ON t.id = e.edge_type_id
         JOIN nodes n ON n.id = e.target_node_id
         JOIN symbols s ON s.id = n.ref_id AND n.node_type = 'symbol'
         WHERE t.name = 'sql_reads'
         ORDER BY relation`,
      )
      .all() as Array<{ relation: string }>;

    const names = relations.map((r) => r.relation).sort();
    expect(names).toEqual(
      expect.arrayContaining(['app.demo', 'hr.employees', '__tpl_schema_name__.assignments']),
    );
    expect(names).not.toContain('scoped');
    expect(names).not.toContain('emp_age');
  });

  it('plain_select: standalone SELECT gets sql_reads via file unit symbol', async () => {
    const rel = 'standalone/plain_select.sql';
    const harness = createTestHarness(plugin);
    await harness.indexFile(rel, fs.readFileSync(fixtureFile(rel)!, 'utf8'));

    const fileId = harness.getFileId(rel);
    expect(fileId).toBeDefined();
    harness.store.createNode('file', fileId!);

    resolveSqlReadEdges({ store: harness.store });

    const reads = countEdgesByType(harness.store.db, 'sql_reads');
    expect(reads).toBeGreaterThanOrEqual(1);

    const relations = harness.store.db
      .prepare(
        `SELECT DISTINCT json_extract(s.metadata, '$.relation') AS relation
         FROM edges e
         JOIN edge_types t ON t.id = e.edge_type_id
         JOIN nodes n ON n.id = e.target_node_id
         JOIN symbols s ON s.id = n.ref_id AND n.node_type = 'symbol'
         WHERE t.name = 'sql_reads'`,
      )
      .all() as Array<{ relation: string }>;
    expect(relations.map((r) => r.relation)).toContain('app.orders');
  });

  it('distinct_on_newline: app.orders sql_reads sources scoped CTE after DISTINCT/ON preprocess', async () => {
    const rel = 'standalone/distinct_on_newline_reads.sql';
    const sql = `WITH decoy AS (
  SELECT 1
),
scoped AS (
  SELECT DISTINCT
    ON (student_id) student_id
  FROM app.orders
)
SELECT 1`;
    const harness = createTestHarness(plugin);
    await harness.indexFile(rel, sql);

    const fileId = harness.getFileId(rel);
    expect(fileId).toBeDefined();
    harness.store.createNode('file', fileId!);

    resolveSqlReadEdges({ store: harness.store });

    const rows = harness.store.db
      .prepare(
        `SELECT json_extract(src.metadata, '$.name') AS source_cte,
                json_extract(tgt.metadata, '$.relation') AS relation,
                json_extract(e.metadata, '$.lineStart') AS ref_line
         FROM edges e
         JOIN edge_types t ON t.id = e.edge_type_id
         JOIN nodes sn ON sn.id = e.source_node_id
         JOIN symbols src ON src.id = sn.ref_id AND sn.node_type = 'symbol'
         JOIN nodes tn ON tn.id = e.target_node_id
         JOIN symbols tgt ON tgt.id = tn.ref_id AND tn.node_type = 'symbol'
         WHERE t.name = 'sql_reads'
           AND json_extract(tgt.metadata, '$.relation') = 'app.orders'`,
      )
      .all() as Array<{ source_cte: string; relation: string; ref_line: number }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_cte).toBe('scoped');
    expect(rows[0]!.relation).toBe('app.orders');
    expect(rows[0]!.ref_line).toBe(7);
  });
});
