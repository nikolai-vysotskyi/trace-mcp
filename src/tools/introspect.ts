/**
 * Introspection tools — primarily useful for developing trace-mcp itself.
 *
 * Tools:
 *   get_implementations  — find all TypeScript classes/interfaces that
 *                          extend or implement a given name.
 *   get_api_surface      — list all exported symbols grouped by file.
 *   get_plugin_registry  — list registered plugins, their manifests,
 *                          and all known edge types.
 */
import type { Store, SymbolWithFilePath } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';

// ---------------------------------------------------------------------------
// get_implementations
// ---------------------------------------------------------------------------

export interface ImplementorItem {
  symbol_id: string;
  name: string;
  kind: string;
  signature: string | null;
  file: string;
  line: number | null;
  relation: 'implements' | 'extends';
  /** raw metadata.implements / metadata.extends value */
  via: string | string[];
}

export interface GetImplementationsResult {
  target: string;
  implementors: ImplementorItem[];
  total: number;
}

export function getImplementations(
  store: Store,
  name: string,
): GetImplementationsResult {
  const rows = store.findImplementors(name);

  const implementors: ImplementorItem[] = rows.map((row) => {
    const meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
    const imp = meta['implements'];
    const ext = meta['extends'];

    // Determine whether this is an implements or extends relation
    let relation: 'implements' | 'extends' = 'extends';
    let via: string | string[] = ext as string | string[];
    if (Array.isArray(imp) && imp.includes(name)) {
      relation = 'implements';
      via = imp;
    }

    return {
      symbol_id: row.symbol_id,
      name: row.name,
      kind: row.kind,
      signature: row.signature,
      file: row.file_path,
      line: row.line_start,
      relation,
      via,
    };
  });

  return { target: name, implementors, total: implementors.length };
}

// ---------------------------------------------------------------------------
// get_api_surface
// ---------------------------------------------------------------------------

export interface ApiSurfaceSymbol {
  symbol_id: string;
  name: string;
  kind: string;
  signature: string | null;
  line: number | null;
  default: boolean;
}

export interface ApiSurfaceFile {
  file: string;
  exports: ApiSurfaceSymbol[];
}

export interface GetApiSurfaceResult {
  file_pattern: string | null;
  files: ApiSurfaceFile[];
  total_symbols: number;
}

export function getApiSurface(
  store: Store,
  filePattern?: string,
): GetApiSurfaceResult {
  const rows = store.getExportedSymbols(filePattern);

  // Group by file
  const byFile = new Map<string, ApiSurfaceSymbol[]>();
  for (const row of rows) {
    const meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
    const sym: ApiSurfaceSymbol = {
      symbol_id: row.symbol_id,
      name: row.name,
      kind: row.kind,
      signature: row.signature,
      line: row.line_start,
      default: Boolean(meta['default']),
    };
    const list = byFile.get(row.file_path) ?? [];
    list.push(sym);
    byFile.set(row.file_path, list);
  }

  const files: ApiSurfaceFile[] = [];
  for (const [file, exports] of byFile) {
    files.push({ file, exports });
  }

  return {
    file_pattern: filePattern ?? null,
    files,
    total_symbols: rows.length,
  };
}

// ---------------------------------------------------------------------------
// get_plugin_registry
// ---------------------------------------------------------------------------

export interface LanguagePluginInfo {
  name: string;
  version: string;
  priority: number;
  extensions: string[];
}

export interface FrameworkPluginInfo {
  name: string;
  version: string;
  priority: number;
  dependencies: string[];
  active: boolean;
}

export interface EdgeTypeInfo {
  name: string;
  category: string;
  description: string;
}

export interface GetPluginRegistryResult {
  language_plugins: LanguagePluginInfo[];
  framework_plugins: FrameworkPluginInfo[];
  edge_types: EdgeTypeInfo[];
  active_frameworks: string[];
}

export function getPluginRegistry(
  store: Store,
  registry: PluginRegistry,
  activeFrameworkNames: Set<string>,
): GetPluginRegistryResult {
  const languagePlugins: LanguagePluginInfo[] = registry
    .getLanguagePlugins()
    .map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
      priority: p.manifest.priority,
      extensions: p.supportedExtensions,
    }));

  const frameworkPlugins: FrameworkPluginInfo[] = registry
    .getAllFrameworkPlugins()
    .map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
      priority: p.manifest.priority,
      dependencies: p.manifest.dependencies ?? [],
      active: activeFrameworkNames.has(p.manifest.name),
    }));

  const edgeTypes = store.getEdgeTypes();

  return {
    language_plugins: languagePlugins,
    framework_plugins: frameworkPlugins,
    edge_types: edgeTypes,
    active_frameworks: [...activeFrameworkNames].sort(),
  };
}
