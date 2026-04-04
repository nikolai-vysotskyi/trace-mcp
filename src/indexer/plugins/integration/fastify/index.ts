/**
 * FastifyPlugin — detects Fastify projects and extracts route handlers,
 * lifecycle hooks, and plugin registrations.
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

// fastify.get('/path', handler) or fastify.post('/path', opts, handler)
const SHORTHAND_ROUTE_RE =
  /(?:fastify|app|server|instance)\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/g;

// fastify.route({ method: 'GET', url: '/path', ... })
const ROUTE_OBJECT_RE =
  /\.route\s*\(\s*\{[^}]*?method\s*:\s*['"`]([^'"`]+)['"`][^}]*?url\s*:\s*['"`]([^'"`]+)['"`]/g;

// fastify.addHook('onRequest', ...)
const HOOK_RE =
  /\.addHook\s*\(\s*['"`]([^'"`]+)['"`]/g;

// fastify.register(pluginName, ...)
const REGISTER_RE =
  /\.register\s*\(\s*([A-Za-z][\w.]*)/g;

export interface FastifyRoute {
  method: string;
  path: string;
}

/** Extract route definitions from Fastify source code. */
export function extractFastifyRoutes(source: string): FastifyRoute[] {
  const routes: FastifyRoute[] = [];

  // Shorthand methods: fastify.get('/path', ...)
  const shortRe = new RegExp(SHORTHAND_ROUTE_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = shortRe.exec(source)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
    });
  }

  // Route object: fastify.route({ method: 'GET', url: '/path' })
  const objRe = new RegExp(ROUTE_OBJECT_RE.source, 'g');
  while ((match = objRe.exec(source)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
    });
  }

  return routes;
}

/** Extract lifecycle hook names from Fastify source code. */
export function extractFastifyHooks(source: string): string[] {
  const hooks: string[] = [];
  const re = new RegExp(HOOK_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    hooks.push(match[1]);
  }
  return hooks;
}

/** Extract plugin registration names from Fastify source code. */
export function extractFastifyPlugins(source: string): string[] {
  const plugins: string[] = [];
  const re = new RegExp(REGISTER_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    plugins.push(match[1]);
  }
  return plugins;
}

export class FastifyPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'fastify',
    version: '1.0.0',
    priority: 25,
    category: 'framework',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('fastify' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return 'fastify' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'fastify_route', category: 'fastify', description: 'Route handler' },
        { name: 'fastify_hook', category: 'fastify', description: 'Lifecycle hook' },
        { name: 'fastify_plugin', category: 'fastify', description: 'Plugin registration' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    const routes = extractFastifyRoutes(source);
    if (routes.length > 0) {
      result.frameworkRole = 'fastify_route';
      for (const route of routes) {
        result.routes!.push({
          method: route.method,
          uri: route.path,
        });
      }
    }

    const hooks = extractFastifyHooks(source);
    if (hooks.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'fastify_hook';
    }

    const plugins = extractFastifyPlugins(source);
    if (plugins.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'fastify_plugin';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    return ok(edges);
  }
}
