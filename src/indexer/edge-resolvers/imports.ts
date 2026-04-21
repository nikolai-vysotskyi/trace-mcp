/** Pass 2d: Resolve ES module import specifiers to file→file graph edges. */
import path from 'node:path';
import type { PipelineState } from '../pipeline-state.js';
import { EsModuleResolver } from '../resolvers/es-modules.js';
import { logger } from '../../logger.js';
import { PhantomPackageFactory } from './phantom-externals.js';

/**
 * Derive a package-bucket name from an npm specifier. Scoped packages
 * (`@vue/reactivity/...`) collapse to `@vue/reactivity`; plain packages
 * (`lodash/fp/pipe`) collapse to `lodash`.
 */
function npmBucketFor(specifier: string): string | null {
  if (!specifier) return null;
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('@/') || specifier.startsWith('~') || specifier.startsWith('#')) return null;
  if (specifier.startsWith('node:')) return specifier.split('/')[0];
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return parts[0];
  }
  return specifier.split('/')[0];
}

export function resolveEsmImportEdges(state: PipelineState): void {
  const { store } = state;
  if (state.pendingImports.size === 0) return;

  let resolver: EsModuleResolver;
  try {
    const workspacePaths = state.workspaces?.map((ws) => ws.path) ?? [];
    resolver = new EsModuleResolver(state.rootPath, workspacePaths);
  } catch {
    logger.warn('EsModuleResolver init failed — skipping import edge resolution');
    return;
  }

  let created = 0;
  let phantomEdges = 0;
  const phantomPackages = new PhantomPackageFactory(state, 'typescript');
  const phantomEdgesSeen = new Set<string>();

  const pendingFileIds = Array.from(state.pendingImports.keys());
  const fileMap = store.getFilesByIds(pendingFileIds);
  const fileNodeMap = store.getNodeIdsBatch('file', pendingFileIds);

  // Workspace lookup for pending source files (needed to scope phantom packages)
  const fileWorkspace = new Map<number, string | null>();
  {
    const ids = pendingFileIds;
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const ph = chunk.map(() => '?').join(',');
      const rows = store.db.prepare(
        `SELECT id, workspace FROM files WHERE id IN (${ph})`,
      ).all(...chunk) as Array<{ id: number; workspace: string | null }>;
      for (const r of rows) fileWorkspace.set(r.id, r.workspace);
    }
  }

  const targetFileCache = new Map<string, { id: number; nodeId: number } | null>();
  const resolveTargetFile = (relPath: string): { id: number; nodeId: number } | null => {
    const cached = targetFileCache.get(relPath);
    if (cached !== undefined) return cached;
    const f = store.getFile(relPath);
    if (!f) { targetFileCache.set(relPath, null); return null; }
    const nodeId = store.getNodeId('file', f.id);
    if (nodeId == null) { targetFileCache.set(relPath, null); return null; }
    const entry = { id: f.id, nodeId };
    targetFileCache.set(relPath, entry);
    return entry;
  };

  const importsEdgeType = store.db.prepare('SELECT id FROM edge_types WHERE name = ?').get('imports') as { id: number } | undefined;
  if (!importsEdgeType) return;

  const insertStmt = store.db.prepare(
    `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
     VALUES (?, ?, ?, 1, ?, 0)
     ON CONFLICT(source_node_id, target_node_id, edge_type_id)
     DO UPDATE SET metadata = excluded.metadata`,
  );

  // Languages whose `imports` edges carry filesystem-path specifiers (vs FQNs
   // like PHP's `use`). CSS/HTML/XML/SVG `@import`/href/src targets resolve via
   // the same oxc-resolver pass — without this, asset files stay isolated.
   const TS_JS_LANGS = new Set([
    'typescript', 'javascript', 'tsx', 'jsx', 'vue',
    'css', 'scss', 'sass', 'less', 'stylus',
    'html', 'xml', 'svg',
  ]);

  store.db.transaction(() => {
    for (const [fileId, imports] of state.pendingImports) {
      const file = fileMap.get(fileId);
      if (!file) continue;
      // Skip non-JS/TS files — PHP/Python imports are handled by their own
      // resolvers. Without this guard, PHP `use` entries (PHP FQNs like
      // `App\Actions\Foo`) get run through npm bucketing and pollute the
      // phantom graph.
      if (!TS_JS_LANGS.has(file.language ?? '')) continue;

      const absSource = path.resolve(state.rootPath, file.path);
      const sourceNodeId = fileNodeMap.get(fileId);
      if (sourceNodeId == null) continue;

      const consolidated = new Map<string, string[]>();
      for (const { from, specifiers } of imports) {
        const existing = consolidated.get(from);
        if (existing) {
          existing.push(...specifiers);
        } else {
          consolidated.set(from, [...specifiers]);
        }
      }

      const sourceWs = fileWorkspace.get(fileId) ?? null;

      for (const [from, specifiers] of consolidated) {
        if (!from) continue;
        // External URL (HTML/CSS href to CDN) — not a file nor an npm package.
        if (from.startsWith('http://') || from.startsWith('https://') || from.startsWith('//')
            || from.startsWith('data:')) continue;
        const isRelative = from.startsWith('.') || from.startsWith('/') || from.startsWith('@/') || from.startsWith('~');

        // Always try the path resolver first. Bare specifiers may still be
        // local — tsconfig/jsconfig `baseUrl` or `paths` can turn something
        // like `static/svg/Logo.svg` into a file inside the repo. Only fall
        // back to npm phantom when resolution lands outside the project root.
        const resolved = resolver.resolve(from, absSource);
        if (resolved) {
          const relTarget = path.relative(state.rootPath, resolved);
          // `path.relative` returns something starting with `..` when the
          // target is outside rootPath — those are real npm deps under
          // node_modules, handled by the bucket fallback below.
          if (!relTarget.startsWith('..') && !path.isAbsolute(relTarget)) {
            const target = resolveTargetFile(relTarget);
            if (target) {
              insertStmt.run(
                sourceNodeId,
                target.nodeId,
                importsEdgeType.id,
                JSON.stringify({ from, specifiers }),
              );
              created++;
              continue;
            }
          }
        }

        if (isRelative) {
          // Unresolved relative import — likely points outside the indexed
          // source tree or into a generated file. Skip rather than phantom
          // (would pollute the bucket view with per-file noise).
          continue;
        }

        // Bare specifier — npm package, node: builtin, etc. Anchor to a
        // phantom package bucket so consumers of the same library cluster.
        const bucket = npmBucketFor(from);
        if (!bucket) continue;
        const dedupKey = `${sourceNodeId}\0${sourceWs ?? ''}\0${bucket}`;
        if (phantomEdgesSeen.has(dedupKey)) continue;
        phantomEdgesSeen.add(dedupKey);

        const pkg = phantomPackages.ensure(bucket, sourceWs);
        if (pkg.node_id === sourceNodeId) continue;
        insertStmt.run(
          sourceNodeId,
          pkg.node_id,
          importsEdgeType.id,
          JSON.stringify({ from, specifiers, external: true, bucket }),
        );
        phantomEdges++;
      }
    }
  })();

  if (created > 0 || phantomEdges > 0) {
    logger.info({ edges: created, phantomEdges }, 'ES module import edges resolved');
  }
}
