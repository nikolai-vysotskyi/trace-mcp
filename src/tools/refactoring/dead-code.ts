/**
 * Multi-signal dead code detection (v2).
 *
 * Three independent evidence signals:
 * 1. Import graph — symbol name not found in any import specifier
 * 2. Call graph — symbol name not mentioned in bodies of other files
 * 3. Barrel exports — symbol not re-exported from any barrel file (index.ts, __init__.py, mod.rs)
 *
 * Confidence = signals_fired / 3.  Default threshold 0.5 (at least 2 of 3 must fire).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../../db/store.js';
import { logger } from '../../logger.js';
import {
  type ConfidenceLevel,
  classifyConfidence,
  type Methodology,
} from '../shared/confidence.js';

// ════════════════════════════════��═══════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface DeadCodeItem {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  confidence: number;
  confidence_level: ConfidenceLevel;
  signals: {
    import_graph: boolean;
    call_graph: boolean;
    barrel_exports: boolean;
  };
}

interface DeadCodeResult {
  file_pattern: string | null;
  dead_symbols: DeadCodeItem[];
  total_exports: number;
  total_dead: number;
  threshold: number;
  _methodology: Methodology;
  _warnings?: string[];
}

/**
 * Frameworks where entry points come from decorators, file-system routing, or
 * convention-based discovery — none of which the import-graph signal sees.
 * If any of these are detected, dead code results may include framework-managed
 * symbols (controllers, handlers, routes, views) that are actually live.
 */
const DECORATOR_DRIVEN_FRAMEWORKS = new Set([
  'nestjs',
  'laravel',
  'django',
  'rails',
  'spring',
  'fastapi',
  'flask',
  'nextjs',
  'nuxt',
  'drf',
  'blade',
  'inertia',
  'n8n',
]);

/**
 * Languages whose import edges carry `specifiers` metadata — the only kind
 * the import_graph signal can read.  For all other languages, `buildImportedNamesSet`
 * returns empty (their imports don't contain named specifiers), so import_graph
 * always fires "not imported" for their files — a systematic false positive source.
 *
 * These are derived empirically from helpers.ts / extractSymbols in each plugin:
 *   - TypeScript/JavaScript: esm_imports with specifiers array
 *   - Python: py_imports with specifiers array
 *   - Java/Kotlin/Scala: imports with specifiers (qualified name parts)
 *   - Swift: imports with specifiers
 *   - C#: imports with specifiers
 *
 * NOT here (emit imports/module only, no specifiers):
 *   Go, Ruby, PHP, Rust, C, C++, Vue, Blade, and the 60+ regex-based plugins.
 */
export const SPECIFIER_TRACKED_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'java',
  'kotlin',
  'scala',
  'swift',
  'csharp',
]);

// ═══════════════════════════════���════════════════════════════════════════
// BARREL FILE DETECTION
// ═══════════════════════════════════════════��════════════════════════════

const BARREL_PATTERNS = [/^index\.[jt]sx?$/, /^mod\.rs$/, /^__init__\.py$/, /^main\.[jt]sx?$/];

function isBarrelFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return BARREL_PATTERNS.some((p) => p.test(base));
}

// ════════════════════════════════════════════════════════════════════════
// SIGNAL 1: IMPORT GRAPH
// ═══════════════════════════════════════��════════════════════════════════

/**
 * Build set of all imported specifier names across the project.
 * Uses import edges metadata which stores specifier lists.
 */
function buildImportedNamesSet(store: Store): Set<string> {
  const importedNames = new Set<string>();

  for (const edgeType of ['imports', 'esm_imports', 'py_imports']) {
    const edges = store.getEdgesByType(edgeType);
    for (const edge of edges) {
      if (!edge.metadata) continue;
      const meta =
        typeof edge.metadata === 'string'
          ? (JSON.parse(edge.metadata) as Record<string, unknown>)
          : (edge.metadata as Record<string, unknown>);

      const specifiers = meta.specifiers;
      if (Array.isArray(specifiers)) {
        for (const s of specifiers) {
          if (typeof s === 'string') {
            const clean = s.startsWith('* as ') ? s.slice(5) : s;
            importedNames.add(clean);
          }
        }
      }
    }
  }

  return importedNames;
}

// ════════════════════════════════════════════════════════════════════════
// SIGNAL 2: CALL GRAPH (text-match in other files' bodies)
// ════════════════════════════════════════════════════════════════════════

/**
 * Build a set of symbol names that appear in call/reference edges.
 * Checks if the symbol's node has any incoming edges (calls, references).
 */
function buildReferencedSymbolIds(store: Store): Set<number> {
  const referenced = new Set<number>();

  for (const edgeType of ['calls', 'references']) {
    const edges = store.getEdgesByType(edgeType);
    for (const edge of edges) {
      referenced.add(edge.target_node_id);
    }
  }

  return referenced;
}

// ════════════════════════════════════════════════════════════════════════
// SIGNAL 3: BARREL EXPORTS
// ═════════════════════════════════════════════════���══════════════════════

/**
 * Build set of symbol names that are re-exported from barrel files.
 * Scans import edges where the SOURCE file is a barrel file.
 */
function buildBarrelExportedNames(store: Store): Set<string> {
  const barrelNames = new Set<string>();

  const allFiles = store.getAllFiles();
  const barrelFileIds = new Set<number>();
  for (const f of allFiles) {
    if (isBarrelFile(f.path)) barrelFileIds.add(f.id);
  }

  if (barrelFileIds.size === 0) return barrelNames;

  // Get barrel file node IDs (batched)
  const barrelNodeMap = store.getNodeIdsBatch('file', [...barrelFileIds]);
  const barrelNodeIds = new Set<number>(barrelNodeMap.values());

  // Check ESM import edges FROM barrel files — the specifiers they import
  // are effectively re-exported
  for (const edgeType of ['esm_imports', 'imports', 'py_imports', 'py_reexports']) {
    const edges = store.getEdgesByType(edgeType);
    for (const edge of edges) {
      if (!barrelNodeIds.has(edge.source_node_id)) continue;
      if (!edge.metadata) continue;

      const meta =
        typeof edge.metadata === 'string'
          ? (JSON.parse(edge.metadata) as Record<string, unknown>)
          : (edge.metadata as Record<string, unknown>);

      const specifiers = meta.specifiers;
      if (Array.isArray(specifiers)) {
        for (const s of specifiers) {
          if (typeof s === 'string') {
            const clean = s.startsWith('* as ') ? s.slice(5) : s;
            barrelNames.add(clean);
          }
        }
      }
    }
  }

  return barrelNames;
}

// ════════════════════════════��═══════════════════════════════════════════
// MAIN: MULTI-SIGNAL DEAD CODE DETECTION
// ════════════════════════════════════════════════════════════════════════

export function getDeadCodeV2(
  store: Store,
  options: {
    filePattern?: string;
    threshold?: number;
    limit?: number;
    detectedFrameworks?: string[];
  } = {},
): DeadCodeResult {
  const { filePattern, threshold = 0.5, limit = 50, detectedFrameworks = [] } = options;

  // Exclude test fixtures (sample projects — always false positives) and test
  // files (entry points run by test runners, never imported by production code).
  const TEST_FIXTURE_RE = /(?:^|\/)(?:tests?|__tests__|spec)\/fixtures?\//;
  const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[jt]sx?$/;
  const exported = store
    .getExportedSymbols(filePattern)
    .filter((s) => s.kind !== 'method') // methods inherit export from class
    .filter((s) => !TEST_FIXTURE_RE.test(s.file_path))
    .filter((s) => !TEST_FILE_RE.test(s.file_path));

  // Build all three signal datasets
  const importedNames = buildImportedNamesSet(store);
  const referencedNodeIds = buildReferencedSymbolIds(store);
  const barrelExportedNames = buildBarrelExportedNames(store);

  // Batch: get node IDs for all exported symbols at once
  const exportedSymIds = exported.map((s) => s.id);
  const symNodeIdMap = store.getNodeIdsBatch('symbol', exportedSymIds);

  const dead: DeadCodeItem[] = [];

  for (const sym of exported) {
    // Signal 1: not in any import specifier
    const notImported = !importedNames.has(sym.name);

    // Signal 2: no incoming call/reference edges to this symbol's node
    const symNodeId = symNodeIdMap.get(sym.id);
    const notReferenced = symNodeId === undefined || !referencedNodeIds.has(symNodeId);

    // Signal 3: not re-exported from any barrel file
    const notInBarrel = !barrelExportedNames.has(sym.name);

    const signalCount = (notImported ? 1 : 0) + (notReferenced ? 1 : 0) + (notInBarrel ? 1 : 0);
    const confidence = Math.round((signalCount / 3) * 100) / 100;

    if (confidence >= threshold) {
      dead.push({
        symbol_id: sym.symbol_id,
        name: sym.name,
        kind: sym.kind,
        file: sym.file_path,
        line: sym.line_start,
        confidence,
        confidence_level: classifyConfidence(signalCount, 3),
        signals: {
          import_graph: notImported,
          call_graph: notReferenced,
          barrel_exports: notInBarrel,
        },
      });
    }
  }

  // Sort by confidence desc, then by name
  dead.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));

  // Framework warnings: convention/decorator-driven frameworks have entry points
  // that the import-graph signal cannot see, so results may contain false positives.
  const warnings: string[] = [];
  const flaggedFrameworks = detectedFrameworks.filter((f) =>
    DECORATOR_DRIVEN_FRAMEWORKS.has(f.toLowerCase()),
  );
  if (flaggedFrameworks.length > 0) {
    warnings.push(
      `Detected framework(s) [${flaggedFrameworks.join(', ')}] use decorators, ` +
        `file-system routing, or convention-based entry points that this detector ` +
        `does not trace. Symbols reachable only via routes/handlers/controllers may ` +
        `be reported as dead. Verify low/medium-confidence results before removal.`,
    );
  }
  if (importedNames.size === 0 && exported.length > 0) {
    warnings.push(
      `Zero import specifiers indexed across the project. The import_graph signal ` +
        `cannot distinguish live from dead — all results rely on call_graph and ` +
        `barrel_exports only. Treat results as low confidence regardless of score.`,
    );
  }

  // Import-gap warning: languages whose import edges don't carry specifiers make
  // import_graph always fire "not imported", inflating confidence for their files.
  const indexedLanguages = new Set(
    store
      .getAllFiles()
      .filter((f) => (filePattern ? f.path.includes(filePattern) : true))
      .map((f) => f.language?.toLowerCase() ?? '')
      .filter(Boolean),
  );
  const gapLanguages = [...indexedLanguages].filter(
    (lang) =>
      !SPECIFIER_TRACKED_LANGUAGES.has(lang) &&
      // Exclude data formats that never have named imports
      ![
        'json',
        'yaml',
        'toml',
        'xml',
        'html',
        'css',
        'markdown',
        'sql',
        'ini',
        'dockerfile',
        'makefile',
      ].includes(lang),
  );
  if (gapLanguages.length > 0) {
    warnings.push(
      `Language(s) [${gapLanguages.sort().join(', ')}] do not emit import specifiers. ` +
        `The import_graph signal will always fire "not imported" for symbols in these files, ` +
        `raising confidence scores regardless of actual usage. ` +
        `Reachability mode (mode="reachability") is more reliable for these languages.`,
    );
  }

  const methodology: Methodology = {
    algorithm: 'multi_signal_export_analysis',
    signals: [
      'import_graph: symbol name absent from all import specifiers across the project',
      'call_graph: symbol node has no incoming calls/references edges',
      'barrel_exports: symbol name not re-exported from any barrel file (index.ts, __init__.py, mod.rs)',
    ],
    confidence_formula: 'signals_fired / 3 (1=low, 2=medium, 3=multi_signal)',
    limitations: [
      'dynamic dispatch and reflection are not tracked',
      'framework decorators (@Controller, @Get, etc.) are not entry points',
      'file-system routing (Next.js pages, Nuxt) is not traced',
      'string-based references (e.g. dynamic imports with computed paths) are missed',
      'methods are excluded — only top-level exports are evaluated',
      'import_graph signal is blind for Go, Ruby, PHP, Rust, C, C++ and other languages ' +
        'that emit import edges without named specifiers — see _warnings for affected languages',
    ],
  };

  return {
    file_pattern: filePattern ?? null,
    dead_symbols: dead.slice(0, limit),
    total_exports: exported.length,
    total_dead: dead.length,
    threshold,
    _methodology: methodology,
    ...(warnings.length > 0 ? { _warnings: warnings } : {}),
  };
}

// ════════════════════════════════════════════════════════════════════════
// REACHABILITY MODE — graph BFS from auto-detected entry points
// ════════════════════════════════════════════════════════════════════════

export interface ReachabilityDeadCodeItem {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  reason: 'unreachable_from_entry_points';
}

export interface ReachabilityDeadCodeResult {
  mode: 'reachability';
  file_pattern: string | null;
  dead_symbols: ReachabilityDeadCodeItem[];
  total_exports: number;
  total_dead: number;
  entry_points: {
    total: number;
    sources: Record<string, number>;
  };
  reached_symbols: number;
  _methodology: Methodology;
  _warnings?: string[];
}

/**
 * Edge types that propagate reachability forward (caller → callee).
 * Note: `imports`/`esm_imports` go file → file, so when we hit a file we
 * also enqueue its symbol nodes (handled inside the BFS).
 */
const REACHABILITY_EDGE_TYPES = new Set([
  'calls',
  'references',
  'esm_imports',
  'imports',
  'py_imports',
  'py_reexports',
  'renders',
  'dispatches',
]);

/** Framework roles that mark a symbol as a runtime entry point. */
const ENTRY_FRAMEWORK_ROLES = new Set([
  'controller',
  'route',
  'route_handler',
  'request_handler',
  'middleware',
  'page', // next.js / nuxt page components
  'layout',
  'api_route',
  'job', // celery / queue jobs
  'task',
  'event_handler',
  'listener',
  'cli_command',
  'mcp_tool',
  // Next.js file conventions (auto-loaded by framework, never imported by user code)
  'next_middleware',
  'next_forbidden',
  'next_unauthorized',
  'next_global_error',
  'next_metadata',
  'next_instrumentation',
  'next_loading',
  'next_error',
  'next_template',
  'next_default',
  'next_server_action',
]);

const ENTRY_FILE_PATTERNS: Array<{ re: RegExp; source: string }> = [
  { re: /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[jt]sx?$/, source: 'test_file' },
  { re: /(?:^|\/)src\/(?:cli|main|index)\.[jt]sx?$/, source: 'main_file' },
  { re: /(?:^|\/)bin\/[^/]+\.[jt]sx?$/, source: 'bin_file' },
];

/**
 * Read package.json `main` and `bin` entries (if present) and resolve to
 * absolute file paths under projectRoot.
 */
function readPackageEntries(projectRoot: string): {
  paths: Set<string>;
  sources: Record<string, string>;
} {
  const paths = new Set<string>();
  const sources: Record<string, string> = {};
  if (!projectRoot) return { paths, sources };
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return { paths, sources };
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const add = (rel: string, src: string) => {
      const norm = path.normalize(rel).replace(/\\/g, '/');
      paths.add(norm);
      sources[norm] = src;
    };
    if (typeof pkg.main === 'string') add(pkg.main, 'package_main');
    if (typeof pkg.module === 'string') add(pkg.module, 'package_module');
    if (typeof pkg.bin === 'string') add(pkg.bin, 'package_bin');
    if (pkg.bin && typeof pkg.bin === 'object') {
      for (const v of Object.values(pkg.bin)) {
        if (typeof v === 'string') add(v, 'package_bin');
      }
    }
  } catch (e) {
    logger.warn({ err: e }, 'reachability: failed to parse package.json');
  }
  return { paths, sources };
}

interface EntryCollection {
  symbolNodeIds: Set<number>;
  fileNodeIds: Set<number>;
  sourceCounts: Record<string, number>;
}

function collectEntryPoints(
  store: Store,
  projectRoot: string | undefined,
  manualEntryPoints: string[] | undefined,
): EntryCollection {
  const symbolNodeIds = new Set<number>();
  const fileNodeIds = new Set<number>();
  const sourceCounts: Record<string, number> = {};

  const bump = (src: string, n = 1) => {
    sourceCounts[src] = (sourceCounts[src] ?? 0) + n;
  };

  const allFiles = store.getAllFiles();
  const filesByPath = new Map<string, (typeof allFiles)[number]>();
  for (const f of allFiles) filesByPath.set(f.path.replace(/\\/g, '/'), f);

  // 1. Filename heuristics: tests, main, bin
  const matchedFileIds = new Set<number>();
  for (const f of allFiles) {
    const norm = f.path.replace(/\\/g, '/');
    for (const { re, source } of ENTRY_FILE_PATTERNS) {
      if (re.test(norm)) {
        matchedFileIds.add(f.id);
        bump(source);
        break;
      }
    }
  }

  // 2. package.json main/bin
  const pkg = projectRoot
    ? readPackageEntries(projectRoot)
    : { paths: new Set<string>(), sources: {} };
  for (const rel of pkg.paths) {
    const f = filesByPath.get(rel) ?? filesByPath.get(rel.replace(/^\.?\//, ''));
    if (f) {
      matchedFileIds.add(f.id);
      bump(pkg.sources[rel] ?? 'package_entry');
    }
  }

  // 3. Manual entry-point file paths
  if (manualEntryPoints) {
    for (const ep of manualEntryPoints) {
      const norm = ep.replace(/\\/g, '/');
      const f = filesByPath.get(norm) ?? filesByPath.get(norm.replace(/^\.?\//, ''));
      if (f) {
        matchedFileIds.add(f.id);
        bump('manual');
      }
    }
  }

  // Map matched files → file nodes (BFS will enqueue their symbol nodes)
  const fileNodeMap = store.getNodeIdsBatch('file', [...matchedFileIds]);
  for (const nodeId of fileNodeMap.values()) fileNodeIds.add(nodeId);

  // 4. Routes — every route handler is an entry
  const routeSymbolIds: number[] = [];
  for (const route of store.getAllRoutes()) {
    if (route.controller_symbol_id) {
      const sym = store.getSymbolBySymbolId(route.controller_symbol_id);
      if (sym) {
        routeSymbolIds.push(sym.id);
        bump('route');
      }
    }
  }
  if (routeSymbolIds.length > 0) {
    const nodeMap = store.getNodeIdsBatch('symbol', routeSymbolIds);
    for (const n of nodeMap.values()) symbolNodeIds.add(n);
  }

  // 5. Symbols whose metadata.frameworkRole marks them as a runtime entry
  // Walk all exported symbols once and inspect metadata.
  const frameworkEntrySymIds: number[] = [];
  for (const sym of store.getExportedSymbols()) {
    if (!sym.metadata) continue;
    try {
      const meta =
        typeof sym.metadata === 'string'
          ? (JSON.parse(sym.metadata) as Record<string, unknown>)
          : (sym.metadata as Record<string, unknown>);
      const role =
        typeof meta.frameworkRole === 'string'
          ? meta.frameworkRole
          : typeof meta.role === 'string'
            ? meta.role
            : undefined;
      if (role && ENTRY_FRAMEWORK_ROLES.has(role.toLowerCase())) {
        frameworkEntrySymIds.push(sym.id);
        bump(`framework:${role}`);
      }
    } catch {
      /* ignore malformed metadata */
    }
  }
  if (frameworkEntrySymIds.length > 0) {
    const nodeMap = store.getNodeIdsBatch('symbol', frameworkEntrySymIds);
    for (const n of nodeMap.values()) symbolNodeIds.add(n);
  }

  return { symbolNodeIds, fileNodeIds, sourceCounts };
}

/**
 * Reachability dead code: BFS from auto-detected entry points through the
 * call/import graph; anything exported but not reached is dead.
 *
 * Stricter than multi-signal mode for libraries (no test reach-all
 * heuristic) but more accurate when entry points can be enumerated.
 */
export function getDeadCodeReachability(
  store: Store,
  options: {
    filePattern?: string;
    limit?: number;
    detectedFrameworks?: string[];
    projectRoot?: string;
    entryPoints?: string[];
  } = {},
): ReachabilityDeadCodeResult {
  const { filePattern, limit = 50, detectedFrameworks = [], projectRoot, entryPoints } = options;

  const TEST_FIXTURE_RE = /(?:^|\/)(?:tests?|__tests__|spec)\/fixtures?\//;
  const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[jt]sx?$/;

  const exported = store
    .getExportedSymbols(filePattern)
    .filter((s) => s.kind !== 'method')
    .filter((s) => !TEST_FIXTURE_RE.test(s.file_path))
    .filter((s) => !TEST_FILE_RE.test(s.file_path));

  // Collect entry points
  const entries = collectEntryPoints(store, projectRoot, entryPoints);
  const totalEntryNodes = entries.symbolNodeIds.size + entries.fileNodeIds.size;

  // Helper: enqueue all symbol nodes that belong to a given file id
  const enqueueFileSymbols = (fileId: number, target: Set<number>, worklist: number[]) => {
    const symRows = store.getSymbolsByFile(fileId);
    if (symRows.length === 0) return;
    const symNodeMap = store.getNodeIdsBatch(
      'symbol',
      symRows.map((s) => s.id),
    );
    for (const n of symNodeMap.values()) {
      if (!target.has(n)) {
        target.add(n);
        worklist.push(n);
      }
    }
  };

  // Initial reachable set
  const reached = new Set<number>(entries.symbolNodeIds);
  const worklist: number[] = [...entries.symbolNodeIds];

  // Seed: expand entry files to all their top-level symbol nodes
  for (const fileNodeId of entries.fileNodeIds) {
    const ref = store.getNodeByNodeId(fileNodeId);
    if (ref?.node_type === 'file') {
      enqueueFileSymbols(ref.ref_id, reached, worklist);
    }
    if (!reached.has(fileNodeId)) {
      reached.add(fileNodeId);
      worklist.push(fileNodeId);
    }
  }

  // BFS
  let iterations = 0;
  const MAX_ITERATIONS = 200_000;
  while (worklist.length > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    const nodeId = worklist.pop()!;
    const out = store.getOutgoingEdges(nodeId);
    for (const edge of out) {
      if (!REACHABILITY_EDGE_TYPES.has(edge.edge_type_name)) continue;
      const target = edge.target_node_id;
      if (reached.has(target)) continue;
      reached.add(target);
      worklist.push(target);

      // If we just reached a file node via imports, also reach all of its
      // symbol nodes (the file is being used → its exports are live).
      const ref = store.getNodeByNodeId(target);
      if (ref?.node_type === 'file') {
        enqueueFileSymbols(ref.ref_id, reached, worklist);
      }
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    logger.warn({ iterations }, 'reachability dead-code: BFS hit iteration cap');
  }

  // Map exported symbols to node IDs and bucket dead vs reached
  const symNodeMap = store.getNodeIdsBatch(
    'symbol',
    exported.map((s) => s.id),
  );

  const dead: ReachabilityDeadCodeItem[] = [];
  let reachedExportedCount = 0;

  for (const sym of exported) {
    const nodeId = symNodeMap.get(sym.id);
    if (nodeId !== undefined && reached.has(nodeId)) {
      reachedExportedCount++;
      continue;
    }
    dead.push({
      symbol_id: sym.symbol_id,
      name: sym.name,
      kind: sym.kind,
      file: sym.file_path,
      line: sym.line_start,
      reason: 'unreachable_from_entry_points',
    });
  }

  dead.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

  const warnings: string[] = [];
  if (totalEntryNodes === 0) {
    warnings.push(
      'No entry points were detected. Reachability analysis is meaningless ' +
        'without entry points — every exported symbol will be reported as dead. ' +
        'Pass `entryPoints` explicitly or ensure tests/main/bin/routes exist.',
    );
  }
  const flaggedFrameworks = detectedFrameworks.filter((f) =>
    DECORATOR_DRIVEN_FRAMEWORKS.has(f.toLowerCase()),
  );
  if (flaggedFrameworks.length > 0) {
    warnings.push(
      `Detected framework(s) [${flaggedFrameworks.join(', ')}] use decorator/` +
        `convention-based entry points. Reachability mode auto-promotes routes ` +
        `and symbols with framework metadata.frameworkRole, but anything ` +
        `discovered purely by string lookup or runtime DI may still appear dead.`,
    );
  }

  // Import-gap: reachability relies on call/imports edges; if a language doesn't
  // emit call edges at all (only symbol extraction, no edges), its files will have
  // no outgoing edges and their symbols won't be reached — false positives.
  const reachabilityGapLanguages = [
    ...new Set(
      store
        .getAllFiles()
        .filter((f) => (filePattern ? f.path.includes(filePattern) : true))
        .map((f) => f.language?.toLowerCase() ?? '')
        .filter(Boolean),
    ),
  ].filter(
    (lang) =>
      !SPECIFIER_TRACKED_LANGUAGES.has(lang) &&
      ![
        'json',
        'yaml',
        'toml',
        'xml',
        'html',
        'css',
        'markdown',
        'sql',
        'ini',
        'dockerfile',
        'makefile',
      ].includes(lang),
  );
  if (reachabilityGapLanguages.length > 0) {
    warnings.push(
      `Language(s) [${reachabilityGapLanguages.sort().join(', ')}] have limited call/import ` +
        `edge extraction. Symbols in these files may appear unreachable simply because ` +
        `the indexer did not trace their edges. Review dead symbols in these languages manually.`,
    );
  }

  const methodology: Methodology = {
    algorithm: 'forward_reachability_bfs',
    signals: [
      'BFS from entry points through calls/references/imports/renders/dispatches edges',
      `entry points: tests, package.json main/bin, src/{cli,main,index}, routes, symbols with frameworkRole metadata${entryPoints ? ', user-provided' : ''}`,
      'reaching a file node propagates to all its symbol nodes',
    ],
    confidence_formula: 'binary: reached or unreached (no probabilistic score)',
    limitations: [
      'dynamic dispatch and reflection are not tracked',
      'string-based references (dynamic imports, runtime require) are missed',
      'manual entry points must be provided for non-standard layouts',
      'methods are excluded — only top-level exports are evaluated',
      'edges only as good as the indexer — missing call edges yield false positives',
    ],
  };

  return {
    mode: 'reachability',
    file_pattern: filePattern ?? null,
    dead_symbols: dead.slice(0, limit),
    total_exports: exported.length,
    total_dead: dead.length,
    entry_points: {
      total: totalEntryNodes,
      sources: entries.sourceCounts,
    },
    reached_symbols: reachedExportedCount,
    _methodology: methodology,
    ...(warnings.length > 0 ? { _warnings: warnings } : {}),
  };
}
