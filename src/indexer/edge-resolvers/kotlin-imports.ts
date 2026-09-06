/**
 * Resolve Kotlin import specifiers to file→file graph edges (TRA-451).
 *
 *     import com.example.store.Repo      // → the file declaring class Repo
 *     import com.example.store.*         // → every file with a top-level
 *                                            declaration in that package
 *     import com.example.util.Ids.next   // → the file declaring object Ids
 *
 * The Kotlin plugin already extracted these (`metadata.from`), but nothing
 * consumed them — same gap TRA-449 closed for Go, since closed for Java,
 * Rust, C/C++, Ruby, C#. Resolution indexes the **declared** `fqn` already
 * persisted on every symbol (package + name), not the file's directory path.
 *
 * A first version matched on directory suffix the way Java's resolver does,
 * on the (Java-inherited) assumption that package mirrors directory layout.
 * Kotlin doesn't enforce that — code review on this PR (TRA-451) caught it
 * with a fixture where `misleading/Ghost.kt` declares `package
 * org.unrelated`: the path-based resolver linked an importer of
 * `com.example.app.misleading.Ghost` straight to that file, a confident
 * wrong edge, not a missed one. Indexing the declared `fqn` instead makes
 * that same input resolve to nothing, which is correct — no file in the
 * fixture declares that package.
 *
 * One case the plugin's own `fqn` doesn't carry: a nested class's `fqn` is
 * `package.Name`, not `package.Outer.Name` (`parentSymbolId` handles
 * `symbolId` collisions between a nested and a same-named top-level
 * declaration, but the `fqn` field itself drops the outer name). So
 * `import com.example.store.Repo.Cursor` won't exact-match anything; the
 * one-segment-up fallback (same trick Java's resolver uses, for the same
 * reason) retries as `com.example.store.Repo` and finds the outer class's
 * file, which is the correct target either way.
 */
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

function addTo(map: Map<string, number[]>, key: string, id: number): void {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

export function resolveKotlinImportEdges(state: PipelineState, _scope?: ChangeScope): void {
  // WHY: driven by `state.pendingImports`, already scoped to re-extracted files.
  void _scope;
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);
  const hasKotlin = pendingFileIds.some((id) => fileMap.get(id)?.language === 'kotlin');
  if (!hasKotlin) return;

  // `fqn`, dot-segments swapped for `/`, → the file(s) declaring it.
  // `byPackage` keys are that same path with the last segment stripped — a
  // wildcard import names the package, not a specific declaration.
  const byFqn = new Map<string, number[]>();
  const byPackage = new Map<string, number[]>();
  const fqnRows = store.db
    .prepare(
      `SELECT DISTINCT s.fqn, s.file_id FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE s.fqn IS NOT NULL AND f.language = 'kotlin'`,
    )
    .all() as Array<{ fqn: string; file_id: number }>;
  if (fqnRows.length === 0) return;

  const allKotlinIds = new Set<number>();
  for (const { fqn, file_id } of fqnRows) {
    const path = fqn.split('.').join('/');
    allKotlinIds.add(file_id);
    addTo(byFqn, path, file_id);
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (dir) addTo(byPackage, dir, file_id);
  }

  const importsEdgeType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const nodeIds = new Map<number, number>();
  const lookupIds = Array.from(allKotlinIds).concat(pendingFileIds);
  const CHUNK = 500;
  for (let i = 0; i < lookupIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('file', lookupIds.slice(i, i + CHUNK))) {
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
   * `com.example.store.Repo` → the files it can mean. Tried in order: an
   * exact declaration match, the package it would be as a wildcard, then
   * one segment up — the nested-class case documented above.
   */
  const resolve = (specifier: string): number[] => {
    const bare = specifier.endsWith('.*') ? specifier.slice(0, -2) : specifier;
    const path = bare.split('.').join('/');
    const exact = byFqn.get(path);
    if (exact) return exact;
    const pkg = byPackage.get(path);
    if (pkg) return pkg;
    const cut = path.lastIndexOf('/');
    return (cut > 0 && byFqn.get(path.slice(0, cut))) || [];
  };

  let created = 0;
  let external = 0;

  store.db.transaction(() => {
    for (const [fileId, imports] of state.pendingImports) {
      if (fileMap.get(fileId)?.language !== 'kotlin') continue;
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
    logger.info({ edges: created, external }, 'Kotlin import edges resolved');
  }
}
