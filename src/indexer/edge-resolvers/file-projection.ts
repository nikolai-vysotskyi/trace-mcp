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

import { logger } from '../../logger.js';
import type { PipelineState } from '../pipeline-state.js';

export function resolveFileProjectionEdges(state: PipelineState): void {
  const { store } = state;

  const importsType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('imports') as
    | { id: number }
    | undefined;
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
  // Workspace isolation: skip edges between files in different workspaces.
  // The underlying symbol edges may already be intentionally cross-repo
  // (e.g. `workspace_import`, `api_call`), but those live at file level to
  // begin with — projecting to file level would be a no-op. Cross-workspace
  // symbol edges that DO exist come from FQN-based resolvers that don't
  // filter by workspace (Laravel ORM, etc.) — projecting them to file edges
  // would visually merge independent projects. Drop them here.
  const stmt = store.db.prepare(`
    INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
    SELECT DISTINCT
      src_file_node.id AS source_node_id,
      tgt_file_node.id AS target_node_id,
      ? AS edge_type_id,
      1,
      '{"projected":true}',
      0,
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
      AND (
        src_file.workspace IS NULL OR tgt_file.workspace IS NULL
        OR src_file.workspace = tgt_file.workspace
      )
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
      0,
      'ast_inferred'
    FROM edges e
    JOIN nodes sn ON sn.id = e.source_node_id AND sn.node_type = 'file'
    JOIN files src_file ON src_file.id = sn.ref_id
    JOIN nodes tn ON tn.id = e.target_node_id AND tn.node_type = 'symbol'
    JOIN symbols ts ON ts.id = tn.ref_id
    JOIN files tgt_file ON tgt_file.id = ts.file_id
    JOIN nodes tgt_file_node ON tgt_file_node.node_type = 'file' AND tgt_file_node.ref_id = tgt_file.id
    WHERE src_file.id <> tgt_file.id
      AND (
        src_file.workspace IS NULL OR tgt_file.workspace IS NULL
        OR src_file.workspace = tgt_file.workspace
      )
      AND e.edge_type_id NOT IN (${[...excludedSet].map(() => '?').join(',') || 'SELECT -1'})
  `);

  const before = (
    store.db
      .prepare(`SELECT COUNT(*) AS c FROM edges WHERE edge_type_id = ?`)
      .get(importsType.id) as { c: number }
  ).c;
  store.db.transaction(() => {
    stmt.run(importsType.id, ...excludedSet);
    stmtFileSym.run(importsType.id, ...excludedSet);
  })();
  const after = (
    store.db
      .prepare(`SELECT COUNT(*) AS c FROM edges WHERE edge_type_id = ?`)
      .get(importsType.id) as { c: number }
  ).c;

  const added = after - before;
  if (added > 0) {
    logger.info({ edges: added }, 'File projection edges resolved');
  }
}

/**
 * Final sweep: delete every cross-workspace edge that belongs to an
 * edge-type category outside the cross-ws allow-list.
 *
 * Workspace isolation is a project-level invariant: a file in
 * `fair/fair-laravel` should never have framework-level edges to a file in
 * `15carats/15carats-laravel`, because those are independent Laravel apps
 * that happen to sit under one root. Resolvers that look up classes by FQN
 * (`App\Models\User` exists in all 8 apps) will pick an arbitrary match
 * unless they're strictly workspace-scoped, and several resolvers bypass
 * the main `storeRawEdges` cross-ws filter by writing directly through
 * their own prepared statements.
 *
 * Running this as a post-pass is the simplest, catch-all fix: regardless
 * of how an edge got there, if it crosses workspaces and isn't in the
 * allow-list, it's deleted.
 *
 * Allow-list:
 *   - workspace (cross_workspace_import, api_call, type_import, etc.)
 *   - runtime   (observed production traces, legitimately cross-repo)
 */
export function purgeForbiddenCrossWorkspaceEdges(state: PipelineState): void {
  const { store } = state;

  // Running only in multi-workspace projects
  if (!state.workspaces || state.workspaces.length === 0) return;

  const ALLOWED = ['workspace', 'runtime'];
  const placeholders = ALLOWED.map(() => '?').join(',');

  const result = store.db
    .prepare(`
    DELETE FROM edges
    WHERE id IN (
      SELECT e.id
      FROM edges e
      JOIN edge_types et ON et.id = e.edge_type_id
      JOIN nodes ns ON ns.id = e.source_node_id
      JOIN nodes nt ON nt.id = e.target_node_id
      LEFT JOIN symbols ssy ON ns.node_type = 'symbol' AND ssy.id = ns.ref_id
      LEFT JOIN files sf ON sf.id = CASE WHEN ns.node_type = 'file' THEN ns.ref_id ELSE ssy.file_id END
      LEFT JOIN symbols tsy ON nt.node_type = 'symbol' AND tsy.id = nt.ref_id
      LEFT JOIN files tf ON tf.id = CASE WHEN nt.node_type = 'file' THEN nt.ref_id ELSE tsy.file_id END
      WHERE sf.workspace IS NOT NULL
        AND tf.workspace IS NOT NULL
        AND sf.workspace <> tf.workspace
        AND et.category NOT IN (${placeholders})
    )
  `)
    .run(...ALLOWED);

  const deleted = Number(result.changes ?? 0);
  if (deleted > 0) {
    logger.info({ deleted }, 'Purged forbidden cross-workspace edges');
  }
}
