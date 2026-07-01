import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerContext } from '../../server/types.js';
import { registerSearchTools } from './navigation/search-tools.js';
import { registerLookupTools } from './navigation/lookup-tools.js';
import { registerContextTools } from './navigation/context-tools.js';
import { registerTaskContextTools } from './navigation/task-context-tools.js';

// Search-tool retrieval-mode dispatch helpers (`runFlatSearch`, `resolveExactLookup`)
// live in `src/tools/navigation/search-dispatcher.ts` so the `SearchToolRetriever`
// adapter can share them. See plan-cognee-search-migration-IMPL.md.
//
// This file is a thin orchestrator: the ~9 navigation tools previously
// registered here in one 1000+ line function are now split by theme across
// src/tools/register/navigation/*.ts. See each sub-module for its tool list.

/**
 * Registers the Level 1 navigation tools: search, symbol/file lookups, and
 * task/feature context assembly. Delegates to themed sub-registrars:
 * - search-tools.ts: `search`, `suggest_queries`
 * - lookup-tools.ts: `get_symbol`, `get_outline`, `get_related_symbols`, `get_change_impact`
 * - context-tools.ts: `get_context_bundle`, `get_feature_context`
 * - task-context-tools.ts: `get_task_context`
 */
export function registerNavigationTools(server: McpServer, ctx: ServerContext): void {
  registerSearchTools(server, ctx);
  registerLookupTools(server, ctx);
  registerContextTools(server, ctx);
  registerTaskContextTools(server, ctx);
}
