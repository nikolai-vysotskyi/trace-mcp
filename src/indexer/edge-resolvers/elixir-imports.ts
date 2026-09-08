/**
 * Pass 2e10: Resolve Elixir `alias`, `import`, `use`, `require` specifiers to
 * file→file graph edges (TRA-1227).
 *
 *     alias MyApp.Accounts             // → file declaring module MyApp.Accounts
 *     alias MyApp.Repo.{User, Post}    // → files declaring MyApp.Repo.User, MyApp.Repo.Post
 *     import MyApp.Helpers             // → file declaring module MyApp.Helpers
 *     use MyApp.Web, :controller       // → file declaring module MyApp.Web
 *     require Logger                   // → external standard library module
 *
 * The Elixir plugin extracts these into `edgeType: 'imports'` (`metadata.module`),
 * but previously no pipeline pass consumed them.
 *
 * Resolution strategy:
 * 1. Declared AST module/protocol symbols (`s.kind = 'class'` or `'interface'`)
 *    persisted on files with `language = 'elixir'`. `s.name` / `s.fqn` holds the
 *    PascalCase module name (e.g. `Plug.Conn` or `MyApp.Accounts`).
 * 2. Conventional path fallback: converts `PascalCase` module segments to
 *    `snake_case` path components (e.g. `Plug.Conn` → `plug/conn.ex` or
 *    `MyApp.Repo.User` → `my_app/repo/user.ex`) and matches file path suffixes.
 * 3. Sub-module fallback: one segment up (e.g. `Plug.Conn.Status` if declared
 *    within `Plug.Conn`'s file).
 * 4. Test file isolation: imports from production code never resolve to `_test.exs`
 *    or `test/` files if a non-test candidate exists.
 * 5. External and ambiguous classification: standard library modules (`Logger`,
 *    `GenServer`, `Enum`, `Application`, etc.) or third-party packages with no
 *    matching local symbol/file are tracked as `external`.
 */
import { logger } from '../../logger.js';
import type { ChangeScope } from '../../plugin-api/types.js';
import type { PipelineState } from '../pipeline-state.js';

function addTo(map: Map<string, number[]>, key: string, id: number): void {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

/** Convert PascalCase Elixir module name to snake_case relative path segments. */
export function moduleToPath(mod: string): string {
  return mod
    .split('.')
    .map((part) =>
      part
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase(),
    )
    .join('/');
}

/** Every trailing `/`-aligned suffix of a path, longest first. */
function suffixes(p: string): string[] {
  const out = [p];
  for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) {
    out.push(p.slice(i + 1));
  }
  return out;
}

/** Expand multi-alias syntax e.g. Prefix.{A, B} if present in raw specifier. */
export function expandMultiAlias(specifier: string): string[] {
  const match = specifier.match(/^(.+?)\.\{([^}]+)\}$/);
  if (match) {
    const prefix = match[1].trim();
    return match[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `${prefix}.${s}`);
  }
  return [specifier];
}

function isTestPath(p: string): boolean {
  return p.endsWith('_test.exs') || p.includes('/test/') || p.startsWith('test/');
}

export function resolveElixirImportEdges(state: PipelineState, _scope?: ChangeScope): void {
  // WHY: driven by `state.pendingImports`, already scoped to re-extracted files.
  void _scope;
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);
  const hasElixir = pendingFileIds.some((id) => fileMap.get(id)?.language === 'elixir');
  if (!hasElixir) return;

  // 1. Index declared Elixir module symbols:
  // s.name or s.fqn -> file_id(s)
  const byModule = new Map<string, number[]>();
  const moduleRows = store.db
    .prepare(
      `SELECT DISTINCT s.name, s.fqn, s.file_id FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE f.language = 'elixir' AND (s.kind = 'class' OR s.kind = 'interface')`,
    )
    .all() as Array<{ name: string; fqn: string | null; file_id: number }>;

  const allElixirIds = new Set<number>();
  for (const { name, fqn, file_id } of moduleRows) {
    allElixirIds.add(file_id);
    if (name) addTo(byModule, name, file_id);
    if (fqn && fqn !== name) addTo(byModule, fqn, file_id);
  }

  // 2. Index Elixir files by path suffix for convention-based path resolution:
  const bySuffix = new Map<string, number[]>();
  const filePathMap = new Map<number, string>();
  for (const f of store.getAllFiles()) {
    if (f.language !== 'elixir') continue;
    allElixirIds.add(f.id);
    const p = f.path.split('\\').join('/');
    filePathMap.set(f.id, p);
    for (const s of suffixes(p)) {
      addTo(bySuffix, s, f.id);
    }
  }

  if (allElixirIds.size === 0) return;

  const importsEdgeType = store.db
    .prepare('SELECT id FROM edge_types WHERE name = ?')
    .get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const nodeIds = new Map<number, number>();
  const lookupIds = Array.from(allElixirIds).concat(pendingFileIds);
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

  const resolveTarget = (
    mod: string,
    isFromTest: boolean,
  ): { targetId?: number; ambiguous?: boolean } => {
    // 1. Direct module symbol match
    let candidates = byModule.get(mod);
    if (!candidates || candidates.length === 0) {
      // 2. Convention path suffix match: e.g. Plug.Conn -> plug/conn.ex or plug/conn.exs
      const relSuffix = moduleToPath(mod);
      candidates = bySuffix.get(`${relSuffix}.ex`) ?? bySuffix.get(`${relSuffix}.exs`);
    }
    if (!candidates || candidates.length === 0) {
      // 3. Fallback one segment up: e.g. Plug.Conn.Status -> Plug.Conn
      const lastDot = mod.lastIndexOf('.');
      if (lastDot > 0) {
        const parentMod = mod.slice(0, lastDot);
        candidates = byModule.get(parentMod);
      }
    }

    if (!candidates || candidates.length === 0) {
      return {};
    }

    // Filter test candidates if importing file is non-test
    if (!isFromTest && candidates.length > 1) {
      const nonTest = candidates.filter((id) => !isTestPath(filePathMap.get(id) ?? ''));
      if (nonTest.length > 0) candidates = nonTest;
    }

    if (candidates.length === 1) {
      return { targetId: candidates[0] };
    }

    // If multiple candidates remain, check if they are identical file
    const unique = Array.from(new Set(candidates));
    if (unique.length === 1) {
      return { targetId: unique[0] };
    }

    return { ambiguous: true };
  };

  let created = 0;
  let external = 0;
  let ambiguous = 0;

  store.db.transaction(() => {
    for (const [fileId, imports] of state.pendingImports) {
      const file = fileMap.get(fileId);
      if (file?.language !== 'elixir') continue;
      const sourceNodeId = nodeIds.get(fileId);
      if (sourceNodeId == null) continue;

      const fromPath = filePathMap.get(fileId) ?? file.path.split('\\').join('/');
      const fromIsTest = isTestPath(fromPath);

      const seen = new Set<string>();
      for (const { from } of imports) {
        if (!from) continue;
        const expanded = expandMultiAlias(from);
        for (const spec of expanded) {
          if (seen.has(spec)) continue;
          seen.add(spec);

          const { targetId, ambiguous: isAmbiguous } = resolveTarget(spec, fromIsTest);
          if (isAmbiguous) {
            ambiguous++;
            continue;
          }
          if (targetId == null) {
            external++;
            continue;
          }

          if (targetId === fileId) {
            // Self-reference (e.g. alias of module in own file)
            continue;
          }

          const targetNodeId = nodeIds.get(targetId);
          if (targetNodeId == null || targetNodeId === sourceNodeId) continue;

          insertStmt.run(
            sourceNodeId,
            targetNodeId,
            importsEdgeType.id,
            JSON.stringify({ from: spec }),
          );
          created++;
        }
      }
    }
  })();

  if (created > 0 || external > 0 || ambiguous > 0) {
    logger.info({ edges: created, external, ambiguous }, 'Elixir import edges resolved');
  }
}
