/**
 * Pass 2e5: Resolve Rust `use` / `mod` specifiers to file→file graph edges
 * (TRA-565).
 *
 * Rust names a module path, and cargo forces the module tree to mirror the
 * directory layout below the crate root, so the specifier *is* the path:
 *
 *     mod store;                    // → <crate>/store.rs or <crate>/store/mod.rs
 *     use crate::store::Repo;       // → the same file, one segment deeper
 *     use self::row::Row;           // → relative to this file's own module
 *     use super::ids::next;         // → one module up
 *     use other_crate::Thing;       // → that workspace member's crate root
 *
 * The Rust plugin already extracted these (`metadata.module`), but nothing
 * consumed them — the same gap TRA-449 closed for Go and TRA-483 for Java.
 *
 * A crate root is any `src/` directory holding `lib.rs` / `main.rs`. Its name
 * comes from the sibling Cargo.toml when there is one — workspaces routinely
 * name a crate differently from its directory (`crates/regex` is `grep-regex`),
 * and without the manifest every sibling import in one is missed — and from the
 * directory otherwise. A `[lib] path` pointing somewhere else, or a crates.io
 * dependency, resolves to nothing rather than to an invented node.
 */
import fs from 'node:fs';
import nodePath from 'node:path';
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

/** Crate names are `-` in Cargo.toml and `_` in source. */
const normalize = (name: string): string => name.split('-').join('_');

/** Nothing in the repo can resolve these, and every crate imports them. */
const PRELUDE = new Set(['std', 'core', 'alloc', 'proc_macro', 'test']);

interface RustFile {
  /** Directory holding the crate root, e.g. `tokio/src` (`''` when flat). */
  crateDir: string;
  /** Module path below the crate root, `/`-joined. `''` for the crate root. */
  modPath: string;
}

/** `tokio/src/sync/mutex.rs` → crate `tokio/src`, module `sync/mutex`. */
function classify(path: string): RustFile {
  const segments = path.slice(0, -'.rs'.length).split('/');
  const srcIdx = segments.lastIndexOf('src');
  const crateDir = srcIdx >= 0 ? segments.slice(0, srcIdx + 1).join('/') : '';
  const mod = srcIdx >= 0 ? segments.slice(srcIdx + 1) : segments;
  const last = mod[mod.length - 1];
  if (last === 'mod' || last === 'lib' || last === 'main') mod.pop();
  return { crateDir, modPath: mod.join('/') };
}

/**
 * `crate::a::{b, c::D}` → `crate::a::b`, `crate::a::c::D`. One `use` can name
 * many modules, and without expanding the braces the whole statement resolves
 * to the shallowest one.
 */
function expandUse(spec: string, out: string[] = []): string[] {
  const open = spec.indexOf('{');
  if (open < 0) {
    out.push(spec);
    return out;
  }
  const prefix = spec.slice(0, open);
  let depth = 0;
  let item = '';
  for (let i = open; i < spec.length; i++) {
    const c = spec[i];
    if (c === '{') {
      depth++;
      if (depth === 1) continue;
    } else if (c === '}') {
      depth--;
      if (depth === 0) break;
    } else if (c === ',' && depth === 1) {
      expandUse(prefix + item, out);
      item = '';
      continue;
    }
    item += c;
  }
  if (item) expandUse(prefix + item, out);
  return out;
}

/** Strip comments, renames, globs and whitespace: `a::b as c` → `a::b`. */
function clean(spec: string): string {
  return spec
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+as\s+[A-Za-z_][A-Za-z0-9_]*/g, '')
    .replace(/\s+/g, '')
    .replace(/::\*$/, '')
    .replace(/::self$/, '');
}

/**
 * `name = "grep-regex"` from the `[package]` table of `<dir>/Cargo.toml`. The
 * manifest is not an indexed file, so it is read from disk like go.mod is.
 */
function crateName(rootPath: string, dir: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(nodePath.join(rootPath, dir, 'Cargo.toml'), 'utf8');
  } catch {
    return undefined;
  }
  const pkg = content.indexOf('[package]');
  if (pkg < 0) return undefined;
  const rest = content.slice(pkg);
  const end = rest.indexOf('\n[', 1);
  const match = /^\s*name\s*=\s*"([^"]+)"/m.exec(end > 0 ? rest.slice(0, end) : rest);
  return match?.[1];
}

export function resolveRustImportEdges(state: PipelineState, _scope?: ChangeScope): void {
  // WHY: driven by `state.pendingImports`, already scoped to re-extracted files.
  void _scope;
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);
  const hasRust = pendingFileIds.some((id) => fileMap.get(id)?.language === 'rust');
  if (!hasRust) return;

  // `<crateDir>\0<modPath>` → the files that module can mean (`foo.rs` and
  // `foo/mod.rs` are the same module; only one may exist, so this is a list
  // for safety, not because both are expected).
  const byModule = new Map<string, number[]>();
  // Crate name → crate root directories declaring it.
  const crateDirs = new Map<string, Set<string>>();
  const sources = new Map<number, RustFile>();
  const allRustIds: number[] = [];

  for (const f of store.getAllFiles()) {
    const p = f.path.split('\\').join('/');
    if (!p.endsWith('.rs')) continue;
    allRustIds.push(f.id);
    const info = classify(p);
    sources.set(f.id, info);
    const key = `${info.crateDir}\0${info.modPath}`;
    const list = byModule.get(key);
    if (list) list.push(f.id);
    else byModule.set(key, [f.id]);

    if (info.modPath === '' && info.crateDir.endsWith('src')) {
      const owner = info.crateDir.slice(0, -'src'.length).replace(/\/$/, '');
      const name =
        crateName(state.rootPath, owner) ??
        (owner.includes('/') ? owner.slice(owner.lastIndexOf('/') + 1) : owner);
      if (name) {
        const set = crateDirs.get(normalize(name));
        if (set) set.add(info.crateDir);
        else crateDirs.set(normalize(name), new Set([info.crateDir]));
      }
    }
  }
  if (allRustIds.length === 0) return;

  const importsEdgeType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const nodeIds = new Map<number, number>();
  const lookupIds = allRustIds.concat(pendingFileIds);
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

  /** Longest module prefix that is a file wins — `a::b::C` prefers `a/b.rs`. */
  const deepest = (crateDir: string, segments: string[]): number[] => {
    for (let i = segments.length; i >= 0; i--) {
      const hit = byModule.get(`${crateDir}\0${segments.slice(0, i).join('/')}`);
      if (hit) return hit;
    }
    return [];
  };

  const resolve = (specifier: string, from: RustFile): number[] => {
    const segments = specifier.split('::').filter(Boolean);
    const head = segments[0];
    if (!head || PRELUDE.has(head)) return [];

    if (head === 'crate') return deepest(from.crateDir, segments.slice(1));
    if (head === 'self') {
      const own = from.modPath ? from.modPath.split('/') : [];
      return deepest(from.crateDir, own.concat(segments.slice(1)));
    }
    if (head === 'super') {
      const own = from.modPath ? from.modPath.split('/') : [];
      let rest = segments;
      while (rest[0] === 'super') {
        own.pop();
        rest = rest.slice(1);
      }
      return deepest(from.crateDir, own.concat(rest));
    }

    // A sibling crate in the same workspace.
    const inWorkspace = crateDirs.get(normalize(head));
    if (inWorkspace) {
      const targets: number[] = [];
      for (const dir of inWorkspace) targets.push(...deepest(dir, segments.slice(1)));
      if (targets.length > 0) return targets;
    }

    // 2015-edition `use foo::Bar;` — `foo` is a module of this crate, not a
    // dependency. Only accepted when this crate really has that module.
    if (byModule.has(`${from.crateDir}\0${head}`)) return deepest(from.crateDir, segments);
    return [];
  };

  let created = 0;
  let external = 0;

  store.db.transaction(() => {
    for (const [fileId, imports] of state.pendingImports) {
      if (fileMap.get(fileId)?.language !== 'rust') continue;
      const sourceNodeId = nodeIds.get(fileId);
      const info = sources.get(fileId);
      if (sourceNodeId == null || !info) continue;

      const seen = new Set<string>();
      for (const { from } of imports) {
        if (!from) continue;
        for (const specifier of expandUse(clean(from))) {
          if (seen.has(specifier)) continue;
          seen.add(specifier);

          const targets = resolve(specifier, info);
          if (targets.length === 0) {
            external++;
            continue;
          }
          for (const targetId of targets) {
            const targetNodeId = nodeIds.get(targetId);
            if (targetNodeId == null || targetNodeId === sourceNodeId) continue;
            insertStmt.run(
              sourceNodeId,
              targetNodeId,
              importsEdgeType.id,
              JSON.stringify({ from: specifier }),
            );
            created++;
          }
        }
      }
    }
  })();

  if (created > 0 || external > 0) {
    logger.info({ edges: created, external }, 'Rust import edges resolved');
  }
}
