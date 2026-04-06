/** Pass 2c: Resolve TypeScript extends/implements into graph edges. */
import type { PipelineState } from '../pipeline-state.js';
import { logger } from '../../logger.js';

export function resolveTypeScriptHeritageEdges(state: PipelineState): void {
  const { store } = state;
  const changedFileIds = state.isIncremental && state.changedFileIds.size > 0
    ? Array.from(state.changedFileIds)
    : undefined;
  const symbolsWithHeritage = store.getSymbolsWithHeritage(changedFileIds);
  if (symbolsWithHeritage.length === 0) return;

  // Collect all target names referenced by heritage metadata
  const neededNames = new Set<string>();
  for (const sym of symbolsWithHeritage) {
    try {
      if (!sym.metadata) continue;
      const meta = JSON.parse(sym.metadata) as Record<string, unknown>;
      const ext = meta['extends'];
      if (Array.isArray(ext)) for (const n of ext) { if (typeof n === 'string') neededNames.add(n); }
      else if (typeof ext === 'string') neededNames.add(ext);
      const impl = meta['implements'];
      if (Array.isArray(impl)) for (const n of impl) { if (typeof n === 'string') neededNames.add(n); }
    } catch { /* skip malformed metadata */ }
  }

  // Build name → {id, kind} index
  const nameIndex = new Map<string, { id: number; kind: string }[]>();
  if (neededNames.size > 0) {
    const CHUNK = 500;
    const nameArr = Array.from(neededNames);
    for (let i = 0; i < nameArr.length; i += CHUNK) {
      const chunk = nameArr.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = store.db.prepare(
        `SELECT id, name, kind FROM symbols WHERE kind IN ('class', 'interface') AND name IN (${ph})`,
      ).all(...chunk) as { id: number; name: string; kind: string }[];
      for (const s of rows) {
        const list = nameIndex.get(s.name) ?? [];
        list.push({ id: s.id, kind: s.kind });
        nameIndex.set(s.name, list);
      }
    }
  }

  // Pre-load symbol node IDs
  const allNeededIds = [...new Set([
    ...symbolsWithHeritage.map((s) => s.id),
    ...[...nameIndex.values()].flat().map((s) => s.id),
  ])];
  const symbolNodeMap = new Map<number, number>();
  const CHUNK = 500;
  for (let i = 0; i < allNeededIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('symbol', allNeededIds.slice(i, i + CHUNK))) {
      symbolNodeMap.set(k, v);
    }
  }

  const tsExtendsType = store.db.prepare('SELECT id FROM edge_types WHERE name = ?').get('ts_extends') as { id: number } | undefined;
  const tsImplementsType = store.db.prepare('SELECT id FROM edge_types WHERE name = ?').get('ts_implements') as { id: number } | undefined;
  if (!tsExtendsType || !tsImplementsType) return;

  let created = 0;
  const insertStmt = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, NULL, 0)`,
  );

  store.db.transaction(() => {
    for (const sym of symbolsWithHeritage) {
      let meta: Record<string, unknown> = {};
      try { if (sym.metadata) meta = JSON.parse(sym.metadata) as Record<string, unknown>; } catch { continue; }
      const sourceNodeId = symbolNodeMap.get(sym.id);
      if (sourceNodeId == null) continue;

      const ext = meta['extends'];
      const extNames = Array.isArray(ext) ? ext as string[] : typeof ext === 'string' ? [ext] : [];
      for (const targetName of extNames) {
        const targets = nameIndex.get(targetName);
        if (!targets?.length) continue;
        const targetNodeId = symbolNodeMap.get(targets[0].id);
        if (targetNodeId == null) continue;
        insertStmt.run(sourceNodeId, targetNodeId, tsExtendsType.id);
        created++;
      }

      const impl = meta['implements'];
      if (Array.isArray(impl)) {
        for (const targetName of impl as string[]) {
          const targets = nameIndex.get(targetName);
          if (!targets?.length) continue;
          const target = targets.find((t) => t.kind === 'interface') ?? targets[0];
          const targetNodeId = symbolNodeMap.get(target.id);
          if (targetNodeId == null) continue;
          insertStmt.run(sourceNodeId, targetNodeId, tsImplementsType.id);
          created++;
        }
      }
    }
  })();

  if (created > 0) {
    logger.info({ edges: created }, 'TypeScript heritage edges resolved');
  }
}
