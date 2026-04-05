import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');
import { z } from 'zod';
import type { Store } from './db/store.js';
import type { PluginRegistry } from './plugin-api/registry.js';
import type { TraceMcpConfig } from './config.js';
import { getIndexHealth, getProjectMap } from './tools/project.js';
import { buildProjectContext } from './indexer/project-context.js';
import { getSymbol, search, getFileOutline, type SearchResultItemProjected } from './tools/navigation.js';
import { getComponentTree } from './tools/components.js';
import { getChangeImpact } from './tools/impact.js';
import { getFeatureContext } from './tools/context.js';
import { IndexingPipeline } from './indexer/pipeline.js';
import { formatToolError } from './errors.js';
import { validatePath } from './utils/security.js';
import { logger } from './logger.js';
import { createAIProvider, BlobVectorStore, type AIProvider, type RerankerService } from './ai/index.js';
import { LLMReranker } from './ai/reranker.js';
import { registerAITools } from './tools/ai-tools.js';
import { getMiddlewareChain } from './tools/middleware-chain.js';
import { getModuleGraph } from './tools/module-graph.js';
import { getDITree } from './tools/di-tree.js';
import { getNavigationGraph } from './tools/rn-navigation.js';
import { getScreenContext } from './tools/screen-context.js';
import { getRequestFlow } from './tools/flow.js';
import { getModelContext } from './tools/model.js';
import { getSchema } from './tools/schema.js';
import { getEventGraph } from './tools/events.js';
import { findReferences } from './tools/references.js';
import { getCallGraph } from './tools/call-graph.js';
import { getLivewireContext } from './tools/livewire.js';
import { getNovaResource } from './tools/nova.js';
import { getTestsFor } from './tools/tests.js';
import { getImplementations, getApiSurface, getPluginRegistry, getTypeHierarchy, getDeadExports, getDependencyGraph, getUntestedExports, selfAudit } from './tools/introspect.js';
import { getCouplingMetrics, getDependencyCycles, getPageRank, getExtractionCandidates, getRepoHealth } from './tools/graph-analysis.js';
import { getChurnRate, getHotspots } from './tools/git-analysis.js';
import { getDeadCodeV2 } from './tools/dead-code.js';
import { checkRenameSafe } from './tools/rename-check.js';
import { applyRename, removeDeadCode, extractFunction } from './tools/refactor.js';
import { getLayerViolations, detectLayerPreset, type LayerDefinition } from './tools/layer-violations.js';
import { getFileOwnership, getSymbolOwnership } from './tools/git-ownership.js';
import { getComplexityTrend } from './tools/complexity-trend.js';
import { getCouplingTrend, getSymbolComplexityTrend } from './tools/history.js';
import { suggestQueries } from './tools/suggest.js';
import { getRelatedSymbols } from './tools/related.js';
import { getContextBundle } from './tools/context-bundle.js';
import { getTaskContext } from './tools/task-context.js';
import { predictBugs, detectDrift, getTechDebt, assessChangeRisk, getHealthTrends } from './tools/predictive-intelligence.js';
import { queryByIntent, getDomainMap, getDomainContext, getCrossDomainDependencies } from './tools/intent.js';
import { graphQuery } from './tools/graph-query.js';
import { getRuntimeProfile, getRuntimeCallGraph, getEndpointAnalytics, getRuntimeDependencies } from './tools/runtime.js';
import { RuntimeIntelligence } from './runtime/lifecycle.js';
import { searchText } from './tools/search-text.js';
import { visualizeGraph, getDependencyDiagram } from './tools/visualize.js';
import { getDataflow } from './tools/dataflow.js';
import { TopologyStore } from './topology/topology-db.js';
import { TOPOLOGY_DB_PATH, ensureGlobalDirs } from './global.js';
import { getServiceMap, getCrossServiceImpact, getApiContract, getServiceDependencies, getContractDrift } from './tools/topology.js';
import { getFederationGraph, getFederationImpact, federationAddRepo, federationSync, getFederationClients } from './tools/federation.js';
import { resolvePreset, listPresets } from './tools/presets.js';
import { withHints } from './tools/hints.js';
import { scanSecurity, type RuleName, type Severity } from './tools/security-scan.js';
import { detectAntipatterns, type AntipatternCategory, type Severity as AntipatternSeverity } from './tools/antipatterns.js';
import { scanCodeSmells, type SmellCategory, type SmellPriority } from './tools/code-smells.js';
import { taintAnalysis, type TaintSourceKind, type TaintSinkKind } from './tools/taint-analysis.js';
import { generateSbom, type SbomFormat } from './tools/sbom.js';
import { getArtifacts, type ArtifactCategory } from './tools/artifacts.js';
import { fallbackSearch, fallbackOutline } from './tools/zero-index.js';
import { planBatchChange } from './tools/batch-changes.js';
import { getCoChanges, collectCoChanges, persistCoChanges } from './tools/co-changes.js';
import { getChangedSymbols, compareBranches } from './tools/changed-symbols.js';
import { SessionTracker } from './session-tracker.js';
import { SessionJournal } from './session-journal.js';
import { auditConfig } from './tools/audit-config.js';
import { AnalyticsStore } from './analytics/analytics-store.js';
import { getSessionAnalytics, getOptimizationReport } from './analytics/session-analytics.js';
import { runBenchmark, formatBenchmarkMarkdown } from './analytics/benchmark.js';
import { detectCoverage } from './analytics/tech-detector.js';
import { analyzeRealSavings } from './analytics/real-savings.js';
import { syncAnalytics } from './analytics/sync.js';
import { evaluateQualityGates, QualityGatesConfigSchema, type QualityGatesConfig } from './tools/quality-gates.js';
import { listBundles, loadAllBundles, searchBundles } from './bundles.js';
import { detectCommunities, getCommunities, getCommunityDetail } from './tools/communities.js';
import { registerPrompts } from './prompts/index.js';
import { packContext } from './tools/pack-context.js';
import { generateDocs } from './tools/generate-docs.js';
import { getPackageDeps } from './tools/package-deps.js';
import { getControlFlow } from './tools/control-flow.js';
import { buildNegativeEvidence } from './tools/evidence.js';
import { FileWatcher } from './file-watcher.js';

/** Compact JSON — no pretty-printing, strip nulls; saves 25–35% tokens on every response */
function j(value: unknown): string {
  return JSON.stringify(value, (_key, val) => (val === null || val === undefined) ? undefined : val);
}

// jh() is defined inside createServer() as a closure over the savings tracker

/** Extract result count from an MCP tool response for journal tracking */
function extractResultCount(response: { content: Array<{ type: string; text: string }>; isError?: boolean }): number {
  if (response?.isError) return 0;
  try {
    const text = response?.content?.[0]?.text;
    if (!text) return 0;
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return 1;
    // Try common count fields
    if (typeof parsed.total === 'number') return parsed.total;
    if (Array.isArray(parsed.items)) return parsed.items.length;
    if (Array.isArray(parsed.symbols)) return parsed.symbols.length;
    if (Array.isArray(parsed.references)) return parsed.references.length;
    if (Array.isArray(parsed.data)) return parsed.data.length;
    return 1; // non-empty response = at least 1 result
  } catch {
    return 1;
  }
}

/** Apply per-parameter description overrides to a Zod-like schema object.
 *  `toolOverrides` are from the tool-specific nested config, `sharedOverrides` from `_shared`. */
function applyParamOverrides(
  schema: Record<string, unknown>,
  toolOverrides: Record<string, string>,
  sharedOverrides: Record<string, string>,
): void {
  for (const paramName of Object.keys(schema)) {
    const desc = toolOverrides[paramName] ?? sharedOverrides[paramName];
    if (desc) {
      const zodType = schema[paramName];
      if (zodType && typeof zodType === 'object' && 'describe' in zodType && typeof (zodType as { describe: unknown }).describe === 'function') {
        schema[paramName] = (zodType as { describe: (d: string) => unknown }).describe(desc);
      }
    }
  }
}

export function createServer(
  store: Store,
  registry: PluginRegistry,
  config: TraceMcpConfig,
  rootPath?: string,
): McpServer {
  const projectRoot = rootPath ?? process.cwd();

  // Determine which framework plugins are registered → drives dynamic tool registration
  const frameworkNames = new Set(
    registry.getAllFrameworkPlugins().map((p) => p.manifest.name),
  );
  const has = (...names: string[]) => names.some((n) => frameworkNames.has(n));
  const detectedFrameworks = [...frameworkNames].join(', ') || 'none';

  const server = new McpServer(
    { name: 'trace-mcp', version: PKG_VERSION },
    {
      instructions: [
        `trace-mcp is a framework-aware code intelligence server for this project. Detected frameworks: ${detectedFrameworks}.`,
        '',
        'IMPORTANT: For ANY code exploration task, ALWAYS use trace-mcp tools first. NEVER fall back to Read/Grep/Glob/Bash(ls,find) for navigating source code — trace-mcp gives semantic, structured results that are cheaper in tokens and more accurate.',
        '',
        'WHEN TO USE trace-mcp tools:',
        '',
        'Navigation & search:',
        '- Finding a function/class/method → `search` (understands symbol kinds, FQNs, language filters; use `implements`/`extends` to filter by interface)',
        '- Understanding a file before editing → `get_outline` (signatures only — cheaper than Read)',
        '- Reading one symbol\'s source → `get_symbol` (returns only the symbol, not the whole file)',
        '- Quick keyword context → `get_feature_context` (NL query → relevant symbols + source)',
        '- Starting work on a task → `get_task_context` (NL task → full execution context with tests)',
        '',
        'Relationships & impact:',
        '- What breaks if I change X → `get_change_impact` (reverse dependency graph)',
        '- Who calls this / what does it call → `get_call_graph` (bidirectional)',
        '- All usages of a symbol → `find_usages` (semantic: imports, calls, renders, dispatches)',
        '- Tests for a symbol/file → `get_tests_for` (understands test-to-source mapping)',
        '',
        'Architecture & meta-analysis:',
        '- All implementations of an interface → `get_type_hierarchy` (walks extends/implements tree)',
        '- All classes implementing X → `search` with `implements` or `extends` filter',
        '- Project health / coverage gaps → `self_audit` (dead exports, untested code, hotspots)',
        '- Module dependency graph → `get_module_graph` (NestJS) or `get_import_graph`',
        '- Dead code / dead exports → `get_dead_code` / `get_dead_exports`',
        '- Circular dependencies → `get_circular_imports`',
        '- Coupling analysis → `get_coupling`',
        '',
        'Framework-specific:',
        '- HTTP request flow → `get_request_flow` (route → middleware → controller → service)',
        '- DB model details → `get_model_context` (relationships, schema, metadata)',
        '- Database schema → `get_schema` (from migrations/ORM definitions)',
        '- Component tree → `get_component_tree` (React/Vue/Angular)',
        '- State stores → `get_state_stores` (Zustand/Redux/Pinia)',
        '- Event graph → `get_event_graph` (event emitters/listeners)',
        '',
        'WHEN TO USE native tools (Read/Grep/Glob):',
        '- Non-code files (.md, .json, .yaml, .toml, config) → Read/Grep',
        '- Reading a file before editing (Edit needs full content) → Read',
        '- Finding files by name pattern → Glob',
        '',
        'Start with `get_project_map` (summary_only=true) to orient yourself.',
      ].join('\n'),
    },
  );

  // --- Tool preset gate ---
  const presetName = process.env.TRACE_MCP_PRESET ?? config.tools?.preset ?? 'full';
  const presetResult = resolvePreset(presetName);
  const activePreset = presetResult ?? 'all'; // unknown preset → full
  const includeSet = config.tools?.include ? new Set(config.tools.include) : null;
  const excludeSet = config.tools?.exclude ? new Set(config.tools.exclude) : null;

  function toolAllowed(name: string): boolean {
    if (excludeSet?.has(name)) return false;
    if (includeSet?.has(name)) return true;
    if (activePreset === 'all') return true;
    return activePreset.has(name);
  }

  /** Gated tool registration — skips tools not in the active preset.
   *  Also wraps the callback to record tool calls for savings tracking.
   *  Supports description overrides: flat string or nested { _description, param: desc, ... }.
   *  The special `_shared` key in descriptions applies to all tools' parameters. */
  const _originalTool = server.tool.bind(server);
  const registeredToolNames: string[] = [];
  const toolHandlers = new Map<string, (params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>>();
  const descriptionOverrides = config.tools?.descriptions ?? {};
  const sharedParamOverrides = (typeof descriptionOverrides._shared === 'object' && descriptionOverrides._shared !== null)
    ? descriptionOverrides._shared as Record<string, string>
    : {};
  server.tool = ((...args: unknown[]) => {
    const name = args[0] as string;
    if (!toolAllowed(name)) return undefined as never;
    registeredToolNames.push(name);

    const override = descriptionOverrides[name];
    if (override) {
      if (typeof override === 'string') {
        // Flat override: replace entire tool description
        if (typeof args[1] === 'string') args[1] = override;
      } else if (typeof override === 'object') {
        // Nested override: _description for tool, other keys for params
        const obj = override as Record<string, string>;
        if (obj._description && typeof args[1] === 'string') {
          args[1] = obj._description;
        }
        // Apply per-parameter description overrides to Zod schema
        const schemaIdx = typeof args[1] === 'string' ? 2 : 1;
        const schema = args[schemaIdx];
        if (schema && typeof schema === 'object') {
          applyParamOverrides(schema as Record<string, unknown>, obj, sharedParamOverrides);
        }
      }
    } else if (Object.keys(sharedParamOverrides).length > 0) {
      // Apply _shared overrides even when no tool-specific override exists
      const schemaIdx = typeof args[1] === 'string' ? 2 : 1;
      const schema = args[schemaIdx];
      if (schema && typeof schema === 'object') {
        applyParamOverrides(schema as Record<string, unknown>, {}, sharedParamOverrides);
      }
    }

    // Wrap the last argument (callback) to record calls + journal
    const cbIdx = args.length - 1;
    const originalCb = args[cbIdx] as Function;
    if (typeof originalCb === 'function') {
      // Capture handler for batch API (calls original directly, no savings/journal double-counting)
      toolHandlers.set(name, async (params: Record<string, unknown>) => {
        return await originalCb(params) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      });

      args[cbIdx] = async (...cbArgs: unknown[]) => {
        savings.recordCall(name);
        // Extract params from MCP callback args (first arg is the params object)
        const params = (cbArgs[0] && typeof cbArgs[0] === 'object') ? cbArgs[0] as Record<string, unknown> : {};

        // Check for duplicate query before executing
        const duplicateCheck = journal.checkDuplicate(name, params);
        if (duplicateCheck) {
          // Still execute but prepend warning to response
          const result = await originalCb(...cbArgs) as { content: Array<{ type: string; text: string }>; isError?: boolean };
          if (result?.content?.[0]?.text && !result.isError) {
            try {
              const parsed = JSON.parse(result.content[0].text);
              const obj = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
                ? parsed : { data: parsed };
              obj._duplicate_warning = duplicateCheck;
              result.content[0].text = JSON.stringify(obj);
            } catch { /* keep original response */ }
          }
          // Record in journal after execution
          const count = extractResultCount(result);
          journal.record(name, params, count);
          return result;
        }

        const result = await originalCb(...cbArgs);
        const count = extractResultCount(result as { content: Array<{ type: string; text: string }> });
        journal.record(name, params, count);
        return result;
      };
    }
    return (_originalTool as Function)(...args);
  }) as typeof server.tool;

  if (presetName !== 'full') {
    logger.info({ preset: presetName, tools: activePreset === 'all' ? 'all' : activePreset.size }, 'Tool preset active');
  }

  // --- Session savings tracker + journal ---
  const savings = new SessionTracker(projectRoot);
  const journal = new SessionJournal();

  // Flush savings on process exit
  const flushSavings = () => savings.flush();
  process.on('SIGINT', flushSavings);
  process.on('SIGTERM', flushSavings);
  process.on('exit', flushSavings);

  /** JSON-serialize with contextual next-step hints + budget warnings */
  let budgetWarningShown = false;
  function jh(toolName: string, value: unknown): string {
    const hinted = withHints(toolName, value);
    const stats = savings.getSessionStats();
    if (stats.total_calls >= 15 && !budgetWarningShown) {
      budgetWarningShown = true;
      const obj = (hinted !== null && typeof hinted === 'object' && !Array.isArray(hinted))
        ? hinted as Record<string, unknown>
        : { data: hinted };
      obj._budget_warning = `${stats.total_calls} tool calls this session (~${stats.total_raw_tokens} raw tokens). Consider using get_task_context or get_feature_context for consolidated context instead of many small queries.`;
      return j(obj);
    }
    return j(hinted);
  }

  // AI layer (optional)
  const aiProvider: AIProvider = createAIProvider(config);
  const vectorStore = config.ai?.enabled ? new BlobVectorStore(store.db) : null;
  const embeddingService = config.ai?.enabled ? aiProvider.embedding() : null;
  const reranker: RerankerService | null = config.ai?.enabled
    ? new LLMReranker(aiProvider.fastInference())
    : null;

  // --- Auto-reindex file watcher ---
  if (config.watch?.enabled !== false) {
    const knownExtensions = new Set(registry.getLanguagePlugins().flatMap(p => p.supportedExtensions));
    const fileWatcher = new FileWatcher(
      projectRoot,
      async (files) => {
        const pipeline = new IndexingPipeline(store, registry, config, projectRoot);
        await pipeline.indexFiles(files);
      },
      {
        debounceMs: config.watch?.debounceMs ?? 2000,
        extensions: knownExtensions,
      },
    );
    fileWatcher.start();

    const stopWatcher = () => fileWatcher.stop();
    process.on('SIGINT', stopWatcher);
    process.on('SIGTERM', stopWatcher);
    process.on('exit', stopWatcher);
  }

  /** Validate a user-supplied path stays within projectRoot; returns error response on failure */
  function guardPath(filePath: string): { content: [{ type: 'text'; text: string }]; isError: true } | null {
    const check = validatePath(filePath, projectRoot);
    if (check.isErr()) {
      return { content: [{ type: 'text', text: j(formatToolError(check.error)) }], isError: true };
    }
    return null;
  }

  // --- Zero-index Fallback Tools ---

  server.tool(
    'fallback_search',
    'On-the-fly text search using ripgrep — works without an index. Use when the index is empty or stale. Returns file matches with line numbers. Suggest `reindex` after using this.',
    {
      query: z.string().min(1).max(500).describe('Search query (text or regex)'),
      file_pattern: z.string().max(256).optional().describe('Glob filter (e.g. "*.ts", "src/**/*.py")'),
      case_sensitive: z.boolean().optional().describe('Case-sensitive search (default: false)'),
      max_results: z.number().int().min(1).max(200).optional().describe('Max results (default: 50)'),
    },
    async ({ query, file_pattern, case_sensitive, max_results }) => {
      const result = fallbackSearch(projectRoot, query, {
        filePattern: file_pattern,
        caseSensitive: case_sensitive,
        maxResults: max_results,
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'fallback_outline',
    'Regex-based symbol extraction for a single file — works without an index. Extracts classes, functions, interfaces, types, variables. Use when the index is unavailable. Suggest `reindex` after using this.',
    {
      path: z.string().min(1).max(512).describe('Relative file path'),
    },
    async ({ path: filePath }) => {
      const blocked = guardPath(filePath);
      if (blocked) return blocked;
      try {
        const result = fallbackOutline(projectRoot, filePath);
        return { content: [{ type: 'text', text: j(result) }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text', text: j({ error: 'File not found or unreadable', path: filePath }) }], isError: true };
      }
    },
  );

  // --- Core Tools (always registered) ---

  server.tool(
    'get_index_health',
    'Get index status, statistics, and health information',
    {},
    async () => {
      const result = getIndexHealth(store, config);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'reindex',
    'Trigger (re)indexing of the project or a subdirectory',
    {
      path: z.string().max(512).optional().describe('Subdirectory to index (default: project root)'),
      force: z.boolean().optional().describe('Skip hash check and reindex all files'),
    },
    async ({ path: indexPath, force }) => {
      if (indexPath) {
        const blocked = guardPath(indexPath);
        if (blocked) return blocked;
      }
      logger.info({ path: indexPath, force }, 'Reindex requested');
      const pipeline = new IndexingPipeline(store, registry, config, projectRoot);

      const result = indexPath
        ? await pipeline.indexFiles([indexPath])
        : await pipeline.indexAll(force ?? false);

      return { content: [{ type: 'text', text: j({ status: 'completed', ...result }) }] };
    },
  );

  server.tool(
    'get_project_map',
    'Get project overview: detected frameworks, languages, file counts, structure. Call with summary_only=true at session start to orient yourself before diving into code.',
    {
      summary_only: z.boolean().optional().describe('Return only framework list + counts (default false)'),
    },
    async ({ summary_only }) => {
      const ctx = buildProjectContext(projectRoot);
      const result = getProjectMap(store, registry, summary_only ?? false, ctx);
      return { content: [{ type: 'text', text: jh('get_project_map', result) }] };
    },
  );

  // --- Env Vars Tool ---

  server.tool(
    'get_env_vars',
    'List environment variable keys from .env files with inferred value types/formats. Never exposes actual values — only keys, types (string/number/boolean/empty), and formats (url/email/ip/path/uuid/json/base64/csv/dsn/etc). Use to understand project configuration without accessing secrets.',
    {
      pattern: z.string().max(256).optional().describe('Filter keys by pattern (e.g. "DB_" or "REDIS")'),
      file: z.string().max(512).optional().describe('Filter by specific .env file path'),
    },
    async ({ pattern, file }) => {
      let vars = pattern ? store.searchEnvVars(pattern) : store.getAllEnvVars();

      if (file) {
        vars = vars.filter((v) => v.file_path === file || v.file_path.endsWith(file));
      }

      if (vars.length === 0) {
        return { content: [{ type: 'text', text: 'No env vars found. Run indexing first or adjust the filter.' }] };
      }

      // Group by file
      const grouped: Record<string, { key: string; type: string; format: string | null; comment: string | null }[]> = {};
      for (const v of vars) {
        const arr = grouped[v.file_path] ??= [];
        arr.push({
          key: v.key,
          type: v.value_type,
          format: v.value_format,
          comment: v.comment,
        });
      }

      return { content: [{ type: 'text', text: j(grouped) }] };
    },
  );

  // --- Level 1 Navigation Tools ---

  server.tool(
    'get_symbol',
    'Look up a symbol by symbol_id or FQN and return its source code. Use instead of Read when you need one specific function/class/method — returns only the symbol, not the whole file.',
    {
      symbol_id: z.string().max(512).optional().describe('The symbol_id to look up'),
      fqn: z.string().max(512).optional().describe('The fully qualified name to look up'),
      max_lines: z.number().int().min(1).max(10000).optional().describe('Truncate source to this many lines (omit for full source)'),
    },
    async ({ symbol_id, fqn, max_lines }) => {
      const result = getSymbol(store, projectRoot, { symbolId: symbol_id, fqn, maxLines: max_lines });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      const { symbol, file, source, truncated } = result.value;
      return {
        content: [{
          type: 'text',
          text: jh('get_symbol', {
            symbol_id: symbol.symbol_id,
            name: symbol.name,
            kind: symbol.kind,
            fqn: symbol.fqn,
            signature: symbol.signature,
            summary: symbol.summary,
            file: file.path,
            line_start: symbol.line_start,
            line_end: symbol.line_end,
            source,
            ...(truncated ? { truncated: true } : {}),
          }),
        }],
      };
    },
  );

  server.tool(
    'search',
    'Search symbols by name, kind, or text. Use instead of Grep when looking for functions, classes, methods, or variables in source code. Supports kind/language/file_pattern filters. Set fuzzy=true for typo-tolerant search (trigram + Levenshtein). Auto-falls back to fuzzy if exact search returns 0 results.',
    {
      query: z.string().min(1).max(500).describe('Search query'),
      kind: z.string().max(64).optional().describe('Filter by symbol kind (class, method, function, etc.)'),
      language: z.string().max(64).optional().describe('Filter by language'),
      file_pattern: z.string().max(512).optional().describe('Filter by file path pattern'),
      implements: z.string().max(256).optional().describe('Filter to classes implementing this interface'),
      extends: z.string().max(256).optional().describe('Filter to classes/interfaces extending this name'),
      fuzzy: z.boolean().optional().describe('Enable fuzzy search (trigram + Levenshtein). Auto-enabled when exact search returns 0 results.'),
      fuzzy_threshold: z.number().min(0).max(1).optional().describe('Minimum Jaccard trigram similarity (default 0.3)'),
      max_edit_distance: z.number().int().min(1).max(10).optional().describe('Maximum Levenshtein edit distance (default 3)'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default 20)'),
      offset: z.number().int().min(0).max(50000).optional().describe('Offset for pagination'),
    },
    async ({ query, kind, language, file_pattern, limit, offset, implements: impl, extends: ext, fuzzy, fuzzy_threshold, max_edit_distance }) => {
      const result = await search(
        store,
        query,
        { kind, language, filePattern: file_pattern, implements: impl, extends: ext },
        limit ?? 20,
        offset ?? 0,
        { vectorStore, embeddingService, reranker },
        { fuzzy, fuzzyThreshold: fuzzy_threshold, maxEditDistance: max_edit_distance },
      );
      // Project to AI-useful fields only — strips DB internals (id, file_id, byte offsets, etc.)
      const items: SearchResultItemProjected[] = result.items.map(({ symbol, file, score }) => ({
        symbol_id: symbol.symbol_id,
        name: symbol.name,
        kind: symbol.kind,
        fqn: symbol.fqn,
        signature: symbol.signature,
        summary: symbol.summary,
        file: file.path,
        line: symbol.line_start,
        score,
      }));
      const response: Record<string, unknown> = { items, total: result.total, search_mode: result.search_mode };
      if (items.length === 0) {
        // Auto-fallback: try text search when symbol search finds nothing
        const textResult = searchText(store, projectRoot, {
          query,
          filePattern: file_pattern,
          language,
          maxResults: Math.min(limit ?? 20, 10),
          contextLines: 1,
        });
        if (textResult.isOk() && textResult.value.matches.length > 0) {
          const tv = textResult.value;
          response.fallback_text_matches = tv.matches;
          response.fallback_total = tv.total_matches;
          response.search_mode = 'symbol_miss_text_fallback';
        } else {
          const stats = store.getStats();
          response.evidence = buildNegativeEvidence(
            stats.totalFiles, stats.totalSymbols,
            result.search_mode === 'fuzzy' || !!fuzzy,
            'search',
          );
        }
      }
      return { content: [{ type: 'text', text: jh('search', response) }] };
    },
  );

  server.tool(
    'get_outline',
    'Get all symbols for a file (signatures only, no bodies). Use instead of Read to understand a file before editing — much cheaper in tokens.',
    {
      path: z.string().max(512).describe('Relative file path'),
    },
    async ({ path: filePath }) => {
      const blocked = guardPath(filePath);
      if (blocked) return blocked;
      const result = getFileOutline(store, filePath);
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: jh('get_outline', result.value) }] };
    },
  );

  server.tool(
    'get_change_impact',
    'Full change impact report: reverse dependencies, risk scoring, affected tests, co-change hidden couplings, module grouping, and actionable mitigations. Use before making any change to understand blast radius and plan safely.',
    {
      file_path: z.string().max(512).optional().describe('Relative file path to analyze'),
      symbol_id: z.string().max(512).optional().describe('Symbol ID to analyze'),
      depth: z.number().int().min(1).max(20).optional().describe('Max traversal depth (default 3)'),
      max_dependents: z.number().int().min(1).max(5000).optional().describe('Cap on returned dependents (default 200)'),
    },
    async ({ file_path, symbol_id, depth, max_dependents }) => {
      if (file_path) {
        const blocked = guardPath(file_path);
        if (blocked) return blocked;
      }
      const result = getChangeImpact(
        store,
        { filePath: file_path, symbolId: symbol_id },
        depth ?? 3,
        max_dependents ?? 200,
        projectRoot,
      );
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: jh('get_change_impact', result.value) }] };
    },
  );

  server.tool(
    'get_feature_context',
    'Find relevant symbols and code for a natural language feature description. Use as a starting point when given a task — assembles the most relevant source within a token budget.',
    {
      description: z.string().min(1).max(2000).describe('Natural language description of the feature to find context for'),
      token_budget: z.number().int().min(100).max(100000).optional().describe('Max tokens for assembled context (default 4000)'),
    },
    async ({ description, token_budget }) => {
      const result = getFeatureContext(store, projectRoot, description, token_budget ?? 4000);
      if (result.items.length === 0) {
        const stats = store.getStats();
        const enriched = { ...result, evidence: buildNegativeEvidence(stats.totalFiles, stats.totalSymbols, false, 'get_feature_context') };
        return { content: [{ type: 'text', text: jh('get_feature_context', enriched) }] };
      }
      return { content: [{ type: 'text', text: jh('get_feature_context', result) }] };
    },
  );

  server.tool(
    'suggest_queries',
    'Onboarding helper: shows top imported files, most connected symbols (PageRank), language stats, and example tool calls. Call this first when exploring an unfamiliar project.',
    {},
    async () => {
      const result = suggestQueries(store);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_related_symbols',
    'Find symbols related via co-location (same file), shared importers, and name similarity. Useful for discovering related code when exploring a symbol.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to find related symbols for'),
      max_results: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    async ({ symbol_id, max_results }) => {
      const result = getRelatedSymbols(store, { symbolId: symbol_id, maxResults: max_results ?? 20 });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: jh('get_related_symbols', result.value) }] };
    },
  );

  server.tool(
    'get_context_bundle',
    'Get a symbol\'s source code + its import dependencies + optional callers, packed within a token budget. Supports batch queries with shared-import deduplication.',
    {
      symbol_id: z.string().max(512).optional().describe('Single symbol ID'),
      symbol_ids: z.array(z.string().max(512)).max(20).optional().describe('Batch: multiple symbol IDs'),
      fqn: z.string().max(512).optional().describe('Alternative: look up by FQN'),
      include_callers: z.boolean().optional().describe('Include who calls these symbols (default false)'),
      token_budget: z.number().int().min(100).max(100000).optional().describe('Max tokens (default 8000)'),
      output_format: z.enum(['json', 'markdown']).optional().describe('Output format (default json)'),
    },
    async ({ symbol_id, symbol_ids, fqn, include_callers, token_budget, output_format }) => {
      const ids = symbol_ids ?? (symbol_id ? [symbol_id] : []);
      const result = getContextBundle(store, projectRoot, {
        symbolIds: ids,
        fqn: fqn ?? undefined,
        includeCallers: include_callers ?? false,
        tokenBudget: token_budget ?? 8000,
        outputFormat: output_format ?? 'json',
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: jh('get_context_bundle', result.value) }] };
    },
  );

  server.tool(
    'get_task_context',
    'Get the optimal code context for a development task. Traces execution paths through the dependency graph, includes relevant tests, and adapts strategy based on task type (bug fix, new feature, refactor). Use this as your PRIMARY context-gathering tool when starting work on a task — it replaces manual chaining of search → get_symbol → get_context_bundle.',
    {
      task: z.string().min(1).max(2000).describe('Natural language description of the task'),
      token_budget: z.number().int().min(100).max(100000).optional().describe('Max tokens (default 8000)'),
      focus: z.enum(['minimal', 'broad', 'deep']).optional().describe('Context strategy: minimal (fast, essential only), broad (default, wide net), deep (follow full execution chains)'),
      include_tests: z.boolean().optional().describe('Include relevant test files (default true)'),
    },
    async ({ task, token_budget, focus, include_tests }) => {
      const result = await getTaskContext(store, projectRoot, {
        task,
        tokenBudget: token_budget ?? 8000,
        focus: focus ?? 'broad',
        includeTests: include_tests ?? true,
      }, { vectorStore, embeddingService });
      return { content: [{ type: 'text', text: jh('get_task_context', result) }] };
    },
  );

  // --- Level 2 Framework Tools ---

  if (has('vue', 'nuxt', 'inertia')) {
    server.tool(
      'get_component_tree',
      'Build a component render tree starting from a given .vue file',
      {
        component_path: z.string().max(512).describe('Relative path to the root .vue file'),
        depth: z.number().int().min(1).max(20).optional().describe('Max tree depth (default 3)'),
        token_budget: z.number().int().min(100).max(100000).optional().describe('Max tokens for the tree (default 8000)'),
      },
      async ({ component_path, depth, token_budget }) => {
        const blocked = guardPath(component_path);
        if (blocked) return blocked;
        const result = getComponentTree(store, component_path, depth ?? 3, token_budget ?? 8000);
        if (result.isErr()) {
          return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        }
        return { content: [{ type: 'text', text: jh('get_component_tree', result.value) }] };
      },
    );
  }

  // --- Level 3 Framework-Specific Tools ---

  if (has('express', 'nestjs', 'laravel', 'fastapi', 'flask', 'drf', 'spring', 'rails', 'fastify', 'hono', 'trpc')) {
    server.tool(
      'get_request_flow',
      'Trace request flow for a URL+method: route → middleware → controller → service (Laravel/Express/NestJS/Fastify/Hono/tRPC/FastAPI/Flask/DRF)',
      {
        url: z.string().max(512).describe('Route URL (e.g. /api/users)'),
        method: z.string().max(64).optional().describe('HTTP method (default GET)'),
      },
      async ({ url, method }) => {
        const result = getRequestFlow(store, url, method ?? 'GET');
        if (result.isErr()) {
          return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        }
        return { content: [{ type: 'text', text: jh('get_request_flow', result.value) }] };
      },
    );
  }

  if (has('express', 'nestjs', 'fastapi', 'flask', 'spring')) {
    server.tool(
      'get_middleware_chain',
      'Trace middleware chain for a route URL (Express/NestJS/FastAPI/Flask)',
      {
        url: z.string().max(512).describe('Route URL to trace middleware for'),
      },
      async ({ url }) => {
        const result = getMiddlewareChain(store, projectRoot, url);
        if (result.isErr()) {
          return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        }
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );
  }

  if (has('nestjs')) {
    server.tool(
      'get_module_graph',
      'Build NestJS module dependency graph (module -> imports -> controllers -> providers -> exports)',
      {
        module_name: z.string().max(256).describe('NestJS module class name (e.g. AppModule)'),
      },
      async ({ module_name }) => {
        const result = getModuleGraph(store, projectRoot, module_name);
        if (result.isErr()) {
          return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        }
        return { content: [{ type: 'text', text: jh('get_module_graph', result.value) }] };
      },
    );

    server.tool(
      'get_di_tree',
      'Trace NestJS dependency injection tree (what a service injects + who injects it)',
      {
        service_name: z.string().max(256).describe('NestJS service/provider class name'),
      },
      async ({ service_name }) => {
        const result = getDITree(store, service_name);
        if (result.isErr()) {
          return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        }
        return { content: [{ type: 'text', text: jh('get_di_tree', result.value) }] };
      },
    );
  }

  if (has('react-native')) {
    server.tool(
      'get_navigation_graph',
      'Build React Native navigation tree from screens, navigators, and deep links',
      {},
      async () => {
        const result = getNavigationGraph(store);
        if (result.isErr()) {
          return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        }
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_screen_context',
      'Get full context for a React Native screen: navigator, navigation edges, deep link, platform variants, native modules',
      {
        screen_name: z.string().max(256).describe('Screen name (e.g. ProfileScreen or Profile)'),
      },
      async ({ screen_name }) => {
        const result = getScreenContext(store, screen_name);
        if (result.isErr()) {
          return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        }
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );
  }

  if (has('laravel', 'mongoose', 'sequelize', 'prisma', 'typeorm', 'drizzle', 'sqlalchemy')) {
    server.tool(
      'get_model_context',
      'Get full model context: relationships, schema, and metadata (Eloquent/Mongoose/Sequelize/SQLAlchemy/Prisma/TypeORM/Drizzle)',
      {
        model_name: z.string().max(256).describe('Model class name (e.g. User, Post)'),
      },
      async ({ model_name }) => {
        const result = getModelContext(store, model_name);
        if (result.isErr()) {
          return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        }
        return { content: [{ type: 'text', text: jh('get_model_context', result.value) }] };
      },
    );

    server.tool(
      'get_schema',
      'Get database schema reconstructed from migrations or ORM model definitions',
      {
        table_name: z.string().max(256).optional().describe('Table/collection/model name (omit for all)'),
      },
      async ({ table_name }) => {
        const result = getSchema(store, table_name);
        if (result.isErr()) {
          return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        }
        return { content: [{ type: 'text', text: jh('get_schema', result.value) }] };
      },
    );
  }

  if (has('laravel', 'nestjs', 'celery', 'django', 'socketio')) {
    server.tool(
      'get_event_graph',
      'Get event/signal/task dispatch graph (Laravel events, Django signals, NestJS events, Celery tasks, Socket.io events)',
      {
        event_name: z.string().max(256).optional().describe('Filter to a specific event class name'),
      },
      async ({ event_name }) => {
        const result = getEventGraph(store, event_name);
        if (result.isErr()) {
          return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        }
        return { content: [{ type: 'text', text: jh('get_event_graph', result.value) }] };
      },
    );
  }

  server.tool(
    'find_usages',
    'Find all places that reference a symbol or file (imports, calls, renders, dispatches). Use instead of Grep for symbol usages — understands semantic relationships, not just text matches.',
    {
      symbol_id: z.string().max(512).optional().describe('Symbol ID to find references for'),
      fqn: z.string().max(512).optional().describe('Fully qualified name to find references for'),
      file_path: z.string().max(512).optional().describe('File path to find references for'),
    },
    async ({ symbol_id, fqn, file_path }) => {
      if (file_path) {
        const blocked = guardPath(file_path);
        if (blocked) return blocked;
      }
      const result = findReferences(store, { symbolId: symbol_id, fqn, filePath: file_path });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      if (result.value.total === 0) {
        const stats = store.getStats();
        const enriched = { ...result.value, evidence: buildNegativeEvidence(stats.totalFiles, stats.totalSymbols, false, 'find_usages') };
        return { content: [{ type: 'text', text: jh('find_usages', enriched) }] };
      }
      return { content: [{ type: 'text', text: jh('find_usages', result.value) }] };
    },
  );

  server.tool(
    'get_call_graph',
    'Build a bidirectional call graph centered on a symbol (who calls it + what it calls). Use to understand control flow through a function.',
    {
      symbol_id: z.string().max(512).optional().describe('Symbol ID to center the graph on'),
      fqn: z.string().max(512).optional().describe('Fully qualified name to center the graph on'),
      depth: z.number().int().min(1).max(20).optional().describe('Traversal depth on each side (default 2)'),
    },
    async ({ symbol_id, fqn, depth }) => {
      const result = getCallGraph(store, { symbolId: symbol_id, fqn }, depth ?? 2);
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: jh('get_call_graph', result.value) }] };
    },
  );

  server.tool(
    'get_tests_for',
    'Find test files and test functions that cover a given symbol or file. Use instead of Glob/Grep — understands test-to-source mapping, not just filename conventions.',
    {
      symbol_id: z.string().max(512).optional().describe('Symbol ID to find tests for'),
      fqn: z.string().max(512).optional().describe('Fully qualified name to find tests for'),
      file_path: z.string().max(512).optional().describe('File path to find tests for'),
    },
    async ({ symbol_id, fqn, file_path }) => {
      if (file_path) {
        const blocked = guardPath(file_path);
        if (blocked) return blocked;
      }
      const result = getTestsFor(store, { symbolId: symbol_id, fqn, filePath: file_path });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: jh('get_tests_for', result.value) }] };
    },
  );

  if (has('laravel')) {
    server.tool(
      'get_livewire_context',
      'Get full context for a Livewire component: properties, actions, events, view, child components',
      {
        component_name: z.string().max(256).describe('Livewire component class name or FQN (e.g. UserProfile or App\\Livewire\\UserProfile)'),
      },
      async ({ component_name }) => {
        const result = getLivewireContext(store, component_name);
        if (result.isErr()) {
          return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        }
        return { content: [{ type: 'text', text: jh('get_livewire_context', result.value) }] };
      },
    );

    server.tool(
      'get_nova_resource',
      'Get full context for a Laravel Nova resource: model, fields, actions, filters, lenses, metrics',
      {
        resource_name: z.string().max(256).describe('Nova resource class name or FQN (e.g. User or App\\Nova\\User)'),
      },
      async ({ resource_name }) => {
        const result = getNovaResource(store, resource_name);
        if (result.isErr()) {
          return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        }
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );
  }

  if (has('zustand-redux')) {
    server.tool(
      'get_state_stores',
      'List all Zustand stores and Redux Toolkit slices with their state fields, actions/reducers, and dispatch sites',
      {},
      async () => {
        const routes = store.getAllRoutes();
        const stores = routes.filter((r) => r.method === 'STORE' || r.method === 'SLICE');
        const dispatches = routes.filter((r) => r.method === 'DISPATCH');
        return {
          content: [{
            type: 'text',
            text: j({
              stores: stores.map((s) => ({
                type: s.method === 'STORE' ? 'zustand' : 'redux',
                name: s.uri.replace(/^(zustand|redux):/, ''),
                handler: s.handler,
                metadata: s.metadata ? JSON.parse(s.metadata) : null,
              })),
              dispatches: dispatches.map((d) => ({
                action: d.uri.replace(/^action:/, ''),
                file: d.file_id ? store.getFileById(d.file_id)?.path : null,
              })),
              totalStores: stores.length,
              totalDispatches: dispatches.length,
            }),
          }],
        };
      },
    );
  }

  // --- Self-Development / Introspection Tools ---

  server.tool(
    'get_implementations',
    'Find all classes that implement or extend a given interface or base class',
    {
      name: z.string().max(256).describe('Interface or base class name (e.g. UserRepositoryInterface)'),
    },
    async ({ name }) => {
      const result = getImplementations(store, name);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_api_surface',
    'List all exported symbols (public API) of a file or matching files',
    {
      file_pattern: z.string().max(512).optional().describe('Glob-style pattern to filter files (e.g. src/services/*.ts)'),
    },
    async ({ file_pattern }) => {
      const result = getApiSurface(store, file_pattern);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_plugin_registry',
    'List all registered indexer plugins and the edge types they emit',
    {},
    async () => {
      const result = getPluginRegistry(store, registry, frameworkNames);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_type_hierarchy',
    'Walk TypeScript class/interface hierarchy: ancestors (what it extends/implements) and descendants (what extends/implements it)',
    {
      name: z.string().max(256).describe('Class or interface name (e.g. "LanguagePlugin", "Store")'),
      max_depth: z.number().int().min(1).max(20).optional().describe('Max traversal depth (default 10)'),
    },
    async ({ name, max_depth }) => {
      const result = getTypeHierarchy(store, name, max_depth ?? 10);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_dead_exports',
    'Find exported symbols never imported by any other file — dead code candidates',
    {
      file_pattern: z.string().max(512).optional().describe('Filter files by glob pattern (e.g. "src/tools/*.ts")'),
    },
    async ({ file_pattern }) => {
      const result = getDeadExports(store, file_pattern);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_import_graph',
    'Show file-level dependency graph: what a file imports and what imports it (requires reindex for ESM edge resolution)',
    {
      file_path: z.string().max(512).describe('Relative file path to analyze (e.g. "src/server.ts")'),
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
    'Find exported public symbols with no matching test file — test coverage gaps',
    {
      file_pattern: z.string().max(512).optional().describe('Filter by file glob pattern (e.g. "src/tools/%")'),
    },
    async ({ file_pattern }) => {
      const result = getUntestedExports(store, file_pattern);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );


  server.tool('self_audit', 'One-shot project health audit: dead exports, untested code, dependency hotspots, heritage metrics', {}, async () => {
    return { content: [{ type: 'text', text: j(selfAudit(store)) }] };
  });

  // --- Graph Analysis Tools ---

  server.tool(
    'get_coupling',
    'Coupling analysis: afferent (Ca), efferent (Ce), instability index per file. Shows which modules are stable vs unstable',
    {
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default: all)'),
      assessment: z.enum(['stable', 'neutral', 'unstable', 'isolated']).optional().describe('Filter by stability assessment'),
    },
    async ({ limit, assessment }) => {
      let results = getCouplingMetrics(store);
      if (assessment) results = results.filter((r) => r.assessment === assessment);
      if (limit) results = results.slice(0, limit);
      return { content: [{ type: 'text', text: jh('get_coupling_metrics', results) }] };
    },
  );

  server.tool(
    'get_circular_imports',
    'Find circular dependency chains in the import graph (Kosaraju SCC algorithm)',
    {},
    async () => {
      const cycles = getDependencyCycles(store);
      return {
        content: [{
          type: 'text',
          text: jh('get_dependency_cycles', {
            total_cycles: cycles.length,
            cycles,
            ...(cycles.length === 0 ? { message: 'No circular dependencies found' } : {}),
          }),
        }],
      };
    },
  );

  server.tool(
    'get_pagerank',
    'File importance ranking via PageRank on the import graph. Shows most central/important files',
    {
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default: 50)'),
    },
    async ({ limit }) => {
      const results = getPageRank(store);
      return { content: [{ type: 'text', text: jh('get_page_rank', results.slice(0, limit ?? 50)) }] };
    },
  );

  server.tool(
    'get_refactor_candidates',
    'Find functions with high complexity called from many files — candidates for extraction to shared modules',
    {
      min_cyclomatic: z.number().int().min(1).optional().describe('Min cyclomatic complexity (default: 5)'),
      min_callers: z.number().int().min(1).optional().describe('Min distinct caller files (default: 2)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 20)'),
    },
    async ({ min_cyclomatic, min_callers, limit }) => {
      const results = getExtractionCandidates(store, {
        minCyclomatic: min_cyclomatic,
        minCallers: min_callers,
        limit,
      });
      return { content: [{ type: 'text', text: j(results) }] };
    },
  );

  server.tool(
    'get_project_health',
    'Comprehensive project health: coupling metrics, dependency cycles, PageRank, extraction candidates, hotspots — all in one call',
    {},
    async () => {
      const result = getRepoHealth(store);
      const hotspots = getHotspots(store, projectRoot);
      return { content: [{ type: 'text', text: jh('get_repo_health', { ...result, hotspots: hotspots.slice(0, 10) }) }] };
    },
  );

  // --- Git Analysis Tools ---

  server.tool(
    'get_git_churn',
    'Per-file git churn: commits, unique authors, frequency, volatility assessment. Requires git.',
    {
      since_days: z.number().int().min(1).optional().describe('Analyze commits from last N days (default: all history)'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default: 50)'),
      file_pattern: z.string().max(256).optional().describe('Filter files containing this substring'),
    },
    async ({ since_days, limit, file_pattern }) => {
      const results = getChurnRate(projectRoot, {
        sinceDays: since_days,
        limit,
        filePattern: file_pattern,
      });
      if (results.length === 0) {
        return { content: [{ type: 'text', text: j({ message: 'No git history available or no matching files' }) }] };
      }
      return { content: [{ type: 'text', text: j(results) }] };
    },
  );

  server.tool(
    'get_risk_hotspots',
    'Code hotspots: files with both high complexity AND high git churn (Adam Tornhill methodology). Score = complexity × log(1 + commits)',
    {
      since_days: z.number().int().min(1).optional().describe('Git churn window in days (default: 90)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 20)'),
      min_cyclomatic: z.number().int().min(1).optional().describe('Min cyclomatic complexity to consider (default: 3)'),
    },
    async ({ since_days, limit, min_cyclomatic }) => {
      const results = getHotspots(store, projectRoot, {
        sinceDays: since_days,
        limit,
        minCyclomatic: min_cyclomatic,
      });
      if (results.length === 0) {
        return { content: [{ type: 'text', text: j({ message: 'No hotspots found (no complex files with git churn)' }) }] };
      }
      return { content: [{ type: 'text', text: jh('get_hotspots', results) }] };
    },
  );

  server.tool(
    'get_dead_code',
    'Multi-signal dead code detection: combines import graph, call graph, and barrel export analysis. Confidence = signals_fired / 3. More accurate than get_dead_exports.',
    {
      file_pattern: z.string().max(512).optional().describe('Filter by file glob pattern (e.g. "src/tools/%")'),
      threshold: z.number().min(0).max(1).optional().describe('Min confidence to report (default: 0.5 = at least 2 of 3 signals)'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default: 50)'),
    },
    async ({ file_pattern, threshold, limit }) => {
      const result = getDeadCodeV2(store, {
        filePattern: file_pattern,
        threshold,
        limit,
      });
      return { content: [{ type: 'text', text: jh('get_dead_code', result) }] };
    },
  );

  server.tool(
    'scan_security',
    'Scan project files for OWASP Top-10 security vulnerabilities using pattern matching. Detects SQL injection (CWE-89), XSS (CWE-79), command injection (CWE-78), path traversal (CWE-22), hardcoded secrets (CWE-798), insecure crypto (CWE-327), open redirects (CWE-601), and SSRF (CWE-918). Skips test files.',
    {
      scope: z.string().max(512).optional().describe('Directory to scan (default: whole project)'),
      rules: z.array(z.enum([
        'sql_injection', 'xss', 'command_injection', 'path_traversal',
        'hardcoded_secrets', 'insecure_crypto', 'open_redirect', 'ssrf', 'all',
      ])).min(1).describe('Rules to apply (use ["all"] for full scan)'),
      severity_threshold: z.enum(['critical', 'high', 'medium', 'low']).optional()
        .describe('Minimum severity to report (default: low)'),
    },
    async ({ scope, rules, severity_threshold }) => {
      if (scope) {
        const blocked = guardPath(scope);
        if (blocked) return blocked;
      }
      const result = scanSecurity(store, projectRoot, {
        scope,
        rules: rules as RuleName[],
        severityThreshold: severity_threshold as Severity | undefined,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'detect_antipatterns',
    'Detect performance antipatterns: N+1 query risks, missing eager loading, unbounded queries, event listener leaks, circular model dependencies, missing indexes. Static analysis across all indexed ORMs (Eloquent, Sequelize, Mongoose, Django, Prisma, TypeORM, Drizzle).',
    {
      category: z.array(z.enum([
        'n_plus_one_risk', 'missing_eager_load', 'unbounded_query',
        'event_listener_leak', 'circular_dependency', 'missing_index',
      ])).optional().describe('Antipattern categories to check (default: all)'),
      file_pattern: z.string().max(512).optional().describe('Filter to files matching this pattern'),
      severity_threshold: z.enum(['critical', 'high', 'medium', 'low']).optional()
        .describe('Minimum severity to report (default: low)'),
      limit: z.number().int().min(1).max(500).optional().describe('Max findings to return (default: 100)'),
    },
    async ({ category, file_pattern, severity_threshold, limit }) => {
      const result = detectAntipatterns(store, projectRoot, {
        category: category as AntipatternCategory[] | undefined,
        file_pattern,
        severity_threshold: severity_threshold as AntipatternSeverity | undefined,
        limit,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: jh('detect_antipatterns', result.value) }] };
    },
  );

  server.tool(
    'scan_code_smells',
    'Find deferred work and shortcuts: TODO/FIXME/HACK/XXX comments, empty functions & stubs, hardcoded values (IPs, URLs, credentials, magic numbers, feature flags). Surfaces technical debt that grep alone misses by combining comment scanning, symbol body analysis, and context-aware false-positive filtering.',
    {
      category: z.array(z.enum([
        'todo_comment', 'empty_function', 'hardcoded_value',
      ])).optional().describe('Categories to scan (default: all)'),
      scope: z.string().max(512).optional().describe('Directory to scan (default: whole project)'),
      priority_threshold: z.enum(['high', 'medium', 'low']).optional()
        .describe('Minimum priority to report (default: low)'),
      include_tests: z.boolean().optional()
        .describe('Include test files in scan (default: false)'),
      tags: z.array(z.string().max(64)).optional()
        .describe('Filter TODO comments by tag (e.g. ["FIXME","HACK"]). Only applies to todo_comment category'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max findings to return (default: 200)'),
    },
    async ({ category, scope, priority_threshold, include_tests, tags, limit }) => {
      if (scope) {
        const blocked = guardPath(scope);
        if (blocked) return blocked;
      }
      const result = scanCodeSmells(store, projectRoot, {
        category: category as SmellCategory[] | undefined,
        scope,
        priority_threshold: priority_threshold as SmellPriority | undefined,
        include_tests,
        tags,
        limit,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: jh('scan_code_smells', result.value) }] };
    },
  );

  server.tool(
    'taint_analysis',
    'Track flow of untrusted data from sources (HTTP params, env vars, file reads) to dangerous sinks (SQL queries, exec, innerHTML, redirects). Framework-aware: knows Express req.params, Laravel $request->input, Django request.GET, FastAPI Query(), etc. Reports unsanitized flows with CWE IDs and fix suggestions. More accurate than pattern-based scanning — traces actual data flow paths.',
    {
      scope: z.string().max(512).optional().describe('Directory to scan (default: whole project)'),
      sources: z.array(z.enum([
        'http_param', 'http_body', 'http_header', 'cookie',
        'env', 'file_read', 'db_result', 'user_input',
      ])).optional().describe('Filter by source kinds (default: all)'),
      sinks: z.array(z.enum([
        'sql_query', 'exec', 'eval', 'innerHTML', 'redirect',
        'file_write', 'response_body', 'template_raw',
      ])).optional().describe('Filter by sink kinds (default: all)'),
      include_sanitized: z.boolean().optional().describe('Include flows with sanitizers (default: false)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max flows to return (default: 100)'),
    },
    async ({ scope, sources, sinks, include_sanitized, limit }) => {
      if (scope) {
        const blocked = guardPath(scope);
        if (blocked) return blocked;
      }
      const result = taintAnalysis(store, projectRoot, {
        scope,
        sources: sources as TaintSourceKind[] | undefined,
        sinks: sinks as TaintSinkKind[] | undefined,
        includeSanitized: include_sanitized,
        limit,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'generate_sbom',
    'Generate a Software Bill of Materials (SBOM) from package manifests and lockfiles. Supports npm, Composer, pip, Go, Cargo, Bundler, Maven. Outputs CycloneDX, SPDX, or plain JSON. Includes license compliance warnings for copyleft licenses.',
    {
      format: z.enum(['cyclonedx', 'spdx', 'json']).optional().describe('Output format (default: json)'),
      include_dev: z.boolean().optional().describe('Include devDependencies (default: false)'),
      include_transitive: z.boolean().optional().describe('Include transitive dependencies (default: true)'),
    },
    async ({ format, include_dev, include_transitive }) => {
      const result = generateSbom(projectRoot, {
        format: format as SbomFormat | undefined,
        includeDev: include_dev,
        includeTransitive: include_transitive,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'get_artifacts',
    'Surface non-code knowledge from the index: DB schemas (migrations, ORM models), API specs (routes, OpenAPI endpoints), infrastructure (docker-compose services, K8s resources), CI pipelines (jobs, stages), and config (env vars). All data from the existing index — no extra I/O.',
    {
      category: z.enum(['database', 'api', 'infra', 'ci', 'config', 'all']).optional()
        .describe('Filter by artifact category (default: all)'),
      query: z.string().max(256).optional().describe('Text filter on name/kind/file'),
      limit: z.number().int().min(1).max(1000).optional().describe('Max results (default: 200)'),
    },
    async ({ category, query, limit }) => {
      const result = getArtifacts(store, {
        category: category as ArtifactCategory | undefined,
        query,
        limit,
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'plan_batch_change',
    'Analyze the impact of updating a package/dependency. Shows all affected files, import references, and generates a PR template with checklist. Use before upgrading a dependency to understand blast radius.',
    {
      package: z.string().min(1).max(256).describe('Package name (e.g. "express", "laravel/framework", "react")'),
      from_version: z.string().max(64).optional().describe('Current version'),
      to_version: z.string().max(64).optional().describe('Target version'),
      breaking_changes: z.array(z.string().max(500)).max(20).optional().describe('Known breaking changes to include in the report'),
    },
    async ({ package: pkg, from_version, to_version, breaking_changes }) => {
      const result = planBatchChange(store, {
        package: pkg,
        fromVersion: from_version,
        toVersion: to_version,
        breakingChanges: breaking_changes,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'get_complexity_report',
    'Get complexity metrics (cyclomatic, max nesting, param count) for symbols in a file or across the project. Useful for identifying complex code before refactoring.',
    {
      file_path: z.string().max(512).optional().describe('File path to report on (omit for project-wide top complex symbols)'),
      min_cyclomatic: z.number().int().min(1).optional().describe('Min cyclomatic complexity to include (default: 1 for file, 5 for project)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default: 30)'),
      sort_by: z.enum(['cyclomatic', 'nesting', 'params']).optional().describe('Sort by metric (default: cyclomatic)'),
    },
    async ({ file_path, min_cyclomatic, limit: lim, sort_by }) => {
      if (file_path) {
        const blocked = guardPath(file_path);
        if (blocked) return blocked;
      }
      const sortCol = sort_by === 'nesting' ? 's.max_nesting' : sort_by === 'params' ? 's.param_count' : 's.cyclomatic';
      const threshold = min_cyclomatic ?? (file_path ? 1 : 5);
      const maxRows = lim ?? 30;

      const conditions = ['s.cyclomatic IS NOT NULL', `s.cyclomatic >= ?`];
      const params: unknown[] = [threshold];
      if (file_path) {
        conditions.push('f.path = ?');
        params.push(file_path);
      }
      params.push(maxRows);

      const rows = store.db.prepare(`
        SELECT s.symbol_id, s.name, s.kind, f.path as file, s.line_start as line,
               s.cyclomatic, s.max_nesting, s.param_count
        FROM symbols s JOIN files f ON s.file_id = f.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${sortCol} DESC
        LIMIT ?
      `).all(...params);

      return { content: [{ type: 'text', text: j(rows) }] };
    },
  );

  server.tool(
    'check_rename',
    'Pre-rename collision detection: checks the symbol\'s own file and all importing files for existing symbols with the target name',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to rename'),
      target_name: z.string().min(1).max(256).describe('Proposed new name'),
    },
    async ({ symbol_id, target_name }) => {
      const result = checkRenameSafe(store, symbol_id, target_name);
      return { content: [{ type: 'text', text: jh('check_rename_safe', result) }] };
    },
  );

  // --- Refactoring Execution Tools ---

  server.tool(
    'apply_rename',
    'Rename a symbol across all usages (definition + all importing files). Runs collision detection first and aborts on conflicts. Returns the list of edits applied.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to rename (from search or outline)'),
      new_name: z.string().min(1).max(256).describe('New name for the symbol'),
    },
    async ({ symbol_id, new_name }) => {
      const result = applyRename(store, projectRoot, symbol_id, new_name);
      if (!result.success) {
        return { content: [{ type: 'text', text: j(result) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'remove_dead_code',
    'Safely remove a dead symbol from its file. Verifies the symbol is actually dead (multi-signal detection or zero incoming edges) before removal. Warns about orphaned imports in other files.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to remove (from get_dead_code results)'),
    },
    async ({ symbol_id }) => {
      const result = removeDeadCode(store, projectRoot, symbol_id);
      if (!result.success) {
        return { content: [{ type: 'text', text: j(result) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'extract_function',
    'Extract a range of lines into a new named function. Detects parameters (variables from outer scope) and return values (variables used after the range). Supports TypeScript/JavaScript, Python, and Go.',
    {
      file_path: z.string().max(512).describe('File path (relative to project root)'),
      start_line: z.number().int().min(1).describe('First line to extract (1-indexed, inclusive)'),
      end_line: z.number().int().min(1).describe('Last line to extract (1-indexed, inclusive)'),
      function_name: z.string().min(1).max(256).describe('Name for the extracted function'),
    },
    async ({ file_path, start_line, end_line, function_name }) => {
      const blocked = guardPath(file_path);
      if (blocked) return blocked;
      const result = extractFunction(store, projectRoot, file_path, start_line, end_line, function_name);
      if (!result.success) {
        return { content: [{ type: 'text', text: j(result) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- Architecture & Ownership Tools ---

  server.tool(
    'check_architecture',
    'Check architectural layer rules: detect forbidden imports between layers (e.g. domain importing infrastructure). Supports auto-detected presets (clean-architecture, hexagonal) or custom layers.',
    {
      preset: z.enum(['clean-architecture', 'hexagonal']).optional().describe('Use a built-in layer preset (auto-detected if omitted)'),
      layers: z.array(z.object({
        name: z.string().min(1).max(64),
        path_prefixes: z.array(z.string().min(1).max(256)).min(1),
        may_not_import: z.array(z.string().min(1).max(64)),
      })).max(20).optional().describe('Custom layer definitions (overrides preset)'),
    },
    async ({ preset, layers: customLayers }) => {
      let layerDefs: LayerDefinition[];

      if (customLayers && customLayers.length > 0) {
        layerDefs = customLayers;
      } else if (preset) {
        const { LAYER_PRESETS } = await import('./tools/layer-violations.js');
        layerDefs = LAYER_PRESETS[preset] ?? [];
      } else {
        // Auto-detect
        const detected = detectLayerPreset(store);
        if (!detected) {
          return { content: [{ type: 'text', text: j({ message: 'No layer structure detected. Provide layers or use a preset.' }) }] };
        }
        layerDefs = detected.layers;
      }

      const result = getLayerViolations(store, layerDefs);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_code_owners',
    'Git-based code ownership: who contributed most to specific files (git shortlog). Requires git.',
    {
      file_paths: z.array(z.string().max(512)).min(1).max(20).describe('File paths to check ownership for'),
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
    'Git blame-based symbol ownership: who wrote which lines of a specific symbol. Requires git.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to check ownership for'),
    },
    async ({ symbol_id }) => {
      const result = getSymbolOwnership(store, projectRoot, symbol_id);
      if (!result) {
        return { content: [{ type: 'text', text: j({ message: 'Could not determine ownership (no git or symbol not found)' }) }] };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_complexity_trend',
    'Complexity trend for a file: compares current cyclomatic complexity with historical git snapshots. Shows if code is getting more or less complex over time.',
    {
      file_path: z.string().max(512).describe('File path to analyze'),
      snapshots: z.number().int().min(2).max(20).optional().describe('Number of historical snapshots (default: 5)'),
    },
    async ({ file_path, snapshots }) => {
      const blocked = guardPath(file_path);
      if (blocked) return blocked;
      const result = getComplexityTrend(store, projectRoot, file_path, { snapshots });
      if (!result) {
        return { content: [{ type: 'text', text: j({ message: 'No complexity data or git history for this file' }) }] };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- Historical Graph Analysis (Time Machine) ---

  server.tool(
    'get_coupling_trend',
    'Coupling trend for a file over time: tracks Ca (afferent), Ce (efferent), and instability across git history. Shows whether a module is stabilizing or destabilizing. Complements get_git_churn with structural graph data.',
    {
      file_path: z.string().max(512).describe('File path to analyze'),
      since_days: z.number().int().min(1).optional().describe('Analyze last N days (default: 90)'),
      snapshots: z.number().int().min(2).max(20).optional().describe('Number of historical snapshots (default: 6)'),
    },
    async ({ file_path, since_days, snapshots }) => {
      const blocked = guardPath(file_path);
      if (blocked) return blocked;
      const result = getCouplingTrend(store, projectRoot, file_path, {
        sinceDays: since_days,
        snapshots,
      });
      if (!result) {
        return { content: [{ type: 'text', text: j({ message: 'No coupling data or git history for this file' }) }] };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_symbol_complexity_trend',
    'Per-symbol complexity trend: tracks cyclomatic complexity, nesting depth, param count, and line count for a specific function/method/class across git history. Shows whether a symbol is getting more or less complex over time.',
    {
      symbol_id: z.string().min(1).max(512).describe('Symbol ID to analyze (from search or outline)'),
      since_days: z.number().int().min(1).optional().describe('Analyze last N days (default: all history)'),
      snapshots: z.number().int().min(2).max(20).optional().describe('Number of historical snapshots (default: 6)'),
    },
    async ({ symbol_id, since_days, snapshots }) => {
      const result = getSymbolComplexityTrend(store, projectRoot, symbol_id, {
        sinceDays: since_days,
        snapshots,
      });
      if (!result) {
        return { content: [{ type: 'text', text: j({ message: 'Symbol not found or no git history available' }) }] };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- Multi-Repo Topology Tools (optional) ---
  if (config.topology?.enabled) {
    ensureGlobalDirs();
    const topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
    const additionalRepos = config.topology.repos ?? [];

    server.tool(
      'get_service_map',
      'Get map of all services, their APIs, and inter-service dependencies. Auto-detects services from Docker Compose or treats each repo as a service.',
      {
        include_endpoints: z.boolean().optional().describe('Include full endpoint list per service (default false)'),
      },
      async ({ include_endpoints }) => {
        const result = getServiceMap(topoStore, projectRoot, additionalRepos, { includeEndpoints: include_endpoints });
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_cross_service_impact',
      'Analyze cross-service impact of changing an endpoint or event. Shows which services would be affected.',
      {
        service: z.string().min(1).max(256).describe('Service name'),
        endpoint: z.string().max(512).optional().describe('Endpoint path (e.g. /api/users/{id})'),
        event: z.string().max(256).optional().describe('Event channel name (e.g. user.created)'),
      },
      async ({ service, endpoint, event }) => {
        const result = getCrossServiceImpact(topoStore, projectRoot, additionalRepos, { service, endpoint, event });
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_api_contract',
      'Get API contract (OpenAPI/gRPC/GraphQL) for a service. Parses spec files found in the service repo.',
      {
        service: z.string().min(1).max(256).describe('Service name'),
        contract_type: z.enum(['openapi', 'grpc', 'graphql']).optional().describe('Filter by contract type'),
      },
      async ({ service, contract_type }) => {
        const result = getApiContract(topoStore, projectRoot, additionalRepos, { service, contractType: contract_type });
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_service_deps',
      'Get external service dependencies: which services this one calls (outgoing) and which call it (incoming).',
      {
        service: z.string().min(1).max(256).describe('Service name'),
        direction: z.enum(['outgoing', 'incoming', 'both']).optional().describe('Dependency direction (default both)'),
      },
      async ({ service, direction }) => {
        const result = getServiceDependencies(topoStore, projectRoot, additionalRepos, { service, direction });
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_contract_drift',
      'Detect mismatches between API spec and implementation: endpoints in spec but not in code, or in code but not in spec.',
      {
        service: z.string().min(1).max(256).describe('Service name'),
      },
      async ({ service }) => {
        const result = getContractDrift(topoStore, store, projectRoot, additionalRepos, { service });
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    // --- Federation Tools (within topology block) ---

    server.tool(
      'get_federation_graph',
      'Show all federated repositories and their cross-repo connections. Displays repos, endpoints, client calls, and inter-repo dependency edges.',
      {},
      async () => {
        const result = getFederationGraph(topoStore);
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_federation_impact',
      'Cross-repo impact analysis: find all client code across federated repos that would break if an endpoint changes. Resolves down to symbol level when per-repo indexes exist.',
      {
        endpoint: z.string().max(512).optional().describe('Endpoint path pattern (e.g. /api/users)'),
        method: z.string().max(10).optional().describe('HTTP method filter (e.g. GET, POST)'),
        service: z.string().max(256).optional().describe('Service name filter'),
      },
      async ({ endpoint, method, service }) => {
        const result = getFederationImpact(topoStore, { endpoint, method, service });
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'federation_add_repo',
      'Add a repository to the federation. Discovers services, parses API contracts (OpenAPI/gRPC/GraphQL), scans for HTTP client calls, and links them to known endpoints.',
      {
        repo_path: z.string().min(1).max(1024).describe('Absolute or relative path to the repository'),
        name: z.string().max(256).optional().describe('Display name for the repo (default: directory basename)'),
        contract_paths: z.array(z.string().max(512)).optional().describe('Explicit contract file paths relative to repo root'),
      },
      async ({ repo_path, name, contract_paths }) => {
        const result = federationAddRepo(topoStore, { repoPath: repo_path, name, contractPaths: contract_paths });
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'federation_sync',
      'Re-scan all federated repos: re-discover services, re-parse contracts, re-scan client calls, and re-link everything.',
      {},
      async () => {
        const result = federationSync(topoStore);
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_federation_clients',
      'Find all client calls across federated repos that call a specific endpoint. Shows file, line, call type, and confidence.',
      {
        endpoint: z.string().min(1).max(512).describe('Endpoint path to search for (e.g. /api/users)'),
        method: z.string().max(10).optional().describe('HTTP method filter'),
      },
      async ({ endpoint, method }) => {
        const result = getFederationClients(topoStore, { endpoint, method });
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );
  }

  // --- Runtime Intelligence Tools (optional) ---
  if (config.runtime?.enabled) {
    const runtimeIntelligence = new RuntimeIntelligence(store, {
      enabled: true,
      otlp: config.runtime.otlp,
      retention: config.runtime.retention,
      mapping: config.runtime.mapping,
    });
    runtimeIntelligence.start().catch((e) => logger.error({ error: e }, 'Failed to start Runtime Intelligence'));

    server.tool(
      'get_runtime_profile',
      'Runtime profile for a symbol or route: call count, latency percentiles (p50/p95/p99), error rate, calls per hour. Requires OTLP trace ingestion.',
      {
        symbol_id: z.string().max(512).optional().describe('Symbol ID to profile'),
        fqn: z.string().max(512).optional().describe('Fully qualified name'),
        route_uri: z.string().max(512).optional().describe('Route URI to profile'),
        since: z.string().max(64).optional().describe('ISO8601 start time (default: 24h ago)'),
      },
      async ({ symbol_id, fqn, route_uri, since }) => {
        const result = getRuntimeProfile(store, { symbolId: symbol_id, fqn, routeUri: route_uri, since });
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_runtime_call_graph',
      'Actual call graph from runtime traces (vs static analysis). Shows observed call paths with call counts and latency.',
      {
        symbol_id: z.string().max(512).optional().describe('Symbol ID as root'),
        fqn: z.string().max(512).optional().describe('Fully qualified name as root'),
        depth: z.number().int().min(1).max(10).optional().describe('Max traversal depth (default 3)'),
        since: z.string().max(64).optional().describe('ISO8601 start time (default: 24h ago)'),
      },
      async ({ symbol_id, fqn, depth, since }) => {
        const result = getRuntimeCallGraph(store, { symbolId: symbol_id, fqn, depth, since });
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_endpoint_analytics',
      'Per-route analytics: request count, error rate, latency, caller services. Requires OTLP trace ingestion.',
      {
        uri: z.string().max(512).describe('Route URI (e.g. "/api/users/{id}")'),
        method: z.string().max(10).optional().describe('HTTP method filter'),
        since: z.string().max(64).optional().describe('ISO8601 start time (default: 24h ago)'),
      },
      async ({ uri, method, since }) => {
        const result = getEndpointAnalytics(store, { uri, method, since });
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );

    server.tool(
      'get_runtime_deps',
      'Which external services (databases, caches, APIs, queues) does this code actually call at runtime. Based on OTLP traces.',
      {
        symbol_id: z.string().max(512).optional().describe('Symbol ID'),
        fqn: z.string().max(512).optional().describe('Fully qualified name'),
        file_path: z.string().max(512).optional().describe('File path'),
      },
      async ({ symbol_id, fqn, file_path }) => {
        if (file_path) {
          const blocked = guardPath(file_path);
          if (blocked) return blocked;
        }
        const result = getRuntimeDependencies(store, { symbolId: symbol_id, fqn, filePath: file_path });
        if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
        return { content: [{ type: 'text', text: j(result.value) }] };
      },
    );
  }

  // --- Intent Layer Tools ---

  server.tool(
    'query_by_intent',
    'Natural language query to find code by business intent (e.g. "how are refunds processed?", "authentication flow"). Searches symbols and maps them to business domains.',
    {
      query: z.string().min(1).max(500).describe('Business-level question about the codebase'),
      limit: z.number().int().min(1).max(50).optional().describe('Max symbols to return (default 15)'),
    },
    async ({ query, limit }) => {
      const result = queryByIntent(store, query, { limit });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      if (result.value.symbols.length === 0) {
        const stats = store.getStats();
        const enriched = { ...result.value, evidence: buildNegativeEvidence(stats.totalFiles, stats.totalSymbols, false, 'query_by_intent') };
        return { content: [{ type: 'text', text: j(enriched) }] };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'get_domain_map',
    'Get hierarchical map of business domains with key symbols per domain. Auto-builds domain taxonomy on first call using heuristic classification.',
    {
      depth: z.number().int().min(1).max(5).optional().describe('Max taxonomy depth (default 3)'),
      include_symbols: z.boolean().optional().describe('Include top symbols per domain (default true)'),
      symbols_per_domain: z.number().int().min(1).max(20).optional().describe('Max symbols per domain (default 5)'),
    },
    async ({ depth, include_symbols, symbols_per_domain }) => {
      const result = await getDomainMap(store, { depth, includeSymbols: include_symbols, symbolsPerDomain: symbols_per_domain });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'get_domain_context',
    'Get all code related to a specific business domain. Supports "parent/child" notation (e.g. "payments/refunds").',
    {
      domain: z.string().min(1).max(256).describe('Domain name (e.g. "payments" or "payments/refunds")'),
      include_related: z.boolean().optional().describe('Include symbols from related domains (default false)'),
      token_budget: z.number().int().min(500).max(16000).optional().describe('Token budget for source context (default 4000)'),
    },
    async ({ domain, include_related, token_budget }) => {
      const result = await getDomainContext(store, domain, { includeRelated: include_related, tokenBudget: token_budget });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'get_cross_domain_deps',
    'Show which business domains depend on which. Based on edges between symbols in different domains.',
    {
      domain: z.string().max(256).optional().describe('Focus on a specific domain (default: all)'),
    },
    async ({ domain }) => {
      const result = await getCrossDomainDependencies(store, { domain });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Graph Query (NL → Graph) ---

  server.tool(
    'graph_query',
    'Natural language graph query — ask questions about code relationships and get a subgraph + Mermaid diagram. Examples: "How does authentication flow from login to database?", "What services depend on UserModel?", "Trace the flow through PaymentService".',
    {
      query: z.string().min(1).max(500).describe('Natural language question about code relationships'),
      depth: z.number().int().min(1).max(6).optional().describe('Max traversal depth (default 3)'),
      max_nodes: z.number().int().min(1).max(200).optional().describe('Max nodes in result graph (default 100)'),
    },
    async ({ query, depth, max_nodes }) => {
      const result = graphQuery(store, query, { depth, max_nodes });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: jh('graph_query', result.value) }] };
    },
  );

  // --- Dataflow Analysis ---

  server.tool(
    'get_dataflow',
    'Intra-function dataflow analysis: track how each parameter flows through the function body — into which calls, where it gets mutated, and what is returned. Phase 1: single function scope.',
    {
      symbol_id: z.string().max(512).optional().describe('Symbol ID of the function/method to analyze'),
      fqn: z.string().max(512).optional().describe('Fully qualified name of the function/method'),
      direction: z.enum(['forward', 'backward', 'both']).optional().describe('Analysis direction (default both)'),
      depth: z.number().int().min(1).max(5).optional().describe('Max analysis depth for chained calls (default 3)'),
    },
    async ({ symbol_id, fqn, direction, depth }) => {
      const result = getDataflow(store, projectRoot, { symbolId: symbol_id, fqn, direction, depth });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Graph Visualization ---

  server.tool(
    'visualize_graph',
    'Generate interactive HTML graph visualization of file/symbol dependencies. Opens in browser. Supports force/hierarchical/radial layouts, community detection, color by language/role.',
    {
      scope: z.string().min(1).max(512).describe('Scope: file path, directory (e.g. "src/"), or "project"'),
      depth: z.number().int().min(1).max(5).optional().describe('Max hops from scope (default 2)'),
      layout: z.enum(['force', 'hierarchical', 'radial']).optional().describe('Graph layout algorithm (default force)'),
      color_by: z.enum(['community', 'language', 'framework_role']).optional().describe('Node coloring strategy (default community)'),
      include_edges: z.array(z.string()).optional().describe('Filter edge types (default: all)'),
      output: z.string().max(512).optional().describe('Output file path (default: /tmp/trace-mcp-graph.html)'),
    },
    async ({ scope, depth, layout, color_by, include_edges, output }) => {
      const result = visualizeGraph(store, {
        scope,
        depth,
        layout,
        colorBy: color_by,
        includeEdges: include_edges,
        output,
      });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'get_dependency_diagram',
    'Generate a text-based dependency diagram (Mermaid or DOT format) for inline display in chat. Trims to max_nodes most important nodes for readability.',
    {
      scope: z.string().min(1).max(512).describe('Scope: file path, directory, or "project"'),
      depth: z.number().int().min(1).max(5).optional().describe('Max hops from scope (default 2)'),
      max_nodes: z.number().int().min(1).max(100).optional().describe('Max nodes in diagram (default 30)'),
      format: z.enum(['mermaid', 'dot']).optional().describe('Output format (default mermaid)'),
    },
    async ({ scope, depth, max_nodes, format }) => {
      const result = getDependencyDiagram(store, { scope, depth, maxNodes: max_nodes, format });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Text Search ---

  server.tool(
    'search_text',
    'Full-text search across all indexed files. Supports regex, glob file patterns, language filter. Use for finding strings, comments, TODOs, config values, error messages — anything not captured as a symbol.',
    {
      query: z.string().min(1).max(1000).describe('Search string or regex pattern'),
      is_regex: z.boolean().optional().describe('Treat query as regex (default false)'),
      file_pattern: z.string().max(512).optional().describe('Glob filter, e.g. "src/**/*.ts"'),
      language: z.string().max(64).optional().describe('Filter by language (e.g. "typescript", "python")'),
      max_results: z.number().int().min(1).max(200).optional().describe('Max matches to return (default 50)'),
      context_lines: z.number().int().min(0).max(10).optional().describe('Lines of context before/after each match (default 0 — set higher if you need surrounding code)'),
      case_sensitive: z.boolean().optional().describe('Case-sensitive search (default false)'),
    },
    async ({ query, is_regex, file_pattern, language, max_results, context_lines, case_sensitive }) => {
      const result = searchText(store, projectRoot, {
        query,
        isRegex: is_regex,
        filePattern: file_pattern,
        language,
        maxResults: max_results,
        contextLines: context_lines,
        caseSensitive: case_sensitive,
      });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Predictive Intelligence Tools ---

  server.tool(
    'predict_bugs',
    'Predict which files are most likely to contain bugs. Multi-signal scoring: git churn, fix-commit ratio, complexity, coupling, PageRank importance, author count. Results are cached for 1 hour; use refresh=true to recompute.',
    {
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default: 50)'),
      min_score: z.number().min(0).max(1).optional().describe('Min bug probability score to include (default: 0)'),
      file_pattern: z.string().max(256).optional().describe('Filter files containing this substring'),
      refresh: z.boolean().optional().describe('Force recomputation (default: false)'),
    },
    async ({ limit, min_score, file_pattern, refresh }) => {
      const result = predictBugs(store, projectRoot, {
        limit,
        minScore: min_score,
        filePattern: file_pattern,
        sinceDays: config.predictive?.git_since_days,
        weights: config.predictive?.weights?.bug,
        refresh,
        cacheTtlMinutes: config.predictive?.cache_ttl_minutes,
      });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'detect_drift',
    'Detect architectural drift: cross-module co-change anomalies (files in different modules that always change together) and shotgun surgery patterns (commits touching 3+ modules). Requires git.',
    {
      since_days: z.number().int().min(1).optional().describe('Analyze commits from last N days (default: 180)'),
      min_confidence: z.number().min(0).max(1).optional().describe('Min Jaccard confidence for co-change anomalies (default: 0.3)'),
    },
    async ({ since_days, min_confidence }) => {
      const result = detectDrift(store, projectRoot, {
        sinceDays: since_days ?? config.predictive?.git_since_days,
        minConfidence: min_confidence,
        moduleDepth: config.predictive?.module_depth,
      });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'get_tech_debt',
    'Per-module tech debt score (A–F grade) combining: complexity, coupling instability, test coverage gaps, and git churn. Includes actionable recommendations.',
    {
      module: z.string().max(256).optional().describe('Focus on a specific module path (e.g. "src/tools")'),
      refresh: z.boolean().optional().describe('Force recomputation (default: false)'),
    },
    async ({ module, refresh }) => {
      const result = getTechDebt(store, projectRoot, {
        module,
        moduleDepth: config.predictive?.module_depth,
        sinceDays: config.predictive?.git_since_days,
        weights: config.predictive?.weights?.tech_debt,
        refresh,
      });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'assess_change_risk',
    'Before modifying a file or symbol, predict risk level (low/medium/high/critical) with contributing factors and recommended mitigations. Combines blast radius, complexity, git churn, test coverage, and coupling.',
    {
      file_path: z.string().max(512).optional().describe('File path to assess'),
      symbol_id: z.string().max(512).optional().describe('Symbol ID to assess'),
    },
    async ({ file_path, symbol_id }) => {
      if (file_path) {
        const blocked = guardPath(file_path);
        if (blocked) return blocked;
      }
      const result = assessChangeRisk(store, projectRoot, {
        filePath: file_path,
        symbolId: symbol_id,
        sinceDays: config.predictive?.git_since_days,
        weights: config.predictive?.weights?.change_risk,
      });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'get_health_trends',
    'Time-series health metrics for a file or module: bug score, complexity, coupling, churn over time. Populated by predict_bugs runs.',
    {
      file_path: z.string().max(512).optional().describe('File path to check'),
      module: z.string().max(256).optional().describe('Module path prefix to check'),
      limit: z.number().int().min(1).max(100).optional().describe('Max data points (default: 50)'),
    },
    async ({ file_path, module, limit }) => {
      if (file_path) {
        const blocked = guardPath(file_path);
        if (blocked) return blocked;
      }
      const result = getHealthTrends(store, { filePath: file_path, module, limit });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Workspace / Monorepo ---

  server.tool(
    'get_workspace_map',
    'List all detected monorepo workspaces with file counts, symbol counts, and languages. Returns dependency graph between workspaces showing cross-workspace imports.',
    {
      include_dependencies: z.boolean().optional().describe('Include cross-workspace dependency graph (default: true)'),
    },
    async ({ include_dependencies }) => {
      const workspaces = store.getWorkspaceStats();
      if (workspaces.length === 0) {
        return { content: [{ type: 'text', text: j({ workspaces: [], note: 'No workspaces detected. This project may not be a monorepo, or it has not been indexed yet.' }) }] };
      }

      const result: Record<string, unknown> = {
        workspaces: workspaces.map((ws) => ({
          name: ws.workspace,
          files: ws.file_count,
          symbols: ws.symbol_count,
          languages: ws.languages ? [...new Set(ws.languages.split(',').filter(Boolean))] : [],
        })),
      };

      if (include_dependencies !== false) {
        const deps = store.getWorkspaceDependencyGraph();
        result.dependencies = deps.map((d) => ({
          from: d.from_workspace,
          to: d.to_workspace,
          edges: d.edge_count,
          types: d.edge_types.split(','),
        }));
      }

      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'get_cross_workspace_impact',
    'Show which workspaces are affected by changes in a given workspace. Lists all cross-workspace edges, affected symbols, and the public API surface consumed by other workspaces.',
    {
      workspace: z.string().max(256).describe('Workspace name to analyze'),
    },
    async ({ workspace }) => {
      const exports = store.getWorkspaceExports(workspace);
      const crossEdges = store.getCrossWorkspaceEdges()
        .filter((e) => e.source_workspace === workspace || e.target_workspace === workspace);

      const consumers = new Map<string, Set<string>>();
      for (const edge of crossEdges) {
        if (edge.source_workspace === workspace && edge.target_workspace) {
          // This workspace provides to target
          const key = edge.target_workspace;
          if (!consumers.has(key)) consumers.set(key, new Set());
          if (edge.source_symbol) consumers.get(key)!.add(edge.source_symbol);
        }
      }

      const providers = new Map<string, Set<string>>();
      for (const edge of crossEdges) {
        if (edge.target_workspace === workspace && edge.source_workspace) {
          // This workspace consumes from source
          const key = edge.source_workspace;
          if (!providers.has(key)) providers.set(key, new Set());
          if (edge.target_symbol) providers.get(key)!.add(edge.target_symbol);
        }
      }

      return {
        content: [{
          type: 'text',
          text: j({
            workspace,
            public_api: exports.map((s) => ({
              name: s.name,
              kind: s.kind,
              fqn: s.fqn,
              file: s.file_path,
            })),
            consumed_by: Object.fromEntries(
              [...consumers.entries()].map(([ws, symbols]) => [ws, { symbols: [...symbols], count: symbols.size }]),
            ),
            depends_on: Object.fromEntries(
              [...providers.entries()].map(([ws, symbols]) => [ws, { symbols: [...symbols], count: symbols.size }]),
            ),
            cross_workspace_edges: crossEdges.length,
          }),
        }],
      };
    },
  );

  // --- Resources ---

  server.resource(
    'project-map',
    'project://map',
    { mimeType: 'application/json', description: 'Project map (frameworks, stats, structure)' },
    async () => {
      const ctx = buildProjectContext(projectRoot);
      const result = getProjectMap(store, registry, false, ctx);
      return {
        contents: [{ uri: 'project://map', mimeType: 'application/json', text: j(result) }],
      };
    },
  );

  server.resource(
    'project-health',
    'project://health',
    { mimeType: 'application/json', description: 'Index health status' },
    async () => {
      const result = getIndexHealth(store, config);
      return {
        contents: [{ uri: 'project://health', mimeType: 'application/json', text: j(result) }],
      };
    },
  );


  // --- Co-Change Analysis ---
  server.tool('get_co_changes', 'Find files that frequently change together in git history (temporal coupling).', { file: z.string().min(1).max(512).describe('File path to analyze'), min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence threshold (default 0.3)'), min_count: z.number().int().min(1).optional().describe('Minimum co-change count (default 3)'), window_days: z.number().int().min(1).max(730).optional().describe('Git history window in days (default 180)'), limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)') }, async ({ file, min_confidence, min_count, window_days, limit: lim }) => { const result = getCoChanges(store, { file, minConfidence: min_confidence, minCount: min_count, windowDays: window_days, limit: lim }); if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true }; return { content: [{ type: 'text', text: j(result.value) }] }; });
  server.tool('refresh_co_changes', 'Rebuild co-change index from git history.', { window_days: z.number().int().min(1).max(730).optional().describe('Git history window in days (default 180)') }, async ({ window_days }) => { const days = window_days ?? 180; const pairs = collectCoChanges(projectRoot, days); const count = persistCoChanges(store, pairs, projectRoot, days); return { content: [{ type: 'text', text: j({ status: 'completed', pairs_stored: count, window_days: days }) }] }; });
  // --- Changed Symbols ---
  server.tool('get_changed_symbols', 'Map a git diff to affected symbols (functions, classes, methods). For PR review.', { since: z.string().min(1).max(256).describe('Git ref to compare from (SHA, branch, tag)'), until: z.string().max(256).optional().describe('Git ref to compare to (default: HEAD)'), include_blast_radius: z.boolean().optional().describe('Include blast radius for each changed symbol (default false)'), max_blast_depth: z.number().int().min(1).max(10).optional().describe('Max blast radius traversal depth (default 3)') }, async ({ since, until, include_blast_radius, max_blast_depth }) => { const result = getChangedSymbols(store, projectRoot, { since, until, includeBlastRadius: include_blast_radius, maxBlastDepth: max_blast_depth }); if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true }; return { content: [{ type: 'text', text: j(result.value) }] }; });

  server.tool(
    'compare_branches',
    'Compare two branches at symbol level: what was added, modified, removed. Resolves merge-base automatically, groups by category/file/risk, includes blast radius and risk assessment.',
    {
      branch: z.string().min(1).max(256).describe('Branch to compare (e.g. "feature/payments")'),
      base: z.string().max(256).optional().describe('Base branch (default: "main")'),
      include_blast_radius: z.boolean().optional().describe('Include blast radius per symbol (default true)'),
      max_blast_depth: z.number().int().min(1).max(10).optional().describe('Max blast radius depth (default 3)'),
      group_by: z.enum(['file', 'category', 'risk']).optional().describe('Group results by: file, category (added/modified/removed), or risk level (default: category)'),
    },
    async ({ branch, base, include_blast_radius, max_blast_depth, group_by }) => {
      const result = compareBranches(store, projectRoot, {
        branch,
        base,
        includeBlastRadius: include_blast_radius,
        maxBlastDepth: max_blast_depth,
        groupBy: group_by,
      });
      if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Community Detection ---
  server.tool('detect_communities', 'Run Leiden community detection on the file dependency graph. Identifies tightly-coupled file clusters (modules).', { resolution: z.number().min(0.1).max(5).optional().describe('Resolution parameter — higher values produce more communities (default 1.0)') }, async ({ resolution }) => { const result = detectCommunities(store, resolution ?? 1.0); if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true }; return { content: [{ type: 'text', text: j(result.value) }] }; });
  server.tool('get_communities', 'Get previously detected communities (file clusters). Run detect_communities first.', {}, async () => { const result = getCommunities(store); if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true }; return { content: [{ type: 'text', text: j(result.value) }] }; });
  server.tool('get_community', 'Get details for a specific community: files, inter-community dependencies.', { id: z.number().int().min(0).describe('Community ID') }, async ({ id }) => { const result = getCommunityDetail(store, id); if (result.isErr()) return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true }; return { content: [{ type: 'text', text: j(result.value) }] }; });

  // --- Audit Config ---
  server.tool('audit_config', 'Scan AI agent config files for stale references, dead paths, and token bloat.', { config_files: z.array(z.string().max(512)).optional().describe('Specific config files to audit (default: auto-detect)'), fix_suggestions: z.boolean().optional().describe('Include fix suggestions (default true)') }, async ({ config_files, fix_suggestions }) => { const result = auditConfig(store, projectRoot, { configFiles: config_files, fixSuggestions: fix_suggestions ?? true }); return { content: [{ type: 'text', text: j(result) }] }; });


  // --- Control Flow Graph ---
  server.tool(
    'get_control_flow',
    'Build a Control Flow Graph (CFG) for a function/method: if/else branches, loops, try/catch, returns, throws. Shows logical paths through the code. Outputs Mermaid diagram, ASCII, or JSON.',
    {
      symbol_id: z.string().max(512).optional().describe('Symbol ID of the function/method'),
      fqn: z.string().max(512).optional().describe('Fully qualified name of the function/method'),
      format: z.enum(['json', 'mermaid', 'ascii']).optional().describe('Output format (default: mermaid)'),
      simplify: z.boolean().optional().describe('Collapse sequential statements (default: true)'),
    },
    async ({ symbol_id, fqn, format: fmt, simplify }) => {
      const result = getControlFlow(store, projectRoot, {
        symbolId: symbol_id,
        fqn,
        format: fmt ?? 'mermaid',
        simplify: simplify ?? true,
      });
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  // --- Cross-Repo Package Dependencies ---
  server.tool(
    'get_package_deps',
    'Cross-repo package dependency analysis: find which registered projects depend on a package, or what packages a project publishes. Scans package.json/composer.json/pyproject.toml across all repos in the registry.',
    {
      package: z.string().max(256).optional().describe('Package name to analyze (e.g. "@myorg/shared-utils")'),
      project: z.string().max(256).optional().describe('Project name — analyze all packages it publishes'),
      direction: z.enum(['dependents', 'dependencies', 'both']).optional().describe('Direction (default: both)'),
    },
    async ({ package: pkg, project, direction }) => {
      const result = getPackageDeps({
        package: pkg,
        project,
        direction: direction ?? 'both',
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- Documentation Generation ---
  server.tool(
    'generate_docs',
    'Auto-generate project documentation from the code graph. Produces structured docs with architecture, API surface, data models, components, and dependency analysis.',
    {
      scope: z.enum(['project', 'module', 'directory']).optional().describe('Scope (default: project)'),
      path: z.string().max(512).optional().describe('Path for module/directory scope'),
      format: z.enum(['markdown', 'html']).optional().describe('Output format (default: markdown)'),
      sections: z.array(z.enum(['overview', 'architecture', 'api_surface', 'data_model', 'components', 'events', 'dependencies'])).optional()
        .describe('Sections to include (default: all)'),
    },
    async ({ scope, path: scopePath, format: fmt, sections: secs }) => {
      const result = generateDocs(store, registry, {
        scope: scope ?? 'project',
        path: scopePath,
        format: fmt ?? 'markdown',
        sections: secs ?? ['overview', 'architecture', 'api_surface', 'data_model', 'components', 'events', 'dependencies'],
        projectRoot,
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- Repo Packing ---
  server.tool(
    'pack_context',
    'Pack project context into a single document for external LLMs. Intelligent selection by graph importance, fits within token budget. Better than Repomix for focused context.',
    {
      scope: z.enum(['project', 'module', 'feature']).describe('Scope: project (whole repo), module (subdirectory), feature (NL query)'),
      path: z.string().max(512).optional().describe('Subdirectory path (for module scope)'),
      query: z.string().max(500).optional().describe('Natural language query (for feature scope)'),
      format: z.enum(['xml', 'markdown', 'json']).optional().describe('Output format (default: markdown)'),
      max_tokens: z.number().int().min(1000).max(200000).optional().describe('Token budget (default: 50000)'),
      include: z.array(z.enum(['file_tree', 'outlines', 'source', 'dependencies', 'routes', 'models', 'tests'])).optional()
        .describe('Sections to include (default: outlines + source + routes)'),
      compress: z.boolean().optional().describe('Strip function bodies, keep signatures (default: true)'),
    },
    async ({ scope, path: scopePath, query, format: fmt, max_tokens, include: inc, compress }) => {
      const result = packContext(store, registry, {
        scope,
        path: scopePath,
        query,
        format: fmt ?? 'markdown',
        maxTokens: max_tokens ?? 50000,
        include: inc ?? ['outlines', 'source', 'routes'],
        compress: compress ?? true,
        projectRoot,
      });
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- AI-powered tools (registered only when AI is enabled) ---
  if (config.ai?.enabled) {
    registerAITools(server, {
      store,
      smartInference: aiProvider.inference(),
      fastInference: aiProvider.fastInference(),
      embeddingService,
      vectorStore,
      reranker,
      projectRoot,
    });
  }

  // --- Quality Gates ---

  server.tool(
    'check_quality_gates',
    'Run configurable quality gate checks against the project. Returns pass/fail for each gate (complexity, coupling, circular imports, dead exports, tech debt, security, antipatterns, code smells). Designed for CI integration — AI can verify gates pass before committing.',
    {
      scope: z.enum(['project', 'changed']).optional().describe('Scope: "project" (all) or "changed" (git diff). Default: project'),
      since: z.string().max(128).optional().describe('Git ref for "changed" scope (e.g. "main")'),
      config: z.object({
        fail_on: z.enum(['error', 'warning', 'none']).optional(),
        rules: z.record(z.string(), z.object({
          threshold: z.union([z.number(), z.string()]),
          severity: z.enum(['error', 'warning']).optional(),
        })).optional(),
      }).optional().describe('Inline config overrides (merged with project config)'),
    },
    async ({ scope: _scope, since: _since, config: inlineConfig }) => {
      // Load quality gates config from project config
      let gatesConfig: QualityGatesConfig;
      const rawQG = (config as Record<string, unknown>).quality_gates;
      if (rawQG) {
        const parsed = QualityGatesConfigSchema.safeParse(rawQG);
        gatesConfig = parsed.success ? parsed.data : { enabled: true, fail_on: 'error', rules: {
          max_cyclomatic_complexity: { threshold: 30, severity: 'warning' },
          max_circular_import_chains: { threshold: 0, severity: 'error' },
          max_security_critical_findings: { threshold: 0, severity: 'error' },
        }};
      } else {
        gatesConfig = { enabled: true, fail_on: 'error', rules: {
          max_cyclomatic_complexity: { threshold: 30, severity: 'warning' },
          max_circular_import_chains: { threshold: 0, severity: 'error' },
          max_security_critical_findings: { threshold: 0, severity: 'error' },
        }};
      }

      // Apply inline overrides
      if (inlineConfig?.fail_on) gatesConfig.fail_on = inlineConfig.fail_on;
      if (inlineConfig?.rules) {
        for (const [key, val] of Object.entries(inlineConfig.rules)) {
          (gatesConfig.rules as Record<string, unknown>)[key] = {
            ...(gatesConfig.rules as Record<string, unknown>)[key] as Record<string, unknown> | undefined,
            ...val,
          };
        }
      }

      const report = evaluateQualityGates(store, projectRoot, gatesConfig, {
        sinceDays: config.predictive?.git_since_days,
        moduleDepth: config.predictive?.module_depth,
      });

      return { content: [{ type: 'text', text: j(report) }] };
    },
  );

  // --- Pre-Indexed Bundles ---

  server.tool(
    'search_bundles',
    'Search pre-indexed bundles for symbols from popular libraries (React, Express, etc.). Returns symbol definitions from dependency bundles — useful for go-to-definition into node_modules/vendor. Install bundles via CLI: `trace-mcp bundles export`.',
    {
      query: z.string().min(1).max(256).describe('Symbol name or FQN to search'),
      kind: z.string().max(64).optional().describe('Filter by symbol kind (function, class, interface, etc.)'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default: 20)'),
    },
    async ({ query, kind, limit }) => {
      const bundles = loadAllBundles();
      if (bundles.length === 0) {
        return { content: [{ type: 'text', text: j({ message: 'No bundles installed. Use `trace-mcp bundles export` to create bundles from indexed dependencies.' }) }] };
      }
      const results = searchBundles(bundles, query, { kind, limit });
      for (const b of bundles) b.db.close();
      return { content: [{ type: 'text', text: j({ results, bundles_searched: bundles.length }) }] };
    },
  );

  server.tool(
    'list_bundles',
    'List installed pre-indexed bundles for dependency libraries. Shows package name, version, symbol/edge counts, and size.',
    {},
    async () => {
      const bundles = listBundles();
      return { content: [{ type: 'text', text: j({ bundles, total: bundles.length }) }] };
    },
  );

  // --- Always-registered meta tools (bypass preset gate) ---

  _originalTool(
    'get_preset_info',
    'Show active tool preset, available presets, and which tools are registered in this session',
    {},
    async () => {
      const presets = listPresets();
      return {
        content: [{
          type: 'text',
          text: j({
            active_preset: presetName,
            registered_tools: registeredToolNames.length,
            tool_names: registeredToolNames,
            available_presets: presets,
          }),
        }],
      };
    },
  );

  // --- Analytics: Session Analytics ---
  _originalTool(
    'get_session_analytics',
    'Analyze AI agent session logs: token usage, cost breakdown by tool/server, top files, models used. Parses Claude Code JSONL logs automatically.',
    {
      period: z.enum(['today', 'week', 'month', 'all']).optional().describe('Time period (default: week)'),
      session_id: z.string().max(128).optional().describe('Specific session ID to analyze'),
    },
    async ({ period, session_id }) => {
      try {
        const analyticsStore = new AnalyticsStore();
        try {
          const result = getSessionAnalytics(analyticsStore, { period, sessionId: session_id, projectPath: projectRoot });
          return { content: [{ type: 'text', text: j(result) }] };
        } finally {
          analyticsStore.close();
        }
      } catch (e) {
        return { content: [{ type: 'text', text: j({ error: e instanceof Error ? e.message : String(e) }) }], isError: true };
      }
    },
  );

  // --- Analytics: Optimization Report ---
  _originalTool(
    'get_optimization_report',
    'Detect token waste patterns in AI agent sessions: repeated file reads, Bash grep instead of search, large file reads, unused trace-mcp tools. Provides savings estimates.',
    {
      period: z.enum(['today', 'week', 'month', 'all']).optional().describe('Time period (default: week)'),
    },
    async ({ period }) => {
      try {
        const analyticsStore = new AnalyticsStore();
        try {
          const result = getOptimizationReport(analyticsStore, { period, projectPath: projectRoot });
          return { content: [{ type: 'text', text: j(result) }] };
        } finally {
          analyticsStore.close();
        }
      } catch (e) {
        return { content: [{ type: 'text', text: j({ error: e instanceof Error ? e.message : String(e) }) }], isError: true };
      }
    },
  );

  // --- Analytics: Benchmark ---
  _originalTool(
    'benchmark_project',
    'Synthetic token efficiency benchmark: compare raw file reads vs trace-mcp compact responses across symbol lookup, file exploration, search, and impact analysis scenarios.',
    {
      queries: z.number().int().min(1).max(50).optional().describe('Queries per scenario (default 10)'),
      seed: z.number().int().optional().describe('Random seed for reproducibility (default 42)'),
      format: z.enum(['json', 'markdown']).optional().describe('Output format (default: json)'),
    },
    async ({ queries, seed, format: fmt }) => {
      const result = runBenchmark(store, { queries, seed, projectName: projectRoot });
      if (fmt === 'markdown') {
        return { content: [{ type: 'text', text: formatBenchmarkMarkdown(result) }] };
      }
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  // --- Analytics: Coverage Report ---
  _originalTool(
    'get_coverage_report',
    'Technology profile of the project: detected frameworks/ORMs/UI libs from manifests (package.json, composer.json, etc.), which are covered by trace-mcp plugins, and coverage gaps.',
    {},
    async () => {
      try {
        const result = detectCoverage(projectRoot);
        return { content: [{ type: 'text', text: j(result) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: j({ error: e instanceof Error ? e.message : String(e) }) }], isError: true };
      }
    },
  );

  // --- Analytics: Real Savings ---
  _originalTool(
    'get_real_savings',
    'Analyze actual session logs to show how much could be saved by using trace-mcp instead of raw Read/Bash file reads. Includes per-file breakdown and A/B comparison of sessions with/without trace-mcp.',
    {
      period: z.enum(['today', 'week', 'month', 'all']).optional().describe('Time period (default: week)'),
    },
    async ({ period }) => {
      try {
        const analyticsStore = new AnalyticsStore();
        try {
          syncAnalytics(analyticsStore);
          const toolCalls = analyticsStore.getToolCallsForOptimization({ projectPath: projectRoot, period: period ?? 'week' });
          const result = analyzeRealSavings(store, toolCalls, period ?? 'week');
          return { content: [{ type: 'text', text: j(result) }] };
        } finally {
          analyticsStore.close();
        }
      } catch (e) {
        return { content: [{ type: 'text', text: j({ error: e instanceof Error ? e.message : String(e) }) }], isError: true };
      }
    },
  );

  // --- Analytics: Usage Trends ---
  _originalTool(
    'get_usage_trends',
    'Daily token usage trends over time: sessions, tokens, estimated cost, tool calls per day. Good for spotting cost spikes and tracking optimization progress.',
    {
      days: z.number().int().min(1).max(365).optional().describe('Number of days to show (default: 30)'),
    },
    async ({ days }) => {
      try {
        const analyticsStore = new AnalyticsStore();
        try {
          syncAnalytics(analyticsStore);
          const trends = analyticsStore.getUsageTrends(days ?? 30);
          const total = trends.reduce((s, d) => ({
            sessions: s.sessions + d.sessions,
            tokens: s.tokens + d.tokens,
            cost_usd: s.cost_usd + d.cost_usd,
            tool_calls: s.tool_calls + d.tool_calls,
          }), { sessions: 0, tokens: 0, cost_usd: 0, tool_calls: 0 });
          return { content: [{ type: 'text', text: j({ days: days ?? 30, daily: trends, totals: total }) }] };
        } finally {
          analyticsStore.close();
        }
      } catch (e) {
        return { content: [{ type: 'text', text: j({ error: e instanceof Error ? e.message : String(e) }) }], isError: true };
      }
    },
  );

  _originalTool(
    'get_session_stats',
    'Token savings stats for this session and cumulative across all sessions. Shows per-tool call counts, estimated token savings, and reduction percentage.',
    {},
    async () => {
      const stats = savings.getFullStats();
      return {
        content: [{
          type: 'text',
          text: j(stats),
        }],
      };
    },
  );

  server.tool(
    'get_session_journal',
    'Session history: all tool calls made, files read, zero-result searches, and duplicate queries. Use to avoid repeating work or to understand what has already been explored.',
    {},
    async () => {
      const summary = journal.getSummary();
      return { content: [{ type: 'text', text: j(summary) }] };
    },
  );

  // --- Batch API: multiple tool calls in one MCP request ---
  _originalTool(
    'batch',
    'Execute multiple trace-mcp tools in a single MCP request. Returns results for all calls. Use to reduce round-trips when you need several independent queries (e.g., get_outline for 3 files, or search + get_symbol together).',
    {
      calls: z.array(z.object({
        tool: z.string().describe('Tool name (e.g., "get_outline", "get_symbol", "search")'),
        args: z.record(z.unknown()).describe('Tool arguments'),
      })).min(1).max(10).describe('Array of tool calls to execute (max 10)'),
    },
    async ({ calls }) => {
      const results: { tool: string; result?: unknown; error?: string }[] = [];
      for (const call of calls) {
        const handler = toolHandlers.get(call.tool);
        if (!handler) {
          results.push({ tool: call.tool, error: `Unknown tool: ${call.tool}` });
          continue;
        }
        try {
          savings.recordCall(call.tool);
          const response = await handler(call.args);
          // Parse the JSON text from the response to embed inline
          const text = response.content?.[0]?.text;
          if (text) {
            try {
              results.push({ tool: call.tool, result: JSON.parse(text) });
            } catch {
              results.push({ tool: call.tool, result: text });
            }
          } else {
            results.push({ tool: call.tool, result: response });
          }
        } catch (e) {
          results.push({ tool: call.tool, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { content: [{ type: 'text', text: j({ batch_results: results, total: results.length }) }] };
    },
  );

  // --- MCP Prompts (workflow templates) ---
  registerPrompts(server, { store, registry, config, projectRoot });

  return server;
}
