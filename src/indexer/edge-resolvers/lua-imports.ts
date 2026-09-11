/**
 * Pass 2e11: Resolve Lua `require` specifiers to file→file graph edges (TRA-1332).
 *
 * In Lua, modules are imported via `require("mod")`, `require 'mod'`, or `pcall(require, "mod")`.
 * Dots in module specifiers represent path separators:
 * `require("luacheck.stages.parse_inline_options")` -> `luacheck/stages/parse_inline_options.lua`
 * or `luacheck/stages/parse_inline_options/init.lua`
 *
 * The Lua language plugin extracts these into `edgeType: 'imports'` (`metadata.module`),
 * but previously no pipeline pass consumed them.
 *
 * Resolution strategy:
 * 1. Normalizes module specifier:
 *    - Strips optional trailing `.lua` or `.luau`
 *    - Handles relative requires (`./foo`, `../bar`, `.foo`, `..bar`)
 *    - Converts module dot separators to `/` (e.g. `foo.bar` -> `foo/bar`)
 * 2. Candidate filenames:
 *    For `foo/bar`, candidate filenames are:
 *    - `foo/bar.lua`
 *    - `foo/bar/init.lua`
 *    - `foo/bar.luau`
 *    - `foo/bar/init.luau`
 * 3. Search hierarchy:
 *    a. If relative (`./` or `../`), resolve strictly relative to requiring file's directory
 *    b. Exact match relative to workspace/repo root
 *    c. Common Lua root directories: `lua/`, `src/`, `lib/` (e.g. Neovim plugins, Lua CLI tools)
 *    d. Relative to requiring file's directory (`fromDir`)
 *    e. Suffix matching against indexed Lua files
 * 4. Ambiguity and test filtering:
 *    If multiple candidates match via suffix search, and the requiring file is not a test file,
 *    ignore candidate files in `spec/` or `test/` before declaring ambiguity.
 * 5. External tracking:
 *    Standard library modules (`string`, `table`, `math`, `io`, `os`, `debug`, `coroutine`,
 *    `package`, `utf8`, `bit`, `bit32`, `jit`) and external rocks (e.g. `socket`, `lanes`,
 *    `lfs`, `argparse`, `cjson`) that do not exist locally are tracked as `external`.
 */
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

function addTo(map: Map<string, number[]>, key: string, id: number): void {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

/** Every trailing `/`-aligned suffix of a path, longest first. */
function suffixes(p: string): string[] {
  const out = [p];
  for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) {
    out.push(p.slice(i + 1));
  }
  return out;
}

/**
 * Collapse `.` and `..` segments in a posix-style relative path.
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

/** Convert a Lua module require specifier to relative path segments. */
export function moduleToPathSegments(specifier: string): string {
  let cleaned = specifier.trim().replace(/\\/g, '/');
  if (cleaned.endsWith('.lua')) {
    cleaned = cleaned.slice(0, -4);
  } else if (cleaned.endsWith('.luau')) {
    cleaned = cleaned.slice(0, -5);
  }

  // Handle relative dots: e.g. "./foo", "../bar", ".sub", "..sibling"
  if (cleaned.startsWith('./') || cleaned.startsWith('../')) {
    const prefix = cleaned.startsWith('./') ? './' : '../';
    const rest = cleaned.slice(prefix.length).replace(/\./g, '/');
    return prefix + rest;
  }
  if (cleaned.startsWith('.')) {
    const m = cleaned.match(/^(\.+)(.*)$/);
    if (m) {
      const dotCount = m[1].length;
      const rest = m[2].replace(/\./g, '/');
      const prefix = dotCount === 1 ? './' : '../'.repeat(dotCount - 1);
      return prefix + rest;
    }
  }

  return cleaned.replace(/\./g, '/');
}

/** Candidate filenames for a Lua module path segment. */
export function luaCandidatePaths(rel: string): string[] {
  return [`${rel}.lua`, `${rel}/init.lua`, `${rel}.luau`, `${rel}/init.luau`];
}

function isTestPath(p: string): boolean {
  return (
    p.includes('/spec/') ||
    p.startsWith('spec/') ||
    p.includes('/test/') ||
    p.startsWith('test/') ||
    p.includes('/tests/') ||
    p.startsWith('tests/') ||
    p.endsWith('_spec.lua') ||
    p.endsWith('_test.lua')
  );
}

const COMMON_ROOTS = ['lua', 'src', 'lib'];

export function resolveLuaImportEdges(state: PipelineState, _scope?: ChangeScope): void {
  // WHY: driven by `state.pendingImports`, already scoped to re-extracted files.
  void _scope;
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);
  const hasLua = pendingFileIds.some((id) => fileMap.get(id)?.language === 'lua');
  if (!hasLua) return;

  const byPath = new Map<string, number>();
  const bySuffix = new Map<string, number[]>();
  const allLuaIds: number[] = [];
  const filePathMap = new Map<number, string>();

  for (const f of store.getAllFiles()) {
    if (f.language !== 'lua') continue;
    const p = f.path.split('\\').join('/');
    allLuaIds.push(f.id);
    filePathMap.set(f.id, p);
    byPath.set(p, f.id);
    for (const s of suffixes(p)) addTo(bySuffix, s, f.id);
  }
  if (allLuaIds.length === 0) return;

  const importsEdgeType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const nodeIds = new Map<number, number>();
  const lookupIds = allLuaIds.concat(pendingFileIds);
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

  const resolve = (
    specifier: string,
    fromPath: string,
    fromDir: string,
  ): number | 'ambiguous' | undefined => {
    const isRelative =
      specifier.startsWith('.') || specifier.startsWith('./') || specifier.startsWith('../');
    const rel = moduleToPathSegments(specifier);
    const candidates = luaCandidatePaths(rel);

    // 1. Explicit relative imports (./foo or ../bar): resolve relative to fromDir
    if (isRelative) {
      for (const cand of candidates) {
        const exact = normalizePath(fromDir ? `${fromDir}/${cand}` : cand);
        const hit = byPath.get(exact);
        if (hit != null) return hit;
      }
      return undefined;
    }

    // 2. Exact match from project root
    for (const cand of candidates) {
      const hit = byPath.get(cand);
      if (hit != null) return hit;
    }

    // 3. Common Lua source roots (lua/, src/, lib/)
    for (const root of COMMON_ROOTS) {
      for (const cand of candidates) {
        const hit = byPath.get(`${root}/${cand}`);
        if (hit != null) return hit;
      }
    }

    // 4. Relative to fromDir (convenience for same-directory require("sub"))
    if (fromDir) {
      for (const cand of candidates) {
        const relFromDir = normalizePath(`${fromDir}/${cand}`);
        const hit = byPath.get(relFromDir);
        if (hit != null) return hit;
      }
    }

    // 5. Suffix search across all indexed Lua files
    const matchingIds = new Set<number>();
    for (const cand of candidates) {
      const ids = bySuffix.get(cand);
      if (ids) {
        for (const id of ids) matchingIds.add(id);
      }
    }

    if (matchingIds.size === 1) {
      return Array.from(matchingIds)[0];
    }

    if (matchingIds.size > 1) {
      if (!isTestPath(fromPath)) {
        const nonTest = Array.from(matchingIds).filter(
          (id) => !isTestPath(filePathMap.get(id) ?? ''),
        );
        if (nonTest.length === 1) return nonTest[0];
        if (nonTest.length > 1) return 'ambiguous';
      } else {
        return 'ambiguous';
      }
    }

    return undefined;
  };

  let created = 0;
  let external = 0;
  let ambiguous = 0;

  store.db.transaction(() => {
    for (const [fileId, imports] of state.pendingImports) {
      const file = fileMap.get(fileId);
      if (!file || file.language !== 'lua') continue;
      const sourceNodeId = nodeIds.get(fileId);
      if (sourceNodeId == null) continue;

      const fromPath = file.path.split('\\').join('/');
      const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';

      const seen = new Set<string>();
      for (const { from } of imports) {
        if (!from || seen.has(from)) continue;
        seen.add(from);

        const target = resolve(from, fromPath, fromDir);
        if (target === 'ambiguous') {
          ambiguous++;
          continue;
        }
        if (target == null) {
          external++;
          continue;
        }

        const targetNodeId = nodeIds.get(target);
        if (targetNodeId == null || targetNodeId === sourceNodeId) continue;
        insertStmt.run(sourceNodeId, targetNodeId, importsEdgeType.id, JSON.stringify({ from }));
        created++;
      }
    }
  })();

  if (created > 0 || external > 0 || ambiguous > 0) {
    logger.info({ edges: created, external, ambiguous }, 'Lua import edges resolved');
  }
}
