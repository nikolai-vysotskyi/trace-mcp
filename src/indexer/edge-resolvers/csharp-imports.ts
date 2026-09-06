/**
 * Resolve C# `using` directive edges to the file declaring the namespace
 * (TRA-1027 — next after Ruby in the C#/Kotlin/Swift/Elixir/Lua backlog
 * `import-capable-languages.ts` names as "extract but nothing consumes").
 *
 * Unlike Java, C# does not force the namespace to mirror the directory
 * layout — `namespace Acme.Store` can live at any path — so suffix-matching
 * the specifier against file paths (the Java/Go approach) would silently
 * under-resolve any project that doesn't follow the folder-per-namespace
 * convention. Resolution instead uses the `namespace` symbols the plugin
 * already extracts (`CSharpLanguagePlugin.extractNamespace`, kind
 * `namespace`, `fqn` set to the dotted namespace path):
 *
 *     using Acme.Store;             // → every file declaring `namespace Acme.Store`
 *     using static Acme.Store.Ids;  // → trims the trailing type to the namespace
 *     using Alias = Acme.Store.Db;  // → same trim; alias doesn't change the target
 *
 * A namespace with no declaring file in the index (BCL, NuGet package) simply
 * fails to resolve rather than inventing a node.
 */
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

export function resolveCSharpImportEdges(state: PipelineState, _scope?: ChangeScope): void {
  // WHY: driven by `state.pendingImports`, already scoped to re-extracted files.
  void _scope;
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);
  const hasCSharp = pendingFileIds.some((id) => fileMap.get(id)?.language === 'csharp');
  if (!hasCSharp) return;

  // Namespace name → the files that declare it via a `namespace` block.
  const byNamespace = new Map<string, number[]>();
  const rows = store.db
    .prepare(
      `SELECT s.file_id AS fileId, s.fqn AS fqn
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE s.kind = 'namespace' AND f.language = 'csharp' AND s.fqn IS NOT NULL`,
    )
    .all() as Array<{ fileId: number; fqn: string }>;
  for (const { fileId, fqn } of rows) {
    const list = byNamespace.get(fqn);
    if (list) list.push(fileId);
    else byNamespace.set(fqn, [fileId]);
  }
  if (byNamespace.size === 0) return;

  const importsEdgeType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const nodeIds = new Map<number, number>();
  const allNamespaceFileIds = Array.from(byNamespace.values()).flat().concat(pendingFileIds);
  const CHUNK = 500;
  for (let i = 0; i < allNamespaceFileIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('file', allNamespaceFileIds.slice(i, i + CHUNK))) {
      nodeIds.set(k, v);
    }
  }

  const insertStmt = store.db.prepare(
    `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, ?, 0)
     ON CONFLICT(source_node_id, target_node_id, edge_type_id)
     DO UPDATE SET metadata = excluded.metadata`,
  );

  /**
   * `Acme.Store` resolves directly. `using static Acme.Store.Ids` and aliased
   * `using X = Acme.Store.Ids` name a type, not a namespace, so fall back to
   * the specifier with its last segment trimmed.
   */
  const resolve = (specifier: string): number[] => {
    const direct = byNamespace.get(specifier);
    if (direct) return direct;
    const cut = specifier.lastIndexOf('.');
    return (cut > 0 && byNamespace.get(specifier.slice(0, cut))) || [];
  };

  let created = 0;
  let external = 0;

  store.db.transaction(() => {
    for (const [fileId, imports] of state.pendingImports) {
      if (fileMap.get(fileId)?.language !== 'csharp') continue;
      const sourceNodeId = nodeIds.get(fileId);
      if (sourceNodeId == null) continue;

      const seen = new Set<string>();
      for (const { from } of imports) {
        if (!from || seen.has(from)) continue;
        seen.add(from);

        const targets = resolve(from);
        if (targets.length === 0) {
          external++;
          continue;
        }
        for (const targetId of targets) {
          const targetNodeId = nodeIds.get(targetId);
          if (targetNodeId == null || targetNodeId === sourceNodeId) continue;
          insertStmt.run(sourceNodeId, targetNodeId, importsEdgeType.id, JSON.stringify({ from }));
          created++;
        }
      }
    }
  })();

  if (created > 0 || external > 0) {
    logger.info({ edges: created, external }, 'C# import edges resolved');
  }
}
