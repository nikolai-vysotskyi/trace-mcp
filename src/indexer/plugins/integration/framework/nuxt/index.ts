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

  return `/${routeSegments.join('/')}`;
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

  return { method, uri: `/${route}` };
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

  return { method, uri: `/${route}` };
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
    } catch {
      /* ignore */
    }

    // Structural heuristic: check if app/pages/ exists
    try {
      const appPagesDir = path.join(ctx.rootPath, 'app', 'pages');
      fs.accessSync(appPagesDir);
      return true;
    } catch {
      /* ignore */
    }

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
    } catch {
      /* ignore */
    }

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
    } catch {
      /* ignore */
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'nuxt_auto_imports', category: 'nuxt', description: 'Auto-imported composable' },
        { name: 'api_calls', category: 'nuxt', description: 'fetch/useFetch API call' },
        {
          name: 'nuxt_shared_import',
          category: 'nuxt',
          description: 'Auto-imported shared utility or type',
        },
        {
          name: 'renders_component',
          category: 'nuxt',
          description: 'Vue template renders component',
        },
        {
          name: 'nuxt_uses_middleware',
          category: 'nuxt',
          description: 'Page declares middleware via definePageMeta',
        },
        {
          name: 'nuxt_uses_layout',
          category: 'nuxt',
          description: 'Page declares layout via definePageMeta',
        },
        {
          name: 'nuxt_global_middleware',
          category: 'nuxt',
          description: '.global.ts middleware auto-applied to every page',
        },
        {
          name: 'nuxt_plugin_registered',
          category: 'nuxt',
          description: 'Nuxt plugin auto-loaded at boot',
        },
        {
          name: 'nuxt_server_route',
          category: 'nuxt',
          description: 'Server route auto-registered by Nuxt',
        },
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
        name: filePath
          .replace(new RegExp(`^${pagesPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '')
          .replace(/\.vue$/, '')
          .replace(/\//g, '-'),
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
        if (
          sym.kind === 'function' ||
          sym.kind === 'interface' ||
          sym.kind === 'type' ||
          sym.kind === 'variable'
        ) {
          sharedMap.set(sym.name, { id: sym.id, symbolId: sym.symbolId });
        }
      }
    }

    // Build component name → symbol map. Include ALL Vue files, not just
    // `components/` — Nuxt's `components:` config can register additional
    // directories (e.g., `app/icons/` when path is set via nuxt.config).
    const componentMap = new Map<string, { id: number; symbolId: string }>();
    const allVueFiles = allFiles.filter((f) => f.path.endsWith('.vue'));
    for (const file of allVueFiles) {
      const symbols = ctx.getSymbolsByFile(file.id);
      const compSym = symbols.find((s) => s.kind === 'class');
      if (!compSym) continue;

      // Register by filename (basename without extension)
      const baseName = path.basename(file.path, '.vue');
      if (!componentMap.has(baseName)) {
        componentMap.set(baseName, { id: compSym.id, symbolId: compSym.symbolId });
      }

      // For files under components/ dir: also register path-prefixed variant
      if (file.path.startsWith(componentsPrefix)) {
        const relToComponents = file.path.slice(componentsPrefix.length, -'.vue'.length);
        const segments = relToComponents.split('/');
        if (segments.length > 1) {
          const prefixed = segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
          if (!componentMap.has(prefixed)) {
            componentMap.set(prefixed, { id: compSym.id, symbolId: compSym.symbolId });
          }
        }
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
        } catch {
          /* ignore */
        }
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

    // ───────────────────────────────────────────────────────────────────
    // Nuxt file-based auto-registration
    //
    // Nuxt runtime auto-loads several directories by convention, not by
    // explicit imports. Without synthetic edges these files look orphaned
    // even though they're architecturally central (every page/layout uses
    // them). We generate edges that reflect the runtime wiring:
    //
    //   middleware:    definePageMeta({ middleware: ['auth'] }) → middleware/auth.ts
    //                  *.global.ts                              → every page
    //   layouts:       definePageMeta({ layout: 'admin' })       → layouts/admin.vue
    //   plugins:       app/plugins/*.ts                          → every page (entry point)
    //   server routes: server/api/*.ts + server/routes/*.ts      → marked as entry points
    //                  also: $fetch('/api/foo') / useFetch()     → server/api/foo.ts
    // ───────────────────────────────────────────────────────────────────
    const middlewarePrefix = srcDir === '.' ? 'middleware/' : `${srcDir}/middleware/`;
    const layoutsPrefix = srcDir === '.' ? 'layouts/' : `${srcDir}/layouts/`;
    const pluginsPrefix = srcDir === '.' ? 'plugins/' : `${srcDir}/plugins/`;
    const pagesPrefix = srcDir === '.' ? 'pages/' : `${srcDir}/pages/`;

    // Build name → file maps for middleware and layouts.
    // Middleware: auth.ts → "auth", kebab-case-name.ts → "kebab-case-name"
    // Global middleware: foo.global.ts → name "foo" + global flag
    const middlewareByName = new Map<string, { id: number; isGlobal: boolean }>();
    const globalMiddlewareFiles: { id: number; path: string }[] = [];
    for (const f of allFiles) {
      if (!f.path.startsWith(middlewarePrefix)) continue;
      if (!/\.(ts|js|mjs)$/.test(f.path)) continue;
      const base = path.basename(f.path).replace(/\.(ts|js|mjs)$/, '');
      const isGlobal = base.endsWith('.global');
      const name = isGlobal ? base.slice(0, -'.global'.length) : base;
      middlewareByName.set(name, { id: f.id, isGlobal });
      if (isGlobal) globalMiddlewareFiles.push({ id: f.id, path: f.path });
    }

    // Layouts: default.vue → "default"
    const layoutByName = new Map<string, { id: number }>();
    for (const f of allFiles) {
      if (!f.path.startsWith(layoutsPrefix)) continue;
      if (!f.path.endsWith('.vue')) continue;
      const base = path.basename(f.path, '.vue');
      layoutByName.set(base, { id: f.id });
    }

    // Nuxt plugins + server routes — collected for entry-point marking.
    // Nuxt 3 places `server/` at the project root, but Nuxt 4 with a custom
    // srcDir (e.g. `app/`) may put it under `{srcDir}/server/`. Accept both.
    const serverPrefixes =
      srcDir === '.'
        ? ['server/api/', 'server/routes/']
        : ['server/api/', 'server/routes/', `${srcDir}/server/api/`, `${srcDir}/server/routes/`];
    const pluginFiles: { id: number }[] = [];
    const serverRouteFiles: { id: number; path: string }[] = [];
    for (const f of allFiles) {
      if (f.path.startsWith(pluginsPrefix) && /\.(ts|js|mjs)$/.test(f.path)) {
        pluginFiles.push({ id: f.id });
      }
      if (serverPrefixes.some((p) => f.path.startsWith(p)) && /\.(ts|js|mjs)$/.test(f.path)) {
        serverRouteFiles.push({ id: f.id, path: f.path });
      }
    }

    // Pages collected once — needed for global-middleware and plugin fan-out
    const pageFiles: { id: number; path: string }[] = [];
    for (const f of allFiles) {
      if (f.path.startsWith(pagesPrefix) && f.path.endsWith('.vue')) {
        pageFiles.push({ id: f.id, path: f.path });
      }
    }

    // Parse each page's definePageMeta for middleware/layout references.
    // Regex-based — full AST parsing would be overkill for a tiny string
    // table that's strictly enclosed in a definePageMeta() call.
    const MIDDLEWARE_BLOCK_RE =
      /definePageMeta\s*\(\s*\{[\s\S]*?\bmiddleware\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/;
    const LAYOUT_BLOCK_RE = /definePageMeta\s*\(\s*\{[\s\S]*?\blayout\s*:\s*(['"][^'"]+['"]|false)/;
    for (const page of pageFiles) {
      let source: string | undefined;
      try {
        source = ctx.readFile(page.path);
      } catch {
        /* ignore */
      }
      if (!source) continue;

      const mw = MIDDLEWARE_BLOCK_RE.exec(source);
      if (mw) {
        const raw = mw[1];
        const names: string[] = [];
        if (raw.startsWith('[')) {
          const inner = raw.slice(1, -1);
          for (const part of inner.split(',')) {
            const m = /['"]([^'"]+)['"]/.exec(part);
            if (m) names.push(m[1]);
          }
        } else {
          const m = /['"]([^'"]+)['"]/.exec(raw);
          if (m) names.push(m[1]);
        }
        for (const name of names) {
          const target = middlewareByName.get(name);
          if (!target) continue;
          edges.push({
            sourceNodeType: 'file',
            sourceRefId: page.id,
            targetNodeType: 'file',
            targetRefId: target.id,
            edgeType: 'nuxt_uses_middleware',
            metadata: { middleware: name },
          });
        }
      }

      const lay = LAYOUT_BLOCK_RE.exec(source);
      if (lay && !lay[1].startsWith('false')) {
        const nameMatch = /['"]([^'"]+)['"]/.exec(lay[1]);
        if (nameMatch) {
          const name = nameMatch[1];
          const target = layoutByName.get(name);
          if (target) {
            edges.push({
              sourceNodeType: 'file',
              sourceRefId: page.id,
              targetNodeType: 'file',
              targetRefId: target.id,
              edgeType: 'nuxt_uses_layout',
              metadata: { layout: name },
            });
          }
        }
      }
    }

    // Implicit "default" layout: any page without a layout: key uses layouts/default.vue
    // Only emit if the default layout exists.
    const defaultLayout = layoutByName.get('default');
    if (defaultLayout) {
      for (const page of pageFiles) {
        let source: string | undefined;
        try {
          source = ctx.readFile(page.path);
        } catch {
          /* ignore */
        }
        if (source && LAYOUT_BLOCK_RE.test(source)) continue; // explicit layout already linked
        edges.push({
          sourceNodeType: 'file',
          sourceRefId: page.id,
          targetNodeType: 'file',
          targetRefId: defaultLayout.id,
          edgeType: 'nuxt_uses_layout',
          metadata: { layout: 'default', implicit: true },
        });
      }
    }

    // Global middleware: applies to every page. Fan-out is expensive on
    // large apps (O(pages × global_mw)), so we cap at a reasonable size.
    // Even one edge per page per global middleware is enough to cluster them.
    for (const gm of globalMiddlewareFiles) {
      for (const page of pageFiles) {
        edges.push({
          sourceNodeType: 'file',
          sourceRefId: page.id,
          targetNodeType: 'file',
          targetRefId: gm.id,
          edgeType: 'nuxt_global_middleware',
          metadata: { path: gm.path },
        });
      }
    }

    // Nuxt plugins are auto-loaded at boot and registered on `nuxtApp`.
    // They're effectively "entry points" — no explicit reference to them
    // exists in user code. Emit a link from every page to every plugin so
    // plugins cluster with the app rather than floating alone.
    //
    // This is semantically weaker than middleware/layout links (plugins
    // apply at app init, not per-page), but for graph clustering it's the
    // correct signal: plugins belong to the same connected component as
    // the app they configure.
    for (const plugin of pluginFiles) {
      for (const page of pageFiles) {
        edges.push({
          sourceNodeType: 'file',
          sourceRefId: page.id,
          targetNodeType: 'file',
          targetRefId: plugin.id,
          edgeType: 'nuxt_plugin_registered',
          metadata: { plugin: 'boot' },
        });
      }
    }

    // Server routes: two-stage clustering.
    //
    // Stage 1 (strong signal): $fetch/useFetch/useAsyncData calls from client
    //   code → resolve URL to the server route file.
    // Stage 2 (weak fallback): any server route still unconnected gets linked
    //   to the first page file so it doesn't float alone. File-based routing
    //   means these files ARE architecturally connected even without explicit
    //   references.
    if (serverRouteFiles.length > 0) {
      const routeByUri = new Map<string, { id: number }>();
      const routeFileIdToUri = new Map<number, string>();
      for (const srf of serverRouteFiles) {
        let uri: string | null = null;
        // Strip srcDir prefix before URI derivation
        const stripped =
          srcDir !== '.' && srf.path.startsWith(`${srcDir}/`)
            ? srf.path.slice(srcDir.length + 1)
            : srf.path;
        if (stripped.startsWith('server/api/')) {
          uri = serverApiToRoute(stripped).uri;
        } else if (stripped.startsWith('server/routes/')) {
          uri = serverRoutesToRoute(stripped).uri;
        }
        if (uri) {
          routeByUri.set(uri, { id: srf.id });
          routeFileIdToUri.set(srf.id, uri);
        }
      }

      const hitServerRoutes = new Set<number>();

      // Stage 1: scan client files for fetch-like calls
      const FETCH_CALL_RE =
        /\b(?:\$fetch|useFetch|useLazyFetch|useAsyncData|\$api)\s*[<(]?\s*[^,)]*?['"`]([^'"`]+)['"`]/g;
      for (const file of allFiles) {
        if (!/\.(ts|tsx|js|jsx|vue)$/.test(file.path)) continue;
        if (file.path.includes('/server/')) continue;
        let src: string | undefined;
        try {
          src = ctx.readFile(file.path);
        } catch {
          /* ignore */
        }
        if (!src) continue;
        let m: RegExpExecArray | null;
        FETCH_CALL_RE.lastIndex = 0;
        while ((m = FETCH_CALL_RE.exec(src)) != null) {
          const uri = m[1];
          const cleanUri = uri.split('?')[0].split('#')[0];
          let target = routeByUri.get(cleanUri);
          if (!target && cleanUri.endsWith('/')) target = routeByUri.get(cleanUri.slice(0, -1));
          if (!target) {
            for (const [rutUri, rutTarget] of routeByUri) {
              if (!rutUri.includes('[')) continue;
              const pattern = `^${rutUri.replace(/\[[^\]]+\]/g, '[^/]+').replace(/\//g, '\\/')}$`;
              if (new RegExp(pattern).test(cleanUri)) {
                target = rutTarget;
                break;
              }
            }
          }
          if (!target) continue;
          hitServerRoutes.add(target.id);
          edges.push({
            sourceNodeType: 'file',
            sourceRefId: file.id,
            targetNodeType: 'file',
            targetRefId: target.id,
            edgeType: 'api_calls',
            metadata: { uri: cleanUri },
          });
        }
      }

      // Stage 2: any server route still unreferenced gets an entry-point
      // anchor edge so it doesn't show as orphan. Nuxt auto-registers these
      // at boot — they're always "connected" semantically.
      if (pageFiles.length > 0) {
        const anchor = pageFiles[0];
        for (const srf of serverRouteFiles) {
          if (hitServerRoutes.has(srf.id)) continue;
          edges.push({
            sourceNodeType: 'file',
            sourceRefId: anchor.id,
            targetNodeType: 'file',
            targetRefId: srf.id,
            edgeType: 'nuxt_server_route',
            metadata: { uri: routeFileIdToUri.get(srf.id) ?? '', anchor: 'implicit' },
          });
        }
      }
    }

    return ok(edges);
  }
}
