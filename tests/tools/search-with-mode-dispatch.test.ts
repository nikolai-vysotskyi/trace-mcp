/**
 * Regression test for the `search_with_mode` MCP dispatcher.
 *
 * The dispatcher in `src/tools/register/retrieval.ts` runs a registered
 * retriever via `runRetriever(retriever, input)`. Different retrievers
 * accept different input shapes — `LexicalRetriever` reads `text`, while
 * `GraphCompletionRetriever` reads `query`. If the dispatcher only
 * passes one shape, graph_completion silently returns zero items.
 *
 * This test installs a spy retriever via `vi.mock`, calls
 * `search_with_mode` through the registered MCP tool, and asserts the
 * input the retriever received contains BOTH `text` and `query`. That
 * guards against regression to the single-shape input.
 */
import { describe, it, expect, vi } from 'vitest';

interface CapturedInput {
  text?: string;
  query?: string;
  limit?: number;
}

const capture: { last?: CapturedInput } = {};

vi.mock('../../src/retrieval/modes/registry.js', () => {
  const SEARCH_MODE_NAMES = [
    'lexical',
    'semantic',
    'hybrid',
    'summary',
    'feeling_lucky',
    'graph_completion',
  ] as const;
  const spy = {
    name: 'spy',
    async getContext(input: unknown) {
      capture.last = input as CapturedInput;
      return { query: input, data: input };
    },
    async getCompletion() {
      return [];
    },
    async getAnswer(c: unknown[]) {
      return c;
    },
  };
  return {
    SEARCH_MODE_NAMES,
    createDefaultSearchModeRegistry: () => ({
      getMode: (_name: string) => spy,
      listModes: () => Array.from(SEARCH_MODE_NAMES),
    }),
  };
});

describe('search_with_mode dispatcher input shape (regression)', () => {
  it('passes both `text` and `query` so retrievers with either contract work', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { registerRetrievalTools } = await import('../../src/tools/register/retrieval.js');
    const { createTestStore } = await import('../test-utils.js');

    const store = createTestStore();
    const server = new McpServer({ name: 'test', version: '0.0.0' });

    const ctx = {
      store,
      projectRoot: '/tmp',
      embeddingService: null,
      vectorStore: null,
      j: (v: unknown) => JSON.stringify(v),
    } as unknown as Parameters<typeof registerRetrievalTools>[1];

    registerRetrievalTools(server, ctx);

    const tools = (server as unknown as { _registeredTools: Record<string, { handler: Function }> })
      ._registeredTools;
    const tool = tools['search_with_mode'];
    expect(tool).toBeDefined();

    await tool.handler({ query: 'hello world', mode: 'graph_completion' }, {});

    expect(capture.last).toBeDefined();
    expect(capture.last?.text).toBe('hello world');
    // The bug: dispatcher passed only `text`, so this was undefined for
    // graph_completion. The fix passes both — guard against regression.
    expect(capture.last?.query).toBe('hello world');
  });
});
