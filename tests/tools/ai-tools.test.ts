import { describe, it, expect, beforeAll, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';
import type {
  InferenceService,
  EmbeddingService,
  VectorStore,
  RerankerService,
} from '../../src/ai/interfaces.js';
import { registerAITools } from '../../src/tools/ai/ai-tools.js';

function createMockInference(response = '{"explanation": "This class handles auth."}') {
  return {
    generate: vi.fn(async () => response),
  } satisfies InferenceService;
}

function seedData(store: Store): void {
  const fileId = store.insertFile('src/auth/service.ts', 'typescript', 'hash1', 500);
  store.insertSymbol(fileId, {
    symbolId: 'src/auth/service.ts::AuthService#class',
    name: 'AuthService',
    kind: 'class',
    fqn: 'AuthService',
    byteStart: 0,
    byteEnd: 100,
    signature: 'class AuthService',
    metadata: { exported: true },
  });

  store.insertSymbol(fileId, {
    symbolId: 'src/auth/service.ts::login#method',
    name: 'login',
    kind: 'method',
    byteStart: 10,
    byteEnd: 80,
    signature: 'async login(email: string): Promise<User>',
    metadata: { exported: false },
  });

  const file2Id = store.insertFile('src/auth/controller.ts', 'typescript', 'hash2', 300);
  store.insertSymbol(file2Id, {
    symbolId: 'src/auth/controller.ts::AuthController#class',
    name: 'AuthController',
    kind: 'class',
    fqn: 'AuthController',
    byteStart: 0,
    byteEnd: 100,
    signature: 'class AuthController',
    metadata: { exported: true },
  });
}

describe('AI Tools registration', () => {
  let store: Store;
  let smartInference: InferenceService;

  beforeAll(() => {
    store = createTestStore();
    seedData(store);
    smartInference = createMockInference();
  });

  it('registerAITools does not throw', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    expect(() => {
      registerAITools(server, {
        store,
        smartInference,
        fastInference: createMockInference(),
        embeddingService: null,
        vectorStore: null,
        reranker: null,
        projectRoot: '/tmp/fake',
      });
    }).not.toThrow();
  });
});

describe('AI tool helpers', () => {
  let store: Store;

  beforeAll(() => {
    store = createTestStore();
    seedData(store);
  });

  it('getUnsummarizedSymbols returns symbols with null summary', () => {
    const symbols = store.getUnsummarizedSymbols(['class', 'method'], 10);
    expect(symbols.length).toBe(3);
    expect(symbols.every((s) => s.kind === 'class' || s.kind === 'method')).toBe(true);
  });

  it('updateSymbolSummary writes to DB', () => {
    const sym = store.getSymbolBySymbolId('src/auth/service.ts::AuthService#class');
    expect(sym).toBeDefined();
    store.updateSymbolSummary(sym!.id, 'Handles user authentication');
    const updated = store.getSymbolBySymbolId('src/auth/service.ts::AuthService#class');
    expect(updated?.summary).toBe('Handles user authentication');
  });
});
