import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../plugin-api/types.js';
import { resolveComponentTag, toKebabCase, toPascalCase } from './resolver.js';

export class VueFrameworkPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'vue-framework',
    version: '1.0.0',
    priority: 10,
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

    return ok(edges);
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
