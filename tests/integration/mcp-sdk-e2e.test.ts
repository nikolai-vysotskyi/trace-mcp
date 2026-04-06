/**
 * MCP SDK E2E integration test.
 * Indexes the mcp-server-app fixture and verifies tool/resource/prompt extraction.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { McpSdkPlugin } from '../../src/indexer/plugins/integration/api/mcp-sdk/index.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/mcp-server-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('MCP SDK E2E', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new McpSdkPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes fixture files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('extracts MCP tool registrations as routes', () => {
    const routes = store.getAllRoutes();
    const tools = routes.filter((r) => r.method === 'TOOL');
    expect(tools.length).toBe(2);
    const names = tools.map((r) => r.uri);
    expect(names).toContain('get_user');
    expect(names).toContain('create_item');
  });

  it('extracts MCP resource registrations', () => {
    const routes = store.getAllRoutes();
    const resources = routes.filter((r) => r.method === 'RESOURCE');
    expect(resources.length).toBe(1);
    expect(resources[0].uri).toBe('config://app');
  });

  it('extracts MCP prompt registrations', () => {
    const routes = store.getAllRoutes();
    const prompts = routes.filter((r) => r.method === 'PROMPT');
    expect(prompts.length).toBe(2);
    const names = prompts.map((r) => r.uri);
    expect(names).toContain('code_review');
    expect(names).toContain('summarize');
  });

  it('sets framework role on server files', () => {
    const files = store.getAllFiles();
    const mcpFiles = files.filter(
      (f) => f.framework_role === 'mcp_server' || f.framework_role === 'mcp_transport',
    );
    expect(mcpFiles.length).toBeGreaterThan(0);
  });
});
