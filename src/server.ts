import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Store } from './db/store.js';
import type { PluginRegistry } from './plugin-api/registry.js';
import type { TraceMcpConfig } from './config.js';
import { getIndexHealth, getProjectMap } from './tools/project.js';
import { getSymbol, search, getFileOutline } from './tools/navigation.js';
import { getComponentTree } from './tools/components.js';
import { getChangeImpact } from './tools/impact.js';
import { getFeatureContext } from './tools/context.js';
import { IndexingPipeline } from './indexer/pipeline.js';
import { formatToolError } from './errors.js';
import { logger } from './logger.js';
import { createAIProvider, BlobVectorStore, type AIProvider } from './ai/index.js';
import { getMiddlewareChain } from './tools/middleware-chain.js';
import { getModuleGraph } from './tools/module-graph.js';
import { getDITree } from './tools/di-tree.js';
import { getNavigationGraph } from './tools/rn-navigation.js';

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

  // --- Tools ---

  server.tool(
    'get_index_health',
    'Get index status, statistics, and health information',
    {},
    async () => {
      const result = getIndexHealth(store, config);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'reindex',
    'Trigger (re)indexing of the project or a subdirectory',
    {
      path: z.string().optional().describe('Subdirectory to index (default: project root)'),
      force: z.boolean().optional().describe('Skip hash check and reindex all files'),
    },
    async ({ path: indexPath, force }) => {
      logger.info({ path: indexPath, force }, 'Reindex requested');
      const pipeline = new IndexingPipeline(store, registry, config, projectRoot);

      let result;
      if (indexPath) {
        result = await pipeline.indexFiles([indexPath]);
      } else {
        result = await pipeline.indexAll(force ?? false);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'completed',
            ...result,
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_project_map',
    'Get project overview: frameworks, statistics, structure, key entry points',
    {},
    async () => {
      const result = getProjectMap(store, registry);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- Level 1 Navigation Tools ---

  server.tool(
    'get_symbol',
    'Look up a symbol by symbol_id or FQN and return its source code',
    {
      symbol_id: z.string().optional().describe('The symbol_id to look up'),
      fqn: z.string().optional().describe('The fully qualified name to look up'),
    },
    async ({ symbol_id, fqn }) => {
      const result = getSymbol(store, projectRoot, { symbolId: symbol_id, fqn });
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: JSON.stringify(formatToolError(result.error), null, 2) }],
          isError: true,
        };
      }
      const { symbol, file, source } = result.value;
      return {
        content: [{ type: 'text', text: JSON.stringify({ symbol, file: file.path, source }, null, 2) }],
      };
    },
  );

  server.tool(
    'search',
    'Search symbols using full-text search with optional filters',
    {
      query: z.string().describe('Search query'),
      kind: z.string().optional().describe('Filter by symbol kind (class, method, function, etc.)'),
      language: z.string().optional().describe('Filter by language'),
      file_pattern: z.string().optional().describe('Filter by file path pattern'),
      limit: z.number().optional().describe('Max results (default 20)'),
      offset: z.number().optional().describe('Offset for pagination'),
    },
    async ({ query, kind, language, file_pattern, limit, offset }) => {
      const result = search(
        store,
        query,
        { kind, language, filePattern: file_pattern },
        limit ?? 20,
        offset ?? 0,
        { vectorStore, embeddingService },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'get_file_outline',
    'Get all symbols for a file (signatures only, no bodies)',
    {
      path: z.string().describe('Relative file path'),
    },
    async ({ path: filePath }) => {
      const result = getFileOutline(store, filePath);
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: JSON.stringify(formatToolError(result.error), null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  // --- Level 2 Framework Tools ---

  server.tool(
    'get_component_tree',
    'Build a component render tree starting from a given .vue file',
    {
      component_path: z.string().describe('Relative path to the root .vue file'),
      depth: z.number().optional().describe('Max tree depth (default 3)'),
    },
    async ({ component_path, depth }) => {
      const result = getComponentTree(store, component_path, depth ?? 3);
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: JSON.stringify(formatToolError(result.error), null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  server.tool(
    'get_change_impact',
    'Determine what depends on a file or symbol (reverse dependency analysis)',
    {
      file_path: z.string().optional().describe('Relative file path to analyze'),
      symbol_id: z.string().optional().describe('Symbol ID to analyze'),
      depth: z.number().optional().describe('Max traversal depth (default 5)'),
    },
    async ({ file_path, symbol_id, depth }) => {
      const result = getChangeImpact(store, { filePath: file_path, symbolId: symbol_id }, depth ?? 5);
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: JSON.stringify(formatToolError(result.error), null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  server.tool(
    'get_feature_context',
    'Find relevant symbols and code for a feature description using FTS + graph expansion',
    {
      description: z.string().describe('Natural language description of the feature to find context for'),
      token_budget: z.number().optional().describe('Max tokens for assembled context (default 4000)'),
    },
    async ({ description, token_budget }) => {
      const result = getFeatureContext(store, projectRoot, description, token_budget ?? 4000);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- Level 3 Framework-Specific Tools ---

  server.tool(
    'get_middleware_chain',
    'Trace middleware chain for a route URL (Express: app->router->route; NestJS: guards->pipes->interceptors)',
    {
      url: z.string().describe('Route URL to trace middleware for'),
    },
    async ({ url }) => {
      const result = getMiddlewareChain(store, projectRoot, url);
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: JSON.stringify(formatToolError(result.error), null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  server.tool(
    'get_module_graph',
    'Build NestJS module dependency graph (module -> imports -> controllers -> providers -> exports)',
    {
      module_name: z.string().describe('NestJS module class name (e.g. AppModule)'),
    },
    async ({ module_name }) => {
      const result = getModuleGraph(store, projectRoot, module_name);
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: JSON.stringify(formatToolError(result.error), null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  server.tool(
    'get_di_tree',
    'Trace NestJS dependency injection tree (what a service injects + who injects it)',
    {
      service_name: z.string().describe('NestJS service/provider class name'),
    },
    async ({ service_name }) => {
      const result = getDITree(store, service_name);
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: JSON.stringify(formatToolError(result.error), null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  server.tool(
    'get_navigation_graph',
    'Build React Native navigation tree from screens, navigators, and deep links',
    {},
    async () => {
      const result = getNavigationGraph(store);
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: JSON.stringify(formatToolError(result.error), null, 2) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      };
    },
  );

  // --- Resources ---

  server.resource(
    'project-map',
    'project://map',
    { mimeType: 'application/json', description: 'Project map (frameworks, stats, structure)' },
    async () => {
      const result = getProjectMap(store, registry);
      return {
        contents: [{
          uri: 'project://map',
          mimeType: 'application/json',
          text: JSON.stringify(result, null, 2),
        }],
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
        contents: [{
          uri: 'project://health',
          mimeType: 'application/json',
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  return server;
}
