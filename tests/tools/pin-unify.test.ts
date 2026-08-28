/**
 * TRA-196 — the unified `pin` tool covers both scopes the `pin_symbol` /
 * `pin_file` aliases used to serve (same underlying upsertPin calls). Those
 * aliases were retired in 2.0 (TRA-240); one case here guards that they stay
 * gone rather than creeping back in additively.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerAnalysisTools } from '../../src/tools/register/analysis.js';
import type { ServerContext } from '../../src/server/types.js';
import { createTestStore } from '../test-utils.js';

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

function makeCtx(store: ReturnType<typeof createTestStore>): ServerContext {
  return {
    store,
    projectRoot: '/tmp',
    config: {},
    registry: { getAllFrameworkPlugins: () => [] },
    topoStore: null,
    j: (v: unknown) => JSON.stringify(v),
    jh: (_tool: string, v: unknown) => JSON.stringify(v),
    guardPath: () => null,
  } as unknown as ServerContext;
}

describe('pin (unified) — covers the retired pin_symbol/pin_file scopes (TRA-196)', () => {
  let store: ReturnType<typeof createTestStore>;
  let tools: Record<string, RegisteredTool>;

  beforeEach(() => {
    store = createTestStore();
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerAnalysisTools(server, makeCtx(store));
    tools = getRegisteredTools(server);
  });

  it('pin{symbol_id} matches pin_symbol', async () => {
    const viaPin = parseText(
      await tools.pin.handler({ symbol_id: 'src/foo.ts::Foo#class', weight: 2.0 }, {}),
    ) as { ok: boolean; pins: Array<{ scope: string; target_id: string; weight: number }> };
    expect(viaPin.ok).toBe(true);
    expect(viaPin.pins).toHaveLength(1);
    expect(viaPin.pins[0]).toMatchObject({
      scope: 'symbol',
      target_id: 'src/foo.ts::Foo#class',
      weight: 2.0,
    });
  });

  it('pin{file_path} matches pin_file', async () => {
    const viaPin = parseText(
      await tools.pin.handler({ file_path: 'src/foo.ts', weight: 1.5 }, {}),
    ) as { ok: boolean; pins: Array<{ scope: string; target_id: string; weight: number }> };
    expect(viaPin.ok).toBe(true);
    expect(viaPin.pins).toHaveLength(1);
    expect(viaPin.pins[0]).toMatchObject({ scope: 'file', target_id: 'src/foo.ts', weight: 1.5 });
  });

  it('pin{symbol_id, file_path} pins both with the same weight', async () => {
    const result = parseText(
      await tools.pin.handler(
        { symbol_id: 'src/foo.ts::Foo#class', file_path: 'src/foo.ts', weight: 2.5 },
        {},
      ),
    ) as { ok: boolean; pins: Array<{ scope: string; weight: number }> };
    expect(result.ok).toBe(true);
    expect(result.pins).toHaveLength(2);
    expect(result.pins.map((p) => p.scope).sort()).toEqual(['file', 'symbol']);
    for (const pin of result.pins) expect(pin.weight).toBe(2.5);
  });

  it('pin with neither symbol_id nor file_path errors', async () => {
    const result = await tools.pin.handler({}, {});
    expect(result.isError).toBe(true);
    const parsed = parseText(result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
  });

  it('pin{file_path, weight: 0.5} records a demotion weight', async () => {
    const result = parseText(
      await tools.pin.handler({ file_path: 'src/baz.ts', weight: 0.5 }, {}),
    ) as { ok: boolean; pins: Array<{ scope: string; target_id: string; weight: number }> };
    expect(result.ok).toBe(true);
    expect(result.pins[0]).toMatchObject({ scope: 'file', target_id: 'src/baz.ts', weight: 0.5 });
  });

  it('the retired pin_symbol / pin_file aliases are no longer registered (TRA-240)', () => {
    expect(tools.pin_symbol).toBeUndefined();
    expect(tools.pin_file).toBeUndefined();
  });

  it('regression: unpin and list_pins are untouched by this change', async () => {
    await tools.pin.handler({ file_path: 'src/temp.ts' }, {});
    const listed = parseText(await tools.list_pins.handler({}, {})) as { total: number };
    expect(listed.total).toBe(1);

    const unpinned = parseText(await tools.unpin.handler({ file_path: 'src/temp.ts' }, {})) as {
      ok: boolean;
      deleted: number;
    };
    expect(unpinned.ok).toBe(true);
    expect(unpinned.deleted).toBe(1);
  });
});
