import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatToolError } from '../../errors.js';
import type { ServerContext } from '../../server/types.js';
import { OutputFormatSchema, encodeResponse } from '../_common/output-format.js';
import {
  PIN_MAX_ACTIVE,
  PIN_WEIGHT_DEFAULT,
  PIN_WEIGHT_MAX,
  PIN_WEIGHT_MIN,
  deletePin,
  invalidatePinsCache,
  listPins,
  upsertPin,
} from '../../scoring/pins.js';
import { invalidatePageRankCache } from '../../scoring/pagerank.js';
import { getEdgeBottlenecks } from '../analysis/bottlenecks.js';
import { getComplexityTrend } from '../analysis/complexity-trend.js';
import { checkSymbolForDuplicates } from '../analysis/duplication.js';
import { generateInsightsReport } from '../analysis/insights-report.js';
import {
  getCouplingMetrics,
  getDependencyCycles,
  getExtractionCandidates,
  getPageRank,
  getRepoHealth,
} from '../analysis/graph-analysis.js';
import { getCouplingTrend, getSymbolComplexityTrend } from '../analysis/history.js';
import {
  getApiSurface,
  getDeadExports,
  getDependencyGraph,
  getImplementations,
  getPluginRegistry,
  getTypeHierarchy,
  getUntestedExports,
  getUntestedSymbols,
  selfAudit,
} from '../analysis/introspect.js';
import {
  detectLayerPreset,
  getLayerViolations,
  type LayerDefinition,
} from '../analysis/layer-violations.js';
import { getHotspots } from '../git/git-analysis.js';
import { getFileOwnership, getSymbolOwnership } from '../git/git-ownership.js';
import { buildNegativeEvidence } from '../shared/evidence.js';

export function registerAnalysisTools(server: McpServer, ctx: ServerContext): void {
  const { store, registry, projectRoot, guardPath, j, jh } = ctx;

  // Reconstruct frameworkNames from registry for get_plugin_registry
  const frameworkNames = new Set(registry.getAllFrameworkPlugins().map((p) => p.manifest.name));

  // --- Self-Development / Introspection Tools ---

  server.tool(
    'get_implementations',
    'Find all classes that implement or extend a given interface or base class. Use when you know the interface name. For full hierarchy tree (ancestors + descendants) use get_type_hierarchy instead. Read-only. Returns JSON: { implementations: [{ symbol_id, name, kind, file, line }], total }.',
    {
      name: z
        .string()
        .max(256)
        .describe('Interface or base class name (e.g. UserRepositoryInterface)'),
    },
    async ({ name }) => {
      const result = getImplementations(store, name);
      if (result.total === 0) {
        const stats = store.getStats();
        // Determine verdict: does the named class/interface exist at all?
        const target =
          store.getSymbolByName(name, 'class') ?? store.getSymbolByName(name, 'interface');
        const enriched = {
          ...result,
          evidence: buildNegativeEvidence({
            indexedFiles: stats.totalFiles,
            indexedSymbols: stats.totalSymbols,
            toolName: 'get_implementations',
            verdict: target ? 'symbol_indexed_but_isolated' : 'not_found_in_project',
            symbol: name,
          }),
        };
        return { content: [{ type: 'text', text: j(enriched) }] };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_api_surface',
    'List all exported symbols (public API) of a file or matching files. Use to understand what a module exposes. For finding unused exports use get_dead_exports instead. Read-only. Returns JSON: { files: [{ path, exports: [{ name, kind, signature }] }] }.',
    {
      file_pattern: z
        .string()
        .max(512)
        .optional()
        .describe('Glob-style pattern to filter files (e.g. src/services/*.ts)'),
    },
    async ({ file_pattern }) => {
      const result = getApiSurface(store, file_pattern);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_plugin_registry',
    'List all registered indexer plugins and the edge types they emit. Use for debugging indexer behavior or understanding which frameworks are supported. Read-only. Returns JSON: { languagePlugins, frameworkPlugins, edgeTypes }.',
    {},
    async () => {
      const result = getPluginRegistry(store, registry, frameworkNames);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_type_hierarchy',
    'Walk TypeScript class/interface hierarchy: ancestors (what it extends/implements) and descendants (what extends/implements it). Use to understand inheritance trees. For a flat list of implementations only use get_implementations instead. Read-only. Returns JSON: { name, ancestors: [...], descendants: [...] }.',
    {
      name: z
        .string()
        .max(256)
        .describe('Class or interface name (e.g. "LanguagePlugin", "Store")'),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Max traversal depth (default 10)'),
    },
    async ({ name, max_depth }) => {
      const result = getTypeHierarchy(store, name, max_depth ?? 10);
      if (result.ancestors.length === 0 && result.descendants.length === 0) {
        const stats = store.getStats();
        const target =
          store.getSymbolByName(name, 'class') ?? store.getSymbolByName(name, 'interface');
        const enriched = {
          ...result,
          evidence: buildNegativeEvidence({
            indexedFiles: stats.totalFiles,
            indexedSymbols: stats.totalSymbols,
            toolName: 'get_type_hierarchy',
            verdict: target ? 'symbol_indexed_but_isolated' : 'not_found_in_project',
            symbol: name,
          }),
        };
        return { content: [{ type: 'text', text: j(enriched) }] };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_dead_exports',
    'Find exported symbols never imported by any other file — dead code candidates. Use for quick export-level dead code scan. For deeper multi-signal dead code detection (including call graph) use get_dead_code instead. Read-only. Returns JSON: { deadExports: [{ symbol_id, name, kind, file }], total }. Set output_format: "toon" for ~20-43% fewer tokens (lossless, table-mode payloads).',
    {
      file_pattern: z
        .string()
        .max(512)
        .optional()
        .describe('Filter files by glob pattern (e.g. "src/tools/*.ts")'),
      output_format: OutputFormatSchema,
    },
    async ({ file_pattern, output_format }) => {
      const result = getDeadExports(store, file_pattern);
      const fmt = output_format === 'markdown' ? 'json' : output_format;
      const text = encodeResponse(result, fmt);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'get_import_graph',
    'Show file-level dependency graph: what a file imports and what imports it (requires reindex for ESM edge resolution). Use to understand module dependencies for a specific file. For project-wide coupling analysis use get_coupling; for visual diagram use get_dependency_diagram. Read-only. Returns JSON: { file, imports: [{ path }], importedBy: [{ path }] }.',
    {
      file_path: z
        .string()
        .max(512)
        .describe('Relative file path to analyze (e.g. "src/server.ts")'),
    },
    async ({ file_path }) => {
      const blocked = guardPath(file_path);
      if (blocked) return blocked;
      const result = getDependencyGraph(store, file_path);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_untested_exports',
    'Find exported public symbols with no matching test file — test coverage gaps. For deeper analysis including non-exported symbols use get_untested_symbols instead. Read-only. Returns JSON: { untested: [{ symbol_id, name, kind, file }], total }. Set output_format: "toon" for ~20-43% fewer tokens (lossless, table-mode payloads).',
    {
      file_pattern: z
        .string()
        .max(512)
        .optional()
        .describe('Filter by file glob pattern (e.g. "src/tools/%")'),
      output_format: OutputFormatSchema,
    },
    async ({ file_pattern, output_format }) => {
      const result = getUntestedExports(store, file_pattern);
      const fmt = output_format === 'markdown' ? 'json' : output_format;
      const text = encodeResponse(result, fmt);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'get_untested_symbols',
    'Find ALL symbols (not just exports) lacking test coverage. Classifies as "unreached" (no test file imports the source) or "imported_not_called" (test imports file but never references this symbol). Use for thorough coverage gap analysis. For exports-only quick scan use get_untested_exports instead. Read-only. Returns JSON: { untested: [{ symbol_id, name, kind, file, classification }], total }.',
    {
      file_pattern: z
        .string()
        .max(512)
        .optional()
        .describe('Filter by file glob pattern (e.g. "src/tools/%")'),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Cap on returned items (default: all)'),
    },
    async ({ file_pattern, max_results }) => {
      const result = getUntestedSymbols(store, file_pattern, max_results);
      return { content: [{ type: 'text', text: jh('get_untested_symbols', result) }] };
    },
  );

  server.tool(
    'self_audit',
    'Dead code & coverage audit: dead exports, untested public symbols, heritage debt. Use as a one-shot health check combining dead exports + untested symbols + heritage debt. For individual checks use get_dead_exports, get_untested_symbols, or get_dead_code separately. Read-only. Returns JSON: { deadExports, untestedSymbols, heritageDebt, summary }.',
    {},
    async () => {
      return { content: [{ type: 'text', text: j(selfAudit(store)) }] };
    },
  );

  server.tool(
    'generate_insights_report',
    'Single-call narrative health snapshot: god files (PageRank), architectural bridges (edge bottlenecks), risk hotspots (complexity × churn), edge resolution-tier breakdown, and gap counts (dead exports, untested, cycles). Aggregates already-computed metrics into ~2K tokens of Markdown plus a structured payload. Use at the start of a session to orient yourself instead of chaining get_pagerank + get_risk_hotspots + get_edge_bottlenecks + self_audit. Read-only. Returns JSON: { generated_at, totals, resolution_tiers, god_files, bridges, hotspots, gaps, markdown }.',
    {
      top_n: z.number().int().min(1).max(20).optional().describe('Items per section (default: 5)'),
    },
    async ({ top_n }) => {
      const result = generateInsightsReport(store, { cwd: projectRoot, topN: top_n });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }] };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Graph Analysis Tools ---

  server.tool(
    'get_coupling',
    'Coupling analysis: afferent (Ca), efferent (Ce), instability index per file. Shows which modules are stable vs unstable. Use to identify fragile or overly-depended-on modules. For coupling changes over time use get_coupling_trend instead. Read-only. Returns JSON: [{ file, ca, ce, instability, assessment }]. Set output_format: "toon" for ~20-43% fewer tokens (lossless, table-mode payloads).',
    {
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default: all)'),
      assessment: z
        .enum(['stable', 'neutral', 'unstable', 'isolated'])
        .optional()
        .describe('Filter by stability assessment'),
      output_format: OutputFormatSchema,
    },
    async ({ limit, assessment, output_format }) => {
      let results = getCouplingMetrics(store);
      if (assessment) results = results.filter((r) => r.assessment === assessment);
      if (limit) results = results.slice(0, limit);
      const fmt = output_format === 'markdown' ? 'json' : output_format;
      const text = encodeResponse(results, fmt);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'get_circular_imports',
    'Find circular dependency chains in the import graph (Kosaraju SCC algorithm). Use to detect and break dependency cycles. Read-only. Returns JSON: { total_cycles, cycles: [[file1, file2, ...]] }.',
    {},
    async () => {
      const cycles = getDependencyCycles(store);
      const stats = store.getStats();
      return {
        content: [
          {
            type: 'text',
            text: jh('get_dependency_cycles', {
              total_cycles: cycles.length,
              cycles,
              ...(cycles.length === 0
                ? {
                    evidence: buildNegativeEvidence(
                      stats.totalFiles,
                      stats.totalSymbols,
                      false,
                      'get_circular_imports',
                    ),
                  }
                : {}),
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'get_pagerank',
    'File importance ranking via PageRank on the import graph. Shows most central/important files. Use to identify architecturally critical files. For combined health metrics use get_project_health instead. Read-only. Returns JSON: [{ file, score }]. Set output_format: "toon" for ~20-43% fewer tokens (lossless, table-mode payloads).',
    {
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default: 50)'),
      output_format: OutputFormatSchema,
    },
    async ({ limit, output_format }) => {
      const results = getPageRank(store);
      const sliced = results.slice(0, limit ?? 50);
      const fmt = output_format === 'markdown' ? 'json' : output_format;
      const text = encodeResponse(sliced, fmt);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'get_edge_bottlenecks',
    'Find architectural bottleneck edges in the import graph: edges sitting on many shortest paths (edge betweenness, Brandes), edges whose removal would disconnect the graph (bridges, Tarjan), and nodes that are single points of failure (articulation points). Score combines structural centrality with co-change weight (bottleneckScore = betweenness × (1 + coChangeWeight)). Use to identify edges to monitor during refactoring and to prioritize decoupling work. For general importance use get_pagerank instead. Read-only. Returns JSON: { edges: [{ sourceFile, targetFile, betweenness, coChangeWeight, bottleneckScore, isBridge }], articulationPoints: [...], stats }.',
    {
      top_n: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe('Max ranked edges (default: 50; 0 = return all)'),
      min_score: z
        .number()
        .min(0)
        .max(10)
        .optional()
        .describe('Filter edges with bottleneckScore < min_score (default: 0)'),
      sampling: z
        .enum(['auto', 'full'])
        .optional()
        .describe(
          'auto (default): √V source sampling for graphs >500 nodes; full: always compute exactly',
        ),
    },
    async ({ top_n, min_score, sampling }) => {
      const result = getEdgeBottlenecks(store, { topN: top_n, minScore: min_score, sampling });
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: jh('get_edge_bottlenecks', result.value) }] };
    },
  );

  server.tool(
    'get_refactor_candidates',
    'Find functions with high complexity called from many files — candidates for extraction to shared modules. Use during architecture review to identify hotspots worth refactoring. Read-only. Returns JSON: [{ symbol_id, name, file, cyclomatic, callerCount }]. Set output_format: "toon" for ~20-43% fewer tokens (lossless, table-mode payloads).',
    {
      min_cyclomatic: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Min cyclomatic complexity (default: 5)'),
      min_callers: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Min distinct caller files (default: 2)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 20)'),
      output_format: OutputFormatSchema,
    },
    async ({ min_cyclomatic, min_callers, limit, output_format }) => {
      const results = getExtractionCandidates(store, {
        minCyclomatic: min_cyclomatic,
        minCallers: min_callers,
        limit,
      });
      const fmt = output_format === 'markdown' ? 'json' : output_format;
      const text = encodeResponse(results, fmt);
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'get_project_health',
    'Structural health: coupling instability, dependency cycles, PageRank rankings, refactor candidates. Use for architecture review as a single aggregated report. For individual metrics use get_coupling, get_circular_imports, or get_pagerank separately. Read-only. Returns JSON: { coupling, cycles, pagerank, refactorCandidates, hotspots }.',
    {},
    async () => {
      const result = getRepoHealth(store);
      const hotspots = getHotspots(store, projectRoot);
      return {
        content: [
          {
            type: 'text',
            text: jh('get_repo_health', { ...result, hotspots: hotspots.slice(0, 10) }),
          },
        ],
      };
    },
  );

  // --- Architecture & Ownership Tools ---

  server.tool(
    'check_architecture',
    'Check architectural layer rules: detect forbidden imports between layers (e.g. domain importing infrastructure). Supports auto-detected presets (clean-architecture, hexagonal) or custom layers. Use to enforce architectural boundaries. Read-only. Returns JSON: { violations: [{ from, to, rule, file, line }], total, preset }.',
    {
      preset: z
        .enum(['clean-architecture', 'hexagonal'])
        .optional()
        .describe('Use a built-in layer preset (auto-detected if omitted)'),
      layers: z
        .array(
          z.object({
            name: z.string().min(1).max(64),
            path_prefixes: z.array(z.string().min(1).max(256)).min(1),
            may_not_import: z.array(z.string().min(1).max(64)),
          }),
        )
        .max(20)
        .optional()
        .describe('Custom layer definitions (overrides preset)'),
    },
    async ({ preset, layers: customLayers }) => {
      let layerDefs: LayerDefinition[];

      if (customLayers && customLayers.length > 0) {
        layerDefs = customLayers;
      } else if (preset) {
        const { LAYER_PRESETS } = await import('../analysis/layer-violations.js');
        layerDefs = LAYER_PRESETS[preset] ?? [];
      } else {
        // Auto-detect
        const detected = detectLayerPreset(store);
        if (!detected) {
          return {
            content: [
              {
                type: 'text',
                text: j({
                  message: 'No layer structure detected. Provide layers or use a preset.',
                }),
              },
            ],
          };
        }
        layerDefs = detected.layers;
      }

      const result = getLayerViolations(store, layerDefs);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_code_owners',
    'Git-based code ownership: who contributed most to specific files (git shortlog). Requires git. Use to identify who to ask about specific files. For symbol-level ownership use get_symbol_owners instead. Read-only. Returns JSON: [{ file, owners: [{ author, commits, percentage }] }].',
    {
      file_paths: z
        .array(z.string().max(512))
        .min(1)
        .max(20)
        .describe('File paths to check ownership for'),
    },
    async ({ file_paths }) => {
      for (const fp of file_paths) {
        const blocked = guardPath(fp);
        if (blocked) return blocked;
      }
      const results = getFileOwnership(projectRoot, file_paths);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: j({ message: 'No git history available' }) }] };
      }
      return { content: [{ type: 'text', text: j(results) }] };
    },
  );

  server.tool(
    'get_symbol_owners',
    'Git blame-based symbol ownership: who wrote which lines of a specific symbol. Requires git. Use for fine-grained ownership of a specific function/class. For file-level ownership use get_code_owners instead. Read-only. Returns JSON: { symbol_id, owners: [{ author, lines, percentage }] }.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to check ownership for'),
    },
    async ({ symbol_id }) => {
      const result = getSymbolOwnership(store, projectRoot, symbol_id);
      if (!result) {
        return {
          content: [
            {
              type: 'text',
              text: j({ message: 'Could not determine ownership (no git or symbol not found)' }),
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_complexity_trend',
    'File complexity over git history: cyclomatic complexity at past commits. Shows if a file is getting more or less complex. Requires git. Use to track whether a file is improving or degrading. For current snapshot use get_complexity_report; for symbol-level trends use get_symbol_complexity_trend. Read-only. Returns JSON: { file, snapshots: [{ commit, date, complexity }] }.',
    {
      file_path: z.string().max(512).describe('File path to analyze'),
      snapshots: z
        .number()
        .int()
        .min(2)
        .max(20)
        .optional()
        .describe('Number of historical snapshots (default: 5)'),
    },
    async ({ file_path, snapshots }) => {
      const blocked = guardPath(file_path);
      if (blocked) return blocked;
      const result = getComplexityTrend(store, projectRoot, file_path, { snapshots });
      if (!result) {
        return {
          content: [
            {
              type: 'text',
              text: j({ message: 'No complexity data or git history for this file' }),
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_coupling_trend',
    'File coupling over git history: Ca/Ce/instability at past commits. Shows if a module is stabilizing or destabilizing. Requires git. Use to track module stability over time. For current coupling snapshot use get_coupling instead. Read-only. Returns JSON: { file, snapshots: [{ commit, date, ca, ce, instability }] }.',
    {
      file_path: z.string().max(512).describe('File path to analyze'),
      since_days: z.number().int().min(1).optional().describe('Analyze last N days (default: 90)'),
      snapshots: z
        .number()
        .int()
        .min(2)
        .max(20)
        .optional()
        .describe('Number of historical snapshots (default: 6)'),
    },
    async ({ file_path, since_days, snapshots }) => {
      const blocked = guardPath(file_path);
      if (blocked) return blocked;
      const result = getCouplingTrend(store, projectRoot, file_path, {
        sinceDays: since_days,
        snapshots,
      });
      if (!result) {
        return {
          content: [
            { type: 'text', text: j({ message: 'No coupling data or git history for this file' }) },
          ],
        };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_symbol_complexity_trend',
    "Single symbol complexity over git history: cyclomatic, nesting, params, lines at past commits. Requires git. Use to track a specific function's complexity evolution. For file-level trends use get_complexity_trend instead. Read-only. Returns JSON: { symbol_id, snapshots: [{ commit, date, cyclomatic, nesting, params, lines }] }.",
    {
      symbol_id: z
        .string()
        .min(1)
        .max(512)
        .describe('Symbol ID to analyze (from search or outline)'),
      since_days: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Analyze last N days (default: all history)'),
      snapshots: z
        .number()
        .int()
        .min(2)
        .max(20)
        .optional()
        .describe('Number of historical snapshots (default: 6)'),
    },
    async ({ symbol_id, since_days, snapshots }) => {
      const result = getSymbolComplexityTrend(store, projectRoot, symbol_id, {
        sinceDays: since_days,
        snapshots,
      });
      if (!result) {
        return {
          content: [
            { type: 'text', text: j({ message: 'Symbol not found or no git history available' }) },
          ],
        };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // ─── Duplication Detection ────────────────────────────────

  server.tool(
    'check_duplication',
    'Check if a function/class name already exists elsewhere in the codebase before creating it. Prevents duplicating existing logic. Call with just a name when planning new code, or symbol_id to check an existing symbol. Returns scored matches — score ≥0.7 means high likelihood of duplication, review the existing symbol before proceeding. Read-only. Returns JSON: { duplicates: [{ symbol_id, name, file, score }], hasDuplication }.',
    {
      symbol_id: z
        .string()
        .max(512)
        .optional()
        .describe('Existing symbol ID to check for duplicates'),
      name: z
        .string()
        .max(256)
        .optional()
        .describe('Function/class name to check (when symbol_id not available)'),
      kind: z
        .enum(['function', 'class', 'method', 'interface', 'type_alias', 'enum'])
        .optional()
        .describe('Symbol kind to narrow search (default: function)'),
      threshold: z
        .number()
        .min(0.3)
        .max(1.0)
        .optional()
        .describe('Minimum similarity score to report (default: 0.60)'),
    },
    async ({ symbol_id, name, kind, threshold }) => {
      if (!symbol_id && !name) {
        return {
          content: [{ type: 'text', text: j({ error: 'Provide symbol_id or name' }) }],
          isError: true,
        };
      }
      const result = checkSymbolForDuplicates(
        store,
        store.db,
        {
          symbol_id,
          name,
          kind,
        },
        {
          threshold: threshold ?? 0.6,
          maxResults: 15,
        },
      );
      return { content: [{ type: 'text', text: jh('check_duplication', result) }] };
    },
  );

  // ─── E10 — ranking pins ──────────────────────────────────────────────
  //
  // pin_symbol / pin_file boost (or demote, with weight<1) specific targets
  // in PageRank-driven ranking. Weights are multiplicative and applied as a
  // post-rank pass inside getPageRank. The pins table is a flat keyed store
  // capped at PIN_MAX_ACTIVE active rows.

  const pinExpirySchema = z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe('Days until the pin expires (default: 7). Omit to set the default TTL.');

  const pinWeightSchema = z
    .number()
    .min(PIN_WEIGHT_MIN)
    .max(PIN_WEIGHT_MAX)
    .optional()
    .describe(
      `Pin weight multiplier in [${PIN_WEIGHT_MIN}, ${PIN_WEIGHT_MAX}]. Default ${PIN_WEIGHT_DEFAULT}. Values < 1 demote.`,
    );

  function bustRankingCaches(): void {
    invalidatePinsCache();
    invalidatePageRankCache();
  }

  function defaultExpiryMs(expiresInDays?: number): number {
    const days = expiresInDays ?? 7;
    return days * 24 * 60 * 60 * 1000;
  }

  server.tool(
    'pin_symbol',
    'Boost (or demote) a specific symbol in PageRank-driven ranking by setting a multiplicative weight. Pinned symbols also boost their containing file via the same weight. Use to surface canonical examples or architectural keystones. Capped at 50 active pins per project. Returns JSON: { ok, pin? }.',
    {
      symbol_id: z.string().min(1).max(512).describe('Symbol FQN to pin'),
      weight: pinWeightSchema,
      expires_in_days: pinExpirySchema,
    },
    async ({ symbol_id, weight, expires_in_days }) => {
      const result = upsertPin(store.db, {
        scope: 'symbol',
        target_id: symbol_id,
        weight,
        expires_in_ms: defaultExpiryMs(expires_in_days),
        created_by: 'user',
      });
      bustRankingCaches();
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: j({ ok: false, error: result.reason }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: j({ ok: true, pin: result.row }) }] };
    },
  );

  server.tool(
    'pin_file',
    'Boost (or demote) a specific file in PageRank-driven ranking by setting a multiplicative weight on its PageRank score. Use to surface canonical examples, architectural keystones, or files central to a work-in-progress feature. Capped at 50 active pins per project. Returns JSON: { ok, pin? }.',
    {
      file_path: z.string().min(1).max(512).describe('File path to pin (project-relative)'),
      weight: pinWeightSchema,
      expires_in_days: pinExpirySchema,
    },
    async ({ file_path, weight, expires_in_days }) => {
      const result = upsertPin(store.db, {
        scope: 'file',
        target_id: file_path,
        weight,
        expires_in_ms: defaultExpiryMs(expires_in_days),
        created_by: 'user',
      });
      bustRankingCaches();
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: j({ ok: false, error: result.reason }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: j({ ok: true, pin: result.row }) }] };
    },
  );

  server.tool(
    'unpin',
    'Remove a ranking pin by target. Pass either symbol_id (for a pinned symbol) or file_path (for a pinned file). At least one is required. Returns JSON: { ok, deleted }.',
    {
      symbol_id: z.string().max(512).optional().describe('Symbol FQN of the pin to remove'),
      file_path: z.string().max(512).optional().describe('File path of the pin to remove'),
    },
    async ({ symbol_id, file_path }) => {
      if (!symbol_id && !file_path) {
        return {
          content: [
            { type: 'text', text: j({ ok: false, error: 'symbol_id or file_path required' }) },
          ],
          isError: true,
        };
      }
      let total = 0;
      if (symbol_id) {
        total += deletePin(store.db, { scope: 'symbol', target_id: symbol_id }).deleted;
      }
      if (file_path) {
        total += deletePin(store.db, { scope: 'file', target_id: file_path }).deleted;
      }
      bustRankingCaches();
      return { content: [{ type: 'text', text: j({ ok: true, deleted: total }) }] };
    },
  );

  server.tool(
    'list_pins',
    'List all active ranking pins with weight, scope, target, expiry, and creator. Use to inspect what is currently boosted/demoted in PageRank-driven ranking. Read-only. Returns JSON: { pins: [{ scope, target_id, weight, expires_at, created_by, created_at }], total, cap }.',
    {},
    async () => {
      const pins = listPins(store.db);
      return {
        content: [
          {
            type: 'text',
            text: j({ pins, total: pins.length, cap: PIN_MAX_ACTIVE }),
          },
        ],
      };
    },
  );
}
