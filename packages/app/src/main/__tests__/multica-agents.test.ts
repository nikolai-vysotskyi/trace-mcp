/**
 * Unit tests for main/multica-agents.ts (TRA-1933 Phase C).
 * The runner is faked throughout — no `multica` binary is ever spawned.
 */
import { describe, expect, it } from 'vitest';
import {
  getMulticaAgentWirings,
  parseTracePreset,
  type MulticaRunner,
} from '../multica-agents.js';

function runnerWith(tables: Record<string, string | Error>): MulticaRunner {
  return async (args: string[]) => {
    const key = args.join(' ');
    const hit = tables[key];
    if (hit instanceof Error) throw hit;
    if (typeof hit === 'string') return hit;
    throw new Error(`unexpected call: ${key}`);
  };
}

const AGENT_LIST = JSON.stringify([
  {
    id: 'agent-1',
    name: 'Lead',
    status: 'idle',
    mcp_config: null,
    mcp_config_redacted: false,
  },
  {
    id: 'agent-2',
    name: 'Impl',
    status: 'busy',
    mcp_config: {
      mcpServers: { trace: { command: 'trace-mcp', args: ['serve', '--preset', 'dev'] } },
    },
    mcp_config_redacted: false,
  },
  {
    id: 'agent-3',
    name: 'Secret',
    status: 'idle',
    mcp_config: null,
    mcp_config_redacted: true,
  },
]);

describe('parseTracePreset', () => {
  it('reads --preset from a trace serve entry', () => {
    expect(
      parseTracePreset({
        mcpServers: { trace: { command: 'trace-mcp', args: ['serve', '--preset', 'review'] } },
      }),
    ).toBe('review');
  });

  it('accepts the legacy trace-mcp key too', () => {
    expect(
      parseTracePreset({
        mcpServers: { 'trace-mcp': { command: 'x', args: ['serve', '--preset', 'perf'] } },
      }),
    ).toBe('perf');
  });

  it('returns null when nothing parseable is there — never a guess', () => {
    expect(parseTracePreset(null)).toBe(null);
    expect(parseTracePreset({})).toBe(null);
    expect(parseTracePreset({ mcpServers: { other: {} } })).toBe(null);
    // serve without --preset: the machine default applies, which we cannot see
    expect(
      parseTracePreset({ mcpServers: { trace: { command: 'x', args: ['serve'] } } }),
    ).toBe(null);
  });
});

describe('getMulticaAgentWirings', () => {
  it('combines agent list with per-agent mcp assignments', async () => {
    const runner = runnerWith({
      'agent list --output json': AGENT_LIST,
      'agent mcp list agent-1 --output json': JSON.stringify([]),
      'agent mcp list agent-2 --output json': JSON.stringify([
        { id: 'srv', name: 'trace', transport: 'stdio', enabled: true },
      ]),
      'agent mcp list agent-3 --output json': JSON.stringify([
        { id: 'srv', name: 'trace', transport: 'stdio', enabled: false },
      ]),
    });

    const report = await getMulticaAgentWirings(runner);

    expect(report.ok).toBe(true);
    expect(report.available).toBe(true);
    expect(report.agents).toEqual([
      {
        id: 'agent-1',
        name: 'Lead',
        status: 'idle',
        traceAssigned: false,
        traceEnabled: false,
        customConfig: 'none',
        preset: null,
      },
      {
        id: 'agent-2',
        name: 'Impl',
        status: 'busy',
        traceAssigned: true,
        traceEnabled: true,
        customConfig: 'present',
        preset: 'dev',
      },
      {
        id: 'agent-3',
        name: 'Secret',
        status: 'idle',
        traceAssigned: true,
        traceEnabled: false,
        customConfig: 'hidden',
        preset: null,
      },
    ]);
  });

  it('reports unavailable (not failed) when the binary is missing', async () => {
    const missing = Object.assign(new Error('spawn multica ENOENT'), { code: 'ENOENT' });
    const report = await getMulticaAgentWirings(runnerWith({ 'agent list --output json': missing }));

    expect(report.ok).toBe(false);
    expect(report.available).toBe(false);
    expect(report.error).toContain('multica CLI not found');
  });

  it('degrades one unreadable assignment to unknown without failing the section', async () => {
    const runner = runnerWith({
      'agent list --output json': AGENT_LIST,
      'agent mcp list agent-1 --output json': new Error('boom'),
      'agent mcp list agent-2 --output json': JSON.stringify([]),
      'agent mcp list agent-3 --output json': JSON.stringify([]),
    });

    const report = await getMulticaAgentWirings(runner);

    expect(report.ok).toBe(true);
    expect(report.agents?.[0].traceAssigned).toBe(null);
    expect(report.agents?.[0].traceEnabled).toBe(null);
    expect(report.agents?.[1].traceAssigned).toBe(false);
  });

  it('reports available-but-broken when the list is not JSON', async () => {
    const report = await getMulticaAgentWirings(
      runnerWith({ 'agent list --output json': 'not json {' }),
    );

    expect(report.ok).toBe(false);
    expect(report.available).toBe(true);
  });
});
