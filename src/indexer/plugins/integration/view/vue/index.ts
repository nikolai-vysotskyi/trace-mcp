import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { resolveComponentTag, toKebabCase, toPascalCase } from './resolver.js';

/** Detects Nuxt 3/4 + Laravel Nova framework-loaded entry points. */
export function isNuxtEntryPoint(filePath: string): boolean {
  return (
    // Nuxt 3/4: (app/)? pages/, layouts/, error.vue, app.vue.
    /(?:^|\/)app\/pages\//.test(filePath) ||
    /(?:^|\/)app\/layouts\//.test(filePath) ||
    /(?:^|\/)app\/error\.vue$/.test(filePath) ||
    /(?:^|\/)app\/app\.vue$/.test(filePath) ||
    /(?:^|\/)pages\//.test(filePath) ||
    /(?:^|\/)layouts\//.test(filePath) ||
    /(?:^|\/)error\.vue$/.test(filePath) ||
    /(?:^|\/)app\.vue$/.test(filePath) ||
    // Laravel Nova components: compiled by Laravel Mix, registered via
    // PHP ServiceProvider::boot() using Nova::script/style/component by
    // file path. Not referenced by name in JS/Vue code.
    /(?:^|\/)nova-components\/[^/]+\/resources\/js\//.test(filePath) ||
    // Laravel Blade-side Vue components (resources/js/components, etc.)
    // are typically registered globally in app.js bootstrap.
    /(?:^|\/)resources\/(?:js|assets\/js)\/components\//.test(filePath)
  );
}

export function classifyNuxtEntry(filePath: string): string {
  if (/(?:^|\/)app\/pages\//.test(filePath) || /(?:^|\/)pages\//.test(filePath)) return 'page';
  if (/(?:^|\/)app\/layouts\//.test(filePath) || /(?:^|\/)layouts\//.test(filePath))
    return 'layout';
  if (/error\.vue$/.test(filePath)) return 'error';
  if (/app\.vue$/.test(filePath)) return 'app_root';
  if (/nova-components\//.test(filePath)) return 'nova_component';
  if (/resources\/(?:js|assets\/js)\/components\//.test(filePath)) return 'laravel_component';
  return 'unknown';
}

/** Common single-word component names that produce too many false positives. */
const GENERIC_COMPONENT_NAMES = new Set([
  'Button',
  'Link',
  'Input',
  'Form',
  'Card',
  'Modal',
  'Page',
  'App',
  'Header',
  'Footer',
  'Layout',
  'Section',
  'Container',
  'Wrapper',
  'Item',
  'List',
  'Menu',
  'Tab',
  'Tabs',
  'Icon',
  'Image',
  'Avatar',
  'Badge',
  'Alert',
  'Toast',
  'Spinner',
  'Loader',
  'Table',
  'Row',
  'Cell',
  'Panel',
  'Error',
  'Success',
  'Warning',
  'Info',
  'Dialog',
  'Tooltip',
  'Popover',
  'Index',
  'Main',
  'Default',
  'Root',
  'Home',
]);

/**
 * Decide whether a component name is distinctive enough to scan for as
 * a string/identifier reference. Generic single-word names produce too
 * many false positives (e.g., `Button` matches everywhere).
 */
function isDistinctiveComponentName(name: string): boolean {
  if (name.length < 5) return false;
  if (GENERIC_COMPONENT_NAMES.has(name)) return false;
  // Must be PascalCase — start with uppercase, have at least one lowercase
  // letter before another uppercase (camelHump) or be long enough to be unique.
  if (!/^[A-Z]/.test(name)) return false;
  return /[a-z][A-Z]/.test(name) || name.length >= 8;
}

/** Detect @vue/server-renderer usage (SSR entry points). */
const VUE_SSR_IMPORT_RE = /(?:from|require\()\s*['"]@vue\/server-renderer['"]/;
const VUE_SSR_CALL_RE =
  /\b(?:renderToString|renderToWebStream|renderToNodeStream|renderToSimpleStream|pipeToWebWritable|pipeToNodeWritable)\s*\(/;

export class VueFrameworkPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'vue-framework',
    version: '1.0.0',
    priority: 10,
    category: 'view',
    dependencies: [],
  };

  /** Cached Nuxt component config, populated per resolveEdges run. */
  private _nuxtConfigCache: NuxtComponentPathConfig[] = [];

  private loadNuxtComponentConfig(
    ctx: ResolveContext,
    allFiles: { id: number; path: string; language: string | null }[],
  ): NuxtComponentPathConfig[] {
    for (const f of allFiles) {
      const name = f.path.split('/').pop() ?? '';
      if (name === 'nuxt.config.ts' || name === 'nuxt.config.js' || name === 'nuxt.config.mjs') {
        const source = ctx.readFile(f.path);
        if (source) {
          const parsed = parseNuxtComponentsConfig(source);
          if (parsed.length > 0) {
            this._nuxtConfigCache = parsed;
            return parsed;
          }
        }
      }
    }
    this._nuxtConfigCache = [];
    return [];
  }

  detect(ctx: ProjectContext): boolean {
    const hasVueFramework = (deps: Record<string, string> | undefined): boolean => {
      if (!deps) return false;
      return (
        'vue' in deps ||
        'nuxt' in deps ||
        'nuxt3' in deps ||
        '@nuxt/core' in deps ||
        '@vue/compiler-sfc' in deps ||
        '@vue/server-renderer' in deps ||
        'vite-plugin-vue' in deps ||
        'quasar' in deps ||
        '@quasar/app' in deps ||
        'vitepress' in deps ||
        'vuepress' in deps ||
        '@vuepress/core' in deps ||
        'laravel-nova' in deps ||
        'laravel-mix' in deps
      );
    };

    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if (hasVueFramework(deps)) return true;
    }

    // Fallback 1: read package.json directly from rootPath
    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content) as Record<string, unknown>;
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      if (hasVueFramework(deps)) return true;
    } catch {
      /* ignore */
    }

    // Fallback 2: presence of nova-components/ dir (Laravel Nova package)
    // or any .vue files in the project — common for Laravel+Nova projects
    // whose root package.json omits vue but they ship Vue bundles.
    try {
      const novaDir = path.join(ctx.rootPath, 'nova-components');
      if (fs.existsSync(novaDir) && fs.statSync(novaDir).isDirectory()) return true;
    } catch {
      /* ignore */
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'renders_component',
          category: 'vue',
          description: 'Parent component renders child in template',
        },
        {
          name: 'uses_composable',
          category: 'vue',
          description: 'Component calls a composable function',
        },
        { name: 'provides_slot', category: 'vue', description: 'Component provides a named slot' },
        {
          name: 'references_component',
          category: 'vue',
          description: 'Dynamic reference to component (e.g., from config/TS)',
        },
        {
          name: 'nuxt_entry_point',
          category: 'vue',
          description:
            'Nuxt 3/4 file-based auto-loaded entry point (pages, layouts, error.vue, app.vue, middleware, plugins)',
        },
        {
          name: 'vue_ssr_entry',
          category: 'vue',
          description: '@vue/server-renderer SSR entry point',
        },
      ],
    };
  }

  extractNodes(
    _filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    // The VueLanguagePlugin already extracts symbols and components.
    // Framework-level resolution happens in resolveEdges.
    const result: FileParseResult = { status: 'ok', symbols: [] };

    // Lightweight marker for @vue/server-renderer entry points.
    if (['typescript', 'javascript', 'vue'].includes(language)) {
      const source = content.toString('utf-8');
      if (VUE_SSR_IMPORT_RE.test(source) || VUE_SSR_CALL_RE.test(source)) {
        result.frameworkRole = 'vue_ssr_renderer';
      }
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    const vueFiles = allFiles.filter((f) => f.path.endsWith('.vue'));
    const composableFiles = allFiles.filter(
      (f) => (f.path.endsWith('.ts') || f.path.endsWith('.js')) && /\/use[A-Z]/.test(f.path),
    );

    // Parse Nuxt component configuration from nuxt.config.ts/js (if any)
    const nuxtComponentConfigs = this.loadNuxtComponentConfig(ctx, allFiles);

    // Map component name -> symbolId for all .vue files.
    // Registers the base name plus Nuxt 3/4 path-based auto-import aliases
    // so <FormsCheckboxInput /> resolves to components/forms/CheckboxInput.vue.
    const componentNameToSymbolId = new Map<string, string>();
    const componentNameToFilePath = new Map<string, string>();

    for (const file of vueFiles) {
      const symbols = ctx.getSymbolsByFile(file.id);
      const compSymbol = symbols.find((s) => s.kind === 'class');
      if (!compSymbol) continue;
      componentNameToSymbolId.set(compSymbol.name, compSymbol.symbolId);
      componentNameToFilePath.set(compSymbol.name, file.path);
      // Nuxt auto-import aliases (FormCheckboxInput, IconArrow, etc.)
      for (const alias of nuxtAutoImportAliases(file.path, nuxtComponentConfigs)) {
        if (!componentNameToSymbolId.has(alias)) {
          componentNameToSymbolId.set(alias, compSymbol.symbolId);
          componentNameToFilePath.set(alias, file.path);
        }
      }
    }

    // Map composable function name -> symbolId
    const composableNameToSymbolId = new Map<string, string>();
    for (const file of composableFiles) {
      const symbols = ctx.getSymbolsByFile(file.id);
      for (const sym of symbols) {
        if (sym.kind === 'function' && sym.name.startsWith('use')) {
          composableNameToSymbolId.set(sym.name, sym.symbolId);
        }
      }
    }

    // For each .vue file, resolve template components and composables
    for (const file of vueFiles) {
      const symbols = ctx.getSymbolsByFile(file.id);
      const compSymbol = symbols.find((s) => s.kind === 'class');
      if (!compSymbol) continue;

      const metadata = compSymbol.metadata as Record<string, unknown> | null | undefined;
      const templateComponents = (metadata?.templateComponents as string[]) ?? [];
      const composables = (metadata?.composables as string[]) ?? [];

      const importMap = this.buildImportMap(ctx, file);

      // Resolve renders_component edges
      for (const tag of templateComponents) {
        // Try direct name lookup first (tag IS the component name, PascalCase or kebab)
        let targetSymbolId =
          componentNameToSymbolId.get(tag) ??
          componentNameToSymbolId.get(toPascalCase(tag)) ??
          componentNameToSymbolId.get(toKebabCase(tag));

        if (!targetSymbolId) {
          // Fall back to file-path-based resolution (imports + componentFiles map)
          const targetPath = resolveComponentTag(tag, importMap, componentNameToFilePath);
          if (!targetPath) continue;
          const targetName = targetPath
            .split('/')
            .pop()
            ?.replace(/\.vue$/, '');
          if (!targetName) continue;
          targetSymbolId = componentNameToSymbolId.get(targetName);
          if (!targetSymbolId) continue;
        }

        edges.push({
          sourceSymbolId: compSymbol.symbolId,
          targetSymbolId,
          edgeType: 'renders_component',
          metadata: { tag },
        });
      }

      // Resolve uses_composable edges
      for (const composableName of composables) {
        const targetSymbolId = composableNameToSymbolId.get(composableName);
        if (!targetSymbolId) continue;

        edges.push({
          sourceSymbolId: compSymbol.symbolId,
          targetSymbolId,
          edgeType: 'uses_composable',
          metadata: { composable: composableName },
        });
      }
    }

    // Dynamic component references: scan TS/JS files for component names
    // mentioned as identifiers/strings (e.g., in config files, route tables,
    // plugin registrations). Covers cases where a component isn't rendered
    // via <Tag/> but IS referenced dynamically.
    this.resolveDynamicComponentRefs(ctx, allFiles, componentNameToSymbolId, edges);

    // Nuxt entry points: pages, layouts, error.vue, app.vue are auto-loaded
    // by Nuxt's file-based router. They're not referenced explicitly in
    // user code, so emit a synthetic edge to mark them as connected.
    this.markNuxtEntryPoints(ctx, vueFiles, edges);

    return ok(edges);
  }

  /**
   * Mark Nuxt 3/4 file-based entry points (pages, layouts, error.vue, app.vue)
   * with a nuxt_entry_point edge from the file to the component symbol.
   * These are auto-loaded by the Nuxt runtime and never referenced by code.
   */
  private markNuxtEntryPoints(
    ctx: ResolveContext,
    vueFiles: { id: number; path: string; language: string | null }[],
    edges: RawEdge[],
  ): void {
    for (const file of vueFiles) {
      if (!isNuxtEntryPoint(file.path)) continue;
      const symbols = ctx.getSymbolsByFile(file.id);
      const compSymbol = symbols.find((s) => s.kind === 'class');
      if (!compSymbol) continue;
      edges.push({
        sourceNodeType: 'file',
        sourceRefId: file.id,
        targetSymbolId: compSymbol.symbolId,
        edgeType: 'nuxt_entry_point',
        metadata: { entryType: classifyNuxtEntry(file.path) },
      });
    }
  }

  /**
   * Scan TS/JS files for references to Vue component names.
   * Emits `references_component` edges from the referring file to the
   * component symbol when a component name appears as a whole word.
   *
   * Filters out short or common names (e.g. "Button", "Link") to avoid
   * false positives — only PascalCase names ≥5 chars with a distinctive
   * prefix or camelHump are considered references.
   */
  private resolveDynamicComponentRefs(
    ctx: ResolveContext,
    allFiles: { id: number; path: string; language: string | null }[],
    componentNameToSymbolId: Map<string, string>,
    edges: RawEdge[],
  ): void {
    // Only consider distinctive component names.
    const names = [...componentNameToSymbolId.keys()].filter(isDistinctiveComponentName);
    if (names.length === 0) return;

    // Build a single anchored regex: \b(Name1|Name2|...)\b
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`\\b(${escaped.join('|')})\\b`, 'g');

    // Map component name → own file path (to skip self-references).
    const nameToOwnFile = new Map<string, string>();
    for (const [name] of componentNameToSymbolId) {
      // Pull from earlier-built map — defensive access is cheap.
      const symbolId = componentNameToSymbolId.get(name);
      if (!symbolId) continue;
      const ownFile = symbolId.split('::')[0];
      if (ownFile) nameToOwnFile.set(name, ownFile);
    }

    for (const file of allFiles) {
      // Scan TS/JS (config, routes, plugins) and Vue (sibling imports).
      const lang = file.language;
      if (lang !== 'typescript' && lang !== 'javascript' && lang !== 'vue') continue;

      const source = ctx.readFile(file.path);
      if (!source) continue;

      const found = new Set<string>();
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        found.add(m[1]);
      }

      for (const name of found) {
        // Skip the component's own file
        if (nameToOwnFile.get(name) === file.path) continue;
        const targetSymbolId = componentNameToSymbolId.get(name);
        if (!targetSymbolId) continue;
        edges.push({
          sourceNodeType: 'file',
          sourceRefId: file.id,
          targetSymbolId,
          edgeType: 'references_component',
          metadata: { name, kind: 'dynamic_ref' },
        });
      }
    }
  }

  /**
   * Build a map of component name -> file path for all known .vue files.
   * Registers PascalCase and kebab-case variants, plus Nuxt 3/4
   * path-based auto-import aliases (components/forms/CheckboxInput.vue
   * → FormsCheckboxInput, forms-checkbox-input).
   */
  private buildImportMap(
    ctx: ResolveContext,
    currentFile: { id: number; path: string },
  ): Map<string, string> {
    const importMap = new Map<string, string>();
    const allFiles = ctx.getAllFiles();

    for (const f of allFiles) {
      if (!f.path.endsWith('.vue') || f.path === currentFile.path) continue;
      const compName = f.path
        .split('/')
        .pop()
        ?.replace(/\.vue$/, '');
      if (!compName) continue;

      // Base name + case variants
      importMap.set(compName, f.path);
      importMap.set(toKebabCase(compName), f.path);
      importMap.set(toPascalCase(compName), f.path);

      // Nuxt 3/4 auto-import path-prefixed aliases
      // (FormCheckboxInput, IconsArrow, etc.)
      for (const alias of nuxtAutoImportAliases(f.path, this._nuxtConfigCache)) {
        importMap.set(alias, f.path);
        importMap.set(toKebabCase(alias), f.path);
      }
    }

    return importMap;
  }
}

/**
 * Parsed Nuxt component configuration entry.
 * Mirrors the shape of `nuxt.config.components[]`.
 */
interface NuxtComponentPathConfig {
  /** The directory path (e.g., '~/components/forms' or 'components/forms') */
  path: string;
  /** Custom prefix to prepend (e.g., 'Form'). Default: path-based. */
  prefix?: string;
  /** If false, disables Nuxt's default directory-path prefix. */
  pathPrefix?: boolean;
}

/**
 * Parse `components: [...]` config from nuxt.config.ts/js source.
 * Uses a lenient regex-based extractor since we can't run a TS compiler.
 * Returns an empty array if no configuration is detected.
 */
export function parseNuxtComponentsConfig(source: string): NuxtComponentPathConfig[] {
  // Find `components: [ ... ]` at top level (heuristic).
  const configMatch = source.match(/\bcomponents\s*:\s*\[([\s\S]*?)\]\s*,/);
  if (!configMatch) return [];
  const body = configMatch[1];

  const entries: NuxtComponentPathConfig[] = [];
  // Match each `{ ... }` object literal
  const objRe = /\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(body)) !== null) {
    const objBody = m[1];
    const pathMatch = objBody.match(/\bpath\s*:\s*['"]([^'"]+)['"]/);
    if (!pathMatch) continue;
    const prefixMatch = objBody.match(/\bprefix\s*:\s*['"]([^'"]+)['"]/);
    const pathPrefixMatch = objBody.match(/\bpathPrefix\s*:\s*(true|false)/);
    entries.push({
      path: pathMatch[1],
      prefix: prefixMatch?.[1],
      pathPrefix: pathPrefixMatch ? pathPrefixMatch[1] === 'true' : undefined,
    });
  }
  return entries;
}

/**
 * Generate Nuxt 3/4 auto-import aliases for a component file.
 * Defaults to directory-based prefix; if a nuxt.config entry matches the
 * component's directory, uses its custom prefix and pathPrefix setting.
 *
 * Examples (default):
 *   components/AppCard.vue                → [AppCard]
 *   components/forms/CheckboxInput.vue    → [CheckboxInput, FormsCheckboxInput]
 *   components/guides/2026/Item.vue       → [Item, Guides2026Item]
 *
 * Examples (with `{ path: '~/components/forms', prefix: 'Form', pathPrefix: false }`):
 *   components/forms/CheckboxInput.vue    → [CheckboxInput, FormCheckboxInput]
 */
export function nuxtAutoImportAliases(
  filePath: string,
  configs: NuxtComponentPathConfig[] = [],
): string[] {
  const parts = filePath.split('/');
  const idx = parts.lastIndexOf('components');
  if (idx === -1) return [];
  const afterComponents = parts.slice(idx + 1);
  const last = afterComponents[afterComponents.length - 1]?.replace(/\.vue$/, '');
  if (!last) return [];
  const prefixSegments = afterComponents.slice(0, -1);
  const fileNamePascal = toPascalCase(last);

  // Match most-specific config entry (longest matching path)
  const normalizedPath = filePath.replace(/^.*?\/components\//, 'components/');
  let matched: NuxtComponentPathConfig | null = null;
  let matchedLen = 0;
  for (const cfg of configs) {
    const cfgPath = cfg.path.replace(/^~\//, '').replace(/^\.\//, '');
    if (normalizedPath.startsWith(`${cfgPath}/`) || normalizedPath.startsWith(cfgPath)) {
      if (cfgPath.length > matchedLen) {
        matched = cfg;
        matchedLen = cfgPath.length;
      }
    }
  }

  const aliases: string[] = [];

  // Aliases with path-based prefix (Nuxt default)
  if (!matched || matched.pathPrefix !== false) {
    const pathPrefixSegments: string[] = [];
    for (const seg of prefixSegments) {
      const pascal = toPascalCase(seg);
      if (!last.startsWith(pascal)) pathPrefixSegments.push(pascal);
    }
    if (pathPrefixSegments.length > 0) {
      aliases.push(pathPrefixSegments.join('') + fileNamePascal);
    }
  }

  // Aliases with custom prefix
  if (matched?.prefix) {
    const customPrefix = toPascalCase(matched.prefix);
    if (!last.startsWith(customPrefix)) {
      aliases.push(customPrefix + fileNamePascal);
    } else {
      aliases.push(fileNamePascal);
    }
  } else if (prefixSegments.length > 0) {
    // Heuristic fallback: also generate singularized path-prefix variant
    // (forms → Form, icons → Icon). Catches common custom-prefix patterns
    // even when we can't parse the Nuxt config.
    const singular: string[] = [];
    for (const seg of prefixSegments) {
      const pascal = toPascalCase(seg);
      const singularized = pascal.endsWith('s') ? pascal.slice(0, -1) : pascal;
      if (!last.startsWith(singularized)) singular.push(singularized);
    }
    if (singular.length > 0) {
      const alias = singular.join('') + fileNamePascal;
      if (!aliases.includes(alias)) aliases.push(alias);
    }
  }

  return aliases;
}
