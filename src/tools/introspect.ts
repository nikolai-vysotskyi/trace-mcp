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
import type { Store, SymbolWithFilePath, SymbolRow } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import { getCouplingMetrics, getDependencyCycles } from './graph-analysis.js';

/** Matches paths inside test fixture directories (sample projects, not real code). */
const TEST_FIXTURE_RE = /(?:^|\/)(?:tests?|__tests__|spec)\/fixtures?\//;

/** Safely parse JSON metadata — returns empty object on malformed input. */
function safeParseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

// ---------------------------------------------------------------------------
// get_implementations
// ---------------------------------------------------------------------------

interface ImplementorItem {
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

interface GetImplementationsResult {
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
    const meta = safeParseMeta(row.metadata);
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

interface ApiSurfaceSymbol {
  symbol_id: string;
  name: string;
  kind: string;
  signature: string | null;
  line: number | null;
  default: boolean;
}

interface ApiSurfaceFile {
  file: string;
  exports: ApiSurfaceSymbol[];
}

interface GetApiSurfaceResult {
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
    const meta = safeParseMeta(row.metadata);
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

interface LanguagePluginInfo {
  name: string;
  version: string;
  priority: number;
  extensions: string[];
}

interface FrameworkPluginInfo {
  name: string;
  version: string;
  priority: number;
  dependencies: string[];
  active: boolean;
}

interface EdgeTypeInfo {
  name: string;
  category: string;
  description: string;
}

interface GetPluginRegistryResult {
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

// ---------------------------------------------------------------------------
// get_type_hierarchy
// ---------------------------------------------------------------------------

interface HierarchyNode {
  name: string;
  kind: string;
  symbol_id: string;
  file: string;
  line: number | null;
  relation: 'root' | 'extends' | 'implements';
  children: HierarchyNode[];
}

interface GetTypeHierarchyResult {
  root: string;
  ancestors: HierarchyNode[];
  descendants: HierarchyNode[];
}

/**
 * Walk TypeScript class/interface hierarchy up (ancestors) and down (descendants).
 * Uses metadata.extends / metadata.implements stored by the TypeScript plugin.
 */
export function getTypeHierarchy(
  store: Store,
  name: string,
  maxDepth = 10,
): GetTypeHierarchyResult {
  // Walk UP: follow extends chain
  const ancestors: HierarchyNode[] = [];
  walkAncestors(store, name, ancestors, new Set(), maxDepth);

  // Walk DOWN: find implementors/subclasses recursively
  const descendants: HierarchyNode[] = [];
  walkDescendants(store, name, descendants, new Set(), maxDepth);

  return { root: name, ancestors, descendants };
}

function walkAncestors(
  store: Store,
  name: string,
  result: HierarchyNode[],
  visited: Set<string>,
  depth: number,
): void {
  if (depth <= 0 || visited.has(name)) return;
  visited.add(name);

  // Find the symbol by name
  const sym = store.getSymbolByName(name, 'class') ?? store.getSymbolByName(name, 'interface');
  if (!sym) return;

  const meta = sym.metadata ? (JSON.parse(sym.metadata) as Record<string, unknown>) : {};
  const ext = meta['extends'];
  const extNames = Array.isArray(ext) ? ext as string[] : typeof ext === 'string' ? [ext] : [];
  const implNames = Array.isArray(meta['implements']) ? meta['implements'] as string[] : [];

  const file = store.getFileById(sym.file_id);

  for (const parentName of extNames) {
    const node: HierarchyNode = {
      name: parentName,
      kind: 'unknown',
      symbol_id: '',
      file: '',
      line: null,
      relation: 'extends',
      children: [],
    };
    // Try to resolve the parent
    const parentSym = store.getSymbolByName(parentName, 'class') ?? store.getSymbolByName(parentName, 'interface');
    if (parentSym) {
      const parentFile = store.getFileById(parentSym.file_id);
      node.kind = parentSym.kind;
      node.symbol_id = parentSym.symbol_id;
      node.file = parentFile?.path ?? '';
      node.line = parentSym.line_start;
    }
    result.push(node);
    walkAncestors(store, parentName, node.children, visited, depth - 1);
  }

  for (const ifaceName of implNames) {
    const node: HierarchyNode = {
      name: ifaceName,
      kind: 'interface',
      symbol_id: '',
      file: '',
      line: null,
      relation: 'implements',
      children: [],
    };
    const ifaceSym = store.getSymbolByName(ifaceName, 'interface');
    if (ifaceSym) {
      const ifaceFile = store.getFileById(ifaceSym.file_id);
      node.symbol_id = ifaceSym.symbol_id;
      node.file = ifaceFile?.path ?? '';
      node.line = ifaceSym.line_start;
    }
    result.push(node);
    walkAncestors(store, ifaceName, node.children, visited, depth - 1);
  }
}

function walkDescendants(
  store: Store,
  name: string,
  result: HierarchyNode[],
  visited: Set<string>,
  depth: number,
): void {
  if (depth <= 0 || visited.has(name)) return;
  visited.add(name);

  const implementors = store.findImplementors(name);

  for (const row of implementors) {
    const meta = safeParseMeta(row.metadata);
    const impl = meta['implements'];
    const ext = meta['extends'];

    let relation: 'extends' | 'implements' = 'extends';
    if (Array.isArray(impl) && (impl as string[]).includes(name)) {
      relation = 'implements';
    }

    const node: HierarchyNode = {
      name: row.name,
      kind: row.kind,
      symbol_id: row.symbol_id,
      file: row.file_path,
      line: row.line_start,
      relation,
      children: [],
    };
    result.push(node);
    walkDescendants(store, row.name, node.children, visited, depth - 1);
  }
}

// ---------------------------------------------------------------------------
// get_dead_exports
// ---------------------------------------------------------------------------

interface DeadExportItem {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
}

interface GetDeadExportsResult {
  file_pattern: string | null;
  dead_exports: DeadExportItem[];
  total_exports: number;
  total_dead: number;
}

/**
 * Find exported symbols that are never imported by any other file.
 * Cross-references exported symbols with import edge metadata (specifiers).
 * An export is "dead" if its name never appears as a specifier in any import edge.
 */
export function getDeadExports(
  store: Store,
  filePattern?: string,
): GetDeadExportsResult {
  const exported = store.getExportedSymbols(filePattern)
    .filter((s) => !TEST_FIXTURE_RE.test(s.file_path));

  // Build a set of all imported specifier names across the entire project
  const importedNames = new Set<string>();
  const importEdges = store.getEdgesByType('imports');
  for (const edge of importEdges) {
    if (!edge.metadata) continue;
    const meta = typeof edge.metadata === 'string'
      ? JSON.parse(edge.metadata) as Record<string, unknown>
      : edge.metadata as Record<string, unknown>;
    const specifiers = meta['specifiers'];
    if (Array.isArray(specifiers)) {
      for (const s of specifiers) {
        if (typeof s === 'string') {
          // Handle "* as name" → add "name"
          const clean = s.startsWith('* as ') ? s.slice(5) : s;
          importedNames.add(clean);
        }
      }
    }
  }

  const dead: DeadExportItem[] = [];
  for (const sym of exported) {
    // Skip methods (their export is inherited from the class)
    if (sym.kind === 'method') continue;
    if (!importedNames.has(sym.name)) {
      dead.push({
        symbol_id: sym.symbol_id,
        name: sym.name,
        kind: sym.kind,
        file: sym.file_path,
        line: sym.line_start,
      });
    }
  }

  return {
    file_pattern: filePattern ?? null,
    dead_exports: dead,
    total_exports: exported.filter((s) => s.kind !== 'method').length,
    total_dead: dead.length,
  };
}

// ---------------------------------------------------------------------------
// get_import_graph
// ---------------------------------------------------------------------------

interface DependencyEdge {
  source: string;
  target: string;
  specifiers: string[];
}

interface GetDependencyGraphResult {
  file: string;
  imports: DependencyEdge[];
  imported_by: DependencyEdge[];
}

/**
 * Show file-level dependency graph: what a file imports and what imports it.
 * Requires ESM import edges (resolved by the pipeline in Pass 2d).
 */
export function getDependencyGraph(
  store: Store,
  filePath: string,
): GetDependencyGraphResult {
  const file = store.getFile(filePath);
  if (!file) {
    return { file: filePath, imports: [], imported_by: [] };
  }

  const nodeId = store.getNodeId('file', file.id);
  if (nodeId == null) {
    return { file: filePath, imports: [], imported_by: [] };
  }

  // Fetch all edges for this node, then batch-resolve targets/sources
  const outgoing = store.getOutgoingEdges(nodeId).filter((e) => e.edge_type_name === 'imports');
  const incoming = store.getIncomingEdges(nodeId).filter((e) => e.edge_type_name === 'imports');

  // Batch resolve all referenced node IDs
  const allRefNodeIds = [
    ...outgoing.map((e) => e.target_node_id),
    ...incoming.map((e) => e.source_node_id),
  ];
  const nodeRefs = store.getNodeRefsBatch(allRefNodeIds);

  // Batch fetch all referenced files
  const fileRefIds = [...nodeRefs.values()]
    .filter((r) => r.nodeType === 'file')
    .map((r) => r.refId);
  const fileMap = fileRefIds.length > 0 ? store.getFilesByIds(fileRefIds) : new Map();

  const imports: DependencyEdge[] = [];
  for (const edge of outgoing) {
    const ref = nodeRefs.get(edge.target_node_id);
    if (!ref || ref.nodeType !== 'file') continue;
    const targetFile = fileMap.get(ref.refId);
    if (!targetFile) continue;
    const meta = edge.metadata
      ? (typeof edge.metadata === 'string' ? JSON.parse(edge.metadata) : edge.metadata) as Record<string, unknown>
      : {};
    imports.push({ source: filePath, target: targetFile.path, specifiers: (meta['specifiers'] as string[]) ?? [] });
  }

  const importedBy: DependencyEdge[] = [];
  for (const edge of incoming) {
    const ref = nodeRefs.get(edge.source_node_id);
    if (!ref || ref.nodeType !== 'file') continue;
    const sourceFile = fileMap.get(ref.refId);
    if (!sourceFile) continue;
    const meta = edge.metadata
      ? (typeof edge.metadata === 'string' ? JSON.parse(edge.metadata) : edge.metadata) as Record<string, unknown>
      : {};
    importedBy.push({ source: sourceFile.path, target: filePath, specifiers: (meta['specifiers'] as string[]) ?? [] });
  }

  return { file: filePath, imports, imported_by: importedBy };
}

// ---------------------------------------------------------------------------
// get_untested_exports
// ---------------------------------------------------------------------------

interface UntestedExportItem {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  signature: string | null;
}

interface GetUntestedExportsResult {
  file_pattern: string | null;
  untested: UntestedExportItem[];
  total_exports: number;
  total_untested: number;
}

/**
 * Find exported public symbols that have no associated test coverage.
 * Uses heuristic path matching: for each exported symbol, checks if any
 * test file in the project matches its file name or symbol name pattern.
 */
export function getUntestedExports(
  store: Store,
  filePattern?: string,
): GetUntestedExportsResult {
  const exported = store.getExportedSymbols(filePattern)
    .filter((s) => s.kind !== 'method') // methods inherit from class
    .filter((s) => !TEST_FIXTURE_RE.test(s.file_path));

  // Collect all test file paths
  const allFiles = store.getAllFiles();
  const testFiles = allFiles
    .filter((f) => /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(f.path))
    .map((f) => f.path.toLowerCase());

  const untested: UntestedExportItem[] = [];

  for (const sym of exported) {
    // Normalize the source file name for matching
    const baseName = sym.file_path
      .replace(/\.[^.]+$/, '') // strip extension
      .split('/').pop()!       // get filename
      .toLowerCase();

    // Check if any test file references this source file
    const hasTest = testFiles.some((testPath) => {
      const testBase = testPath.split('/').pop()!;
      return (
        testBase.includes(baseName) ||
        testBase.includes(toKebab(sym.name))
      );
    });

    if (!hasTest) {
      untested.push({
        symbol_id: sym.symbol_id,
        name: sym.name,
        kind: sym.kind,
        file: sym.file_path,
        line: sym.line_start,
        signature: sym.signature,
      });
    }
  }

  return {
    file_pattern: filePattern ?? null,
    untested,
    total_exports: exported.length,
    total_untested: untested.length,
  };
}

/** Convert PascalCase/camelCase to kebab-case for test file matching */
function toKebab(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// self_audit
// ---------------------------------------------------------------------------

interface SelfAuditResult {
  summary: {
    total_files: number;
    total_symbols: number;
    total_edges: number;
    total_exports: number;
    dead_exports: number;
    untested_exports: number;
    test_files: number;
    import_edges: number;
    heritage_edges: number;
    test_covers_edges: number;
    dependency_cycles: number;
    unstable_modules: number;
    avg_cyclomatic: number | null;
  };
  dead_exports_top10: DeadExportItem[];
  untested_top10: UntestedExportItem[];
  /** Files with most incoming import edges (most depended-on) */
  most_imported_files: { file: string; imported_by_count: number }[];
  /** Files with most outgoing import edges (most dependencies) */
  most_dependent_files: { file: string; imports_count: number }[];
  /** Interfaces/classes with the most implementors */
  widest_interfaces: { name: string; implementor_count: number }[];
  /** Most complex symbols */
  most_complex_symbols: { symbol_id: string; name: string; file: string; cyclomatic: number }[];
  /** Most unstable modules (highest instability index) */
  most_unstable: { file: string; instability: number; ca: number; ce: number }[];
}

/**
 * One-shot project health audit — combines dead exports, untested exports,
 * dependency hotspots, and heritage metrics into a single report.
 */
export function selfAudit(store: Store): SelfAuditResult {
  const stats = store.getStats();

  // Dead exports
  const deadResult = getDeadExports(store);

  // Untested exports
  const untestedResult = getUntestedExports(store);

  // Edge type counts
  const importEdges = store.getEdgesByType('imports');
  const heritageExtends = store.getEdgesByType('ts_extends');
  const heritageImplements = store.getEdgesByType('ts_implements');
  const testCovers = store.getEdgesByType('test_covers');

  // Test files count
  const allFiles = store.getAllFiles();
  const testFileCount = allFiles.filter((f) =>
    /\.(test|spec)\.[jt]sx?$|__tests__\//.test(f.path),
  ).length;

  // Most imported files (incoming import edges per file)
  const importedByCount = new Map<number, number>();
  for (const edge of importEdges) {
    importedByCount.set(
      edge.target_node_id,
      (importedByCount.get(edge.target_node_id) ?? 0) + 1,
    );
  }
  const mostImported = [...importedByCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([nodeId, count]) => {
      const ref = store.getNodeRef(nodeId);
      const file = ref?.nodeType === 'file' ? store.getFileById(ref.refId) : undefined;
      return { file: file?.path ?? `[node:${nodeId}]`, imported_by_count: count };
    });

  // Most dependent files (outgoing import edges per file)
  const importsCount = new Map<number, number>();
  for (const edge of importEdges) {
    importsCount.set(
      edge.source_node_id,
      (importsCount.get(edge.source_node_id) ?? 0) + 1,
    );
  }
  const mostDependent = [...importsCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([nodeId, count]) => {
      const ref = store.getNodeRef(nodeId);
      const file = ref?.nodeType === 'file' ? store.getFileById(ref.refId) : undefined;
      return { file: file?.path ?? `[node:${nodeId}]`, imports_count: count };
    });

  // Widest interfaces — single pass instead of N full-table scans
  // Collect all implements/extends references from heritage metadata, count in-memory
  const heritageSymbols = store.getSymbolsWithHeritage();
  const implCountMap = new Map<string, number>(); // interface name → implementor count
  for (const sym of heritageSymbols) {
    const meta = sym.metadata ? (typeof sym.metadata === 'string' ? JSON.parse(sym.metadata) : sym.metadata) as Record<string, unknown> : {};
    for (const key of ['implements', 'extends']) {
      const parents = meta[key] as string[] | undefined;
      if (Array.isArray(parents)) {
        for (const parentName of parents) {
          implCountMap.set(parentName, (implCountMap.get(parentName) ?? 0) + 1);
        }
      }
    }
  }
  const interfaceCounts = [...implCountMap.entries()]
    .map(([name, count]) => ({ name, implementor_count: count }))
    .filter((x) => x.implementor_count > 0)
    .sort((a, b) => b.implementor_count - a.implementor_count);

  // Coupling & cycles
  const coupling = getCouplingMetrics(store);
  const cycles = getDependencyCycles(store);
  const unstable = coupling.filter((c) => c.assessment === 'unstable');

  // Average cyclomatic complexity
  const complexityRow = store.db.prepare(
    'SELECT AVG(cyclomatic) as avg FROM symbols WHERE cyclomatic IS NOT NULL',
  ).get() as { avg: number | null } | undefined;
  const avgCyclomatic = complexityRow?.avg != null
    ? Math.round(complexityRow.avg * 100) / 100
    : null;

  // Most complex symbols
  const complexSymbols = store.db.prepare(`
    SELECT s.symbol_id, s.name, f.path as file, s.cyclomatic
    FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE s.cyclomatic IS NOT NULL
    ORDER BY s.cyclomatic DESC
    LIMIT 10
  `).all() as { symbol_id: string; name: string; file: string; cyclomatic: number }[];

  return {
    summary: {
      total_files: stats.totalFiles,
      total_symbols: stats.totalSymbols,
      total_edges: stats.totalEdges,
      total_exports: deadResult.total_exports,
      dead_exports: deadResult.total_dead,
      untested_exports: untestedResult.total_untested,
      test_files: testFileCount,
      import_edges: importEdges.length,
      heritage_edges: heritageExtends.length + heritageImplements.length,
      test_covers_edges: testCovers.length,
      dependency_cycles: cycles.length,
      unstable_modules: unstable.length,
      avg_cyclomatic: avgCyclomatic,
    },
    dead_exports_top10: deadResult.dead_exports.slice(0, 10),
    untested_top10: untestedResult.untested.slice(0, 10),
    most_imported_files: mostImported,
    most_dependent_files: mostDependent,
    widest_interfaces: interfaceCounts.slice(0, 10),
    most_complex_symbols: complexSymbols,
    most_unstable: unstable.slice(0, 10).map((c) => ({
      file: c.file, instability: c.instability, ca: c.ca, ce: c.ce,
    })),
  };
}
