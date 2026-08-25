/**
 * `detail_level` wiring for get_feature_context / get_task_context — added
 * for parity with search/get_outline/find_usages (GH #334).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../db/store.js';
import type { ServerContext } from '../../../server/types.js';
import { registerNavigationTools } from '../navigation.js';
import { createTestStore } from '../../../../tests/test-utils.js';

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

// get_feature_context / get_task_context query symbols_fts directly (BM25),
// unlike the trigram-backed `search` tool — so the seeded signature needs to
// contain the query words verbatim (FTS5's default tokenizer doesn't split
// camelCase), and the external-content FTS table needs an explicit rebuild.
function seedStore(store: Store): void {
  const fileId = store.insertFile('src/services/auth.ts', 'typescript', 'h1', 500);
  store.insertSymbol(fileId, {
    symbolId: 'src/services/auth.ts::AuthService#class',
    name: 'AuthService',
    kind: 'class',
    fqn: 'AuthService',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 20,
    signature: 'handles user authentication service login',
  });
  store.db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES ('rebuild')`);
}

function buildContext(store: Store): ServerContext {
  const stub = {
    store,
    projectRoot: '/tmp/fake-project',
    embeddingService: null,
    vectorStore: null,
    reranker: null,
    rankingLedger: null,
    decisionStore: null,
    telemetrySink: null,
    topoStore: null,
    progress: null,
    aiProvider: null,
    journal: null,
    config: {} as unknown,
    registry: {} as unknown,
    savings: {
      getSessionStats: () => ({ total_calls: 0, total_raw_tokens: 0 }),
    },
    has: () => false,
    guardPath: () => null,
    j: (v: unknown) => JSON.stringify(v),
    jh: (_tool: string, v: unknown) => JSON.stringify(v),
    markExplored: () => undefined,
    onPipelineEvent: () => undefined,
  };
  return stub as unknown as ServerContext;
}

function registeredTools(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

describe('detail_level — get_feature_context / get_task_context', () => {
  let store: Store;
  let tools: Record<string, RegisteredTool>;

  beforeEach(() => {
    store = createTestStore();
    seedStore(store);
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerNavigationTools(server, buildContext(store));
    tools = registeredTools(server);
  });

  describe('get_feature_context', () => {
    it('default response carries symbol_id/score/fqn per item', async () => {
      const res = await tools['get_feature_context'].handler(
        { description: 'authentication service' },
        {},
      );
      const payload = JSON.parse(res.content[0].text);
      expect(payload.items.length).toBeGreaterThan(0);
      expect(payload.items[0]).toHaveProperty('symbolId');
      expect(payload.items[0]).toHaveProperty('score');
      expect(payload.detail_level).toBeUndefined();
    });

    it('minimal drops ranking/type metadata but keeps content', async () => {
      const res = await tools['get_feature_context'].handler(
        { description: 'authentication service', detail_level: 'minimal' },
        {},
      );
      const payload = JSON.parse(res.content[0].text);
      expect(payload.detail_level).toBe('minimal');
      expect(payload.items.length).toBeGreaterThan(0);
      for (const item of payload.items) {
        expect(Object.keys(item).sort()).toEqual([
          '_freshness',
          'content',
          'file',
          'name',
          'tokens',
        ]);
      }
    });
  });

  describe('get_task_context', () => {
    it('minimal drops ranking/type metadata from every section but keeps content', async () => {
      const res = await tools['get_task_context'].handler(
        { task: 'understand authentication service', detail_level: 'minimal' },
        {},
      );
      const payload = JSON.parse(res.content[0].text);
      expect(payload.detail_level).toBe('minimal');
      expect(payload.sections.primary.length).toBeGreaterThan(0);
      for (const section of Object.values(
        payload.sections as Record<string, Array<Record<string, unknown>>>,
      )) {
        for (const item of section) {
          expect(Object.keys(item).sort()).toEqual(['content', 'file', 'name', 'tokens']);
        }
      }
    });
  });
});
