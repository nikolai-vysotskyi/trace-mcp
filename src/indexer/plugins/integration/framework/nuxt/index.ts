/**
 * NuxtPlugin — detects Nuxt 3 and Nuxt 4 projects and extracts file-based routes,
 * auto-imported composables, shared utilities, and API routes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRoute,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

/**
 * Convert a Nuxt pages file path to a route URI.
 * pages/index.vue -> /
 * pages/users.vue -> /users
 * pages/users/index.vue -> /users
 * pages/users/[id].vue -> /users/:id
 * pages/[...slug].vue -> /:slug(.*)*
 *
 * Accepts an optional srcDir to strip the correct prefix (e.g. 'app' for Nuxt 4).
 */
export function filePathToRoute(filePath: string, srcDir: string = '.'): string {
  // Normalize: remove {srcDir}/pages/ prefix and .vue suffix
  const pagesPrefix = srcDir === '.' ? 'pages/' : `${srcDir}/pages/`;
  let route = filePath
    .replace(new RegExp(`^${pagesPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '')
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

/**
 * Convert a server/routes file path to a route (no /api prefix).
 * server/routes/health.ts -> GET /health
 * server/routes/webhook.post.ts -> POST /webhook
 */
export function serverRoutesToRoute(filePath: string): { method: string; uri: string } {
  const methodMatch = filePath.match(/\.(get|post|put|patch|delete|head|options)\.(ts|js|mjs)$/);

  let route = filePath.replace(/^server\/routes\//, '');
  if (methodMatch) {
    route = route.replace(/\.(get|post|put|patch|delete|head|options)\.(ts|js|mjs)$/, '');
  } else {
    route = route.replace(/\.(ts|js|mjs)$/, '');
  }

  const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';

  // Handle index files
  route = route.replace(/\/index$/, '');
  if (route === 'index') route = '';

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
    category: 'framework',
    dependencies: ['vue-framework'],
  };

  private nuxt4: boolean = false;
  private srcDir: string = '.';

  /**
   * Detect whether the project uses Nuxt 4.
   * Checks: package.json version, nuxt.config.ts compatibilityVersion, app/pages/ directory.
   */
  private isNuxt4(ctx: ProjectContext): boolean {
    // Check package.json nuxt version
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      const nuxtVersion = deps['nuxt'];
      if (nuxtVersion && (/\^4/.test(nuxtVersion) || />=\s*4\.0\.0/.test(nuxtVersion))) {
        return true;
      }
    }

    // Check nuxt.config.ts for compatibilityVersion: 4
    try {
      const configPath = path.join(ctx.rootPath, 'nuxt.config.ts');
      const configContent = fs.readFileSync(configPath, 'utf-8');
      if (/compatibilityVersion\s*:\s*4/.test(configContent)) {
        return true;
      }
    } catch { /* ignore */ }

    // Structural heuristic: check if app/pages/ exists
    try {
      const appPagesDir = path.join(ctx.rootPath, 'app', 'pages');
      fs.accessSync(appPagesDir);
      return true;
    } catch { /* ignore */ }

    return false;
  }

  /** Returns 'app' for Nuxt 4, '.' for Nuxt 3. */
  getSrcDir(): string {
    return this.srcDir;
  }

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('nuxt' in deps) {
        this.nuxt4 = this.isNuxt4(ctx);
        this.srcDir = this.nuxt4 ? 'app' : '.';
        return true;
      }
    }

    // Check for nuxt.config.ts
    try {
      const configPath = path.join(ctx.rootPath, 'nuxt.config.ts');
      fs.accessSync(configPath);
      this.nuxt4 = this.isNuxt4(ctx);
      this.srcDir = this.nuxt4 ? 'app' : '.';
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
      if ('nuxt' in deps) {
        this.nuxt4 = this.isNuxt4(ctx);
        this.srcDir = this.nuxt4 ? 'app' : '.';
        return true;
      }
    } catch { /* ignore */ }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'nuxt_auto_imports', category: 'nuxt', description: 'Auto-imported composable' },
        { name: 'api_calls', category: 'nuxt', description: 'fetch/useFetch API call' },
        { name: 'nuxt_shared_import', category: 'nuxt', description: 'Auto-imported shared utility or type' },
        { name: 'renders_component', category: 'nuxt', description: 'Vue template renders component' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [] };

    const srcDir = this.srcDir;
    const pagesPrefix = srcDir === '.' ? 'pages/' : `${srcDir}/pages/`;
    const composablesPrefix = srcDir === '.' ? 'composables/' : `${srcDir}/composables/`;
    const pluginsPrefix = srcDir === '.' ? 'plugins/' : `${srcDir}/plugins/`;
    const middlewarePrefix = srcDir === '.' ? 'middleware/' : `${srcDir}/middleware/`;
    const layoutsPrefix = srcDir === '.' ? 'layouts/' : `${srcDir}/layouts/`;

    // Nuxt page -> route
    if (filePath.startsWith(pagesPrefix) && filePath.endsWith('.vue')) {
      const uri = filePathToRoute(filePath, srcDir);
      result.routes!.push({
        method: 'GET',
        uri,
        name: filePath.replace(new RegExp(`^${pagesPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '').replace(/\.vue$/, '').replace(/\//g, '-'),
      });
      result.frameworkRole = 'nuxt_page';
    }

    // Composable
    if (filePath.startsWith(composablesPrefix) && /\.(ts|js)$/.test(filePath)) {
      result.frameworkRole = 'nuxt_composable';
    }

    // Plugin
    if (filePath.startsWith(pluginsPrefix) && /\.(ts|js)$/.test(filePath)) {
      result.frameworkRole = 'nuxt_plugin';
    }

    // Middleware
    if (filePath.startsWith(middlewarePrefix) && /\.(ts|js)$/.test(filePath)) {
      result.frameworkRole = 'nuxt_middleware';
    }

    // Layout
    if (filePath.startsWith(layoutsPrefix) && filePath.endsWith('.vue')) {
      result.frameworkRole = 'nuxt_layout';
    }

    // Server API route (always at project root)
    if (filePath.startsWith('server/api/') && /\.(ts|js|mjs)$/.test(filePath)) {
      const { method, uri } = serverApiToRoute(filePath);
      result.routes!.push({ method, uri });
      result.frameworkRole = 'nuxt_api';
    }

    // Server routes (always at project root, no /api prefix)
    if (filePath.startsWith('server/routes/') && /\.(ts|js|mjs)$/.test(filePath)) {
      const { method, uri } = serverRoutesToRoute(filePath);
      result.routes!.push({ method, uri });
      result.frameworkRole = 'nuxt_server_route';
    }

    // Shared utils and types (Nuxt 4 auto-imports)
    if (
      (filePath.startsWith('shared/utils/') || filePath.startsWith('shared/types/')) &&
      /\.(ts|js)$/.test(filePath)
    ) {
      result.frameworkRole = 'nuxt_shared';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    const srcDir = this.srcDir;
    const composablesPrefix = srcDir === '.' ? 'composables/' : `${srcDir}/composables/`;
    const componentsPrefix = srcDir === '.' ? 'components/' : `${srcDir}/components/`;

    // Find composable files
    const composableFiles = allFiles.filter(
      (f) => f.path.startsWith(composablesPrefix) && /\.(ts|js)$/.test(f.path),
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

    // Find shared files
    const sharedFiles = allFiles.filter(
      (f) =>
        (f.path.startsWith('shared/utils/') || f.path.startsWith('shared/types/')) &&
        /\.(ts|js)$/.test(f.path),
    );

    // Map shared export name -> symbol
    const sharedMap = new Map<string, { id: number; symbolId: string }>();
    for (const file of sharedFiles) {
      const symbols = ctx.getSymbolsByFile(file.id);
      for (const sym of symbols) {
        if (sym.kind === 'function' || sym.kind === 'interface' || sym.kind === 'type' || sym.kind === 'variable') {
          sharedMap.set(sym.name, { id: sym.id, symbolId: sym.symbolId });
        }
      }
    }

    // Build component name → symbol map for Nuxt auto-imported components.
    // Nuxt registers components by filename: `components/AppBaseCard.vue` → `<AppBaseCard>`.
    // For nested dirs, both the basename and the path-prefixed name are registered:
    //   `components/guides/MediaBlock.vue` → `<GuidesMediaBlock>` and `<MediaBlock>`.
    const componentMap = new Map<string, { id: number; symbolId: string }>();
    const componentFiles = allFiles.filter(
      (f) => f.path.startsWith(componentsPrefix) && f.path.endsWith('.vue'),
    );
    for (const file of componentFiles) {
      const symbols = ctx.getSymbolsByFile(file.id);
      const compSym = symbols.find((s) => s.kind === 'class');
      if (!compSym) continue;

      // Register by filename (basename without extension)
      const baseName = path.basename(file.path, '.vue');
      componentMap.set(baseName, { id: compSym.id, symbolId: compSym.symbolId });

      // Also register path-prefixed name: components/foo/Bar.vue → FooBar
      const relToComponents = file.path.slice(componentsPrefix.length, -'.vue'.length);
      const segments = relToComponents.split('/');
      if (segments.length > 1) {
        const prefixed = segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
        componentMap.set(prefixed, { id: compSym.id, symbolId: compSym.symbolId });
      }
    }

    // For each Vue file, detect auto-imported composable, shared, and component usage
    const vueFiles = allFiles.filter((f) => f.path.endsWith('.vue'));
    for (const file of vueFiles) {
      const symbols = ctx.getSymbolsByFile(file.id);
      const compSymbol = symbols.find((s) => s.kind === 'class');
      if (!compSymbol) continue;

      // Extract templateComponents from metadata (already parsed by Vue plugin)
      const meta = compSymbol.metadata as Record<string, unknown> | null;
      const templateComponents = (meta?.templateComponents as string[]) ?? [];

      // Resolve template component references → edges
      for (const tagName of templateComponents) {
        const target = componentMap.get(tagName);
        if (target && target.id !== compSymbol.id) {
          edges.push({
            sourceNodeType: 'symbol',
            sourceRefId: compSymbol.id,
            targetNodeType: 'symbol',
            targetRefId: target.id,
            edgeType: 'renders_component',
            metadata: { component: tagName },
          });
        }
      }

      // Check for composable usage (needs source text)
      if (composableMap.size > 0 || sharedMap.size > 0) {
        let source: string | undefined;
        try {
          source = ctx.readFile(file.path);
        } catch { /* ignore */ }
        if (!source) continue;

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

        // Check for shared utility/type usage
        for (const [name, target] of sharedMap) {
          if (source.includes(name)) {
            edges.push({
              sourceNodeType: 'symbol',
              sourceRefId: compSymbol.id,
              targetNodeType: 'symbol',
              targetRefId: target.id,
              edgeType: 'nuxt_shared_import',
              metadata: { shared: name },
            });
          }
        }
      }
    }

    return ok(edges);
  }
}
