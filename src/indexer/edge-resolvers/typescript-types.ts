/**
 * TypeScript/JavaScript type reference edge resolver.
 * Converts `typeRefs` metadata (collected at extraction time) into `references` edges.
 *
 * This connects:
 *   - function/method params + return type → referenced types/interfaces/classes
 *   - `type Foo = Bar` → Bar
 *   - `interface Foo extends Bar` → Bar (supplements the ts_extends edge)
 *   - `class Foo { field: Bar }` → Bar
 *   - Generic arguments: `Array<Bar>`, `Promise<Baz>` → Bar, Baz
 *
 * Resolution is workspace-isolated and prefers same-workspace candidates.
 */
import type { PipelineState } from '../pipeline-state.js';
import { logger } from '../../logger.js';

const TS_JS_LANGS = "('typescript','javascript','tsx','jsx','vue')";

interface SymbolRow {
  id: number;
  symbol_id: string;
  name: string;
  kind: string;
  file_id: number;
  metadata: string | null;
  workspace: string | null;
}

type TargetEntry = {
  id: number;
  symbol_id: string;
  name: string;
  kind: string;
  file_id: number;
  workspace: string | null;
};

const TARGET_KINDS = new Set(['class', 'interface', 'type', 'enum']);

export function resolveTypeScriptTypeEdges(state: PipelineState): void {
  const { store } = state;

  const refEdgeType = store.db
    .prepare(`SELECT id FROM edge_types WHERE name = ?`)
    .get('references') as { id: number } | undefined;
  if (!refEdgeType) return;

  const sources = store.db
    .prepare(`
    SELECT s.id, s.symbol_id, s.name, s.kind, s.file_id, s.metadata, f.workspace
      FROM symbols s
      JOIN files f ON s.file_id = f.id
     WHERE f.language IN ${TS_JS_LANGS}
       AND s.metadata IS NOT NULL
       AND s.metadata LIKE '%"typeRefs"%'
  `)
    .all() as SymbolRow[];

  if (sources.length === 0) return;

  const targetSyms = store.db
    .prepare(`
    SELECT s.id, s.symbol_id, s.name, s.kind, s.file_id, f.workspace
      FROM symbols s
      JOIN files f ON s.file_id = f.id
     WHERE f.language IN ${TS_JS_LANGS}
       AND s.kind IN ('class','interface','type','enum')
  `)
    .all() as TargetEntry[];

  // Index targets by name
  const byName = new Map<string, TargetEntry[]>();
  for (const t of targetSyms) {
    const list = byName.get(t.name) ?? [];
    list.push(t);
    byName.set(t.name, list);
  }

  // Pre-load node IDs for all targets and sources
  const symbolNodeMap = new Map<number, number>();
  const CHUNK = 500;
  const allIds = [...new Set([...sources.map((s) => s.id), ...targetSyms.map((t) => t.id)])];
  for (let i = 0; i < allIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('symbol', allIds.slice(i, i + CHUNK))) {
      symbolNodeMap.set(k, v);
    }
  }

  // Build per-file imports (reuse pattern from typescript-calls)
  const fileImportMap = buildFileImportMap(state);

  const insertStmt = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
     VALUES (?, ?, ?, 1, ?, 0, 'ast_resolved')`,
  );

  let created = 0;

  store.db.transaction(() => {
    for (const src of sources) {
      let typeRefs: string[] = [];
      try {
        const meta = JSON.parse(src.metadata!) as Record<string, unknown>;
        if (Array.isArray(meta.typeRefs)) typeRefs = meta.typeRefs as string[];
      } catch {
        continue;
      }
      if (typeRefs.length === 0) continue;

      const sourceNodeId = symbolNodeMap.get(src.id);
      if (sourceNodeId == null) continue;

      const fileImports = fileImportMap.get(src.file_id);

      for (const refName of typeRefs) {
        const target = resolveTypeRef(
          refName,
          src.workspace,
          src.file_id,
          fileImports,
          byName,
          targetSyms,
        );
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
    logger.info({ edges: created }, 'TypeScript/JavaScript type-reference edges resolved');
  }
}

function resolveTypeRef(
  name: string,
  sourceWorkspace: string | null,
  sourceFileId: number,
  fileImports: Map<string, number[]> | undefined,
  byName: Map<string, TargetEntry[]>,
  _allTargets: TargetEntry[],
): TargetEntry | null {
  const candidates = byName.get(name);
  if (!candidates || candidates.length === 0) return null;

  // 1. Same file wins
  const sameFile = candidates.find((t) => t.file_id === sourceFileId && TARGET_KINDS.has(t.kind));
  if (sameFile) return sameFile;

  // 2. Imported type: if file has an explicit import for this name
  if (fileImports) {
    const importTargetFiles = fileImports.get(name);
    if (importTargetFiles) {
      for (const tfid of importTargetFiles) {
        const hit = candidates.find((t) => t.file_id === tfid && TARGET_KINDS.has(t.kind));
        if (hit) return hit;
      }
    }
  }

  // 3. Same workspace
  const sameWs = candidates.filter(
    (t) => t.workspace === sourceWorkspace && TARGET_KINDS.has(t.kind),
  );
  if (sameWs.length === 1) return sameWs[0];
  if (sameWs.length > 1) {
    // Tie-break: prefer exported type/interface/class. All are target_kinds; take first.
    return sameWs[0];
  }

  // 4. Strict: no cross-workspace match
  return null;
}

function buildFileImportMap(state: PipelineState): Map<number, Map<string, number[]>> {
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

  const tsJsFileIds = new Set<number>();
  const fl = store.db
    .prepare(`SELECT id FROM files WHERE language IN ${TS_JS_LANGS}`)
    .all() as Array<{ id: number }>;
  for (const r of fl) tsJsFileIds.add(r.id);

  for (const edge of rows) {
    const srcFid = nodeToFileId.get(edge.source_node_id);
    const tgtFid = nodeToFileId.get(edge.target_node_id);
    if (srcFid == null || tgtFid == null) continue;
    if (!tsJsFileIds.has(srcFid)) continue;

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
      const m = spec.match(/^\*\s+as\s+(\w+)$/);
      const nm = m ? m[1] : spec;
      const existing = fileMap.get(nm) ?? [];
      if (!existing.includes(tgtFid)) existing.push(tgtFid);
      fileMap.set(nm, existing);
    }
  }

  return result;
}
