/**
 * Resolve Kotlin import specifiers to file→file graph edges (TRA-451).
 *
 * Kotlin doesn't force the package to mirror the directory layout the way
 * Java does, but the near-universal convention (and every Gradle/Maven
 * scaffold) still lays `src/main/kotlin/com/example/store/Repo.kt` out under
 * `com/example/store/`, so the same suffix-matching trick Java uses applies
 * unchanged:
 *
 *     import com.example.store.Repo      // → .../com/example/store/Repo.kt
 *     import com.example.store.*         // → every .kt file in that directory
 *
 * The Kotlin plugin already extracted these (`metadata.from`), but nothing
 * consumed them — same gap TRA-449 closed for Go, since closed for Java,
 * Rust, C/C++, Ruby, C#. Resolution is pure suffix matching against the
 * indexed files: no build file is read, and a stdlib or third-party import
 * simply fails to match rather than inventing a node.
 *
 * One real gap this doesn't cover: Kotlin also allows importing a top-level
 * function or property directly (`import com.example.util.parseFoo`), and
 * unlike a class, that name has no obligation to match the file it's
 * declared in. Suffix matching on the name resolves the file-per-class case
 * (the large majority in practice) and correctly fails closed — rather than
 * guessing — on the function/property case.
 */
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

/** Every trailing `/`-aligned suffix of a path, longest first. */
function suffixes(path: string): string[] {
  const out = [path];
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
    out.push(path.slice(i + 1));
  }
  return out;
}

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

  // Suffix → file ids. `byType` keys end in `.kt` (an import naming a class),
  // `byPackage` keys are the directories (a wildcard import naming a package).
  const byType = new Map<string, number[]>();
  const byPackage = new Map<string, number[]>();
  const allKotlinIds: number[] = [];
  for (const f of store.getAllFiles()) {
    const p = f.path.split('\\').join('/');
    if (!p.endsWith('.kt')) continue;
    allKotlinIds.push(f.id);
    for (const s of suffixes(p)) addTo(byType, s, f.id);
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (dir) for (const s of suffixes(dir)) addTo(byPackage, s, f.id);
  }
  if (allKotlinIds.length === 0) return;

  const importsEdgeType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const nodeIds = new Map<number, number>();
  const lookupIds = allKotlinIds.concat(pendingFileIds);
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
   * `com.example.store.Repo` → the files it can mean. Tried in order: the
   * type itself, the package it would be as a wildcard, then the type one
   * segment up — which covers a nested class the same way Java's does.
   */
  const resolve = (specifier: string): number[] => {
    const bare = specifier.endsWith('.*') ? specifier.slice(0, -2) : specifier;
    const path = bare.split('.').join('/');
    const type = byType.get(`${path}.kt`);
    if (type) return type;
    const pkg = byPackage.get(path);
    if (pkg) return pkg;
    const cut = path.lastIndexOf('/');
    return (cut > 0 && byType.get(`${path.slice(0, cut)}.kt`)) || [];
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
