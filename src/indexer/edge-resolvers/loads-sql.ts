/**
 * loads_sql — Python file / function → indexed `.sql` file node.
 * Static path resolution only (see `python-sql-loader-paths.ts`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';
import { extractPythonSqlLoadRefs, resolveToIndexedSqlPath } from './python-sql-loader-paths.js';

type PyFileRow = { id: number; path: string };
type FnRow = { symbol_id: string; line_start: number; line_end: number };

function readPySource(state: PipelineState, relPath: string): string | null {
  const cached = state.fileContentCache.get(relPath);
  if (cached !== undefined) return cached;
  try {
    return fs.readFileSync(path.join(state.rootPath, relPath), 'utf8');
  } catch {
    return null;
  }
}

function functionForLine(functions: FnRow[], line: number): FnRow | null {
  let best: FnRow | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const fn of functions) {
    if (line < fn.line_start || line > fn.line_end) continue;
    const span = fn.line_end - fn.line_start;
    if (span < bestSpan) {
      bestSpan = span;
      best = fn;
    }
  }
  return best;
}

export function resolveLoadsSqlEdges(state: PipelineState, scope?: ChangeScope): void {
  const { store } = state;

  store.db
    .prepare(
      'INSERT OR IGNORE INTO edge_types (name, category, directed, description) VALUES (?, ?, 1, ?)',
    )
    .run('loads_sql', 'python', 'Python loader references a .sql file path');

  const edgeType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('loads_sql') as
    | { id: number }
    | undefined;
  if (!edgeType) {
    logger.warn({ edgeType: 'loads_sql' }, 'edge_types row missing — skipping loads_sql');
    return;
  }

  const sqlPathRows = store.db
    .prepare(`SELECT path FROM files WHERE path LIKE '%.sql'`)
    .all() as Array<{ path: string }>;
  const indexedSqlPaths = new Set(sqlPathRows.map((r) => r.path));

  const scopedIds = scope ? Array.from(scope.changedFileIds) : null;
  if (scopedIds && scopedIds.length === 0) return;

  let pyFiles: PyFileRow[];
  if (scopedIds && scopedIds.length > 0) {
    pyFiles = [];
    const CHUNK = 900;
    for (let i = 0; i < scopedIds.length; i += CHUNK) {
      const chunk = scopedIds.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = store.db
        .prepare(`SELECT id, path FROM files WHERE path LIKE '%.py' AND id IN (${ph})`)
        .all(...chunk) as PyFileRow[];
      for (const r of rows) pyFiles.push(r);
    }
  } else {
    pyFiles = store.db
      .prepare(`SELECT id, path FROM files WHERE path LIKE '%.py'`)
      .all() as PyFileRow[];
  }

  if (pyFiles.length === 0) return;

  const pending: Array<{
    sourceFileId: number;
    sourceSymbolId: string | null;
    targetFileId: number;
    metadata: string;
  }> = [];

  for (const py of pyFiles) {
    const source = readPySource(state, py.path);
    if (!source) continue;

    const refs = extractPythonSqlLoadRefs(source, py.path);
    if (refs.length === 0) continue;

    const fnRows = store.db
      .prepare(
        `SELECT symbol_id, line_start, line_end FROM symbols
         WHERE file_id = ? AND kind = 'function'`,
      )
      .all(py.id) as FnRow[];

    for (const ref of refs) {
      const resolved = resolveToIndexedSqlPath(ref.sqlPath, py.path, indexedSqlPaths);
      if (!resolved) continue;
      const targetFile = store.getFile(resolved);
      if (!targetFile) continue;

      const fn = functionForLine(fnRows, ref.line);
      pending.push({
        sourceFileId: py.id,
        sourceSymbolId: fn?.symbol_id ?? null,
        targetFileId: targetFile.id,
        metadata: JSON.stringify({
          sqlPath: resolved,
          via: ref.via,
          callee: ref.callee,
          line: ref.line,
        }),
      });
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

  const targetFileNodeCache = new Map<number, number>();
  const sourceFileNodeCache = new Map<number, number>();

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
      }
      if (src == null) {
        let fileNode = sourceFileNodeCache.get(p.sourceFileId);
        if (fileNode == null) {
          fileNode =
            store.getNodeId('file', p.sourceFileId) ?? store.createNode('file', p.sourceFileId);
          sourceFileNodeCache.set(p.sourceFileId, fileNode);
        }
        src = fileNode;
      }

      let tgt = targetFileNodeCache.get(p.targetFileId);
      if (tgt == null) {
        tgt = store.getNodeId('file', p.targetFileId) ?? store.createNode('file', p.targetFileId);
        targetFileNodeCache.set(p.targetFileId, tgt);
      }

      if (src === tgt) continue;
      insertStmt.run(src, tgt, edgeType.id, p.metadata);
      created++;
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'loads_sql edges resolved');
  }
}
