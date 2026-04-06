import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../../server/types.js';
import { getComponentTree } from '../framework/components.js';
import { getRequestFlow } from '../framework/flow.js';
import { getMiddlewareChain } from '../framework/middleware-chain.js';
import { getModuleGraph } from '../analysis/module-graph.js';
import { getDITree } from '../framework/di-tree.js';
import { getNavigationGraph } from '../framework/rn-navigation.js';
import { getScreenContext } from '../framework/screen-context.js';
import { getModelContext } from '../framework/model.js';
import { getSchema } from '../framework/schema.js';
import { getEventGraph } from '../framework/events.js';
import { findReferences } from '../framework/references.js';
import { getCallGraph } from '../framework/call-graph.js';
import { getLivewireContext } from '../framework/livewire.js';
import { getNovaResource } from '../framework/nova.js';
import { getTestsFor } from '../framework/tests.js';
import { buildNegativeEvidence } from '../shared/evidence.js';
import { formatToolError } from '../../errors.js';

export function registerFrameworkTools(server: McpServer, ctx: ServerContext): void {
  const { store, projectRoot, guardPath, j, jh, has } = ctx;

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
      if (result.value.total === 0) {
        const stats = store.getStats();
        const enriched = { ...result.value, evidence: buildNegativeEvidence(stats.totalFiles, stats.totalSymbols, false, 'get_tests_for') };
        return { content: [{ type: 'text', text: jh('get_tests_for', enriched) }] };
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
}
