/**
 * File-projection post-pass: for every symbol→symbol edge whose endpoints
 * live in different files, ensure there is a corresponding file→file edge.
 *
 * Many framework-specific edge types (`renders_component`, `uses_composable`,
 * `nuxt_auto_imports`, `dispatches`, `listens_to`, Laravel relation edges,
 * Livewire edges, NestJS edges, etc.) are emitted at symbol granularity
 * because that's where the semantic information lives. But when the graph
 * is rendered at *file* granularity — or when downstream tooling asks
 * "do these two files have a relationship?" — those relationships are
 * invisible: the file nodes themselves carry no edges.
 *
 * Running this projection as a resolver pass means the underlying graph is
 * self-consistent: every semantic link between two symbols in different
 * files shows up as a concrete edge between those files too. Viz tools,
 * community detection, PageRank, dead-code analysis — they all benefit.
 *
 * Edge type: reuses the generic `imports` bucket with a `projected: true`
 * flag. We avoid inventing a new type because downstream consumers already
 * treat `imports` as the "this file depends on that file" signal.
 */
import type { PipelineState } from '../pipeline-state.js';
import { logger } from '../../logger.js';

export function resolveFileProjectionEdges(state: PipelineState): void {
  const { store } = state;

  const importsType = store.db.prepare(
    `SELECT id FROM edge_types WHERE name = ?`,
  ).get('imports') as { id: number } | undefined;
  if (!importsType) {
    logger.warn({ edgeType: 'imports' }, 'edge_types row missing — skipping file projection.');
    return;
  }

  // Skip internal structural edges — they don't carry cross-file relationship
  // semantics that would be useful at the file level.
  //   - member_of: method → class in the SAME file (always intra-file anyway)
  //   - unresolved: phantom placeholder
  const excluded = new Set(['member_of', 'unresolved']);
  const excludedIds = store.db
    .prepare(`SELECT id FROM edge_types WHERE name IN (${[...excluded].map(() => '?').join(',')})`)
    .all(...excluded) as Array<{ id: number }>;
  const excludedSet = new Set(excludedIds.map((r) => r.id));

  // For every symbol→symbol edge, compute src_file and tgt_file. Emit a
  // file→file `imports` edge when they differ. Dedup via INSERT OR IGNORE
  // on the (source, target, edge_type) unique key.
  //
  // Single SQL statement: joins both endpoints' node→symbol→file chains
  // and uses INSERT ... SELECT to bulk-insert. Runs in a single transaction.
  const stmt = store.db.prepare(`
    INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
    SELECT DISTINCT
      src_file_node.id AS source_node_id,
      tgt_file_node.id AS target_node_id,
      ? AS edge_type_id,
      1,
      '{"projected":true}',
      CASE WHEN src_file.workspace IS NOT NULL AND tgt_file.workspace IS NOT NULL AND src_file.workspace <> tgt_file.workspace THEN 1 ELSE 0 END,
      'ast_inferred'
    FROM edges e
    JOIN nodes sn ON sn.id = e.source_node_id AND sn.node_type = 'symbol'
    JOIN symbols ss ON ss.id = sn.ref_id
    JOIN files src_file ON src_file.id = ss.file_id
    JOIN nodes src_file_node ON src_file_node.node_type = 'file' AND src_file_node.ref_id = src_file.id
    JOIN nodes tn ON tn.id = e.target_node_id AND tn.node_type = 'symbol'
    JOIN symbols ts ON ts.id = tn.ref_id
    JOIN files tgt_file ON tgt_file.id = ts.file_id
    JOIN nodes tgt_file_node ON tgt_file_node.node_type = 'file' AND tgt_file_node.ref_id = tgt_file.id
    WHERE ss.file_id <> ts.file_id
      AND e.edge_type_id NOT IN (${[...excludedSet].map(() => '?').join(',') || 'SELECT -1'})
  `);

  // Also project file→symbol edges (e.g. nuxt_entry_point, references_component)
  // so the source file reaches the target symbol's file.
  const stmtFileSym = store.db.prepare(`
    INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
    SELECT DISTINCT
      sn.id AS source_node_id,
      tgt_file_node.id AS target_node_id,
      ? AS edge_type_id,
      1,
      '{"projected":true}',
      CASE WHEN src_file.workspace IS NOT NULL AND tgt_file.workspace IS NOT NULL AND src_file.workspace <> tgt_file.workspace THEN 1 ELSE 0 END,
      'ast_inferred'
    FROM edges e
    JOIN nodes sn ON sn.id = e.source_node_id AND sn.node_type = 'file'
    JOIN files src_file ON src_file.id = sn.ref_id
    JOIN nodes tn ON tn.id = e.target_node_id AND tn.node_type = 'symbol'
    JOIN symbols ts ON ts.id = tn.ref_id
    JOIN files tgt_file ON tgt_file.id = ts.file_id
    JOIN nodes tgt_file_node ON tgt_file_node.node_type = 'file' AND tgt_file_node.ref_id = tgt_file.id
    WHERE src_file.id <> tgt_file.id
      AND e.edge_type_id NOT IN (${[...excludedSet].map(() => '?').join(',') || 'SELECT -1'})
  `);

  const before = (store.db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE edge_type_id = ?`).get(importsType.id) as { c: number }).c;
  store.db.transaction(() => {
    stmt.run(importsType.id, ...excludedSet);
    stmtFileSym.run(importsType.id, ...excludedSet);
  })();
  const after = (store.db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE edge_type_id = ?`).get(importsType.id) as { c: number }).c;

  const added = after - before;
  if (added > 0) {
    logger.info({ edges: added }, 'File projection edges resolved');
  }
}
