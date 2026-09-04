/**
 * Pass 2e6: Resolve C/C++ `#include` specifiers to file→file graph edges (TRA-832).
 *
 * `#include "foo/bar.h"` and `#include <foo/bar.h>` both name a path, not a
 * package: the C/C++ plugins already extract every include into
 * `metadata.module` (`extractImportEdges` in `plugins/language/{c,cpp}/helpers.ts`),
 * but no pipeline pass consumed it — the same gap TRA-449 closed for Go,
 * TRA-483 for Java and TRA-565 for Rust. Indexing redis produced zero import
 * edges across 191 C files.
 *
 * C and C++ share one resolver because they share one target set: a `.cpp`
 * file routinely includes a `.h` the C plugin owns, and vice versa in mixed
 * codebases — splitting them would silently miss every cross-language edge.
 *
 * Resolution tries the quoted-include rule a C compiler actually uses first
 * — relative to the including file's own directory — then falls back to
 * matching the specifier as a path suffix against every indexed C/C++ file,
 * which is what makes `<mylib/foo.h>` resolve when the repo's own include
 * root isn't known. A suffix with more than one candidate is ambiguous (a
 * bare `"util.h"` matching a dozen subsystems) and is left unresolved rather
 * than guessing; a system or third-party header simply fails to match either
 * way, so no edge is invented for it.
 */
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

const C_FAMILY_LANGUAGES = new Set(['c', 'cpp']);

/** Every trailing `/`-aligned suffix of a path, longest first. */
function suffixes(p: string): string[] {
  const out = [p];
  for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) {
    out.push(p.slice(i + 1));
  }
  return out;
}

function addTo(map: Map<string, number[]>, key: string, id: number): void {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

/** Collapse `.` and `..` segments in a posix-style relative path. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export function resolveCImportEdges(state: PipelineState, _scope?: ChangeScope): void {
  // WHY: driven by `state.pendingImports`, already scoped to re-extracted files.
  void _scope;
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);
  const hasCFamily = pendingFileIds.some((id) =>
    C_FAMILY_LANGUAGES.has(fileMap.get(id)?.language ?? ''),
  );
  if (!hasCFamily) return;

  // Exact normalized path → file id, for the compiler's own quoted-include
  // resolution rule. Suffix → candidate file ids, for everything else.
  const byPath = new Map<string, number>();
  const bySuffix = new Map<string, number[]>();
  const allIds: number[] = [];
  for (const f of store.getAllFiles()) {
    if (!C_FAMILY_LANGUAGES.has(f.language ?? '')) continue;
    const p = f.path.split('\\').join('/');
    allIds.push(f.id);
    byPath.set(p, f.id);
    for (const s of suffixes(p)) addTo(bySuffix, s, f.id);
  }
  if (allIds.length === 0) return;

  const importsEdgeType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const nodeIds = new Map<number, number>();
  const lookupIds = allIds.concat(pendingFileIds);
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

  const resolve = (specifier: string, fromDir: string): number | undefined => {
    const relative = normalizePath(fromDir ? `${fromDir}/${specifier}` : specifier);
    const exact = byPath.get(relative);
    if (exact != null) return exact;

    const candidates = bySuffix.get(specifier);
    return candidates?.length === 1 ? candidates[0] : undefined;
  };

  let created = 0;
  let external = 0;
  let ambiguous = 0;

  store.db.transaction(() => {
    for (const [fileId, imports] of state.pendingImports) {
      const file = fileMap.get(fileId);
      if (!file || !C_FAMILY_LANGUAGES.has(file.language ?? '')) continue;
      const sourceNodeId = nodeIds.get(fileId);
      if (sourceNodeId == null) continue;

      const fromPath = file.path.split('\\').join('/');
      const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';

      const seen = new Set<string>();
      for (const { from } of imports) {
        if (!from || seen.has(from)) continue;
        seen.add(from);

        const targetId = resolve(from, fromDir);
        if (targetId == null) {
          const candidates = bySuffix.get(from);
          if (candidates && candidates.length > 1) ambiguous++;
          else external++;
          continue;
        }
        const targetNodeId = nodeIds.get(targetId);
        if (targetNodeId == null || targetNodeId === sourceNodeId) continue;
        insertStmt.run(sourceNodeId, targetNodeId, importsEdgeType.id, JSON.stringify({ from }));
        created++;
      }
    }
  })();

  if (created > 0 || external > 0 || ambiguous > 0) {
    logger.info({ edges: created, external, ambiguous }, 'C/C++ import edges resolved');
  }
}
