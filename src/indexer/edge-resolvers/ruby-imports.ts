/**
 * Pass 2e7: Resolve Ruby `require` / `require_relative` specifiers to
 * file→file graph edges.
 *
 * The Ruby plugin has always extracted both into `metadata.from`
 * (`extractImportEdges` in `plugins/language/ruby/helpers.ts`), but no
 * pipeline pass consumed it — the same gap TRA-449 closed for Go, TRA-483 for
 * Java, TRA-565 for Rust and TRA-832 for C/C++.
 *
 * `require_relative 'foo/bar'` names a path relative to the requiring file's
 * own directory, exactly like a C `#include "..."`. `require 'foo/bar'` names
 * a $LOAD_PATH entry instead — in a repo that ships its own `lib`/`app` tree
 * this is usually still one of its own files, and in every other case (a gem
 * this repo doesn't vendor the source for) it correctly resolves to nothing.
 * Both forms omit the `.rb` extension, so it's appended before either lookup
 * runs. A specifier matching more than one file by suffix is left unresolved
 * rather than guessed.
 */
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

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

/**
 * Collapse `.` and `..` segments in a posix-style relative path — same rule
 * as the C/C++ resolver, and for the same reason: a `..` that pops past an
 * empty prefix is kept rather than dropped, so an escaping path never
 * collapses onto an unrelated same-named file at the repo root.
 */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

/** `require`/`require_relative` specifiers never carry an extension. */
function withRbExtension(specifier: string): string {
  return specifier.endsWith('.rb') ? specifier : `${specifier}.rb`;
}

export function resolveRubyImportEdges(state: PipelineState, _scope?: ChangeScope): void {
  // WHY: driven by `state.pendingImports`, already scoped to re-extracted files.
  void _scope;
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);
  const hasRuby = pendingFileIds.some((id) => fileMap.get(id)?.language === 'ruby');
  if (!hasRuby) return;

  // Exact normalized path → file id, for `require_relative`'s own-directory
  // rule. Suffix → candidate file ids, for the $LOAD_PATH case.
  const byPath = new Map<string, number>();
  const bySuffix = new Map<string, number[]>();
  const allIds: number[] = [];
  for (const f of store.getAllFiles()) {
    if (f.language !== 'ruby') continue;
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
      if (!file || file.language !== 'ruby') continue;
      const sourceNodeId = nodeIds.get(fileId);
      if (sourceNodeId == null) continue;

      const fromPath = file.path.split('\\').join('/');
      const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';

      const seen = new Set<string>();
      for (const { from } of imports) {
        if (!from || seen.has(from)) continue;
        seen.add(from);

        const specifier = withRbExtension(from);
        const targetId = resolve(specifier, fromDir);
        if (targetId == null) {
          const candidates = bySuffix.get(specifier);
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
    logger.info({ edges: created, external, ambiguous }, 'Ruby import edges resolved');
  }
}
