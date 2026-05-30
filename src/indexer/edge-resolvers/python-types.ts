/**
 * Python type-reference edge resolver.
 *
 * Converts the `typeRefs` names collected at extraction time (parameter/return
 * annotations on functions & methods, annotated attributes on classes) into
 * symbol-level `references` edges pointing at the referenced class symbols.
 *
 * This is the Python counterpart of `typescript-types.ts`. Without it, changing
 * a Python class (e.g. a SQLModel/Pydantic model `User`) produced a blast radius
 * that only included direct constructor calls — every repository/service function
 * that merely takes or returns a `User` was invisible, because Python imports
 * resolve to file→file edges and type annotations previously produced nothing
 * but unresolved self-loops. Resolving them to `references` edges brings Python
 * impact analysis to parity with TypeScript.
 *
 * Resolution is workspace-isolated and prefers, in order:
 *   1. a target class defined in the same file,
 *   2. a target class reachable through an explicit import of that name,
 *   3. an unambiguous single target in the same workspace.
 */

import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

interface SourceRow {
  id: number;
  name: string;
  kind: string;
  file_id: number;
  metadata: string | null;
  workspace: string | null;
}

interface TargetRow {
  id: number;
  name: string;
  kind: string;
  file_id: number;
  workspace: string | null;
}

// Kinds that a Python type annotation can legitimately point at.
const TARGET_KINDS = new Set(['class', 'interface', 'type_alias', 'enum', 'type']);

export function resolvePythonTypeEdges(state: PipelineState, scope?: ChangeScope): void {
  const { store } = state;

  const refEdgeType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('references') as { id: number } | undefined;
  if (!refEdgeType) return;

  // Scope-aware: only re-resolve type edges OUT from files re-extracted this run.
  // Targets are queried globally — cross-file resolution needs the full set.
  const scopedIds = scope ? Array.from(scope.changedFileIds) : null;
  if (scopedIds && scopedIds.length === 0) return;

  let sources: SourceRow[];
  if (scopedIds && scopedIds.length > 0) {
    const ph = scopedIds.map(() => '?').join(',');
    sources = store.db
      .prepare(`
      SELECT s.id, s.name, s.kind, s.file_id, s.metadata, f.workspace
        FROM symbols s
        JOIN files f ON s.file_id = f.id
       WHERE f.language = 'python'
         AND s.metadata IS NOT NULL
         AND s.metadata LIKE '%"typeRefs"%'
         AND s.file_id IN (${ph})
    `)
      .all(...scopedIds) as SourceRow[];
  } else {
    sources = store.db
      .prepare(`
      SELECT s.id, s.name, s.kind, s.file_id, s.metadata, f.workspace
        FROM symbols s
        JOIN files f ON s.file_id = f.id
       WHERE f.language = 'python'
         AND s.metadata IS NOT NULL
         AND s.metadata LIKE '%"typeRefs"%'
    `)
      .all() as SourceRow[];
  }

  if (sources.length === 0) return;

  const targets = store.db
    .prepare(`
    SELECT s.id, s.name, s.kind, s.file_id, f.workspace
      FROM symbols s
      JOIN files f ON s.file_id = f.id
     WHERE f.language = 'python'
       AND s.kind IN ('class','interface','type_alias','enum','type')
  `)
    .all() as TargetRow[];

  if (targets.length === 0) return;

  const byName = new Map<string, TargetRow[]>();
  for (const t of targets) {
    const list = byName.get(t.name) ?? [];
    list.push(t);
    byName.set(t.name, list);
  }

  // Pre-load node IDs for sources + targets.
  const symbolNodeMap = new Map<number, number>();
  const CHUNK = 500;
  const allIds = [...new Set([...sources.map((s) => s.id), ...targets.map((t) => t.id)])];
  for (let i = 0; i < allIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('symbol', allIds.slice(i, i + CHUNK))) {
      symbolNodeMap.set(k, v);
    }
  }

  const fileImportMap = buildPythonFileImportMap(state);

  const insertStmt = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
     VALUES (?, ?, ?, 1, ?, 0, 'ast_resolved')`,
  );

  let created = 0;

  store.db.transaction(() => {
    for (const src of sources) {
      let typeRefs: string[] = [];
      try {
        const meta = JSON.parse(src.metadata as string) as Record<string, unknown>;
        if (Array.isArray(meta.typeRefs)) typeRefs = meta.typeRefs as string[];
      } catch {
        continue;
      }
      if (typeRefs.length === 0) continue;

      const sourceNodeId = symbolNodeMap.get(src.id);
      if (sourceNodeId == null) continue;

      const fileImports = fileImportMap.get(src.file_id);

      for (const refName of typeRefs) {
        const target = resolveTypeRef(refName, src.workspace, src.file_id, fileImports, byName);
        if (!target) continue;
        if (target.id === src.id) continue;

        const targetNodeId = symbolNodeMap.get(target.id);
        if (targetNodeId == null || targetNodeId === sourceNodeId) continue;

        insertStmt.run(
          sourceNodeId,
          targetNodeId,
          refEdgeType.id,
          JSON.stringify({ type_name: refName, via: 'type_annotation' }),
        );
        created++;
      }
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'Python type-reference edges resolved');
  }
}

function resolveTypeRef(
  name: string,
  sourceWorkspace: string | null,
  sourceFileId: number,
  fileImports: Map<string, number[]> | undefined,
  byName: Map<string, TargetRow[]>,
): TargetRow | null {
  const candidates = byName.get(name);
  if (!candidates || candidates.length === 0) return null;

  // 1. Same file wins.
  const sameFile = candidates.find((t) => t.file_id === sourceFileId && TARGET_KINDS.has(t.kind));
  if (sameFile) return sameFile;

  // 2. Imported: the file explicitly imports this name from a known module.
  if (fileImports) {
    const importTargetFiles = fileImports.get(name);
    if (importTargetFiles) {
      for (const tfid of importTargetFiles) {
        const hit = candidates.find((t) => t.file_id === tfid && TARGET_KINDS.has(t.kind));
        if (hit) return hit;
      }
    }
  }

  // 3. Unambiguous single match in the same workspace.
  const sameWs = candidates.filter(
    (t) => t.workspace === sourceWorkspace && TARGET_KINDS.has(t.kind),
  );
  if (sameWs.length === 1) return sameWs[0];

  // Ambiguous or cross-workspace — do not guess.
  return null;
}

/**
 * file_id → (importedName → [targetFileId]) for Python files, built from the
 * already-resolved file→file `imports` edges and their `specifiers` metadata.
 */
function buildPythonFileImportMap(state: PipelineState): Map<number, Map<string, number[]>> {
  const { store } = state;
  const result = new Map<number, Map<string, number[]>>();

  const importEdgeType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('imports') as { id: number } | undefined;
  if (!importEdgeType) return result;

  const rows = store.db
    .prepare(`
    SELECT e.source_node_id, e.target_node_id, e.metadata
      FROM edges e
      JOIN nodes ns ON ns.id = e.source_node_id
      JOIN nodes nt ON nt.id = e.target_node_id
     WHERE e.edge_type_id = ?
       AND ns.node_type = 'file'
       AND nt.node_type = 'file'
  `)
    .all(importEdgeType.id) as Array<{
    source_node_id: number;
    target_node_id: number;
    metadata: string | null;
  }>;

  if (rows.length === 0) return result;

  const allNodeIds = new Set<number>();
  for (const r of rows) {
    allNodeIds.add(r.source_node_id);
    allNodeIds.add(r.target_node_id);
  }

  const nodeToFileId = new Map<number, number>();
  const arr = Array.from(allNodeIds);
  for (let i = 0; i < arr.length; i += 500) {
    const chunk = arr.slice(i, i + 500);
    const ph = chunk.map(() => '?').join(',');
    const fsRows = store.db
      .prepare(`SELECT id, ref_id FROM nodes WHERE node_type = 'file' AND id IN (${ph})`)
      .all(...chunk) as Array<{ id: number; ref_id: number }>;
    for (const r of fsRows) nodeToFileId.set(r.id, r.ref_id);
  }

  const pyFileIds = new Set<number>();
  const fl = store.db.prepare(`SELECT id FROM files WHERE language = 'python'`).all() as Array<{
    id: number;
  }>;
  for (const r of fl) pyFileIds.add(r.id);

  for (const edge of rows) {
    const srcFid = nodeToFileId.get(edge.source_node_id);
    const tgtFid = nodeToFileId.get(edge.target_node_id);
    if (srcFid == null || tgtFid == null) continue;
    if (!pyFileIds.has(srcFid)) continue;

    let specifiers: string[] = [];
    if (edge.metadata) {
      try {
        const meta = JSON.parse(edge.metadata) as Record<string, unknown>;
        if (Array.isArray(meta.specifiers)) specifiers = meta.specifiers as string[];
      } catch {
        /* ignore */
      }
    }

    let fileMap = result.get(srcFid);
    if (!fileMap) {
      fileMap = new Map();
      result.set(srcFid, fileMap);
    }

    for (const spec of specifiers) {
      if (!spec || spec === '*') continue;
      // `User as U` → bind both the alias and the original name.
      const m = spec.match(/^(\w+)\s+as\s+(\w+)$/);
      const names = m ? [m[1], m[2]] : [spec];
      for (const nm of names) {
        const existing = fileMap.get(nm) ?? [];
        if (!existing.includes(tgtFid)) existing.push(tgtFid);
        fileMap.set(nm, existing);
      }
    }
  }

  return result;
}
