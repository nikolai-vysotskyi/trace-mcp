import { describe, expect, it } from 'vitest';
import { resolveSqlCteRefEdges } from '../../src/indexer/edge-resolvers/sql-cte-refs.js';
import { SqlLanguagePlugin } from '../../src/indexer/plugins/language/sql/index.js';
import { createTestHarness } from '../../src/plugin-api/test-harness.js';

const plugin = new SqlLanguagePlugin();

describe('sql_cte_ref resolver', () => {
  it('resolves nested duplicate CTE names to the inner definition', async () => {
    const rel = 'nested/duplicate_cte_scope.sql';
    const sql = `WITH x AS (SELECT 1), outer AS (
  WITH x AS (SELECT 2) SELECT * FROM x
) SELECT * FROM outer`;
    const harness = createTestHarness(plugin);
    await harness.indexFile(rel, sql);

    const fileId = harness.getFileId(rel);
    expect(fileId).toBeDefined();
    harness.store.createNode('file', fileId!);

    resolveSqlCteRefEdges({ store: harness.store });

    const rows = harness.store.db
      .prepare(
        `SELECT src.symbol_id AS source_id, tgt.symbol_id AS target_id,
                json_extract(tgt.metadata, '$.defIndex') AS target_def_index,
                tgt.line_start AS target_line
         FROM edges e
         JOIN edge_types t ON t.id = e.edge_type_id
         JOIN nodes sn ON sn.id = e.source_node_id
         JOIN symbols src ON src.id = sn.ref_id AND sn.node_type = 'symbol'
         JOIN nodes tn ON tn.id = e.target_node_id
         JOIN symbols tgt ON tgt.id = tn.ref_id AND tn.node_type = 'symbol'
         WHERE t.name = 'sql_cte_ref'
           AND json_extract(src.metadata, '$.name') = 'outer'`,
      )
      .all() as Array<{
      source_id: string;
      target_id: string;
      target_def_index: number;
      target_line: number;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_def_index).toBe(1);
    expect(rows[0]!.target_line).toBeGreaterThan(1);
    expect(rows[0]!.target_id).toContain('::x@');
  });
});
