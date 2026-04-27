/**
 * NestJSPlugin — detects NestJS projects and extracts modules, controllers,
 * routes, providers, and dependency injection edges.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import { escapeRegExp } from '../../../../../utils/security.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRoute,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Delete', 'Patch', 'Head', 'Options'] as const;
const CONTROLLER_RE = /@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/;
const METHOD_DECORATOR_RE = (method: string) =>
  new RegExp(`@${escapeRegExp(method)}\\(\\s*(?:['"\`]([^'"\`]*)['"\`])?\\s*\\)`, 'g');
const MODULE_RE = /@Module\(\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\s*\)/s;
const INJECTABLE_RE = /@Injectable\(\)/;
const USE_GUARDS_RE = /@UseGuards\(\s*([^)]+)\s*\)/g;
const _USE_PIPES_RE = /@UsePipes\(\s*([^)]+)\s*\)/g;
const _USE_INTERCEPTORS_RE = /@UseInterceptors\(\s*([^)]+)\s*\)/g;
const CONSTRUCTOR_RE = /constructor\s*\(([^)]*)\)/s;
const GATEWAY_RE = /@WebSocketGateway\s*\(/;
const SUBSCRIBE_RE = /@SubscribeMessage\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const EVENT_PATTERN_RE = /@EventPattern\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const MICROSERVICE_RE = /@(MessagePattern|EventPattern)\s*\(/;

/** Extract array items from a module decorator property like `imports: [A, B]`. */
function extractModuleArray(body: string, prop: string): string[] {
  const re = new RegExp(`${escapeRegExp(prop)}\\s*:\\s*\\[([^\\]]*?)\\]`, 's');
  const m = body.match(re);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Extract constructor parameter types for DI. */
export function extractConstructorDeps(source: string): string[] {
  const m = source.match(CONSTRUCTOR_RE);
  if (!m) return [];
  const params = m[1];
  const deps: string[] = [];
  // Match patterns like: private userService: UserService
  const paramRe = /(?:private|protected|public|readonly)\s+\w+\s*:\s*(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = paramRe.exec(params)) !== null) {
    deps.push(match[1]);
  }
  return deps;
}

/** Extract route info from a controller file. */
export function extractControllerRoutes(
  source: string,
  filePath: string,
): { basePath: string; routes: RawRoute[]; guards: string[] } {
  const controllerMatch = source.match(CONTROLLER_RE);
  const basePath = controllerMatch ? controllerMatch[1] : '';
  const routes: RawRoute[] = [];
  const guards: string[] = [];

  // Extract class-level guards
  const classGuardMatch = source.match(USE_GUARDS_RE);
  if (classGuardMatch) {
    for (const gm of classGuardMatch) {
      const inner = gm.match(/@UseGuards\(\s*([^)]+)\s*\)/);
      if (inner) {
        guards.push(
          ...inner[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
      }
    }
  }

  for (const method of HTTP_METHODS) {
    const re = METHOD_DECORATOR_RE(method);
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const methodPath = match[1] ?? '';
      const segments = [basePath, methodPath].filter(Boolean);
      const uri = '/' + segments.join('/').replace(/\/+/g, '/').replace(/^\//, '');
      routes.push({
        method: method.toUpperCase(),
        uri: uri || '/',
      });
    }
  }

  return { basePath, routes, guards };
}

function extractGatewayEvents(source: string): string[] {
  const events: string[] = [];
  const re = new RegExp(SUBSCRIBE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) events.push(m[1]);
  }
  return events;
}

function extractMicroservicePatterns(
  source: string,
): { type: 'message' | 'event'; pattern: string }[] {
  const results: { type: 'message' | 'event'; pattern: string }[] = [];
  const eventRe = new RegExp(EVENT_PATTERN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = eventRe.exec(source)) !== null) {
    if (m[1]) results.push({ type: 'event', pattern: m[1] });
  }
  // @MessagePattern('cmd') or @MessagePattern({ cmd: 'sum' })
  const msgStr = /@MessagePattern\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  while ((m = msgStr.exec(source)) !== null) {
    if (m[1]) results.push({ type: 'message', pattern: m[1] });
  }
  const msgObj = /@MessagePattern\s*\(\s*\{[^}]*cmd\s*:\s*['"`]([^'"`]+)['"`]/g;
  while ((m = msgObj.exec(source)) !== null) {
    if (m[1]) results.push({ type: 'message', pattern: m[1] });
  }
  return results;
}

/** Extract module metadata. */
export function extractModuleInfo(source: string): {
  imports: string[];
  controllers: string[];
  providers: string[];
  exports: string[];
} | null {
  const m = source.match(MODULE_RE);
  if (!m) return null;
  const body = m[1];
  return {
    imports: extractModuleArray(body, 'imports'),
    controllers: extractModuleArray(body, 'controllers'),
    providers: extractModuleArray(body, 'providers'),
    exports: extractModuleArray(body, 'exports'),
  };
}

export class NestJSPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'nestjs',
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
      if ('@nestjs/core' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return '@nestjs/core' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'nest_module_imports',
          category: 'nestjs',
          description: 'Module imports another module',
        },
        { name: 'nest_provides', category: 'nestjs', description: 'Module provides a service' },
        {
          name: 'nest_injects',
          category: 'nestjs',
          description: 'Constructor dependency injection',
        },
        { name: 'nest_guards', category: 'nestjs', description: 'UseGuards on controller/method' },
        { name: 'nest_pipes', category: 'nestjs', description: 'UsePipes on controller/method' },
        {
          name: 'nest_interceptors',
          category: 'nestjs',
          description: 'UseInterceptors on controller/method',
        },
        {
          name: 'nest_gateway_event',
          category: 'nestjs',
          description: 'WebSocket gateway @SubscribeMessage handler',
        },
        {
          name: 'nest_message_pattern',
          category: 'nestjs',
          description: 'Microservice @MessagePattern handler',
        },
        {
          name: 'nest_event_pattern',
          category: 'nestjs',
          description: 'Microservice @EventPattern handler',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'typescript') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], routes: [], edges: [] };

    // Controller with routes
    if (source.includes('@Controller')) {
      const { routes } = extractControllerRoutes(source, filePath);
      result.routes = routes;
      result.frameworkRole = 'nest_controller';
    }

    // Module
    if (source.includes('@Module')) {
      const moduleInfo = extractModuleInfo(source);
      if (moduleInfo) {
        result.frameworkRole = 'nest_module';
      }
    }

    // Injectable
    if (INJECTABLE_RE.test(source)) {
      result.frameworkRole = result.frameworkRole ?? 'nest_injectable';
    }

    // WebSocket Gateway
    if (GATEWAY_RE.test(source)) {
      result.frameworkRole = 'nest_gateway';
      const events = extractGatewayEvents(source);
      if (events.length > 0) {
        result.warnings = result.warnings ?? [];
        // store gateway events in metadata via a synthetic warning-free mechanism
        // Use routes as gateway event placeholders
        if (!result.routes) result.routes = [];
        for (const evt of events) {
          result.routes.push({ method: 'WS', uri: evt });
        }
      }
    }

    // Microservice handlers
    if (MICROSERVICE_RE.test(source)) {
      result.frameworkRole = result.frameworkRole ?? 'nest_microservice';
      const patterns = extractMicroservicePatterns(source);
      if (patterns.length > 0) {
        if (!result.routes) result.routes = [];
        for (const p of patterns) {
          result.routes.push({ method: p.type === 'message' ? 'MSG' : 'EVT', uri: p.pattern });
        }
      }
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    // TypeScript symbols don't carry PHP-style FQNs, so build a class-name → symbol
    // map as a fallback for DI/module resolution.
    const classSymbolByName = new Map<string, { id: number }>();
    for (const file of allFiles) {
      if (file.language !== 'typescript') continue;
      for (const sym of ctx.getSymbolsByFile(file.id)) {
        if (sym.kind === 'class') {
          classSymbolByName.set(sym.name, { id: sym.id });
        }
      }
    }

    /** Try FQN first (PHP-style), fall back to plain class name (TypeScript). */
    const resolve = (name: string) => ctx.getSymbolByFqn(name) ?? classSymbolByName.get(name);

    for (const file of allFiles) {
      if (file.language !== 'typescript') continue;

      const source = ctx.readFile(file.path);
      if (!source) continue;

      // Module edges
      const moduleInfo = extractModuleInfo(source);
      if (moduleInfo) {
        const symbols = ctx.getSymbolsByFile(file.id);
        const moduleClass = symbols.find((s) => s.kind === 'class');
        if (moduleClass) {
          // imports
          for (const imp of moduleInfo.imports) {
            const target = resolve(imp);
            if (target) {
              edges.push({
                sourceNodeType: 'symbol',
                sourceRefId: moduleClass.id,
                targetNodeType: 'symbol',
                targetRefId: target.id,
                edgeType: 'nest_module_imports',
              });
            }
          }
          // providers
          for (const prov of moduleInfo.providers) {
            const target = resolve(prov);
            if (target) {
              edges.push({
                sourceNodeType: 'symbol',
                sourceRefId: moduleClass.id,
                targetNodeType: 'symbol',
                targetRefId: target.id,
                edgeType: 'nest_provides',
              });
            }
          }
        }
      }

      // Constructor injection edges
      const deps = extractConstructorDeps(source);
      if (deps.length > 0) {
        const symbols = ctx.getSymbolsByFile(file.id);
        const cls = symbols.find((s) => s.kind === 'class');
        if (cls) {
          for (const dep of deps) {
            const target = resolve(dep);
            if (target) {
              edges.push({
                sourceNodeType: 'symbol',
                sourceRefId: cls.id,
                targetNodeType: 'symbol',
                targetRefId: target.id,
                edgeType: 'nest_injects',
                metadata: { dependency: dep },
              });
            }
          }
        }
      }
    }

    return ok(edges);
  }
}
