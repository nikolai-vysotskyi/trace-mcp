/**
 * What a session gets when its preset name does not resolve (TRA-648).
 *
 * The fallback used to be `all`, so a typo in `TRACE_MCP_PRESET` — or a preset
 * that only exists in a version newer than the one installed, which is every
 * agent configured for the TRA-603 role presets before 3.12.0 publishes — was
 * served the whole 151-tool surface. Measured on this repo 2026-09-01: `design`
 * is 5,042 o200k tokens of `tools/list`, `full` is 36,277. That is a 7.2x
 * increase in the exact direction opposite to what the flag was set for, with
 * nothing anywhere saying so.
 *
 * These pin the direction of the failure, not the sizes — sizes are guarded by
 * src/tools/register/__tests__/preset-surface-budget.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../config.js';
import { TOOL_PRESETS } from '../../tools/project/presets.js';
import {
  createToolFilter,
  DEFAULT_PRESET,
  resolveSessionPreset,
  UNGATED_META_TOOLS,
} from '../tool-filter.js';

/** In `minimal`, absent from it, and gated (so it proves the filter is not `all`). */
const OUTSIDE_DEFAULT = 'taint_analysis';

afterEach(() => {
  delete process.env.TRACE_MCP_PRESET;
});

describe('unknown preset names fail toward the cheap surface (TRA-648)', () => {
  it('backs the default with a real preset', () => {
    expect(Object.keys(TOOL_PRESETS)).toContain(DEFAULT_PRESET);
    expect(TOOL_PRESETS[DEFAULT_PRESET]).not.toBe('all');
    expect(TOOL_PRESETS[DEFAULT_PRESET]).not.toContain(OUTSIDE_DEFAULT);
  });

  it('serves the default surface, not the full one, for an unresolvable config preset', () => {
    const allowed = createToolFilter({ tools: { preset: 'desgin' } } as TraceMcpConfig);
    expect(allowed('search')).toBe(true);
    expect(
      allowed(OUTSIDE_DEFAULT),
      `An unknown preset served "${OUTSIDE_DEFAULT}" — it fell back to the full surface, ` +
        'which is 7.2x the tools/list payload the session asked for.',
    ).toBe(false);
    // Whatever it falls back to must still carry its own escape hatch.
    expect(allowed('load_tools')).toBe(true);
  });

  it('does the same for an unresolvable TRACE_MCP_PRESET', () => {
    process.env.TRACE_MCP_PRESET = 'perfomance';
    const allowed = createToolFilter({} as TraceMcpConfig);
    expect(allowed('search')).toBe(true);
    expect(allowed(OUTSIDE_DEFAULT)).toBe(false);
  });

  it('reports the preset actually in force, plus the name that did not resolve', () => {
    const unknown = resolveSessionPreset({ tools: { preset: 'desgin' } } as TraceMcpConfig);
    expect(unknown.name).toBe(DEFAULT_PRESET);
    expect(unknown.unknownName).toBe('desgin');
    expect(unknown.tools).not.toBe('all');
  });

  it('leaves resolvable names alone', () => {
    for (const name of Object.keys(TOOL_PRESETS)) {
      const resolved = resolveSessionPreset({ tools: { preset: name } } as TraceMcpConfig);
      expect(resolved.name).toBe(name);
      expect(resolved.unknownName).toBeUndefined();
    }
    expect(resolveSessionPreset({ tools: { preset: 'full' } } as TraceMcpConfig).tools).toBe('all');
  });

  it('still lets tools.include reach past the fallback', () => {
    // The escalation path an unknown name leaves the user is not just load_tools.
    const allowed = createToolFilter({
      tools: { preset: 'desgin', include: [OUTSIDE_DEFAULT] },
    } as TraceMcpConfig);
    expect(allowed(OUTSIDE_DEFAULT)).toBe(true);
  });

  it('keeps the meta tools ungated whichever way the fallback goes', () => {
    const allowed = createToolFilter({ tools: { preset: 'desgin' } } as TraceMcpConfig);
    for (const name of UNGATED_META_TOOLS) expect(allowed(name), name).toBe(true);
  });
});
