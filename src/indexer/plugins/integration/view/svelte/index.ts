/**
 * SveltePlugin — detects Svelte/SvelteKit projects and extracts components,
 * slots, events, stores, routes, API endpoints, and hooks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawComponent,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// ── Regex patterns ──────────────────────────────────────────────────────────

// <script> block props: export let propName
const EXPORT_LET_RE = /export\s+let\s+(\w+)/g;

// <slot> usage: <slot /> or <slot name="foo" />
const SLOT_RE = /<slot(?:\s+name\s*=\s*['"]([^'"]+)['"])?\s*\/?>/g;

// Event dispatching: dispatch('event-name')
const DISPATCH_RE = /dispatch\s*\(\s*['"]([^'"]+)['"]/g;

// createEventDispatcher usage
const _CREATE_DISPATCHER_RE = /createEventDispatcher\s*(?:<[^>]*>)?\s*\(\s*\)/;

// Store subscriptions: $storeName
const STORE_SUB_RE = /\$(\w+)/g;

// Store creation: writable(...), readable(...), derived(...)
const _STORE_CREATE_RE = /(?:writable|readable|derived)\s*\(/g;

// Svelte component imports: import Foo from './Foo.svelte'
const SVELTE_IMPORT_RE = /import\s+(\w+)\s+from\s+['"]([^'"]*\.svelte)['"]/g;

// Component usage in template: <ComponentName or <ComponentName>
const COMPONENT_USAGE_RE = /<([A-Z]\w+)[\s/>]/g;

// SvelteKit exported functions: export const GET, export function load, etc.
const EXPORTED_FN_RE =
  /export\s+(?:const|function|async\s+function)\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|load|actions)\b/g;

// SvelteKit actions: named actions inside export const actions = { default, login, ... }
const ACTIONS_BLOCK_RE = /export\s+const\s+actions\s*(?::\s*\w+)?\s*=\s*\{([^}]*)\}/;
const ACTION_NAME_RE = /(\w+)\s*(?::|,|\})/g;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract the <script> block content from a .svelte file. */
function extractScriptBlock(source: string): string {
  const match = /<script[^>]*>([\s\S]*?)<\/script>/.exec(source);
  return match ? match[1] : '';
}

/** Extract the template portion (everything outside <script> and <style>). */
function extractTemplate(source: string): string {
  return source
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
}

/** Determine if a file is a SvelteKit route file based on its path. */
function isSvelteKitRouteFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return /^\+(page|layout|server|error)/.test(base);
}

/** Determine if a file is a SvelteKit hooks file. */
function isSvelteKitHooksFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return /^hooks\.(server|client)\.(ts|js)$/.test(base);
}

/** Extract a SvelteKit route URI from the file path (e.g. src/routes/blog/[slug]/+page.svelte -> /blog/[slug]). */
function extractRouteUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const routesIdx = normalized.indexOf('/routes/');
  if (routesIdx === -1) return '/';
  const afterRoutes = normalized.substring(routesIdx + '/routes'.length);
  const dir = path.posix.dirname(afterRoutes);
  return dir === '.' ? '/' : dir;
}

/** Derive a component name from a file path. */
function componentNameFromPath(filePath: string): string {
  const base = path.basename(filePath, '.svelte');
  // SvelteKit convention files
  if (base.startsWith('+')) return base;
  return base;
}

// Built-in Svelte store-like globals that should not be treated as user stores
const BUILTIN_STORE_NAMES = new Set([
  'page',
  'navigating',
  'updated', // SvelteKit app stores
]);

// ── Plugin ──────────────────────────────────────────────────────────────────

export class SveltePlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'svelte',
    version: '1.0.0',
    priority: 25,
    category: 'view',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if ('svelte' in deps || '@sveltejs/kit' in deps) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content) as Record<string, unknown>;
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return 'svelte' in deps || '@sveltejs/kit' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'svelte_renders',
          category: 'svelte',
          description: 'Parent component renders child component',
        },
        {
          name: 'svelte_dispatches',
          category: 'svelte',
          description: 'Component dispatches a custom event',
        },
        {
          name: 'svelte_uses_store',
          category: 'svelte',
          description: 'Component subscribes to a Svelte store',
        },
        { name: 'sveltekit_route', category: 'svelte', description: 'SvelteKit route definition' },
        {
          name: 'sveltekit_loads',
          category: 'svelte',
          description: 'SvelteKit load function data dependency',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    const source = content.toString('utf-8');
    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      routes: [],
      components: [],
      edges: [],
    };

    if (filePath.endsWith('.svelte')) {
      this.extractSvelteComponent(filePath, source, result);
    } else if (['typescript', 'javascript'].includes(language)) {
      this.extractSvelteKitServerFile(filePath, source, result);
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();
    const svelteFiles = allFiles.filter((f) => f.path.endsWith('.svelte'));

    // Map component name -> symbolId
    const componentNameToSymbolId = new Map<string, string>();
    for (const file of svelteFiles) {
      const symbols = ctx.getSymbolsByFile(file.id);
      const compSymbol = symbols.find((s) => s.kind === 'class');
      if (compSymbol) {
        componentNameToSymbolId.set(compSymbol.name, compSymbol.symbolId);
      }
    }

    // Resolve component render edges via template usage
    for (const file of svelteFiles) {
      const symbols = ctx.getSymbolsByFile(file.id);
      const compSymbol = symbols.find((s) => s.kind === 'class');
      if (!compSymbol) continue;

      const source = ctx.readFile(file.path);
      if (!source) continue;

      const template = extractTemplate(source);
      const usageRe = new RegExp(COMPONENT_USAGE_RE.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = usageRe.exec(template)) !== null) {
        const childName = match[1];
        const targetSymbolId = componentNameToSymbolId.get(childName);
        if (targetSymbolId && targetSymbolId !== compSymbol.symbolId) {
          edges.push({
            sourceSymbolId: compSymbol.symbolId,
            targetSymbolId,
            edgeType: 'svelte_renders',
            metadata: { component: childName },
          });
        }
      }
    }

    return ok(edges);
  }

  // ── Private extraction methods ──────────────────────────────────────────

  private extractSvelteComponent(filePath: string, source: string, result: FileParseResult): void {
    const scriptContent = extractScriptBlock(source);
    const template = extractTemplate(source);
    const name = componentNameFromPath(filePath);
    const isRouteFile = isSvelteKitRouteFile(filePath);

    // Determine component kind
    let kind: RawComponent['kind'] = 'component';
    const base = path.basename(filePath);
    if (base === '+page.svelte') kind = 'page';
    else if (base === '+layout.svelte') kind = 'layout';
    else if (base === '+error.svelte') kind = 'component';

    // Extract props (export let ...)
    const props: Record<string, unknown> = {};
    const propsRe = new RegExp(EXPORT_LET_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = propsRe.exec(scriptContent)) !== null) {
      props[match[1]] = { exported: true };
    }

    // Extract slots
    const slots: string[] = [];
    const slotRe = new RegExp(SLOT_RE.source, 'g');
    while ((match = slotRe.exec(source)) !== null) {
      slots.push(match[1] ?? 'default');
    }

    // Extract dispatched events
    const emits: string[] = [];
    const dispatchRe = new RegExp(DISPATCH_RE.source, 'g');
    while ((match = dispatchRe.exec(scriptContent)) !== null) {
      if (!emits.includes(match[1])) {
        emits.push(match[1]);
      }
    }

    // Extract store subscriptions ($storeName in script or template)
    const composables: string[] = [];
    const storeSeen = new Set<string>();
    const storeRe = new RegExp(STORE_SUB_RE.source, 'g');
    const combined = `${scriptContent}\n${template}`;
    while ((match = storeRe.exec(combined)) !== null) {
      const storeName = match[1];
      // Filter out common non-store $ prefixed items and built-ins
      if (
        storeName &&
        !storeName.startsWith('_') &&
        !BUILTIN_STORE_NAMES.has(storeName) &&
        storeName.length > 1 &&
        !storeSeen.has(storeName)
      ) {
        storeSeen.add(storeName);
        composables.push(`$${storeName}`);
      }
    }

    // Extract imported .svelte components for edge metadata
    const importedComponents: string[] = [];
    const importRe = new RegExp(SVELTE_IMPORT_RE.source, 'g');
    while ((match = importRe.exec(scriptContent)) !== null) {
      importedComponents.push(match[1]);
    }

    // Build the component entry
    const component: RawComponent = {
      name,
      kind,
      framework: 'svelte',
    };
    if (Object.keys(props).length > 0) component.props = props;
    if (emits.length > 0) component.emits = emits;
    if (slots.length > 0) component.slots = slots;
    if (composables.length > 0) component.composables = composables;

    result.components!.push(component);

    // If this is a SvelteKit route page, also emit a route
    if (isRouteFile) {
      const uri = extractRouteUri(filePath);
      result.frameworkRole = 'sveltekit_page';

      if (base === '+page.svelte' || base === '+layout.svelte') {
        result.routes!.push({
          method: 'GET',
          uri,
          metadata: { sveltekit: true, kind: base.replace('.svelte', '') },
        });
      }
    }

    // Emit dispatch edges (component -> event)
    if (emits.length > 0) {
      for (const event of emits) {
        result.edges!.push({
          sourceSymbolId: `${filePath}::${name}`,
          targetSymbolId: `event:${event}`,
          edgeType: 'svelte_dispatches',
          metadata: { event },
        });
      }
    }

    // Emit store usage edges
    if (composables.length > 0) {
      for (const store of composables) {
        result.edges!.push({
          sourceSymbolId: `${filePath}::${name}`,
          targetSymbolId: `store:${store}`,
          edgeType: 'svelte_uses_store',
          metadata: { store },
        });
      }
    }
  }

  private extractSvelteKitServerFile(
    filePath: string,
    source: string,
    result: FileParseResult,
  ): void {
    const base = path.basename(filePath);

    // Only process SvelteKit convention files
    if (!isSvelteKitRouteFile(filePath) && !isSvelteKitHooksFile(filePath)) {
      return;
    }

    const uri = extractRouteUri(filePath);

    // +server.ts — API route handlers (GET, POST, PUT, DELETE, etc.)
    if (/^\+server\.(ts|js)$/.test(base)) {
      result.frameworkRole = 'sveltekit_api';
      const fnRe = new RegExp(EXPORTED_FN_RE.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = fnRe.exec(source)) !== null) {
        const method = match[1];
        if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(method)) {
          result.routes!.push({
            method,
            uri,
            handler: method,
            metadata: { sveltekit: true, kind: '+server' },
          });
        }
      }
      return;
    }

    // +page.server.ts — load function and form actions
    if (/^\+page\.server\.(ts|js)$/.test(base)) {
      result.frameworkRole = 'sveltekit_server';
      const fnRe = new RegExp(EXPORTED_FN_RE.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = fnRe.exec(source)) !== null) {
        const fnName = match[1];
        if (fnName === 'load') {
          result.routes!.push({
            method: 'GET',
            uri,
            handler: 'load',
            metadata: { sveltekit: true, kind: '+page.server', function: 'load' },
          });
        } else if (fnName === 'actions') {
          // Extract named actions from the actions object
          const actionsMatch = ACTIONS_BLOCK_RE.exec(source);
          if (actionsMatch) {
            const actionsBody = actionsMatch[1];
            const actionRe = new RegExp(ACTION_NAME_RE.source, 'g');
            let actionMatch: RegExpExecArray | null;
            while ((actionMatch = actionRe.exec(actionsBody)) !== null) {
              const actionName = actionMatch[1];
              if (actionName === 'async' || actionName === 'function') continue;
              result.routes!.push({
                method: 'POST',
                uri: actionName === 'default' ? uri : `${uri}?/${actionName}`,
                handler: `actions.${actionName}`,
                metadata: { sveltekit: true, kind: '+page.server', action: actionName },
              });
            }
          } else {
            // Fallback: just register a generic POST action
            result.routes!.push({
              method: 'POST',
              uri,
              handler: 'actions',
              metadata: { sveltekit: true, kind: '+page.server', function: 'actions' },
            });
          }
        }
      }
      return;
    }

    // +layout.server.ts — layout load function
    if (/^\+layout\.server\.(ts|js)$/.test(base)) {
      result.frameworkRole = 'sveltekit_layout_server';
      const fnRe = new RegExp(EXPORTED_FN_RE.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = fnRe.exec(source)) !== null) {
        if (match[1] === 'load') {
          result.routes!.push({
            method: 'GET',
            uri,
            handler: 'load',
            metadata: { sveltekit: true, kind: '+layout.server', function: 'load' },
          });
        }
      }
      return;
    }

    // hooks.server.ts / hooks.client.ts
    if (isSvelteKitHooksFile(filePath)) {
      result.frameworkRole = 'sveltekit_hooks';
      result.components!.push({
        name: base.replace(/\.(ts|js)$/, ''),
        kind: 'hook',
        framework: 'svelte',
      });
    }
  }
}
