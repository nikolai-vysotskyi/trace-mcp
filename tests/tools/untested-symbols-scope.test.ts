/**
 * TRA-203 — `get_untested_symbols`'s `scope: "exports_only"` must dispatch
 * to the exact same `getUntestedExports()` call `get_untested_exports`
 * uses, and `get_untested_exports` (the permanent alias) must stay
 * byte-for-byte unchanged. `get_tests_for` is out of scope for this change
 * entirely (different file, untouched) — not exercised here.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { registerAnalysisTools } from '../../src/tools/register/analysis.js';
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

describe('get_untested_symbols { scope: "exports_only" } (TRA-203)', () => {
  let store: Store;
  let tmpDir: string;
  let tools: Record<string, RegisteredTool>;

  beforeAll(async () => {
    tmpDir = createTmpDir('trace-mcp-untested-scope-');
    writeFixtureFile(
      tmpDir,
      'src/uncovered.ts',
      'export function uncoveredFn(): number {\n  return 1;\n}\n',
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
    registerAnalysisTools(server, ctx);
    tools = getRegisteredTools(server);
  });

  it('get_untested_symbols{scope: "exports_only"} matches get_untested_exports', async () => {
    const viaUntestedSymbols = parseText(
      await tools.get_untested_symbols.handler({ scope: 'exports_only' }, {}),
    );
    const viaUntestedExports = parseText(await tools.get_untested_exports.handler({}, {}));
    expect(viaUntestedSymbols).toEqual(viaUntestedExports);
  });

  it('regression: get_untested_symbols default scope (all_symbols) shape is unchanged', async () => {
    const result = parseText(await tools.get_untested_symbols.handler({}, {})) as Record<
      string,
      unknown
    >;
    expect(result).toHaveProperty('untested');
    expect(result).toHaveProperty('total_symbols');
    expect(result).toHaveProperty('by_level');
    const untested = result.untested as Array<Record<string, unknown>>;
    if (untested.length > 0) {
      expect(untested[0]).toHaveProperty('level');
    }
  });

  it('regression: get_untested_exports output shape is unchanged', async () => {
    const result = parseText(await tools.get_untested_exports.handler({}, {})) as Record<
      string,
      unknown
    >;
    expect(result).toHaveProperty('untested');
    expect(result).toHaveProperty('total_exports');
    expect(result).toHaveProperty('total_untested');
  });
});
