/**
 * FastAPI cross-file mount-prefix resolver (pass 2).
 *
 * Within a single file, `router = APIRouter(prefix="/x")` is composed into route
 * URIs at extraction time. But the CROSS-FILE mount —
 *
 *   # routers/users.py:  router = APIRouter();  @router.get("/items")
 *   # main.py:           app.include_router(users_router, prefix="/api/v1")
 *
 * — was lost: the mounted router's routes stayed bare (`/items`). FastAPI serves
 * them under the mount prefix (`/api/v1/items`), so get_request_flow and the
 * cross-service topology missed them.
 *
 * Here we scan `*.include_router(<expr>, prefix="...")` calls, resolve <expr> to
 * the file that defines the router, and rewrite that file's route URIs to
 * prepend the mount prefix. Always recomputed from each route's stored `baseUri`
 * (the within-file-composed path), so re-indexing is idempotent. Conservative:
 * when the defining file or router var can't be resolved unambiguously, the
 * mount is skipped — no guessing.
 *
 * Resolution: import specifiers store the *original* exported name (a project
 * convention — see the TS/Python import extractors), so two router modules both
 * named `router` are indistinguishable by name alone. We therefore parse the
 * mount file's own `from MOD import NAME as ALIAS` bindings to map the mount-site
 * local name → (module, original name), then map the module → defining file via
 * the already-resolved file→file `imports` edges (whose metadata carries the raw
 * `from` module text). This reuses the indexer's module resolution rather than
 * reimplementing relative-import logic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

// `app.include_router(users_router, prefix="/api/v1", tags=[...])` — captures the
// first-paren argument string (nested-paren kwargs truncate the capture, which
// only ever drops a trailing prefix → conservative).
const INCLUDE_ROUTER_RE = /\b\w+\.include_router\(([\s\S]*?)\)/g;
const PREFIX_RE = /\bprefix\s*=\s*['"]([^'"]+)['"]/;
const FIRST_ARG_RE = /^\s*([\w.]+)/;
// `from <module> import <names>` — names may be parenthesized across lines.
const FROM_IMPORT_RE = /\bfrom\s+([.\w]+)\s+import\s+(\([\s\S]*?\)|[^\n]+)/g;
const IMPORT_RE = /^[ \t]*import\s+([.\w]+)(?:\s+as\s+(\w+))?/gm;

interface RouteMeta {
  id: number;
  router: string;
  baseUri: string;
}
interface Mount {
  fileId: number;
  routerExpr: string;
  prefix: string;
}
/** Local binding name → the module it came from + the original imported name
 * (null for a whole-module `import x` binding). */
type ImportBindings = Map<string, { module: string; original: string | null }>;

export function resolveFastapiRouterMounts(state: PipelineState, _scope?: ChangeScope): void {
  const { store } = state;

  const pyFiles = store.db
    .prepare(`SELECT id, path FROM files WHERE language = 'python'`)
    .all() as Array<{ id: number; path: string }>;
  if (pyFiles.length === 0) return;

  // 1. Collect `*.include_router(router, prefix=...)` mounts + the mount files'
  //    import bindings (only files that actually mount something).
  const mounts: Mount[] = [];
  const bindingsByFile = new Map<number, ImportBindings>();
  for (const f of pyFiles) {
    let src: string;
    try {
      src = fs.readFileSync(path.join(state.rootPath, f.path), 'utf-8');
    } catch {
      continue;
    }
    if (!src.includes('include_router')) continue;

    let found = false;
    INCLUDE_ROUTER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((m = INCLUDE_ROUTER_RE.exec(src)) !== null) {
      const argStr = m[1];
      const pfx = PREFIX_RE.exec(argStr);
      if (!pfx?.[1]) continue; // no prefix → nothing to compose
      const fa = FIRST_ARG_RE.exec(argStr);
      if (!fa) continue;
      mounts.push({ fileId: f.id, routerExpr: fa[1], prefix: pfx[1] });
      found = true;
    }
    if (found) bindingsByFile.set(f.id, parseImportBindings(src));
  }
  if (mounts.length === 0) return;

  // 2. from-module → target file id, per file, from the resolved import graph.
  const importTargets = buildImportTargets(state);

  // 3. Routes grouped by file, with their {router var, baseUri} metadata.
  const routesByFile = new Map<number, RouteMeta[]>();
  for (const r of store.getAllRoutes()) {
    if (r.file_id == null || !r.metadata) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(r.metadata) as Record<string, unknown>;
    } catch {
      continue;
    }
    const router = typeof meta.router === 'string' ? meta.router : '';
    const baseUri = typeof meta.baseUri === 'string' ? meta.baseUri : r.uri;
    if (!router || router === 'app') continue; // @app.get routes are never mounted
    const list = routesByFile.get(r.file_id) ?? [];
    list.push({ id: r.id, router, baseUri });
    routesByFile.set(r.file_id, list);
  }
  if (routesByFile.size === 0) return;

  // 4. Resolve + rewrite.
  let rewritten = 0;
  store.db.transaction(() => {
    for (const mount of mounts) {
      const target = resolveTarget(
        mount,
        bindingsByFile.get(mount.fileId),
        importTargets.get(mount.fileId),
        routesByFile,
      );
      if (!target) continue;
      for (const route of routesByFile.get(target.fileId) ?? []) {
        if (route.router !== target.routerVar) continue;
        store.updateRouteUri(route.id, joinRoutePath(mount.prefix, route.baseUri));
        rewritten++;
      }
    }
  })();

  if (rewritten > 0) {
    logger.info(
      { routes: rewritten, mounts: mounts.length },
      'FastAPI cross-file router-mount prefixes composed',
    );
  }
}

function resolveTarget(
  mount: Mount,
  bindings: ImportBindings | undefined,
  fromToFile: Map<string, number> | undefined,
  routesByFile: Map<number, RouteMeta[]>,
): { fileId: number; routerVar: string } | null {
  if (!bindings || !fromToFile) return null;

  const parts = mount.routerExpr.split('.');
  const localName = parts[0]; // module alias (attr form) or the router var (plain form)
  const binding = bindings.get(localName);
  if (!binding) return null;

  const fileId = fromToFile.get(binding.module);
  if (fileId == null) return null;

  const routes = routesByFile.get(fileId);
  if (!routes || routes.length === 0) return null;
  const distinct = [...new Set(routes.map((r) => r.router))];

  // Attribute form `mod.router` → the trailing attr.
  if (parts.length > 1) {
    if (distinct.includes(parts[1])) return { fileId, routerVar: parts[1] };
    return distinct.length === 1 ? { fileId, routerVar: distinct[0] } : null;
  }

  // Plain form → the original imported name is the router var in the defining
  // file; fall back to the file's single router var (covers any naming skew).
  if (binding.original && distinct.includes(binding.original)) {
    return { fileId, routerVar: binding.original };
  }
  return distinct.length === 1 ? { fileId, routerVar: distinct[0] } : null;
}

/** Parse a Python file's `from X import …` / `import X [as Y]` bindings. */
function parseImportBindings(src: string): ImportBindings {
  const bindings: ImportBindings = new Map();

  FROM_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = FROM_IMPORT_RE.exec(src)) !== null) {
    const module = m[1];
    let names = m[2].trim();
    if (names.startsWith('(')) names = names.slice(1, -1);
    for (const raw of names.split(',')) {
      const piece = raw.trim();
      if (!piece || piece === '*') continue;
      const asMatch = piece.match(/^([\w]+)\s+as\s+(\w+)$/);
      if (asMatch) {
        bindings.set(asMatch[2], { module, original: asMatch[1] });
      } else {
        const nm = piece.split(/\s+/)[0];
        if (/^\w+$/.test(nm)) bindings.set(nm, { module, original: nm });
      }
    }
  }

  IMPORT_RE.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const module = m[1];
    const alias = m[2];
    const local = alias ?? module.split('.')[0];
    if (!bindings.has(local)) bindings.set(local, { module, original: null });
  }

  return bindings;
}

/**
 * srcFileId → (raw `from` module text → target file id), built from the
 * already-resolved file→file `imports` edges. The edge metadata's `from` field
 * is the verbatim module string (e.g. `routers.users` or `.routers.users`),
 * which matches what parseImportBindings records.
 */
function buildImportTargets(state: PipelineState): Map<number, Map<string, number>> {
  const { store } = state;
  const out = new Map<number, Map<string, number>>();

  const et = store.db.prepare(`SELECT id FROM edge_types WHERE name = 'imports'`).get() as
    | { id: number }
    | undefined;
  if (!et) return out;

  const rows = store.db
    .prepare(`
    SELECT ns.ref_id AS src, nt.ref_id AS tgt, e.metadata
      FROM edges e
      JOIN nodes ns ON ns.id = e.source_node_id AND ns.node_type = 'file'
      JOIN nodes nt ON nt.id = e.target_node_id AND nt.node_type = 'file'
     WHERE e.edge_type_id = ?
  `)
    .all(et.id) as Array<{ src: number; tgt: number; metadata: string | null }>;

  for (const r of rows) {
    if (!r.metadata) continue;
    let from: string | undefined;
    try {
      from = (JSON.parse(r.metadata) as { from?: string }).from;
    } catch {
      continue;
    }
    if (!from) continue;
    let map = out.get(r.src);
    if (!map) {
      map = new Map();
      out.set(r.src, map);
    }
    map.set(from, r.tgt);
  }

  return out;
}

/** Join a mount prefix and a route path the FastAPI way, then normalize. */
function joinRoutePath(prefix: string, p: string): string {
  let joined = `${prefix}${p}`.replace(/\/{2,}/g, '/');
  if (joined.length > 1 && joined.endsWith('/')) joined = joined.slice(0, -1);
  return joined || '/';
}
