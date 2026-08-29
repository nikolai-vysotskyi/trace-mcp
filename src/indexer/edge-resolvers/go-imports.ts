/**
 * Pass 2e3: Resolve Go import specifiers to file→file graph edges (TRA-449).
 *
 * Go imports name a *package*, and a package is a directory:
 *
 *     module example.com/app          // go.mod
 *     import "example.com/app/store"  // → every .go file under store/
 *
 * The Go plugin already extracts the specifier, but nothing consumed it — the
 * ESM resolver skips non-JS languages and there was no Go pass, so a Go repo
 * indexed with zero import edges while the capability matrix claimed otherwise.
 *
 * Only first-party imports (those under a module path declared by a go.mod in
 * the repo) resolve. Stdlib (`fmt`) and third-party (`github.com/spf13/pflag`)
 * imports have no node to point at and are skipped — the phantom-package
 * bucketing the npm side does is deliberately left out until something needs it.
 */
import fs from 'node:fs';
import nodePath from 'node:path';
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

/** A `module` line from a go.mod, keyed to the directory that declares it. */
interface ModuleRoot {
  /** Module path declared in go.mod, e.g. `example.com/app`. */
  modulePath: string;
  /** Repo-relative directory holding that go.mod (`''` for the root). */
  dir: string;
}

/**
 * Find every go.mod governing an indexed .go file. go.mod itself is not an
 * indexed file (no plugin claims it), so this walks up from each package
 * directory on disk rather than querying the files table.
 */
function findGoModules(state: PipelineState, packageDirs: Iterable<string>): ModuleRoot[] {
  const byDir = new Map<string, ModuleRoot | null>();

  const load = (dir: string): ModuleRoot | null => {
    const cached = byDir.get(dir);
    if (cached !== undefined) return cached;
    let found: ModuleRoot | null = null;
    try {
      const content = fs.readFileSync(nodePath.join(state.rootPath, dir, 'go.mod'), 'utf8');
      const match = /^\s*module\s+(\S+)/m.exec(content);
      if (match) found = { modulePath: match[1], dir };
    } catch {
      found = null;
    }
    byDir.set(dir, found);
    return found;
  };

  const roots = new Map<string, ModuleRoot>();
  for (const packageDir of packageDirs) {
    let dir = packageDir;
    for (;;) {
      const root = load(dir);
      if (root) roots.set(`${root.dir}\0${root.modulePath}`, root);
      if (dir === '') break;
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    }
  }

  // Longest module path first so a nested module wins over the repo-root one.
  return Array.from(roots.values()).sort((a, b) => b.modulePath.length - a.modulePath.length);
}

/** `example.com/app/store` + root `example.com/app` → `store`. */
function specifierToDir(specifier: string, roots: ModuleRoot[]): string | null {
  for (const root of roots) {
    if (specifier === root.modulePath) return root.dir;
    if (specifier.startsWith(`${root.modulePath}/`)) {
      const rest = specifier.slice(root.modulePath.length + 1);
      return root.dir ? `${root.dir}/${rest}` : rest;
    }
  }
  return null;
}

export function resolveGoImportEdges(state: PipelineState, _scope?: ChangeScope): void {
  // WHY: driven by `state.pendingImports`, already scoped to re-extracted files.
  void _scope;
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);
  const hasGo = pendingFileIds.some((id) => fileMap.get(id)?.language === 'go');
  if (!hasGo) return;

  // Package directory → the importable .go files it contains. `_test.go` files
  // only exist in the test binary, so importing a package must not link to
  // them — they stay valid import *sources*, just never targets.
  const filesByDir = new Map<string, Array<{ id: number; path: string }>>();
  for (const f of store.getAllFiles()) {
    const p = f.path.split('\\').join('/');
    if (!p.endsWith('.go') || p.endsWith('_test.go')) continue;
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    let list = filesByDir.get(dir);
    if (!list) {
      list = [];
      filesByDir.set(dir, list);
    }
    list.push({ id: f.id, path: p });
  }
  if (filesByDir.size === 0) return;

  const roots = findGoModules(state, filesByDir.keys());
  if (roots.length === 0) return;

  const importsEdgeType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const nodeIds = new Map<number, number>();
  const allGoIds = Array.from(filesByDir.values())
    .flat()
    .map((f) => f.id)
    .concat(pendingFileIds);
  const CHUNK = 500;
  for (let i = 0; i < allGoIds.length; i += CHUNK) {
    for (const [k, v] of store.getNodeIdsBatch('file', allGoIds.slice(i, i + CHUNK))) {
      nodeIds.set(k, v);
    }
  }

  const insertStmt = store.db.prepare(
    `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, ?, 0)
     ON CONFLICT(source_node_id, target_node_id, edge_type_id)
     DO UPDATE SET metadata = excluded.metadata`,
  );

  let created = 0;
  let external = 0;

  store.db.transaction(() => {
    for (const [fileId, imports] of state.pendingImports) {
      const file = fileMap.get(fileId);
      if (!file || file.language !== 'go') continue;
      const sourceNodeId = nodeIds.get(fileId);
      if (sourceNodeId == null) continue;

      const seen = new Set<string>();
      for (const { from } of imports) {
        if (!from || seen.has(from)) continue;
        seen.add(from);

        const dir = specifierToDir(from, roots);
        if (dir == null) {
          external++;
          continue;
        }
        for (const target of filesByDir.get(dir) ?? []) {
          const targetNodeId = nodeIds.get(target.id);
          if (targetNodeId == null || targetNodeId === sourceNodeId) continue;
          insertStmt.run(
            sourceNodeId,
            targetNodeId,
            importsEdgeType.id,
            JSON.stringify({ from, package: dir }),
          );
          created++;
        }
      }
    }
  })();

  if (created > 0 || external > 0) {
    logger.info({ edges: created, external }, 'Go import edges resolved');
  }
}
