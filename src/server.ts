import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import { getLayerViolations, detectLayerPreset, type LayerDefinition } from './tools/layer-violations.js';
import { getFileOwnership, getSymbolOwnership } from './tools/git-ownership.js';
import { getComplexityTrend } from './tools/complexity-trend.js';
import { suggestQueries } from './tools/suggest.js';
import { getRelatedSymbols } from './tools/related.js';
import { getContextBundle } from './tools/context-bundle.js';
import { predictBugs, detectDrift, getTechDebt, assessChangeRisk, getHealthTrends } from './tools/predictive-intelligence.js';
import { queryByIntent, getDomainMap, getDomainContext, getCrossDomainDependencies } from './tools/intent.js';
import { getRuntimeProfile, getRuntimeCallGraph, getEndpointAnalytics, getRuntimeDependencies } from './tools/runtime.js';
import { RuntimeIntelligence } from './runtime/lifecycle.js';
import { TopologyStore } from './topology/topology-db.js';
import { TOPOLOGY_DB_PATH, ensureGlobalDirs } from './global.js';
import { getServiceMap, getCrossServiceImpact, getApiContract, getServiceDependencies, getContractDrift } from './tools/topology.js';

/** Compact JSON — no pretty-printing; saves 25–35% tokens on every response */
function j(value: unknown): string {
  return JSON.stringify(value);
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
    { name: 'trace-mcp', version: '0.1.0' },
    {
      instructions: [
        `trace-mcp is a framework-aware code intelligence server for this project. Detected frameworks: ${detectedFrameworks}.`,
        '',
        'WHEN TO USE trace-mcp tools (instead of Read/Grep/Glob):',
        '- Finding a function/class/method → `search` (understands symbol kinds, FQNs, language filters)',
        '- Understanding a file before editing → `outline_file` (signatures only — cheaper than Read)',
        '- Reading one symbol\'s source → `get_symbol` (returns only the symbol, not the whole file)',
        '- What breaks if I change X → `get_change_impact` (reverse dependency graph)',
        '- Who calls this / what does it call → `get_call_graph` (bidirectional)',
        '- All usages of a symbol → `trace_usages` (semantic: imports, calls, renders, dispatches)',
        '- Context for a task → `get_feature_context` (NL query → relevant symbols + source)',
        '- Tests for a symbol/file → `get_tests_for` (understands test-to-source mapping)',
        '- HTTP request flow → `get_request_flow` (route → middleware → controller → service)',
        '- DB model details → `get_model_context` (relationships, schema, metadata)',
        '- Database schema → `get_schema` (from migrations/ORM definitions)',
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

  // AI layer (optional)
  const aiProvider: AIProvider = createAIProvider(config);
  const vectorStore = config.ai?.enabled ? new BlobVectorStore(store.db) : null;
  const embeddingService = config.ai?.enabled ? aiProvider.embedding() : null;
  const reranker: RerankerService | null = config.ai?.enabled
    ? new LLMReranker(aiProvider.fastInference())
    : null;

  /** Validate a user-supplied path stays within projectRoot; returns error response on failure */
  function guardPath(filePath: string): { content: [{ type: 'text'; text: string }]; isError: true } | null {
    const check = validatePath(filePath, projectRoot);
    if (check.isErr()) {
      return { content: [{ type: 'text', text: j(formatToolError(check.error)) }], isError: true };
    }
    return null;
  }

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
      return { content: [{ type: 'text', text: j(result) }] };
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
          text: j({
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
    'Search symbols by name, kind, or text. Use instead of Grep when looking for functions, classes, methods, or variables in source code. Supports kind/language/file_pattern filters.',
    {
      query: z.string().min(1).max(500).describe('Search query'),
      kind: z.string().max(64).optional().describe('Filter by symbol kind (class, method, function, etc.)'),
      language: z.string().max(64).optional().describe('Filter by language'),
      file_pattern: z.string().max(512).optional().describe('Filter by file path pattern'),
      implements: z.string().max(256).optional().describe('Filter to classes implementing this interface'),
      extends: z.string().max(256).optional().describe('Filter to classes/interfaces extending this name'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default 20)'),
      offset: z.number().int().min(0).max(50000).optional().describe('Offset for pagination'),
    },
    async ({ query, kind, language, file_pattern, limit, offset, implements: impl, extends: ext }) => {
      const result = await search(
        store,
        query,
        { kind, language, filePattern: file_pattern, implements: impl, extends: ext },
        limit ?? 20,
        offset ?? 0,
        { vectorStore, embeddingService, reranker },
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
      return { content: [{ type: 'text', text: j({ items, total: result.total, search_mode: result.search_mode }) }] };
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
      return { content: [{ type: 'text', text: j(result.value) }] };
    },
  );

  server.tool(
    'get_change_impact',
    'Determine what depends on a file or symbol (reverse dependency analysis). Use before making changes to understand blast radius.',
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
      );
      if (result.isErr()) {
        return { content: [{ type: 'text', text: j(formatToolError(result.error)) }], isError: true };
      }
      return { content: [{ type: 'text', text: j(result.value) }] };
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
      return { content: [{ type: 'text', text: j(result) }] };
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
      return { content: [{ type: 'text', text: j(result.value) }] };
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
      return { content: [{ type: 'text', text: j(result.value) }] };
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
        return { content: [{ type: 'text', text: j(result.value) }] };
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
        return { content: [{ type: 'text', text: j(result.value) }] };
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
        return { content: [{ type: 'text', text: j(result.value) }] };
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
        return { content: [{ type: 'text', text: j(result.value) }] };
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
        return { content: [{ type: 'text', text: j(result.value) }] };
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
        return { content: [{ type: 'text', text: j(result.value) }] };
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
        return { content: [{ type: 'text', text: j(result.value) }] };
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
      return { content: [{ type: 'text', text: j(result.value) }] };
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
      return { content: [{ type: 'text', text: j(result.value) }] };
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
      return { content: [{ type: 'text', text: j(result.value) }] };
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
        return { content: [{ type: 'text', text: j(result.value) }] };
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
      return { content: [{ type: 'text', text: j(results) }] };
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
          text: j({
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
      return { content: [{ type: 'text', text: j(results.slice(0, limit ?? 50)) }] };
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
      return { content: [{ type: 'text', text: j({ ...result, hotspots: hotspots.slice(0, 10) }) }] };
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
      return { content: [{ type: 'text', text: j(results) }] };
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
      return { content: [{ type: 'text', text: j(result) }] };
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

  return server;
}
