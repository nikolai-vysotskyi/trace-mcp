/**
 * Progressive tool disclosure (TRA-402).
 *
 * The behaviour that matters is on the wire, not in the data structures: a
 * deferred tool must be absent from `tools/list` and uncallable, `load_tools`
 * must make it appear *and* fire exactly one `notifications/tools/list_changed`,
 * and `tools.exclude` must stay un-escalatable. So the gate tests drive a real
 * McpServer + Client pair rather than inspecting the gate's return value.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { TraceMcpConfig } from '../../config.js';
import { installToolGate } from '../tool-gate.js';
import { expandLoadRequest, planToolLoad, runLoadTools } from '../tool-surface.js';

// ── Gate integration over a real MCP wire ──────────────────────────────

/** Stubs for installToolGate's savings/journal/serializer collaborators. */
function gateStubs() {
  return {
    savings: {
      recordCall: () => {},
      recordLatency: () => {},
      getSessionStats: () => ({ total_calls: 0, total_raw_tokens: 0 }),
    },
    journal: {
      checkDuplicate: () => null,
      record: () => {},
      getOptimizationHint: () => undefined,
      getEntries: () => [],
      recordDedupSaving: () => {},
    },
  };
}

/**
 * Register three tools through the gate under `config`, then expose the live
 * surface over a real client connection.
 */
async function harness(partial: Partial<TraceMcpConfig> = {}) {
  const config = partial as TraceMcpConfig;
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const { savings, journal } = gateStubs();
  const gate = installToolGate(
    server,
    config,
    // `search` in the preset, `scan_security` and `taint_analysis` outside it.
    new Set(['search']),
    savings as never,
    journal as never,
    (v) => JSON.stringify(v),
    () => 0,
    () => undefined,
    () => {},
  );

  for (const name of ['search', 'scan_security', 'taint_analysis']) {
    server.tool(name, `Run ${name}.`, { q: z.string().describe('query') }, async () => ({
      content: [{ type: 'text' as const, text: `${name} ran` }],
    }));
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const listChanged = vi.fn();
  client.setNotificationHandler(ToolListChangedNotificationSchema, listChanged);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const loadTools = (args: { preset?: string; tools?: string[] }) =>
    runLoadTools(
      {
        deferredTools: gate.deferredTools,
        toolHandlers: gate.toolHandlers,
        registeredToolNames: gate.registeredToolNames,
        isExcluded: (n) => (config.tools?.exclude ?? []).includes(n),
        notifyListChanged: () => server.sendToolListChanged(),
      },
      args,
    );

  const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();

  return { server, client, gate, loadTools, names, listChanged };
}

describe('progressive tool disclosure — gate (TRA-402)', () => {
  it('keeps deferred tools off tools/list and out of batch dispatch', async () => {
    const h = await harness({});
    expect(await h.names()).toEqual(['search']);
    // `batch` dispatches through toolHandlers — a deferred tool must not be
    // reachable that way either, or the preset would be cosmetic.
    expect([...h.gate.toolHandlers.keys()]).toEqual(['search']);
    expect([...h.gate.deferredTools.keys()].sort()).toEqual(['scan_security', 'taint_analysis']);
    await h.client.close();
  });

  it('rejects a tools/call for a deferred tool', async () => {
    const h = await harness({});
    const call = await h.client.callTool({ name: 'scan_security', arguments: { q: 'x' } });
    expect(call.isError).toBe(true);
    expect((call.content as Array<{ text: string }>)[0].text).toMatch(/scan_security disabled/);
    await h.client.close();
  });

  it('load_tools makes a deferred tool appear, callable, and batch-dispatchable', async () => {
    const h = await harness({});
    const result = h.loadTools({ tools: ['scan_security'] });
    expect(result.loaded).toEqual(['scan_security']);

    expect(await h.names()).toEqual(['scan_security', 'search']);
    const call = await h.client.callTool({ name: 'scan_security', arguments: { q: 'x' } });
    expect((call.content as Array<{ text: string }>)[0].text).toBe('scan_security ran');
    expect(h.gate.toolHandlers.has('scan_security')).toBe(true);
    await h.client.close();
  });

  it('fires exactly one tools/list_changed per load_tools call, whatever the batch size', async () => {
    const h = await harness({});
    h.loadTools({ preset: 'full' });
    // The notification is async over the transport; give the loop a turn.
    await h.client.listTools();
    expect(h.listChanged).toHaveBeenCalledTimes(1);
    expect(await h.names()).toEqual(['scan_security', 'search', 'taint_analysis']);
    await h.client.close();
  });

  it('sends no notification when nothing was actually loaded', async () => {
    const h = await harness({});
    const result = h.loadTools({ tools: ['search'] });
    expect(result.already_loaded).toEqual(['search']);
    expect(result.loaded).toEqual([]);
    await h.client.listTools();
    expect(h.listChanged).not.toHaveBeenCalled();
    await h.client.close();
  });

  it("returns the loaded tool's schema so a client that ignores the notification can still use it", async () => {
    const h = await harness({});
    const result = h.loadTools({ tools: ['taint_analysis'] }) as {
      tools: Array<{ name: string; description?: string; input_schema?: { properties?: object } }>;
    };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('taint_analysis');
    expect(result.tools[0].description).toBe('Run taint_analysis.');
    expect(result.tools[0].input_schema?.properties).toHaveProperty('q');
    await h.client.close();
  });

  it('never escalates a tools.exclude entry — exclusion stays a hard restriction', async () => {
    const h = await harness({ tools: { exclude: ['scan_security'] } } as Partial<TraceMcpConfig>);
    const result = h.loadTools({ preset: 'full' });
    expect(result.blocked).toEqual(['scan_security']);
    expect(result.loaded).toEqual(['taint_analysis']);
    expect(await h.names()).toEqual(['search', 'taint_analysis']);
    await h.client.close();
  });

  it('defers nothing on a full-surface session', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const { savings, journal } = gateStubs();
    const gate = installToolGate(
      server,
      {} as TraceMcpConfig,
      'all',
      savings as never,
      journal as never,
      (v) => JSON.stringify(v),
      () => 0,
      () => undefined,
      () => {},
    );
    server.tool('search', 'Run search.', { q: z.string() }, async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));
    expect(gate.deferredTools.size).toBe(0);
    expect(gate.registeredToolNames).toEqual(['search']);
  });
});

// ── Name resolution ────────────────────────────────────────────────────

describe('load_tools request resolution (TRA-402)', () => {
  const deferred = ['scan_security', 'taint_analysis'];

  it('unions preset membership with explicit names', () => {
    const names = expandLoadRequest({ preset: 'review', tools: ['taint_analysis'] }, deferred);
    expect(names).toContain('taint_analysis');
    expect(names).toContain('get_call_graph'); // from the review preset
  });

  it('expands all role presets (dev, security, design, perf, architecture, review)', () => {
    for (const preset of ['dev', 'security', 'design', 'perf', 'architecture', 'review']) {
      const names = expandLoadRequest({ preset }, deferred);
      expect(names.length).toBeGreaterThan(0);
      expect(names).not.toContain(`preset:${preset}`);
    }
  });

  it('treats "full" as everything currently deferred, not the whole registry', () => {
    expect(expandLoadRequest({ preset: 'full' }, deferred).sort()).toEqual(deferred);
  });

  it('surfaces an unknown preset name instead of silently loading nothing', () => {
    const plan = planToolLoad(expandLoadRequest({ preset: 'nope' }, deferred), {
      isLoaded: () => false,
      isDeferred: (n) => deferred.includes(n),
      isExcluded: () => false,
    });
    expect(plan.unknown).toEqual(['preset:nope']);
    expect(plan.load).toEqual([]);
  });

  it('reports an unknown tool name as unknown, not blocked', () => {
    const plan = planToolLoad(['get_nonexistent'], {
      isLoaded: () => false,
      isDeferred: (n) => deferred.includes(n),
      isExcluded: () => false,
    });
    expect(plan).toMatchObject({ unknown: ['get_nonexistent'], blocked: [], load: [] });
  });
});

describe('load_tools discovery call (TRA-402)', () => {
  let deps: Parameters<typeof runLoadTools>[0];

  beforeEach(() => {
    deps = {
      deferredTools: new Map([
        ['scan_security', { registered: { enabled: false }, handler: () => undefined }],
      ]),
      toolHandlers: new Map(),
      registeredToolNames: [],
      isExcluded: () => false,
      notifyListChanged: vi.fn(),
    };
  });

  it('lists the deferred surface when called with no arguments', () => {
    const result = runLoadTools(deps, {});
    expect(result.deferred_tools).toEqual(['scan_security']);
    expect(result.loaded).toEqual([]);
    expect(deps.notifyListChanged).not.toHaveBeenCalled();
  });

  it('treats an empty tools array the same as no arguments', () => {
    expect(runLoadTools(deps, { tools: [] }).deferred_tools).toEqual(['scan_security']);
  });
});
