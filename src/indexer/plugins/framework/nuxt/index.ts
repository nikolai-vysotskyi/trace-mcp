/**
 * NuxtPlugin — detects Nuxt 3 projects and extracts file-based routes,
 * auto-imported composables, and API routes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRoute,
  ResolveContext,
} from '../../../../plugin-api/types.js';

/**
 * Convert a Nuxt pages file path to a route URI.
 * pages/index.vue -> /
 * pages/users.vue -> /users
 * pages/users/index.vue -> /users
 * pages/users/[id].vue -> /users/:id
 * pages/[...slug].vue -> /:slug(.*)*
 */
export function filePathToRoute(filePath: string): string {
  // Normalize: remove pages/ prefix and .vue suffix
  let route = filePath
    .replace(/^pages\//, '')
    .replace(/\.vue$/, '');

  // Handle index files
  route = route.replace(/\/index$/, '');
  if (route === 'index') route = '';

  // Convert path segments
  const segments = route.split('/').filter(Boolean);
  const routeSegments = segments.map((seg) => {
    // Catch-all: [...slug] -> :slug(.*)*
    const catchAll = seg.match(/^\[\.\.\.(\w+)\]$/);
    if (catchAll) return `:${catchAll[1]}(.*)*`;

    // Dynamic: [id] -> :id
    const dynamic = seg.match(/^\[(\w+)\]$/);
    if (dynamic) return `:${dynamic[1]}`;

    return seg;
  });

  return '/' + routeSegments.join('/');
}

/**
 * Convert a server/api file path to an API route.
 * server/api/users.get.ts -> GET /api/users
 * server/api/users.ts -> GET /api/users (default GET)
 */
export function serverApiToRoute(filePath: string): { method: string; uri: string } {
  // Extract HTTP method from filename suffix (e.g., users.get.ts)
  const methodMatch = filePath.match(/\.(get|post|put|patch|delete|head|options)\.(ts|js|mjs)$/);

  let route = filePath.replace(/^server\//, '');
  if (methodMatch) {
    // Remove .method.ext
    route = route.replace(/\.(get|post|put|patch|delete|head|options)\.(ts|js|mjs)$/, '');
  } else {
    // Remove .ext only
    route = route.replace(/\.(ts|js|mjs)$/, '');
  }

  const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';

  // Handle index files
  route = route.replace(/\/index$/, '');

  return { method, uri: '/' + route };
}

/** Detect useFetch / useAsyncData calls and extract the API URL. */
const USE_FETCH_RE = /(?:useFetch|useAsyncData)\(\s*[`'"](\/[^`'"]*)[`'"]/g;

export function extractFetchCalls(source: string): string[] {
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(USE_FETCH_RE.source, 'g');
  while ((match = re.exec(source)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

export class NuxtPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'nuxt',
    version: '1.0.0',
    priority: 15,
    dependencies: ['vue-framework'],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('nuxt' in deps) return true;
    }

    // Check for nuxt.config.ts
    try {
      const configPath = path.join(ctx.rootPath, 'nuxt.config.ts');
      fs.accessSync(configPath);
      return true;
    } catch { /* ignore */ }

    // Fallback: read package.json from disk
    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      if ('nuxt' in deps) return true;
    } catch { /* ignore */ }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'nuxt_auto_imports', category: 'nuxt', description: 'Auto-imported composable' },
        { name: 'api_calls', category: 'nuxt', description: 'fetch/useFetch API call' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [] };

    // Nuxt page -> route
    if (filePath.startsWith('pages/') && filePath.endsWith('.vue')) {
      const uri = filePathToRoute(filePath);
      result.routes!.push({
        method: 'GET',
        uri,
        name: filePath.replace(/^pages\//, '').replace(/\.vue$/, '').replace(/\//g, '-'),
      });
      result.frameworkRole = 'nuxt_page';
    }

    // Server API route
    if (filePath.startsWith('server/api/') && /\.(ts|js|mjs)$/.test(filePath)) {
      const { method, uri } = serverApiToRoute(filePath);
      result.routes!.push({ method, uri });
      result.frameworkRole = 'nuxt_api';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    // Find composable files
    const composableFiles = allFiles.filter(
      (f) => f.path.startsWith('composables/') && /\.(ts|js)$/.test(f.path),
    );

    // Map composable name -> symbol
    const composableMap = new Map<string, { id: number; symbolId: string }>();
    for (const file of composableFiles) {
      const symbols = ctx.getSymbolsByFile(file.id);
      for (const sym of symbols) {
        if (sym.kind === 'function' && sym.name.startsWith('use')) {
          composableMap.set(sym.name, { id: sym.id, symbolId: sym.symbolId });
        }
      }
    }

    // For each Vue file, detect auto-imported composable usage
    const vueFiles = allFiles.filter((f) => f.path.endsWith('.vue'));
    for (const file of vueFiles) {
      let source: string;
      try {
        source = fs.readFileSync(path.resolve(ctx.rootPath, file.path), 'utf-8');
      } catch { continue; }

      const symbols = ctx.getSymbolsByFile(file.id);
      const compSymbol = symbols.find((s) => s.kind === 'class');
      if (!compSymbol) continue;

      // Check for composable usage
      for (const [name, target] of composableMap) {
        if (source.includes(name)) {
          edges.push({
            sourceNodeType: 'symbol',
            sourceRefId: compSymbol.id,
            targetNodeType: 'symbol',
            targetRefId: target.id,
            edgeType: 'nuxt_auto_imports',
            metadata: { composable: name },
          });
        }
      }
    }

    return ok(edges);
  }
}
