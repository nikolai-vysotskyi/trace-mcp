/** Pass 2d: Resolve ES module import specifiers to file→file graph edges. */
import path from 'node:path';
import type { PipelineState } from '../pipeline-state.js';
import { EsModuleResolver } from '../resolvers/es-modules.js';
import { logger } from '../../logger.js';

export function resolveEsmImportEdges(state: PipelineState): void {
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  let resolver: EsModuleResolver;
  try {
    const workspacePaths = state.workspaces?.map((ws) => ws.path) ?? [];
    resolver = new EsModuleResolver(state.rootPath, workspacePaths);
  } catch {
    logger.warn('EsModuleResolver init failed — skipping import edge resolution');
    return;
  }

  let created = 0;

  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);
  const fileNodeMap = store.getNodeIdsBatch('file', pendingFileIds);

  const targetFileCache = new Map<string, { id: number; nodeId: number } | null>();
  const resolveTargetFile = (relPath: string): { id: number; nodeId: number } | null => {
    const cached = targetFileCache.get(relPath);
    if (cached !== undefined) return cached;
    const f = store.getFile(relPath);
    if (!f) { targetFileCache.set(relPath, null); return null; }
    const nodeId = store.getNodeId('file', f.id);
    if (nodeId == null) { targetFileCache.set(relPath, null); return null; }
    const entry = { id: f.id, nodeId };
    targetFileCache.set(relPath, entry);
    return entry;
  };

  const importsEdgeType = store.db.prepare('SELECT id FROM edge_types WHERE name = ?').get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const insertStmt = store.db.prepare(
    `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, ?, 0)
     ON CONFLICT(source_node_id, target_node_id, edge_type_id)
     DO UPDATE SET metadata = excluded.metadata`,
  );

  store.db.transaction(() => {
    for (const [fileId, imports] of state.pendingImports) {
      const file = fileMap.get(fileId);
      if (!file) continue;

      const absSource = path.resolve(state.rootPath, file.path);
      const sourceNodeId = fileNodeMap.get(fileId);
      if (sourceNodeId == null) continue;

      const consolidated = new Map<string, string[]>();
      for (const { from, specifiers } of imports) {
        const existing = consolidated.get(from);
        if (existing) {
          existing.push(...specifiers);
        } else {
          consolidated.set(from, [...specifiers]);
        }
      }

      for (const [from, specifiers] of consolidated) {
        if (!from.startsWith('.') && !from.startsWith('/') && !from.startsWith('@/') && !from.startsWith('~')) continue;

        const resolved = resolver.resolve(from, absSource);
        if (!resolved) continue;

        const relTarget = path.relative(state.rootPath, resolved);
        const target = resolveTargetFile(relTarget);
        if (!target) continue;

        insertStmt.run(
          sourceNodeId,
          target.nodeId,
          importsEdgeType.id,
          JSON.stringify({ from, specifiers }),
        );
        created++;
      }
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'ES module import edges resolved');
  }
}
