/**
 * TRA-199 — `get_dead_code`'s `mode: "exports_only"` must dispatch to the
 * exact same `getDeadExports()` call the retired `get_dead_exports` alias
 * used, so it still emits that alias's exact response shape (TRA-240).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { registerAnalysisTools } from '../../src/tools/register/analysis.js';
import { registerGitTools } from '../../src/tools/register/git.js';
import type { ServerContext } from '../../src/server/types.js';
import { createTestStore, createTmpDir, writeFixtureFile } from '../test-utils.js';

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function getRegisteredTools(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

function parseText(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

describe('get_dead_code { mode: "exports_only" } (TRA-199)', () => {
  let store: Store;
  let tmpDir: string;
  let tools: Record<string, RegisteredTool>;

  beforeAll(async () => {
    tmpDir = createTmpDir('trace-mcp-dead-exports-mode-');
    // An exported symbol with zero external consumers — a dead export.
    writeFixtureFile(
      tmpDir,
      'src/unused.ts',
      'export function unusedFn(): number {\n  return 1;\n}\n',
    );
    // A live symbol so the store isn't trivially empty.
    writeFixtureFile(tmpDir, 'src/used.ts', 'export function usedFn(): number {\n  return 2;\n}\n');
    writeFixtureFile(
      tmpDir,
      'src/consumer.ts',
      "import { usedFn } from './used.js';\nexport function run(): number {\n  return usedFn();\n}\n",
    );

    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = {
      root: tmpDir,
      include: ['src/**/*.ts'],
      exclude: ['node_modules/**'],
      db: { path: ':memory:' },
      plugins: [],
    } as never;
    const pipeline = new IndexingPipeline(store, registry, config, tmpDir);
    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);

    const ctx = {
      store,
      projectRoot: tmpDir,
      config: {},
      registry,
      guardPath: () => null,
      j: (v: unknown) => JSON.stringify(v),
      jh: (_tool: string, v: unknown) => JSON.stringify(v),
    } as unknown as ServerContext;

    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerGitTools(server, ctx);
    registerAnalysisTools(server, ctx);
    tools = getRegisteredTools(server);
  });

  it('get_dead_code{mode: "exports_only"} emits the retired alias response shape', async () => {
    const result = parseText(
      await tools.get_dead_code.handler({ mode: 'exports_only' }, {}),
    ) as Record<string, unknown>;
    expect(result).toHaveProperty('dead_exports');
    expect(result).toHaveProperty('total_dead');
    expect(result).toHaveProperty('total_exports');
  });

  it('the retired get_dead_exports alias is no longer registered (TRA-240)', () => {
    expect(tools.get_dead_exports).toBeUndefined();
  });

  it('get_dead_code{mode: "exports_only"} still defaults limit to 100', async () => {
    const result = parseText(await tools.get_dead_code.handler({ mode: 'exports_only' }, {})) as {
      total_dead: number;
      total_exports: number;
    };
    expect(result).toHaveProperty('total_dead');
    expect(result).toHaveProperty('total_exports');
  });

  it('regression: get_dead_code default mode (multi-signal) shape is unchanged', async () => {
    const result = parseText(await tools.get_dead_code.handler({}, {})) as Record<string, unknown>;
    expect(result).toHaveProperty('dead_symbols');
    expect(result).not.toHaveProperty('dead_exports');
  });
});
