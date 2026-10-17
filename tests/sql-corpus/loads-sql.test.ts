import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { resolveLoadsSqlEdges } from '../../src/indexer/edge-resolvers/loads-sql.js';
import { SqlLanguagePlugin } from '../../src/indexer/plugins/language/sql/index.js';
import { PythonLanguagePlugin } from '../../src/indexer/plugins/language/python/index.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import { executeLanguagePlugin } from '../../src/plugin-api/executor.js';
import { resolvePublicFixtureRoot } from './fixture-paths.js';

const sqlPlugin = new SqlLanguagePlugin();
const pyPlugin = new PythonLanguagePlugin();

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

async function indexFixturePair(store: Store, root: string): Promise<void> {
  const pairs = [
    { rel: 'etl/two_cte_join_sample.sql', plugin: sqlPlugin },
    { rel: 'etl/incremental_keys_sample.sql', plugin: sqlPlugin },
    { rel: 'python/etl_runner.py', plugin: pyPlugin },
  ];
  for (const { rel, plugin } of pairs) {
    const buf = fs.readFileSync(`${root}/${rel}`);
    const result = await executeLanguagePlugin(plugin, rel, buf);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const parsed = result.value;
    const fileId = store.insertFile(rel, parsed.language ?? 'unknown', null, buf.length);
    if (parsed.symbols.length) store.insertSymbols(fileId, parsed.symbols);
  }
}

describe('loads_sql resolver', () => {
  it('links Python loader calls to indexed .sql files', async () => {
    const root = resolvePublicFixtureRoot();
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    await indexFixturePair(store, root);

    const state = {
      store,
      rootPath: root,
      fileContentCache: new Map<string, string>(),
    } as unknown as PipelineState;

    resolveLoadsSqlEdges(state);

    expect(countEdgesByType(store.db, 'loads_sql')).toBeGreaterThanOrEqual(2);

    const targets = store.db
      .prepare(
        `SELECT f.path AS sql_path
         FROM edges e
         JOIN edge_types t ON t.id = e.edge_type_id
         JOIN nodes n ON n.id = e.target_node_id AND n.node_type = 'file'
         JOIN files f ON f.id = n.ref_id
         WHERE t.name = 'loads_sql'
         ORDER BY f.path`,
      )
      .all() as Array<{ sql_path: string }>;

    const paths = targets.map((t) => t.sql_path);
    expect(paths).toEqual(
      expect.arrayContaining(['etl/two_cte_join_sample.sql', 'etl/incremental_keys_sample.sql']),
    );
  });

  it('resolves Path(__file__) constant chains via _load_extract_df', async () => {
    const root = resolvePublicFixtureRoot();
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    for (const { rel, plugin } of [
      { rel: 'etl/two_cte_join_sample.sql', plugin: sqlPlugin },
      { rel: 'python/path_chain_loader.py', plugin: pyPlugin },
    ]) {
      const buf = fs.readFileSync(`${root}/${rel}`);
      const result = await executeLanguagePlugin(plugin, rel, buf);
      expect(result.isOk()).toBe(true);
      if (result.isErr()) return;
      const parsed = result.value;
      const fileId = store.insertFile(rel, parsed.language ?? 'unknown', null, buf.length);
      if (parsed.symbols.length) store.insertSymbols(fileId, parsed.symbols);
    }

    resolveLoadsSqlEdges({
      store,
      rootPath: root,
      fileContentCache: new Map<string, string>(),
    } as unknown as PipelineState);

    const row = store.db
      .prepare(
        `SELECT f.path FROM edges e
         JOIN edge_types t ON t.id = e.edge_type_id
         JOIN nodes n ON n.id = e.target_node_id AND n.node_type = 'file'
         JOIN files f ON f.id = n.ref_id
         WHERE t.name = 'loads_sql'`,
      )
      .all() as Array<{ path: string }>;
    expect(row.map((r) => r.path)).toContain('etl/two_cte_join_sample.sql');
  });
});
