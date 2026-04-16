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
import { resolveComponentTag, toKebabCase, toPascalCase } from './resolver.js';

/** Common single-word component names that produce too many false positives. */
const GENERIC_COMPONENT_NAMES = new Set([
  'Button', 'Link', 'Input', 'Form', 'Card', 'Modal', 'Page', 'App',
  'Header', 'Footer', 'Layout', 'Section', 'Container', 'Wrapper', 'Item',
  'List', 'Menu', 'Tab', 'Tabs', 'Icon', 'Image', 'Avatar', 'Badge',
  'Alert', 'Toast', 'Spinner', 'Loader', 'Table', 'Row', 'Cell', 'Panel',
  'Error', 'Success', 'Warning', 'Info', 'Dialog', 'Tooltip', 'Popover',
  'Index', 'Main', 'Default', 'Root', 'Home',
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

export class VueFrameworkPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'vue-framework',
    version: '1.0.0',
    priority: 10,
    category: 'view',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      return 'vue' in deps;
    }

    // Fallback: try reading package.json from rootPath
    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content) as Record<string, unknown>;
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return 'vue' in deps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'renders_component', category: 'vue', description: 'Parent component renders child in template' },
        { name: 'uses_composable', category: 'vue', description: 'Component calls a composable function' },
        { name: 'provides_slot', category: 'vue', description: 'Component provides a named slot' },
        { name: 'references_component', category: 'vue', description: 'Dynamic reference to component (e.g., from config/TS)' },
      ],
    };
  }

  extractNodes(
    _filePath: string,
    _content: Buffer,
    _language: string,
  ): TraceMcpResult<FileParseResult> {
    // The VueLanguagePlugin already extracts symbols and components.
    // Framework-level resolution happens in resolveEdges.
    return ok({ status: 'ok', symbols: [] });
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    const vueFiles = allFiles.filter((f) => f.path.endsWith('.vue'));
    const composableFiles = allFiles.filter(
      (f) => (f.path.endsWith('.ts') || f.path.endsWith('.js')) && /\/use[A-Z]/.test(f.path),
    );

    // Map component name -> symbolId for all .vue files
    const componentNameToSymbolId = new Map<string, string>();
    const componentNameToFilePath = new Map<string, string>();

    for (const file of vueFiles) {
      const symbols = ctx.getSymbolsByFile(file.id);
      const compSymbol = symbols.find((s) => s.kind === 'class');
      if (compSymbol) {
        componentNameToSymbolId.set(compSymbol.name, compSymbol.symbolId);
        componentNameToFilePath.set(compSymbol.name, file.path);
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
        const targetPath = resolveComponentTag(tag, importMap, componentNameToFilePath);
        if (!targetPath) continue;

        const targetName = targetPath.split('/').pop()?.replace(/\.vue$/, '');
        if (!targetName) continue;

        const targetSymbolId = componentNameToSymbolId.get(targetName);
        if (!targetSymbolId) continue;

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

    return ok(edges);
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
   * Registers PascalCase and kebab-case variants for each component.
   */
  private buildImportMap(
    ctx: ResolveContext,
    currentFile: { id: number; path: string },
  ): Map<string, string> {
    const importMap = new Map<string, string>();
    const allFiles = ctx.getAllFiles();

    for (const f of allFiles) {
      if (!f.path.endsWith('.vue') || f.path === currentFile.path) continue;
      const compName = f.path.split('/').pop()?.replace(/\.vue$/, '');
      if (!compName) continue;

      importMap.set(compName, f.path);
      importMap.set(toKebabCase(compName), f.path);
      importMap.set(toPascalCase(compName), f.path);
    }

    return importMap;
  }
}
