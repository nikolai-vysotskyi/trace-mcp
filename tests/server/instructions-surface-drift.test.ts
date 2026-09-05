import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../../src/server/instructions.js';
import { UNGATED_META_TOOLS } from '../../src/server/tool-filter.js';
import { TOOL_PRESETS, resolvePreset } from '../../src/tools/project/presets.js';
import { allToolNames } from '../docs/tool-surface.js';

/**
 * TRA-929: the instructions block used to be preset-blind — it routed every
 * session to the `full` catalog, so a default (`minimal`) install was told by
 * name to call 26 tools missing from its own `tools/list`.
 *
 * This is the guard that keeps it fixed as presets and tool names move: for
 * every preset, every trace-mcp tool the emitted block names must be on that
 * session's surface. A new preset, or a tool leaving one, fails here rather
 * than shipping a block that promises it.
 */

const REGISTERED = new Set(allToolNames());

/** Backticked identifiers that are params, values, or host vocabulary — not tools. */
const NON_TOOLS = new Set([
  'read',
  'content-match',
  'glob',
  'fusion',
  'implements',
  'extends',
  'exports_only',
  'dry_run',
  'confirm_large',
  'file_path',
  'true',
  'false',
  '_duplication_warnings',
]);

/** Every trace-mcp tool name the block mentions, backticked or not. */
function toolsNamedIn(text: string): string[] {
  const words = new Set([...text.matchAll(/[a-z][a-z0-9_]{2,}/g)].map((m) => m[0]));
  return [...words].filter((w) => !NON_TOOLS.has(w) && REGISTERED.has(w));
}

describe('instructions match the session surface', () => {
  for (const preset of Object.keys(TOOL_PRESETS)) {
    const resolved = resolvePreset(preset);
    if (!resolved) throw new Error(`unresolvable preset in TOOL_PRESETS: ${preset}`);
    // Mirrors createToolFilter with no include/exclude configured.
    const onSurface = (name: string): boolean =>
      resolved === 'all' || resolved.has(name) || UNGATED_META_TOOLS.has(name);

    for (const verbosity of ['full', 'minimal'] as const) {
      it(`names no tool outside the "${preset}" preset (verbosity=${verbosity})`, () => {
        // 'none' for frameworks: framework-gated tools are registered only when
        // their framework is detected, which no preset can tell us.
        const out = buildInstructions('none', verbosity, 'off', onSurface);
        const offSurface = toolsNamedIn(out).filter((n) => !onSurface(n));
        expect(
          offSurface,
          `instructions route "${preset}" to tools it does not advertise: ${offSurface.join(', ')}`,
        ).toEqual([]);
      });
    }
  }

  it('still routes the default preset to the tools it does have', () => {
    const minimal = resolvePreset('minimal') as Set<string>;
    const out = buildInstructions('none', 'full', 'off', (n) => minimal.has(n));
    for (const tool of ['search', 'get_outline', 'get_symbol', 'find_usages', 'register_edit']) {
      expect(out).toContain(tool);
    }
  });

  it('tells a session with a deferred half how to reach it', () => {
    const minimal = resolvePreset('minimal') as Set<string>;
    const out = buildInstructions('none', 'full', 'off', (n) => minimal.has(n));
    expect(out).toContain('load_tools');
    expect(out).toContain('batch');
  });

  it('costs the default surface less than routing it to the full catalog', () => {
    const minimal = resolvePreset('minimal') as Set<string>;
    const preset = buildInstructions('none', 'full', 'off', (n) => minimal.has(n));
    const catalog = buildInstructions('none', 'full', 'off');
    expect(preset.length).toBeLessThan(catalog.length);
  });
});
