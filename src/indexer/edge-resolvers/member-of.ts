/**
 * member_of resolver — emits symbol-level structural edges from each member
 * symbol (method, property, constant, enum_case) to its containing symbol
 * (class, interface, trait, enum).
 *
 * Works by mirroring the `parent_id` relationship stored in the symbols table
 * into the edges table. This gives a complete structural graph where every
 * member is explicitly connected to its container, enabling traversals like
 * "all members of class X" or "which class does this method belong to" via
 * standard edge queries.
 *
 * Language-agnostic: works for PHP, TypeScript, Python, Java, Go, Ruby, etc.
 */
import type { PipelineState } from '../pipeline-state.js';
import { logger } from '../../logger.js';

export function resolveMemberOfEdges(state: PipelineState): void {
  const { store } = state;

  const memberOfType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('member_of') as { id: number } | undefined;
  if (!memberOfType) {
    logger.warn(
      { edgeType: 'member_of' },
      'edge_types row missing — skipping member_of resolution. Run schema migrations.',
    );
    return;
  }

  // Load every symbol that has a parent_id (i.e., is a member of another symbol).
  const rows = store.db
    .prepare(`
    SELECT s.id AS member_id, s.parent_id
    FROM symbols s
    WHERE s.parent_id IS NOT NULL
  `)
    .all() as Array<{ member_id: number; parent_id: number }>;

  if (rows.length === 0) return;

  // Pre-load node IDs for all involved symbols in one batch.
  const ids = new Set<number>();
  for (const r of rows) {
    ids.add(r.member_id);
    ids.add(r.parent_id);
  }
  const idList = Array.from(ids);
  const nodeMap = new Map<number, number>();
  const CHUNK = 500;
  for (let i = 0; i < idList.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('symbol', idList.slice(i, i + CHUNK))) {
      nodeMap.set(k, v);
    }
  }

  const insertStmt = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
     VALUES (?, ?, ?, 1, NULL, 0, 'ast_resolved')`,
  );

  let created = 0;
  store.db.transaction(() => {
    for (const r of rows) {
      const src = nodeMap.get(r.member_id);
      const tgt = nodeMap.get(r.parent_id);
      if (src == null || tgt == null || src === tgt) continue;
      insertStmt.run(src, tgt, memberOfType.id);
      created++;
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'member_of edges resolved');
  }
}
