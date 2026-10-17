/**
 * sql_reads — CTE or `.sql` file → database relation (phantom symbol per relation text).
 * Source metadata: `relationRefs` on AST-indexed SQL symbols (scoped by line to CTE bodies).
 */

import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { SqlRelationRefMeta } from '../plugins/language/sql/sql-index-metadata.js';
import type { PipelineState } from '../pipeline-state.js';
import { SqlRelationPhantomFactory, normalizeSqlRelationText } from './sql-relation-phantoms.js';

type SqlSymbolRow = {
  symbol_id: string;
  file_path: string;
  file_id: number;
  workspace: string | null;
  metadata: string;
  line_start: number;
  line_end: number;
  sql_kind: string | null;
  cte_name: string | null;
};

type CteScope = {
  symbol_id: string;
  name: string;
  line_start: number;
  line_end: number;
};

function unionRelationRefs(rows: SqlSymbolRow[]): SqlRelationRefMeta[] {
  const seen = new Set<string>();
  const out: SqlRelationRefMeta[] = [];
  for (const row of rows) {
    let meta: { relationRefs?: SqlRelationRefMeta[] };
    try {
      meta = JSON.parse(row.metadata) as { relationRefs?: SqlRelationRefMeta[] };
    } catch {
      continue;
    }
    for (const ref of meta.relationRefs ?? []) {
      const key = `${ref.lineStart}:${ref.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}

function isBareCteName(text: string, cteNames: Set<string>): boolean {
  const norm = normalizeSqlRelationText(text);
  if (!norm || norm.includes('.') || norm.includes('{{') || norm.includes('__tpl_')) {
    return false;
  }
  return cteNames.has(norm);
}

/** v1: only schema-qualified or template-backed names (skip alias / function false positives). */
function isRelationReadCandidate(text: string, cteNames: Set<string>): boolean {
  const norm = normalizeSqlRelationText(text);
  if (!norm || isBareCteName(norm, cteNames)) return false;
  return norm.includes('.') || norm.includes('{{') || norm.includes('__tpl_');
}

/** Innermost CTE whose line range contains `line` (smallest span wins). */
function cteForLine(ctes: CteScope[], line: number): CteScope | null {
  let best: CteScope | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const c of ctes) {
    if (line < c.line_start || line > c.line_end) continue;
    const span = c.line_end - c.line_start;
    if (span < bestSpan) {
      bestSpan = span;
      best = c;
    }
  }
  return best;
}

export function resolveSqlReadEdges(state: PipelineState, scope?: ChangeScope): void {
  const { store } = state;

  store.db
    .prepare(
      'INSERT OR IGNORE INTO edge_types (name, category, directed, description) VALUES (?, ?, 1, ?)',
    )
    .run('sql_reads', 'sql', 'Query or CTE reads a database relation (table/view)');

  const edgeType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('sql_reads') as
    | { id: number }
    | undefined;
  if (!edgeType) {
    logger.warn({ edgeType: 'sql_reads' }, 'edge_types row missing — skipping sql_reads');
    return;
  }

  const scopedIds = scope ? Array.from(scope.changedFileIds) : null;
  if (scopedIds && scopedIds.length === 0) return;

  let rows: SqlSymbolRow[];
  if (scopedIds && scopedIds.length > 0) {
    rows = [];
    const CHUNK = 900;
    for (let i = 0; i < scopedIds.length; i += CHUNK) {
      const chunk = scopedIds.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const chunkRows = store.db
        .prepare(
          `SELECT s.symbol_id, s.line_start, s.line_end, f.path AS file_path, f.id AS file_id,
                  f.workspace, s.metadata,
                  json_extract(s.metadata, '$.sqlKind') AS sql_kind,
                  json_extract(s.metadata, '$.name') AS cte_name
           FROM symbols s
           JOIN files f ON f.id = s.file_id
           WHERE f.path LIKE '%.sql'
             AND s.file_id IN (${ph})`,
        )
        .all(...chunk) as SqlSymbolRow[];
      for (const r of chunkRows) rows.push(r);
    }
  } else {
    rows = store.db
      .prepare(
        `SELECT s.symbol_id, s.line_start, s.line_end, f.path AS file_path, f.id AS file_id,
                f.workspace, s.metadata,
                json_extract(s.metadata, '$.sqlKind') AS sql_kind,
                json_extract(s.metadata, '$.name') AS cte_name
         FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.path LIKE '%.sql'`,
      )
      .all() as SqlSymbolRow[];
  }

  if (rows.length === 0) return;

  const byFile = new Map<string, SqlSymbolRow[]>();
  for (const row of rows) {
    const list = byFile.get(row.file_path) ?? [];
    list.push(row);
    byFile.set(row.file_path, list);
  }

  const phantoms = new SqlRelationPhantomFactory(state);
  const pending: Array<{
    sourceSymbolId: string | null;
    fileId: number;
    targetNodeId: number;
    metadata: string;
  }> = [];

  for (const [filePath, fileRows] of byFile) {
    const ctes: CteScope[] = fileRows
      .filter((r) => r.sql_kind === 'cte')
      .map((r) => ({
        symbol_id: r.symbol_id,
        name: (r.cte_name ?? r.symbol_id.split('::')[1]?.split('#')[0]) || '',
        line_start: r.line_start,
        line_end: r.line_end,
      }))
      .filter((c) => c.name);

    const cteNames = new Set(ctes.map((c) => c.name));
    const relationRefs = unionRelationRefs(fileRows);
    const fileId = fileRows[0]?.file_id;
    const workspace = fileRows[0]?.workspace ?? null;
    if (fileId == null) continue;

    for (const ref of relationRefs) {
      const text = normalizeSqlRelationText(ref.text);
      if (!isRelationReadCandidate(text, cteNames)) continue;

      const phantom = phantoms.ensure(text, workspace);
      const meta = JSON.stringify({
        relation: text,
        lineStart: ref.lineStart,
        confidence: ref.confidence,
        file: filePath,
      });

      const owner = cteForLine(ctes, ref.lineStart);
      if (owner) {
        pending.push({
          sourceSymbolId: owner.symbol_id,
          fileId,
          targetNodeId: phantom.node_id,
          metadata: meta,
        });
      } else {
        pending.push({
          sourceSymbolId: null,
          fileId,
          targetNodeId: phantom.node_id,
          metadata: meta,
        });
      }
    }
  }

  if (pending.length === 0) return;

  const sourceSymbolIds = new Set<string>();
  for (const p of pending) {
    if (p.sourceSymbolId) sourceSymbolIds.add(p.sourceSymbolId);
  }

  const symbolNodeCache = new Map<string, number>();
  const symArr = Array.from(sourceSymbolIds);
  const CHUNK = 900;
  for (let i = 0; i < symArr.length; i += CHUNK) {
    const chunk = symArr.slice(i, i + CHUNK);
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

  const fileNodeCache = new Map<number, number>();
  const insertStmt = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
     VALUES (?, ?, ?, 1, ?, 0, 'ast_resolved')`,
  );

  let created = 0;
  store.db.transaction(() => {
    for (const p of pending) {
      let src: number | undefined;
      if (p.sourceSymbolId) {
        src = symbolNodeCache.get(p.sourceSymbolId);
      } else {
        let fileNode = fileNodeCache.get(p.fileId);
        if (fileNode == null) {
          fileNode = store.getNodeId('file', p.fileId) ?? store.createNode('file', p.fileId);
          fileNodeCache.set(p.fileId, fileNode);
        }
        src = fileNode;
      }
      if (src == null || src === p.targetNodeId) continue;
      insertStmt.run(src, p.targetNodeId, edgeType.id, p.metadata);
      created++;
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'sql_reads edges resolved');
  }
}
