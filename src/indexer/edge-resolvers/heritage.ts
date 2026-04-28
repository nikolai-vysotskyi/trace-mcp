/** Pass 2c: Resolve TypeScript extends/implements into graph edges. */

import { logger } from '../../logger.js';
import type { PipelineState } from '../pipeline-state.js';
import { PhantomSymbolFactory } from './phantom-externals.js';

export function resolveTypeScriptHeritageEdges(state: PipelineState): void {
  const { store } = state;
  const changedFileIds =
    state.isIncremental && state.changedFileIds.size > 0
      ? Array.from(state.changedFileIds)
      : undefined;
  const symbolsWithHeritage = store.getSymbolsWithHeritage(changedFileIds);
  if (symbolsWithHeritage.length === 0) return;

  // Look up workspace per source file so phantoms are created per-workspace
  // (matches the isolation semantics used by ts_extends resolution itself —
  // a TS monorepo workspace and another workspace referencing `BaseService`
  // should each get their own phantom, not share one).
  const fileWorkspaceMap = new Map<number, string | null>();
  const fileIds = new Set<number>(symbolsWithHeritage.map((s) => s.file_id));
  if (fileIds.size > 0) {
    const ids = Array.from(fileIds);
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = store.db
        .prepare(`SELECT id, workspace FROM files WHERE id IN (${ph})`)
        .all(...chunk) as Array<{ id: number; workspace: string | null }>;
      for (const r of rows) fileWorkspaceMap.set(r.id, r.workspace);
    }
  }
  const phantoms = new PhantomSymbolFactory(state, 'typescript');
  let phantomNodesCreated = 0;

  // Collect all target names referenced by heritage metadata
  const neededNames = new Set<string>();
  for (const sym of symbolsWithHeritage) {
    try {
      if (!sym.metadata) continue;
      const meta = JSON.parse(sym.metadata) as Record<string, unknown>;
      const ext = meta.extends;
      if (Array.isArray(ext))
        for (const n of ext) {
          if (typeof n === 'string') neededNames.add(n);
        }
      else if (typeof ext === 'string') neededNames.add(ext);
      const impl = meta.implements;
      if (Array.isArray(impl))
        for (const n of impl) {
          if (typeof n === 'string') neededNames.add(n);
        }
    } catch {
      /* skip malformed metadata */
    }
  }

  // Build name → {id, kind, workspace} index — include workspace so we can
  // filter candidates by the source's workspace. Without this, a monorepo
  // with N workspaces all declaring `class BaseService` would cross-link.
  const nameIndex = new Map<string, { id: number; kind: string; workspace: string | null }[]>();
  if (neededNames.size > 0) {
    const CHUNK = 500;
    const nameArr = Array.from(neededNames);
    for (let i = 0; i < nameArr.length; i += CHUNK) {
      const chunk = nameArr.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = store.db
        .prepare(
          `SELECT s.id, s.name, s.kind, f.workspace
           FROM symbols s
           JOIN files f ON f.id = s.file_id
          WHERE s.kind IN ('class', 'interface') AND s.name IN (${ph})`,
        )
        .all(...chunk) as { id: number; name: string; kind: string; workspace: string | null }[];
      for (const s of rows) {
        const list = nameIndex.get(s.name) ?? [];
        list.push({ id: s.id, kind: s.kind, workspace: s.workspace });
        nameIndex.set(s.name, list);
      }
    }
  }

  // Pre-load symbol node IDs
  const allNeededIds = [
    ...new Set([
      ...symbolsWithHeritage.map((s) => s.id),
      ...[...nameIndex.values()].flat().map((s) => s.id),
    ]),
  ];
  const symbolNodeMap = new Map<number, number>();
  const CHUNK = 500;
  for (let i = 0; i < allNeededIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('symbol', allNeededIds.slice(i, i + CHUNK))) {
      symbolNodeMap.set(k, v);
    }
  }

  const tsExtendsType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('ts_extends') as { id: number } | undefined;
  const tsImplementsType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('ts_implements') as { id: number } | undefined;
  if (!tsExtendsType || !tsImplementsType) return;

  let created = 0;
  const insertStmt = store.db.prepare(
    `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, NULL, 0)`,
  );

  store.db.transaction(() => {
    for (const sym of symbolsWithHeritage) {
      let meta: Record<string, unknown> = {};
      try {
        if (sym.metadata) meta = JSON.parse(sym.metadata) as Record<string, unknown>;
      } catch {
        continue;
      }
      const sourceNodeId = symbolNodeMap.get(sym.id);
      if (sourceNodeId == null) continue;

      const sourceWs = fileWorkspaceMap.get(sym.file_id) ?? null;

      const emitPhantomEdge = (
        targetName: string,
        edgeTypeId: number,
        phantomKind: 'class' | 'interface',
      ): void => {
        const before = phantoms.peek(targetName, sourceWs);
        const phantom = phantoms.ensure(targetName, sourceWs, phantomKind);
        if (!before) phantomNodesCreated++;
        if (phantom.node_id === sourceNodeId) return;
        insertStmt.run(sourceNodeId, phantom.node_id, edgeTypeId);
        created++;
      };

      // Strict workspace isolation: a candidate only matches if it shares
      // the source's workspace. Falling back to phantom externals keeps the
      // graph dense without smearing edges across independent projects.
      const pickSameWs = (
        candidates: { id: number; kind: string; workspace: string | null }[] | undefined,
      ) => {
        if (!candidates || candidates.length === 0) return null;
        return candidates.filter((c) => c.workspace === sourceWs);
      };

      const ext = meta.extends;
      const extNames = Array.isArray(ext)
        ? (ext as string[])
        : typeof ext === 'string'
          ? [ext]
          : [];
      for (const targetName of extNames) {
        if (typeof targetName !== 'string' || !targetName) continue;
        const sameWsTargets = pickSameWs(nameIndex.get(targetName));
        if (sameWsTargets && sameWsTargets.length > 0) {
          const targetNodeId = symbolNodeMap.get(sameWsTargets[0].id);
          if (targetNodeId == null) continue;
          insertStmt.run(sourceNodeId, targetNodeId, tsExtendsType.id);
          created++;
          continue;
        }
        // Phantom fallback — external class (React.Component, Error, EventEmitter, etc.)
        emitPhantomEdge(targetName, tsExtendsType.id, 'class');
      }

      const impl = meta.implements;
      if (Array.isArray(impl)) {
        for (const targetName of impl as string[]) {
          if (typeof targetName !== 'string' || !targetName) continue;
          const sameWsTargets = pickSameWs(nameIndex.get(targetName));
          if (sameWsTargets && sameWsTargets.length > 0) {
            const target = sameWsTargets.find((t) => t.kind === 'interface') ?? sameWsTargets[0];
            const targetNodeId = symbolNodeMap.get(target.id);
            if (targetNodeId == null) continue;
            insertStmt.run(sourceNodeId, targetNodeId, tsImplementsType.id);
            created++;
            continue;
          }
          emitPhantomEdge(targetName, tsImplementsType.id, 'interface');
        }
      }
    }
  })();

  if (created > 0) {
    logger.info({ edges: created, phantomNodesCreated }, 'TypeScript heritage edges resolved');
  }
}
