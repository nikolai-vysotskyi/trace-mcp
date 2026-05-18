/**
 * Multi-signal dead code detection (v2).
 *
 * Four independent evidence signals:
 * 1. Import graph — symbol name not found in any import specifier
 * 2. Call graph — symbol name not mentioned in calls/references edges
 * 3. Barrel exports — symbol not re-exported from any barrel file (index.ts, __init__.py, mod.rs)
 * 4. Intra-file usage — symbol name not referenced elsewhere in its own file
 *    (catches default-arg/closure/file-local use that doesn't emit an edge,
 *    e.g. `export const X = ...; function f(p = X) { ... }`).
 *
 * Confidence = signals_fired / 4.  Default threshold 0.5 (at least 2 of 4 must fire).
 *
 * Framework-entry-point heuristic: after the raw signal score is computed,
 * symbols whose name/file shape matches a known framework entry-point pattern
 * (VSCode activate/deactivate, React App, Next.js route exports, electron
 * main, package.json bin/main targets, etc.) have their confidence multiplied
 * by a value in [0.3, 1.0] so they don't surface at confidence 1.0 even when
 * the import-graph signal is blind to their convention-based discovery.
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
    /** True when no other line of the symbol's own file mentions its name (word-boundary match). */
    intra_file_usage: boolean;
    /**
     * Multiplier in [0.3, 1.0] applied to the raw signal score because the
     * symbol looks like a framework-discovered entry point (VSCode activate,
     * React App, Next.js route loader, package.json bin/main target, ...).
     * 1.0 means no downgrade. Lower values mean the framework runtime, not
     * handwritten code, likely invokes this symbol.
     */
    entry_point_multiplier: number;
    /** Why the entry-point multiplier fired (file pattern, symbol name, package.json target, ...). null when no match. */
    entry_point_reason: string | null;
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
 * Decorators / annotations / attributes that mark a symbol as a framework
 * entry point — invoked by the framework's runtime, never imported by hand.
 *
 * CRG v2.3.2 PR #249 surfaced "framework-aware dead code" specifically
 * because controllers/services/repositories were getting flagged as dead
 * by import-graph signal alone. We already warn about it; this set lets
 * us hard-skip those symbols instead of just warning, which is how CRG
 * actually filters its results.
 *
 * Match is case-insensitive and substring-based ("RestController" matches
 * "@RestController" alike). Stored in symbol metadata under one of:
 *   metadata.decorators (TS/JS, NestJS)
 *   metadata.annotations (Java/Kotlin, Spring)
 *   metadata.attributes (C#, .NET)
 *   metadata.frameworkRole (any plugin that sets it explicitly)
 */
const FRAMEWORK_ENTRY_POINT_DECORATORS = new Set(
  [
    // Spring
    'Controller',
    'RestController',
    'Service',
    'Repository',
    'Component',
    'Configuration',
    'Bean',
    'Endpoint',
    // NestJS
    'Injectable',
    'Module',
    'Catch',
    'WebSocketGateway',
    // Decorators that mark route handlers / lifecycle hooks (NestJS+Spring)
    'Get',
    'Post',
    'Put',
    'Delete',
    'Patch',
    'GetMapping',
    'PostMapping',
    'PutMapping',
    'DeleteMapping',
    'PatchMapping',
    'RequestMapping',
    'KafkaListener',
    'EventListener',
    'Scheduled',
    // Laravel / PHP attributes
    'Route',
    'Middleware',
    // Django / DRF
    'api_view',
    'login_required',
    'csrf_exempt',
    // FastAPI / Flask
    'router',
    'app_route',
    // Decorators that imply a framework-managed entry point in any context
    'Listener',
  ].map((s) => s.toLowerCase()),
);

const FRAMEWORK_ENTRY_POINT_ROLES = new Set([
  'controller',
  'service',
  'repository',
  'component',
  'configuration',
  'route',
  'handler',
  'middleware',
  'guard',
  'pipe',
  'interceptor',
  'gateway',
  'listener',
  'consumer',
  'producer',
  'job',
  'task',
  'view',
  'page',
  'layout',
]);

/**
 * Returns true when a symbol's metadata marks it as something the framework
 * runtime — not handwritten code — invokes. Used to hard-skip these from
 * the dead-code candidate set, mirroring CRG's framework-aware filter.
 */
function isFrameworkEntryPoint(metadata: unknown): boolean {
  if (!metadata) return false;
  let meta: Record<string, unknown>;
  try {
    meta = (typeof metadata === 'string' ? JSON.parse(metadata) : metadata) as Record<
      string,
      unknown
    >;
  } catch {
    return false;
  }

  const role = typeof meta.frameworkRole === 'string' ? meta.frameworkRole.toLowerCase() : null;
  if (role && FRAMEWORK_ENTRY_POINT_ROLES.has(role)) return true;

  for (const key of ['decorators', 'annotations', 'attributes'] as const) {
    const arr = meta[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item !== 'string') continue;
      // Strip leading `@` and any `(args)` so we match the bare name.
      const bare = item.replace(/^@/, '').replace(/\(.*$/, '').trim().toLowerCase();
      if (FRAMEWORK_ENTRY_POINT_DECORATORS.has(bare)) return true;
    }
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════
// FRAMEWORK ENTRY-POINT CONFIDENCE DOWNGRADE
// ════════════════════════════════════════════════════════════════════════
//
// Symbols whose discovery is convention-driven (VSCode activate/deactivate,
// React App.tsx default export, Next.js route loader/action, Electron main
// entry, package.json bin/main targets, …) are not visible to the import
// graph signal. Without a downgrade they surface at confidence 1.0 and pollute
// the dead-code result. This heuristic returns a multiplier in [0.3, 1.0] that
// is applied to the raw signal-count score AFTER the per-signal booleans are
// recorded, so users still see why the score was attenuated.

/** Exact symbol names that frameworks invoke by convention. */
const ENTRY_POINT_NAMES_EXACT = new Set([
  // VSCode extension lifecycle
  'activate',
  'deactivate',
  // Electron / Node binary entry
  'main',
  'init',
  'bootstrap',
  // Serverless / FaaS
  'handler',
  // Remix / React Router loaders
  'loader',
  'action',
  'meta',
  'links',
  'headers',
  'shouldRevalidate',
  'ErrorBoundary',
  'HydrateFallback',
  // Next.js page data hooks
  'getServerSideProps',
  'getStaticProps',
  'getStaticPaths',
  'getInitialProps',
  'generateMetadata',
  'generateStaticParams',
  'revalidate',
  'dynamic',
  // Next.js App router conventions
  'Page',
  'Layout',
  'Loading',
  'Error',
  'NotFound',
  'Template',
  'Default',
  // Vue SFC composition
  'setup',
  'onload',
  // tRPC entry
  'appRouter',
  // SvelteKit
  'load',
  'prerender',
  'ssr',
  'csr',
  // Astro
  'getStaticPaths',
]);

/** Default-export names that almost always indicate a framework root. */
const ENTRY_POINT_DEFAULT_EXPORT_NAMES = new Set([
  'App',
  'Root',
  'Application',
  'default',
  'middleware',
  'config',
]);

/**
 * File-path regexes that imply the file lives in a framework-managed slot.
 * Order matters: the first match wins for `entry_point_reason`.
 */
const ENTRY_POINT_FILE_PATTERNS: Array<{ re: RegExp; reason: string; multiplier: number }> = [
  {
    re: /(?:^|\/)packages\/[^/]*vscode[^/]*\/src\/extension\.[jt]sx?$/i,
    reason: 'vscode_extension_entry',
    multiplier: 0.3,
  },
  {
    re: /(?:^|\/)src\/extension\.[jt]sx?$/i,
    reason: 'vscode_extension_entry',
    multiplier: 0.3,
  },
  {
    re: /(?:^|\/)(?:electron|main)\/(?:main|index)\.[jt]sx?$/i,
    reason: 'electron_main',
    multiplier: 0.35,
  },
  {
    re: /(?:^|\/)(?:renderer|app)\/(?:App|Root|main|index)\.[jt]sx?$/i,
    reason: 'app_root',
    multiplier: 0.35,
  },
  {
    re: /(?:^|\/)(?:lambdas?|functions|handlers)\/[^/]+\.[jt]sx?$/i,
    reason: 'serverless_handler',
    multiplier: 0.35,
  },
  {
    re: /(?:^|\/)(?:app|src)\/api\/.+\.[jt]sx?$/i,
    reason: 'nextjs_api_route',
    multiplier: 0.35,
  },
  {
    re: /(?:^|\/)pages\/.+\.[jt]sx?$/i,
    reason: 'nextjs_pages_route',
    multiplier: 0.4,
  },
  {
    re: /(?:^|\/)app\/(?:[^/]+\/)*(?:page|layout|loading|error|not-found|template|default|route|head|middleware)\.[jt]sx?$/i,
    reason: 'nextjs_app_router',
    multiplier: 0.35,
  },
  {
    re: /(?:^|\/)routes\/.+\.[jt]sx?$/i,
    reason: 'routes_directory',
    multiplier: 0.4,
  },
  {
    re: /(?:^|\/)(?:main|bootstrap)\.[jt]sx?$/i,
    reason: 'main_file',
    multiplier: 0.4,
  },
  {
    re: /(?:^|\/)App\.[jt]sx?$/,
    reason: 'react_app_root',
    multiplier: 0.4,
  },
  {
    re: /\.figma\.[jt]sx?$/i,
    reason: 'figma_code_connect',
    multiplier: 0.4,
  },
  {
    re: /(?:^|\/)bin\/[^/]+\.[jt]sx?$/i,
    reason: 'bin_script',
    multiplier: 0.4,
  },
];

/**
 * Files registered as entry points by the project's package.json (main, bin,
 * module, exports). Computed once per `getDeadCodeV2` call.
 */
function readPackageEntryFiles(projectRoot: string | undefined): Set<string> {
  if (!projectRoot) return new Set<string>();
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return new Set<string>();
  const out = new Set<string>();
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const add = (rel: unknown) => {
      if (typeof rel !== 'string') return;
      if (rel.includes('*')) return;
      out.add(path.normalize(rel).replace(/\\/g, '/'));
    };
    add(pkg.main);
    add(pkg.module);
    if (typeof pkg.bin === 'string') add(pkg.bin);
    if (pkg.bin && typeof pkg.bin === 'object') {
      for (const v of Object.values(pkg.bin)) add(v);
    }
    if (pkg.exports !== undefined) {
      for (const target of collectExportsTargets(pkg.exports)) add(target);
    }
  } catch {
    /* unreadable package.json — caller already logs from reachability path */
  }
  return out;
}

/**
 * Returns a confidence multiplier in [0.3, 1.0] for a candidate dead symbol.
 * 1.0 = no downgrade. Lower = looks like a framework entry point. Also
 * returns a human-readable reason string so the result surfaces WHY the
 * downgrade fired.
 */
function getEntryPointDowngrade(
  symbolName: string,
  filePath: string,
  packageEntryFiles: Set<string>,
  symbolMetadata: unknown,
): { multiplier: number; reason: string | null } {
  const normFile = filePath.replace(/\\/g, '/');

  // package.json main/bin/module/exports — symbols exported from these files
  // are the package's public surface; downgrade aggressively.
  for (const pkgFile of packageEntryFiles) {
    if (normFile === pkgFile || normFile.endsWith('/' + pkgFile)) {
      return { multiplier: 0.3, reason: 'package_json_entry' };
    }
  }

  // File-path patterns
  for (const { re, reason, multiplier } of ENTRY_POINT_FILE_PATTERNS) {
    if (re.test(normFile)) {
      return { multiplier, reason };
    }
  }

  // Exact name match (activate, deactivate, handler, loader, ...)
  if (ENTRY_POINT_NAMES_EXACT.has(symbolName)) {
    return { multiplier: 0.4, reason: `entry_point_name:${symbolName}` };
  }

  // Default-export-style root names (App, Root, default) when metadata flags it as a default export
  if (ENTRY_POINT_DEFAULT_EXPORT_NAMES.has(symbolName)) {
    let isDefaultExport = false;
    try {
      const meta =
        typeof symbolMetadata === 'string'
          ? (JSON.parse(symbolMetadata) as Record<string, unknown>)
          : (symbolMetadata as Record<string, unknown> | null | undefined);
      if (meta && (meta.default === true || meta.isDefaultExport === true)) {
        isDefaultExport = true;
      }
    } catch {
      /* ignore */
    }
    return {
      multiplier: isDefaultExport ? 0.35 : 0.5,
      reason: `entry_point_name:${symbolName}`,
    };
  }

  return { multiplier: 1.0, reason: null };
}

// ════════════════════════════════════════════════════════════════════════
// SIGNAL 4: INTRA-FILE USAGE
// ════════════════════════════════════════════════════════════════════════

/**
 * Returns true when `name` appears as a word-boundary token anywhere in
 * `fileContent` OUTSIDE the byte range owned by the symbol's declaration.
 *
 * Catches the default-arg / closure-capture / file-local-helper case where
 * the indexer doesn't emit a `calls`/`references` edge but the symbol is
 * clearly used. Example:
 *
 *     export const CANARY_PATH = path.join(...);
 *     export async function checkEmbeddingDrift(opts = {}) {
 *       const file = opts.filePath ?? CANARY_PATH;  // <-- intra-file use
 *     }
 */
function isUsedIntraFile(
  fileContent: string,
  name: string,
  lineStart: number | null,
  lineEnd: number | null,
): boolean {
  if (!name) return false;
  // Word-boundary match. Escape regex metachars in `name` defensively.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  const lines = fileContent.split('\n');
  let match: RegExpExecArray | null;
  // Build a cumulative line-start offsets table only if we need it.
  const startLine = lineStart ?? -1;
  const endLine = lineEnd ?? -1;
  // Track the line each match falls on by walking the file once.
  let lineNo = 1;
  let offset = 0;
  // Walk through lines and check each for matches outside [startLine, endLine].
  for (const line of lines) {
    if (startLine === -1 || lineNo < startLine || lineNo > endLine) {
      re.lastIndex = 0;
      while ((match = re.exec(line)) !== null) {
        // Skip matches inside a comment that's the very first non-whitespace
        // of the line — common in JSDoc / inline comments mentioning the
        // symbol by name. Cheap heuristic, avoids the "the docblock counts
        // as a use" false-negative-on-deletion.
        const trimmed = line.slice(0, match.index).trimStart();
        if (
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*') ||
          trimmed.startsWith('#')
        ) {
          continue;
        }
        return true;
      }
    }
    offset += line.length + 1;
    lineNo++;
  }
  return false;
}

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
    projectRoot?: string;
  } = {},
): DeadCodeResult {
  const {
    filePattern,
    threshold = 0.5,
    limit = 50,
    detectedFrameworks = [],
    projectRoot,
  } = options;

  // Exclude test fixtures (sample projects — always false positives) and test
  // files (entry points run by test runners, never imported by production code).
  const TEST_FIXTURE_RE = /(?:^|\/)(?:tests?|__tests__|spec)\/fixtures?\//;
  const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[jt]sx?$/;
  // Framework-aware filter: drop symbols that the framework runtime invokes
  // (controllers, services, repositories, route handlers, scheduled jobs,
  // event listeners, etc.). The import-graph signal can't see these — they're
  // discovered by decorator/annotation scan or convention. Without this drop
  // every Spring @Controller and NestJS @Injectable shows up as dead-code
  // confidence 1.0 — a noisy false positive.
  let frameworkSkipped = 0;
  const exported = store
    .getExportedSymbols(filePattern)
    .filter((s) => s.kind !== 'method') // methods inherit export from class
    .filter((s) => !TEST_FIXTURE_RE.test(s.file_path))
    .filter((s) => !TEST_FILE_RE.test(s.file_path))
    .filter((s) => {
      if (isFrameworkEntryPoint(s.metadata)) {
        frameworkSkipped++;
        return false;
      }
      return true;
    });

  // Build all three signal datasets
  const importedNames = buildImportedNamesSet(store);
  const referencedNodeIds = buildReferencedSymbolIds(store);
  const barrelExportedNames = buildBarrelExportedNames(store);

  // Batch: get node IDs for all exported symbols at once
  const exportedSymIds = exported.map((s) => s.id);
  const symNodeIdMap = store.getNodeIdsBatch('symbol', exportedSymIds);

  // Entry-point package.json data (read once per call).
  const packageEntryFiles = readPackageEntryFiles(projectRoot);

  // Per-file content cache for the intra-file signal. We only read when a
  // candidate would otherwise be flagged dead, so the cache stays small.
  const fileContentCache = new Map<string, string | null>();
  const readFileCached = (filePath: string): string | null => {
    if (fileContentCache.has(filePath)) return fileContentCache.get(filePath) ?? null;
    let content: string | null = null;
    if (projectRoot) {
      const abs = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
      try {
        if (fs.existsSync(abs)) {
          const stat = fs.statSync(abs);
          // 2 MB cap — anything larger is almost certainly generated; skipping
          // the intra-file check is the safer side of a false positive.
          if (stat.size <= 2 * 1024 * 1024) {
            content = fs.readFileSync(abs, 'utf-8');
          }
        }
      } catch {
        /* unreadable file — fall back to "no intra-file evidence" */
      }
    }
    fileContentCache.set(filePath, content);
    return content;
  };

  const dead: DeadCodeItem[] = [];
  let entryPointDowngraded = 0;
  let intraFileRescued = 0;

  for (const sym of exported) {
    // Signal 1: not in any import specifier
    const notImported = !importedNames.has(sym.name);

    // Signal 2: no incoming call/reference edges to this symbol's node.
    // Note: `referencedNodeIds` is built from *all* call/reference edges
    // regardless of which file the source lives in, so an intra-file
    // caller correctly flips this signal to false. Mirrors the
    // jcodemunch v1.80.10 fix.
    const symNodeId = symNodeIdMap.get(sym.id);
    const notReferenced = symNodeId === undefined || !referencedNodeIds.has(symNodeId);

    // Hard skip when *anything* references the symbol. The two remaining
    // signals (import + barrel) describe the public surface, not whether
    // the function is actually invoked. With both surface-signals firing
    // and a single intra-file caller we'd otherwise return confidence
    // 0.67 — a confidence-laundered false positive in any monolithic file
    // (entry points, lodash-class single-file libs).
    if (!notReferenced) continue;

    // Signal 3: not re-exported from any barrel file
    const notInBarrel = !barrelExportedNames.has(sym.name);

    // Signal 4: not referenced anywhere in the symbol's own file outside
    // its own declaration range. Catches the default-arg / closure /
    // file-local-helper case the edge graph misses
    // (e.g. `const X = ...; function f(p = X) { ... }`).
    //
    // The signal is only EVALUATED when we have a project root and can
    // actually read the file. Otherwise we keep the historic 3-signal
    // denominator so tests and embedded callers (no projectRoot) see the
    // same confidence numbers as before this fix.
    let notIntraFileUsed = true;
    let intraFileSignalEvaluated = false;
    const content = readFileCached(sym.file_path);
    if (content) {
      intraFileSignalEvaluated = true;
      if (isUsedIntraFile(content, sym.name, sym.line_start, sym.line_end)) {
        notIntraFileUsed = false;
        intraFileRescued++;
        // Hard skip: a symbol used in its own file is not dead, regardless
        // of how many surface signals fire. Mirrors the call-graph hard
        // skip above.
        continue;
      }
    }

    const totalSignals = intraFileSignalEvaluated ? 4 : 3;
    const signalCount =
      (notImported ? 1 : 0) +
      (notReferenced ? 1 : 0) +
      (notInBarrel ? 1 : 0) +
      (intraFileSignalEvaluated && notIntraFileUsed ? 1 : 0);
    const rawConfidence = signalCount / totalSignals;

    // Framework-entry-point downgrade. Applied AFTER raw scoring so signals
    // remain truthful; we just don't trust the verdict for symbols that
    // frameworks discover by convention.
    const { multiplier, reason } = getEntryPointDowngrade(
      sym.name,
      sym.file_path,
      packageEntryFiles,
      sym.metadata,
    );
    if (multiplier < 1.0) entryPointDowngraded++;
    const confidence = Math.round(rawConfidence * multiplier * 100) / 100;

    if (confidence >= threshold) {
      dead.push({
        symbol_id: sym.symbol_id,
        name: sym.name,
        kind: sym.kind,
        file: sym.file_path,
        line: sym.line_start,
        confidence,
        confidence_level: classifyConfidence(signalCount, totalSignals),
        signals: {
          import_graph: notImported,
          call_graph: notReferenced,
          barrel_exports: notInBarrel,
          intra_file_usage: notIntraFileUsed,
          entry_point_multiplier: multiplier,
          entry_point_reason: reason,
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
  if (frameworkSkipped > 0) {
    warnings.push(
      `Framework-aware filter skipped ${frameworkSkipped} symbol(s) carrying ` +
        `entry-point decorators/annotations (Spring stereotypes, NestJS @Injectable/@Controller, ` +
        `Laravel/Django route handlers, etc.). These are invoked by the framework runtime, ` +
        `not via import — counting them as dead is a known false-positive pattern. ` +
        `Pass detail_level metadata or expand FRAMEWORK_ENTRY_POINT_DECORATORS if a real entry ` +
        `point is being missed.`,
    );
  }
  if (entryPointDowngraded > 0) {
    warnings.push(
      `Framework entry points (vscode activate, React App, Next.js route loaders, electron main, ` +
        `package.json bin/main targets, ...) had their confidence downgraded on ${entryPointDowngraded} ` +
        `symbol(s) so they no longer surface at confidence 1.0. The dead-code detector cannot see ` +
        `convention-based discovery, so prefer the entries above 0.7 first; see signals.entry_point_reason ` +
        `on each row for the trigger.`,
    );
  }
  if (intraFileRescued > 0) {
    warnings.push(
      `Intra-file usage signal rescued ${intraFileRescued} symbol(s) that the edge graph missed ` +
        `(default args, closure captures, file-local helpers without a calls/references edge).`,
    );
  }

  const methodology: Methodology = {
    algorithm: 'multi_signal_export_analysis',
    signals: [
      'import_graph: symbol name absent from all import specifiers across the project',
      'call_graph: symbol node has no incoming calls/references edges',
      'barrel_exports: symbol name not re-exported from any barrel file (index.ts, __init__.py, mod.rs)',
      'intra_file_usage: symbol name not referenced elsewhere in its own file (word-boundary match outside the declaration range)',
      'entry_point_multiplier: post-hoc downgrade in [0.3, 1.0] for symbols matching a known framework entry-point file pattern or name (vscode activate, React App, Next.js route loader, package.json bin/main targets, ...)',
    ],
    confidence_formula:
      '(signals_fired / signals_evaluated) * entry_point_multiplier — signals_evaluated = 4 when the symbol file is readable for intra_file_usage, else 3 (1=low, 2=medium, 3+=multi_signal)',
    limitations: [
      'dynamic dispatch and reflection are not tracked',
      'framework-aware filter drops symbols carrying stereotype decorators (@Controller, @Service, @Injectable, etc.) — see _warnings for the count and FRAMEWORK_ENTRY_POINT_DECORATORS for the full list',
      'file-system routing (Next.js pages, Nuxt) is not traced, but matching files get a confidence multiplier <1.0 instead of being hard-skipped',
      'string-based references (e.g. dynamic imports with computed paths) are missed',
      'methods are excluded — only top-level exports are evaluated',
      'import_graph signal is blind for Go, Ruby, PHP, Rust, C, C++ and other languages ' +
        'that emit import edges without named specifiers — see _warnings for affected languages',
      'intra_file_usage signal only runs when projectRoot is provided and the file is under 2 MB; otherwise the symbol falls through to edge-only evidence',
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
 * Read package.json `main`, `module`, `bin`, and `exports` entries (if
 * present) and resolve to relative file paths under projectRoot.
 *
 * `exports` is the modern Node entry-point declaration and is the only
 * authoritative entry list for ESM-first packages. Without it, dead-code
 * reachability flags every public export of a modern npm package as dead.
 * Mirrors the discovery side of jcodemunch v1.80.7 fix.
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
      // Skip patterns we can't resolve to a single file (subpath wildcards)
      if (rel.includes('*')) return;
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
    if (pkg.exports !== undefined) {
      for (const target of collectExportsTargets(pkg.exports)) {
        add(target, 'package_exports');
      }
    }
  } catch (e) {
    logger.warn({ err: e }, 'reachability: failed to parse package.json');
  }
  return { paths, sources };
}

/**
 * Walk the `exports` field per the Node spec and yield concrete relative
 * file paths. Handles:
 *
 * - String shorthand:                 `"exports": "./dist/index.js"`
 * - Conditional at root:              `"exports": { "import": "...", "require": "..." }`
 * - Subpath map:                      `"exports": { ".": "...", "./feat": "..." }`
 * - Nested conditions:                `{ ".": { "import": { "default": "..." } } }`
 * - Conditional arrays (fallbacks):   `"exports": [{ "import": "..." }, "./fallback.js"]`
 *
 * Wildcards (`./feature/*`) are skipped — they map to many files and aren't
 * meaningful as entry-point seeds. Strings that don't begin with `./` or
 * `/` are also skipped (they're package self-references, not file paths).
 */
export function collectExportsTargets(node: unknown): string[] {
  const out: string[] = [];
  visit(node);
  return out;

  function visit(n: unknown): void {
    if (typeof n === 'string') {
      if (n.startsWith('./') || n.startsWith('/')) out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      // Per spec: arrays are ordered fallbacks. Yield every concrete entry
      // because we don't know which condition will match at runtime.
      for (const item of n) visit(item);
      return;
    }
    if (n && typeof n === 'object') {
      const obj = n as Record<string, unknown>;
      // If keys look like subpaths (start with "."), recurse into each value.
      // Otherwise this is a conditions object (import/require/default/...) —
      // recurse into every condition for the same reason as arrays.
      const keys = Object.keys(obj);
      const isSubpathMap = keys.some((k) => k === '.' || k.startsWith('./'));
      if (isSubpathMap) {
        for (const k of keys) {
          // Wildcard-keyed subpaths can't be expanded to a single file; skip.
          if (k.includes('*')) continue;
          visit(obj[k]);
        }
      } else {
        for (const k of keys) visit(obj[k]);
      }
    }
  }
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

  let frameworkSkipped = 0;
  const exported = store
    .getExportedSymbols(filePattern)
    .filter((s) => s.kind !== 'method')
    .filter((s) => !TEST_FIXTURE_RE.test(s.file_path))
    .filter((s) => !TEST_FILE_RE.test(s.file_path))
    .filter((s) => {
      if (isFrameworkEntryPoint(s.metadata)) {
        frameworkSkipped++;
        return false;
      }
      return true;
    });

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
  if (frameworkSkipped > 0) {
    warnings.push(
      `Framework-aware filter skipped ${frameworkSkipped} symbol(s) carrying ` +
        `entry-point decorators/annotations. See FRAMEWORK_ENTRY_POINT_DECORATORS ` +
        `in src/tools/refactoring/dead-code.ts for the full list.`,
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
