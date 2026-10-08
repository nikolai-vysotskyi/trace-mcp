/**
 * sql_cte_ref — CTE symbol → CTE symbol within the same `.sql` file.
 * Source metadata: `referencesCtes` on AST-indexed CTE symbols (Phase 4).
 */

import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import { sqlCteSymbolId } from '../plugins/language/sql/sql-index-metadata.js';
import type { Store } from '../../db/store.js';
import type { PipelineState } from '../pipeline-state.js';

/** First CTE definition with `name` in file (lowest line) when names repeat. */
function resolveCteTargetSymbolId(store: Store, filePath: string, toName: string): string | null {
  const rows = store.db
    .prepare(
      `SELECT s.symbol_id
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.path = ?
         AND json_extract(s.metadata, '$.sqlKind') = 'cte'
         AND json_extract(s.metadata, '$.name') = ?
       ORDER BY s.line_start ASC`,
    )
    .all(filePath, toName) as Array<{ symbol_id: string }>;
  if (rows.length > 0) return rows[0]!.symbol_id;
  return sqlCteSymbolId(filePath, toName);
}

type CteRow = {
  symbol_id: string;
  file_path: string;
  metadata: string;
};

export function resolveSqlCteRefEdges(state: PipelineState, scope?: ChangeScope): void {
  const { store } = state;

  store.db
    .prepare(
      'INSERT OR IGNORE INTO edge_types (name, category, directed, description) VALUES (?, ?, 1, ?)',
    )
    .run('sql_cte_ref', 'sql', 'CTE references another CTE in the same file');

  const edgeType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('sql_cte_ref') as { id: number } | undefined;
  if (!edgeType) {
    logger.warn({ edgeType: 'sql_cte_ref' }, 'edge_types row missing — skipping sql_cte_ref');
    return;
  }

  const scopedIds = scope ? Array.from(scope.changedFileIds) : null;
  let rows: CteRow[];
  if (scopedIds && scopedIds.length === 0) return;
  if (scopedIds && scopedIds.length > 0) {
    rows = [];
    const CHUNK = 900;
    for (let i = 0; i < scopedIds.length; i += CHUNK) {
      const chunk = scopedIds.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const chunkRows = store.db
        .prepare(
          `SELECT s.symbol_id, f.path AS file_path, s.metadata
           FROM symbols s
           JOIN files f ON f.id = s.file_id
           WHERE f.path LIKE '%.sql'
             AND json_extract(s.metadata, '$.sqlKind') = 'cte'
             AND s.file_id IN (${ph})`,
        )
        .all(...chunk) as CteRow[];
      for (const r of chunkRows) rows.push(r);
    }
  } else {
    rows = store.db
      .prepare(
        `SELECT s.symbol_id, f.path AS file_path, s.metadata
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.path LIKE '%.sql'
           AND json_extract(s.metadata, '$.sqlKind') = 'cte'`,
      )
      .all() as CteRow[];
  }

  if (rows.length === 0) return;

  const symbolIdStrs = new Set<string>();
  const pending: Array<{ source: string; target: string }> = [];

  for (const row of rows) {
    let meta: { referencesCtes?: string[] };
    try {
      meta = JSON.parse(row.metadata) as { referencesCtes?: string[] };
    } catch {
      continue;
    }
    const refs = meta.referencesCtes;
    if (!refs?.length) continue;
    for (const toName of refs) {
      const targetId = resolveCteTargetSymbolId(store, row.file_path, toName);
      if (!targetId) continue;
      pending.push({ source: row.symbol_id, target: targetId });
      symbolIdStrs.add(row.symbol_id);
      symbolIdStrs.add(targetId);
    }
  }

  if (pending.length === 0) return;

  const symbolNodeCache = new Map<string, number>();
  const arr = Array.from(symbolIdStrs);
  const CHUNK = 900;
  for (let i = 0; i < arr.length; i += CHUNK) {
    const chunk = arr.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const nodeRows = store.db
      .prepare(
        `SELECT s.symbol_id, n.id AS node_id
         FROM symbols s
         JOIN nodes n ON n.node_type = 'symbol' AND n.ref_id = s.id
         WHERE s.symbol_id IN (${placeholders})`,
      )
      .all(...chunk) as Array<{ symbol_id: string; node_id: number }>;
    for (const r of nodeRows) symbolNodeCache.set(r.symbol_id, r.node_id);
  }

  const insertStmt = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
     VALUES (?, ?, ?, 1, NULL, 0, 'ast_resolved')`,
  );

  let created = 0;
  store.db.transaction(() => {
    for (const { source, target } of pending) {
      const src = symbolNodeCache.get(source);
      const tgt = symbolNodeCache.get(target);
      if (src == null || tgt == null || src === tgt) continue;
      insertStmt.run(src, tgt, edgeType.id);
      created++;
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'sql_cte_ref edges resolved');
  }
}
