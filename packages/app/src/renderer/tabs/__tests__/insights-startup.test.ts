/* The startup-context report's flattener (TRA-759).
 *
 * The two things that must survive the trip from tool payload to row:
 *  - the residual row says it is a residual. It is the biggest number on the
 *    screen and the only one that is a subtraction, so presenting it like the
 *    measured rows would be the report telling a confident lie.
 *  - a hook keeps its own name. "SessionStart hooks cost 2,793 tokens" is
 *    trivia; "hook:superpowers costs 2,793 tokens" is something to act on. */
import { describe, expect, it } from 'vitest';
import { buildLoadToolsCall, flattenStartupContextRows } from '../insights-runtime';

const AUDIT = {
  days: 30,
  sessions: { fresh: 953 },
  startupTokens: { p10: 37_713, median: 49_926, p90: 108_616 },
  sources: [
    {
      source: 'systemPromptToolSchemasAndInstructions',
      meanTokens: 42_202,
      pctOfStartup: 74.7,
      sessions: 953,
      itemised: false,
    },
    {
      source: 'hook:superpowers',
      meanTokens: 2793,
      pctOfStartup: 4.9,
      sessions: 884,
      itemised: true,
    },
  ],
  cost: { startupUsd: 3488, inputSideUsd: 9693, pctOfInputBill: 36 },
  cacheBreakers: [{ cause: 'ttlExpiry', events: 426, extraUsd: 718 }],
  mcpServers: [
    { server: 'context7', sessionsPresent: 870, toolCalls: 8 },
    // Never announced at startup — it costs nothing there, so it is not a row.
    { server: 'ad-hoc', sessionsPresent: 0, toolCalls: 4 },
  ],
};

describe('flattenStartupContextRows', () => {
  it('leads with the size and the price, then the decomposition', () => {
    const { rows } = flattenStartupContextRows(AUDIT);
    expect(rows[0].primary).toContain('49,926');
    expect(rows[1].primary).toContain('$3,488');
    expect(rows[1].badge).toBe('36%');
  });

  it('marks the residual as a residual and keeps a hook’s own name', () => {
    const { rows } = flattenStartupContextRows(AUDIT);
    const residual = rows.find((r) => r.badge === '74.7%');
    expect(residual?.secondary).toContain('Not itemised');
    expect(rows.some((r) => r.primary.includes('superpowers'))).toBe(true);
  });

  it('lists only MCP servers that are actually in the startup block', () => {
    const { rows } = flattenStartupContextRows(AUDIT);
    expect(rows.some((r) => r.primary.includes('context7'))).toBe(true);
    expect(rows.some((r) => r.primary.includes('ad-hoc'))).toBe(false);
  });

  it('returns no rows rather than throwing when the tool answers with nothing', () => {
    expect(flattenStartupContextRows(undefined).rows).toEqual([]);
    expect(flattenStartupContextRows({}).rows).toEqual([]);
  });

  /* Regression: every Insights report calls a tool the daemon's default preset
     leaves disabled, so without this escalation `tools/call` answers
     "Tool <name> disabled" and the pane shows an error instead of a report.
     Reproduced against a stock `serve-http` daemon on 2026-09-03. */
  it('escalates into the report tool before calling it', () => {
    expect(buildLoadToolsCall('startup_context').params).toEqual({
      name: 'load_tools',
      arguments: { tools: ['get_startup_context_audit'] },
    });
  });
});
