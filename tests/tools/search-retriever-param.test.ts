/**
 * TRA-200 — `search`'s `retriever` param must dispatch through the exact
 * same code path as `search_with_mode` (both call `runNamedSearchMode`),
 * so their outputs can never drift, and `search`'s default (no `retriever`)
 * behavior must stay byte-for-byte unchanged.
 */
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { registerSearchTools } from '../../src/tools/register/navigation/search-tools.js';
import { registerRetrievalTools } from '../../src/tools/register/retrieval.js';
import type { ServerContext } from '../../src/server/types.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/no-framework');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['app/**/*.php', 'src/**/*.ts', 'components/**/*.vue'],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function getRegisteredTools(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

function parseText(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

describe('search { retriever } param (TRA-200)', () => {
  let store: Store;
  let ctx: ServerContext;
  let tools: Record<string, RegisteredTool>;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();

    ctx = {
      store,
      projectRoot: FIXTURE_DIR,
      embeddingService: null,
      vectorStore: null,
      reranker: null,
      topoStore: null,
      rankingLedger: null,
      j: (v: unknown) => JSON.stringify(v),
      jh: (_tool: string, v: unknown) => JSON.stringify(v),
    } as unknown as ServerContext;

    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerSearchTools(server, ctx);
    registerRetrievalTools(server, ctx);
    tools = getRegisteredTools(server);
  });

  it('search{retriever: "lexical"} returns the same items as search_with_mode{mode: "lexical"}', async () => {
    const viaSearch = parseText(
      await tools.search.handler({ query: 'User', retriever: 'lexical' }, {}),
    ) as { retriever: string; items: unknown[]; total: number };
    const viaSearchWithMode = parseText(
      await tools.search_with_mode.handler({ query: 'User', mode: 'lexical' }, {}),
    ) as { mode: string; items: unknown[]; total: number };

    expect(viaSearch.retriever).toBe('lexical');
    expect(viaSearchWithMode.mode).toBe('lexical');
    expect(viaSearch.items).toEqual(viaSearchWithMode.items);
    expect(viaSearch.total).toBe(viaSearchWithMode.total);
  });

  it('search{retriever: "feeling_lucky"} matches search_with_mode default', async () => {
    const viaSearch = parseText(
      await tools.search.handler({ query: 'add', retriever: 'feeling_lucky' }, {}),
    ) as { items: unknown[] };
    const viaSearchWithMode = parseText(
      await tools.search_with_mode.handler({ query: 'add' }, {}),
    ) as { items: unknown[] };

    expect(viaSearch.items).toEqual(viaSearchWithMode.items);
  });

  it('search{retriever} response omits the mode-shaping fields (search_mode, buckets, parent)', async () => {
    const result = parseText(
      await tools.search.handler({ query: 'User', retriever: 'lexical' }, {}),
    ) as Record<string, unknown>;
    expect(result).not.toHaveProperty('search_mode');
    expect(result).not.toHaveProperty('mode');
    expect(result).not.toHaveProperty('buckets');
  });

  it('regression: search with no retriever behaves exactly as before (mode-based dispatch)', async () => {
    const result = parseText(await tools.search.handler({ query: 'User' }, {})) as Record<
      string,
      unknown
    >;
    expect(result).toHaveProperty('search_mode');
    expect(result).toHaveProperty('mode', 'single');
    expect(result).not.toHaveProperty('retriever');
  });
});
