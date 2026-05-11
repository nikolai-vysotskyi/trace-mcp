/**
 * Python heritage edge resolver — resolves py_inherits metadata edges
 * to symbol-level graph edges, similar to TypeScript heritage resolver.
 *
 * Reads `metadata.bases` from Python class symbols and creates
 * extends-style edges to the target base class symbols.
 */

import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

export function resolvePythonHeritageEdges(state: PipelineState, scope?: ChangeScope): void {
  const { store } = state;

  // Get all Python class symbols with bases metadata
  const changedFileIds = scope
    ? Array.from(scope.changedFileIds)
    : state.isIncremental && state.changedFileIds.size > 0
      ? Array.from(state.changedFileIds)
      : undefined;

  let query: string;
  const params: unknown[] = [];

  if (changedFileIds?.length) {
    const ph = changedFileIds.map(() => '?').join(',');
    query = `SELECT s.id, s.name, s.metadata FROM symbols s
             JOIN files f ON s.file_id = f.id
             WHERE f.language = 'python' AND s.kind = 'class'
             AND s.metadata IS NOT NULL AND s.metadata LIKE '%"bases"%'
             AND f.id IN (${ph})`;
    params.push(...changedFileIds);
  } else {
    query = `SELECT s.id, s.name, s.metadata FROM symbols s
             JOIN files f ON s.file_id = f.id
             WHERE f.language = 'python' AND s.kind = 'class'
             AND s.metadata IS NOT NULL AND s.metadata LIKE '%"bases"%'`;
  }

  const classesWithBases = store.db.prepare(query).all(...params) as Array<{
    id: number;
    name: string;
    metadata: string;
  }>;

  if (classesWithBases.length === 0) return;

  // Collect all base class names referenced
  const neededNames = new Set<string>();
  for (const cls of classesWithBases) {
    try {
      const meta = JSON.parse(cls.metadata) as Record<string, unknown>;
      const bases = meta.bases;
      if (Array.isArray(bases)) {
        for (const b of bases) {
          if (typeof b === 'string') {
            // Use short name for resolution: `abc.ABC` → `ABC`
            const shortName = b.includes('.') ? b.split('.').pop()! : b;
            neededNames.add(shortName);
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  if (neededNames.size === 0) return;

  // Build name → {id, kind} index for Python classes
  const nameIndex = new Map<string, { id: number }[]>();
  const CHUNK = 500;
  const nameArr = Array.from(neededNames);
  for (let i = 0; i < nameArr.length; i += CHUNK) {
    const chunk = nameArr.slice(i, i + CHUNK);
    const ph = chunk.map(() => '?').join(',');
    const rows = store.db
      .prepare(
        `SELECT s.id, s.name FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.language = 'python' AND s.kind = 'class' AND s.name IN (${ph})`,
      )
      .all(...chunk) as { id: number; name: string }[];
    for (const s of rows) {
      const list = nameIndex.get(s.name) ?? [];
      list.push({ id: s.id });
      nameIndex.set(s.name, list);
    }
  }

  // Pre-load symbol node IDs
  const allIds = [
    ...classesWithBases.map((c) => c.id),
    ...[...nameIndex.values()].flat().map((s) => s.id),
  ];
  const symbolNodeMap = new Map<number, number>();
  for (let i = 0; i < allIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('symbol', allIds.slice(i, i + CHUNK))) {
      symbolNodeMap.set(k, v);
    }
  }

  const extendsType = store.db.prepare(`SELECT id FROM edge_types WHERE name = ?`).get('extends') as
    | { id: number }
    | undefined;
  // Fallback to py_inherits if generic 'extends' doesn't exist
  const pyInheritsType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('py_inherits') as { id: number } | undefined;

  const edgeTypeId = extendsType?.id ?? pyInheritsType?.id;
  if (edgeTypeId == null) return;

  let created = 0;
  const insertStmt = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, NULL, 0)`,
  );

  store.db.transaction(() => {
    for (const cls of classesWithBases) {
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(cls.metadata) as Record<string, unknown>;
      } catch {
        continue;
      }
      const bases = meta.bases;
      if (!Array.isArray(bases)) continue;

      const sourceNodeId = symbolNodeMap.get(cls.id);
      if (sourceNodeId == null) continue;

      for (const base of bases as string[]) {
        const shortName = base.includes('.') ? base.split('.').pop()! : base;
        const targets = nameIndex.get(shortName);
        if (!targets?.length) continue;

        // Prefer same-file match, then first match
        const targetNodeId = symbolNodeMap.get(targets[0].id);
        if (targetNodeId == null) continue;
        if (sourceNodeId === targetNodeId) continue;

        insertStmt.run(sourceNodeId, targetNodeId, edgeTypeId);
        created++;
      }
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'Python heritage edges resolved');
  }
}
