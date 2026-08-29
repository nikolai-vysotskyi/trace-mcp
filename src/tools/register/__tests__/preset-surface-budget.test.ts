/**
 * What a session actually pays for `tools/list`, per preset (TRA-402).
 *
 * tool-schema-budget.test.ts measures the *whole* registered surface, which is
 * what a `full` session pays. Progressive disclosure only makes sense if the
 * small presets are meaningfully cheaper than that, and stay cheaper — a preset
 * that quietly grows back toward `full` gives up the win without anything
 * failing. So this reconstructs the serialized `tools/list` payload for each
 * preset and caps it.
 *
 * The reconstruction is the wire shape (`name` + `description` + JSON-Schema
 * `inputSchema`) rather than a diff of zod objects, for the reason TRA-186
 * settled: structural JSON Schema, not the prose, is most of the cost.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { UNGATED_META_TOOLS } from '../../../server/tool-filter.js';
import { TOOL_PRESETS } from '../../project/presets.js';
import { captureAllTools } from './_capture-tools.js';

const ALL_TOOLS = captureAllTools();

/** Serialized size of the `tools` array a client receives for `preset`. */
function presetPayloadChars(preset: string): { chars: number; tools: number } {
  const members = TOOL_PRESETS[preset];
  const allowed =
    members === 'all' ? null : new Set([...(members as string[]), ...UNGATED_META_TOOLS]);
  const payload = ALL_TOOLS.filter((t) => !allowed || allowed.has(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(z.object(t.schemaShape)),
  }));
  return { chars: JSON.stringify(payload).length, tools: payload.length };
}

/**
 * Measured 2026-08-29 against this reconstruction, with `load_tools` and the
 * widened `minimal` preset in place:
 *
 *   minimal       28 tools /  34,041 chars  (the shipped default)
 *   review        27 tools /  28,866 chars
 *   architecture  35 tools /  33,629 chars
 *   standard      55 tools /  64,598 chars  (the previous default)
 *   full         151 tools / 157,060 chars
 *
 * `load_tools` itself is 905 of those chars — 0.6% of the full surface, and
 * what makes the other 123k optional.
 *
 * These sit below the TRA-250 live-daemon measurement (minimal 32,914 /
 * standard 68,818 / full 187,790 chars) because that path serialized through a
 * daemon with framework-gated tools active; the ratios, which is what these
 * ceilings guard, match. Headroom is ~10%: enough for a tool or two, not enough
 * to hide a preset drifting back toward the full surface.
 */
const PRESET_CHAR_CEILINGS: Record<string, number> = {
  minimal: 37_500,
  review: 32_000,
  architecture: 37_000,
  standard: 71_000,
};

describe('per-preset tools/list budget (TRA-402)', () => {
  const full = presetPayloadChars('full');

  it('measures a full surface consistent with the always-on schema budget', () => {
    expect(full.tools).toBeGreaterThan(140);
  });

  for (const [preset, ceiling] of Object.entries(PRESET_CHAR_CEILINGS)) {
    it(`keeps the "${preset}" tools/list payload under ${ceiling} chars`, () => {
      const { chars, tools } = presetPayloadChars(preset);
      expect(
        chars,
        `The "${preset}" surface is ${chars} chars across ${tools} tools, past the ${ceiling} ceiling. ` +
          'Every session on this preset pays it before asking a question — move the new tool out of the ' +
          'preset and let load_tools pull it in instead of raising the ceiling.',
      ).toBeLessThanOrEqual(ceiling);
    });
  }

  it('makes the minimal preset a real saving over the full surface', () => {
    const minimal = presetPayloadChars('minimal');
    const cut = (full.chars - minimal.chars) / full.chars;
    expect(
      cut,
      `minimal cuts only ${(cut * 100).toFixed(1)}% of the full tools/list payload ` +
        `(${full.chars} → ${minimal.chars}). Below 75% the deferral is not worth the escalation round-trip.`,
    ).toBeGreaterThanOrEqual(0.75);
  });

  it('carries the escalation path in every preset, so no tool is unreachable', () => {
    // The whole design rests on this: a preset that hides `load_tools` makes its
    // own deferred half permanently unreachable, which is the trade progressive
    // disclosure exists to avoid.
    for (const preset of Object.keys(TOOL_PRESETS)) {
      const members = TOOL_PRESETS[preset];
      const allowed =
        members === 'all' ? null : new Set([...(members as string[]), ...UNGATED_META_TOOLS]);
      expect(!allowed || allowed.has('load_tools'), `"${preset}" preset hides load_tools`).toBe(
        true,
      );
    }
  });
});
