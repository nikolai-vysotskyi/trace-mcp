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
  const server = new McpServer({
    name: 'trace-mcp',
    version: '0.1.0',
  });

  const projectRoot = rootPath ?? process.cwd();

  // AI layer (optional)
  const aiProvider: AIProvider = createAIProvider(config);
  const vectorStore = config.ai?.enabled ? new BlobVectorStore(store.db) : null;
  const embeddingService = config.ai?.enabled ? aiProvider.embedding() : null;
  const reranker: RerankerService | null = config.ai?.enabled
    ? new LLMReranker(aiProvider.fastInference())
    : null;

  // Determine which framework plugins are registered → drives dynamic tool registration
  const frameworkNames = new Set(
    registry.getAllFrameworkPlugins().map((p) => p.manifest.name),
  );
  const has = (...names: string[]) => names.some((n) => frameworkNames.has(n));

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
    'Get project overview: frameworks, statistics, languages. Use summary_only=true for a lightweight token-saving version.',
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
    'Look up a symbol by symbol_id or FQN and return its source code',
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
    'Search symbols using full-text search with optional filters',
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
    'get_file_outline',
    'Get all symbols for a file (signatures only, no bodies)',
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
    'Determine what depends on a file or symbol (reverse dependency analysis)',
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
    'Find relevant symbols and code for a feature description using FTS + graph expansion',
    {
      description: z.string().min(1).max(2000).describe('Natural language description of the feature to find context for'),
      token_budget: z.number().int().min(100).max(100000).optional().describe('Max tokens for assembled context (default 4000)'),
    },
    async ({ description, token_budget }) => {
      const result = getFeatureContext(store, projectRoot, description, token_budget ?? 4000);
      return { content: [{ type: 'text', text: j(result) }] };
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
    'find_references',
    'Find all places that reference a symbol or file (incoming edges: imports, calls, renders, dispatches, etc.)',
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
    'Build a bidirectional call graph centered on a symbol (who it calls + who calls it)',
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
    'Find test files and test functions that cover a given symbol or file',
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
    'get_dependency_graph',
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
