/**
 * Resolve C# `using` directive edges to the file declaring the namespace or
 * type (TRA-1027 — next after Ruby in the C#/Kotlin/Swift/Elixir/Lua backlog
 * `import-capable-languages.ts` names as "extract but nothing consumes").
 *
 * Unlike Java, C# does not force the namespace to mirror the directory
 * layout — `namespace Acme.Store` can live at any path — so suffix-matching
 * the specifier against file paths (the Java/Go approach) would silently
 * under-resolve any project that doesn't follow the folder-per-namespace
 * convention. Resolution instead uses the symbols the plugin already
 * extracts (`namespace` from `CSharpLanguagePlugin.extractNamespace`, plus
 * `class`/`interface`/`enum`/`type` for the type-level cases below), each
 * with `fqn` set to its dotted path:
 *
 *     using Acme.Store;             // → every file declaring `namespace Acme.Store`
 *     using static Acme.Store.Ids;  // → only the file declaring type `Acme.Store.Ids`
 *     using Alias = Acme.Store.Db;  // → only the file declaring type `Acme.Store.Db`
 *
 * A namespace is not a directory: `using Acme.Store.Billing` does not import
 * `Acme.Store`, so an exact-namespace or exact-type match is required before
 * falling back — trimming to a *namespace* match on a miss would treat a
 * plain `using` of an unindexed sub-namespace as if it named the parent,
 * linking to every file in it. The one place trimming is still safe is a
 * type miss, where it recovers a nested type's enclosing type. A specifier
 * matching neither (BCL, NuGet package) simply fails to resolve rather than
 * inventing a node.
 */
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

function addTo(map: Map<string, number[]>, key: string, id: number): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(id)) list.push(id);
  } else {
    map.set(key, [id]);
  }
}

export function resolveCSharpImportEdges(state: PipelineState, _scope?: ChangeScope): void {
  // WHY: driven by `state.pendingImports`, already scoped to re-extracted files.
  void _scope;
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);
  const hasCSharp = pendingFileIds.some((id) => fileMap.get(id)?.language === 'csharp');
  if (!hasCSharp) return;

  // Namespace name → the files declaring it via a `namespace` block.
  const byNamespace = new Map<string, number[]>();
  // Type FQN → the file(s) declaring that class/struct/record/interface/enum/delegate.
  const byType = new Map<string, number[]>();
  const rows = store.db
    .prepare(
      `SELECT s.file_id AS fileId, s.fqn AS fqn, s.kind AS kind
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.language = 'csharp' AND s.fqn IS NOT NULL
         AND s.kind IN ('namespace', 'class', 'interface', 'enum', 'type')`,
    )
    .all() as Array<{ fileId: number; fqn: string; kind: string }>;
  for (const { fileId, fqn, kind } of rows) {
    addTo(kind === 'namespace' ? byNamespace : byType, fqn, fileId);
  }
  if (byNamespace.size === 0 && byType.size === 0) return;

  const importsEdgeType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const nodeIds = new Map<number, number>();
  const allTargetFileIds = Array.from(byNamespace.values())
    .concat(Array.from(byType.values()))
    .flat()
    .concat(pendingFileIds);
  const CHUNK = 500;
  for (let i = 0; i < allTargetFileIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('file', allTargetFileIds.slice(i, i + CHUNK))) {
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
   * `Acme.Store` resolves as a namespace directly. `using static
   * Acme.Store.Ids` and aliased `using X = Acme.Store.Ids` name a type, so
   * try an exact type match before trimming — and trim only into `byType`
   * (a nested type's enclosing type), never back into `byNamespace`: a miss
   * on a real namespace means an external/unindexed sub-namespace, not the
   * parent.
   */
  const resolve = (specifier: string): number[] => {
    const ns = byNamespace.get(specifier);
    if (ns) return ns;
    const type = byType.get(specifier);
    if (type) return type;
    const cut = specifier.lastIndexOf('.');
    return (cut > 0 && byType.get(specifier.slice(0, cut))) || [];
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
