/**
 * TRA-197 — `check_edit_safe`'s `depth` param must dispatch to the exact
 * same implementations `assess_change_risk` (depth: "score") and
 * `get_change_impact` (depth: "full") use, and the default (no `depth`)
 * behavior must stay byte-for-byte unchanged.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { registerAdvancedTools } from '../../src/tools/register/advanced.js';
import { registerLookupTools } from '../../src/tools/register/navigation/lookup-tools.js';
import { registerQualityTools } from '../../src/tools/register/quality.js';
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

describe('check_edit_safe { depth } param (TRA-197)', () => {
  let store: Store;
  let tmpDir: string;
  let tools: Record<string, RegisteredTool>;

  beforeAll(async () => {
    tmpDir = createTmpDir('trace-mcp-edit-safe-depth-');
    writeFixtureFile(
      tmpDir,
      'src/hub.ts',
      'export function hub(x: number): number {\n  return x;\n}\n',
    );
    writeFixtureFile(
      tmpDir,
      'src/consumer.ts',
      "import { hub } from './hub.js';\nexport function use(): number {\n  return hub(1);\n}\n",
    );

    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = {
      root: tmpDir,
      include: ['src/**/*.ts'],
      exclude: ['node_modules/**'],
      plugins: [],
    } as never;
    const pipeline = new IndexingPipeline(store, registry, config, tmpDir);
    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);

    const ctx = {
      store,
      projectRoot: tmpDir,
      config: {},
      registry: { getAllFrameworkPlugins: () => [] },
      decisionStore: null,
      topoStore: null,
      guardPath: () => null,
      j: (v: unknown) => JSON.stringify(v),
      jh: (_tool: string, v: unknown) => JSON.stringify(v),
    } as unknown as ServerContext;

    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerQualityTools(server, ctx);
    registerAdvancedTools(server, ctx);
    registerLookupTools(server, ctx);
    tools = getRegisteredTools(server);
  });

  it('check_edit_safe{depth: "score"} matches assess_change_risk', async () => {
    const viaCheckEditSafe = parseText(
      await tools.check_edit_safe.handler(
        { symbol_id: 'src/hub.ts::hub#function', depth: 'score' },
        {},
      ),
    );
    const viaAssessChangeRisk = parseText(
      await tools.assess_change_risk.handler({ symbol_id: 'src/hub.ts::hub#function' }, {}),
    );
    expect(viaCheckEditSafe).toEqual(viaAssessChangeRisk);
  });

  it('check_edit_safe{depth: "full"} matches get_change_impact', async () => {
    const viaCheckEditSafe = parseText(
      await tools.check_edit_safe.handler(
        { symbol_id: 'src/hub.ts::hub#function', depth: 'full' },
        {},
      ),
    );
    const viaGetChangeImpact = parseText(
      await tools.get_change_impact.handler({ symbol_id: 'src/hub.ts::hub#function' }, {}),
    );
    expect(viaCheckEditSafe).toEqual(viaGetChangeImpact);
  });

  it('regression: check_edit_safe with no depth behaves exactly as before (verdict tier)', async () => {
    const result = parseText(
      await tools.check_edit_safe.handler({ symbol_id: 'src/hub.ts::hub#function' }, {}),
    ) as Record<string, unknown>;
    expect(result).toHaveProperty('verdict');
    expect(result).toHaveProperty('blockers');
    expect(result).not.toHaveProperty('risk_score');
    expect(result).not.toHaveProperty('dependents');
  });

  it('regression: assess_change_risk output shape is unchanged', async () => {
    const result = parseText(
      await tools.assess_change_risk.handler({ symbol_id: 'src/hub.ts::hub#function' }, {}),
    ) as Record<string, unknown>;
    expect(result).toHaveProperty('risk_score');
    expect(result).toHaveProperty('risk_level');
    expect(result).toHaveProperty('factors');
  });

  it('regression: get_change_impact output shape is unchanged', async () => {
    const result = parseText(
      await tools.get_change_impact.handler({ symbol_id: 'src/hub.ts::hub#function' }, {}),
    ) as Record<string, unknown>;
    expect(result).toHaveProperty('dependents');
    expect(result).toHaveProperty('totalAffected');
  });
});
