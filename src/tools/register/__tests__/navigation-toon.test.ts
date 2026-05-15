/**
 * Wiring tests for `output_format: "toon"` across the navigation TOON-keeper
 * tools (search, get_outline, get_feature_context).
 *
 * `get_context_bundle` no longer supports `toon` — TOON regressed its payload
 * size in benchmarks — but its `markdown` branch is still exercised below.
 *
 * Strategy: register the navigation tools against a fresh in-memory store,
 * invoke the handler with `output_format: 'toon'`, decode via @toon-format,
 * and assert it deep-equals the JSON branch (lossless round-trip).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { decode as toonDecode } from '@toon-format/toon';
import { beforeEach, describe, expect, it } from 'vitest';
import { indexTrigramsBatch } from '../../../db/fuzzy.js';
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

function seedStore(store: Store): void {
  const fileId = store.insertFile('src/services/auth.ts', 'typescript', 'h1', 500);
  const sym1 = store.insertSymbol(fileId, {
    symbolId: 'src/services/auth.ts::AuthService#class',
    name: 'AuthService',
    kind: 'class',
    fqn: 'AuthService',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 20,
    signature: 'class AuthService',
  });
  const sym2 = store.insertSymbol(fileId, {
    symbolId: 'src/services/auth.ts::login#method',
    name: 'login',
    kind: 'method',
    fqn: 'AuthService.login',
    byteStart: 110,
    byteEnd: 200,
    lineStart: 22,
    lineEnd: 30,
    signature: 'login(email: string): Promise<User>',
  });
  const utilFileId = store.insertFile('src/utils/format.ts', 'typescript', 'h2', 300);
  const sym3 = store.insertSymbol(utilFileId, {
    symbolId: 'src/utils/format.ts::formatCurrency#function',
    name: 'formatCurrency',
    kind: 'function',
    fqn: 'formatCurrency',
    byteStart: 0,
    byteEnd: 50,
    lineStart: 1,
    lineEnd: 5,
    signature: 'function formatCurrency(n: number): string',
  });
  indexTrigramsBatch(store.db, [
    { id: sym1, name: 'AuthService', fqn: 'AuthService' },
    { id: sym2, name: 'login', fqn: 'AuthService.login' },
    { id: sym3, name: 'formatCurrency', fqn: 'formatCurrency' },
  ]);
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

describe('navigation tools — output_format: "toon" wiring', () => {
  let store: Store;
  let server: McpServer;
  let tools: Record<string, RegisteredTool>;

  beforeEach(() => {
    store = createTestStore();
    seedStore(store);
    server = new McpServer({ name: 'test', version: '0.0.0' });
    registerNavigationTools(server, buildContext(store));
    tools = registeredTools(server);
  });

  describe('search', () => {
    it('toon output round-trips losslessly to the json output', async () => {
      const jsonRes = await tools['search'].handler({ query: 'AuthService' }, {});
      const toonRes = await tools['search'].handler(
        { query: 'AuthService', output_format: 'toon' },
        {},
      );
      const toonText = toonRes.content[0].text;
      expect(toonText).toBeTruthy();
      expect(toonText.length).toBeGreaterThan(0);
      const decoded = toonDecode(toonText);
      const jsonPayload = JSON.parse(jsonRes.content[0].text);
      expect(decoded).toEqual(jsonPayload);
    });
  });

  describe('get_outline', () => {
    it('toon output round-trips losslessly to the json output', async () => {
      const jsonRes = await tools['get_outline'].handler({ path: 'src/services/auth.ts' }, {});
      const toonRes = await tools['get_outline'].handler(
        { path: 'src/services/auth.ts', output_format: 'toon' },
        {},
      );
      const toonText = toonRes.content[0].text;
      expect(toonText).toBeTruthy();
      const decoded = toonDecode(toonText);
      const jsonPayload = JSON.parse(jsonRes.content[0].text);
      expect(decoded).toEqual(jsonPayload);
    });
  });

  describe('get_feature_context', () => {
    it('toon output round-trips losslessly to the json output', async () => {
      const jsonRes = await tools['get_feature_context'].handler(
        { description: 'auth service' },
        {},
      );
      const toonRes = await tools['get_feature_context'].handler(
        { description: 'auth service', output_format: 'toon' },
        {},
      );
      const toonText = toonRes.content[0].text;
      expect(toonText).toBeTruthy();
      const decoded = toonDecode(toonText);
      const jsonPayload = JSON.parse(jsonRes.content[0].text);
      expect(decoded).toEqual(jsonPayload);
    });

    it('markdown output still returns the expected envelope shape', async () => {
      const mdRes = await tools['get_feature_context'].handler(
        { description: 'AuthService login authentication', output_format: 'markdown' },
        {},
      );
      const mdText = mdRes.content[0].text;
      expect(mdText).toBeTruthy();
      const parsed = JSON.parse(mdText);
      if ('format' in parsed) {
        expect(parsed.format).toBe('markdown');
        expect(parsed).toHaveProperty('content');
      } else {
        expect(parsed).toHaveProperty('evidence');
      }
    });
  });

  describe('get_context_bundle', () => {
    it('markdown output still returns the existing content shape', async () => {
      const args = {
        symbol_id: 'src/services/auth.ts::AuthService#class',
        output_format: 'markdown',
      };
      const mdRes = await tools['get_context_bundle'].handler(args, {});
      const mdText = mdRes.content[0].text;
      expect(mdText).toBeTruthy();
      const parsed = JSON.parse(mdText);
      expect(parsed).toHaveProperty('content');
    });
  });
});
