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
 * Measured 2026-09-03 against this reconstruction, with `load_tools`, the
 * widened `minimal` preset and the TRA-603 role presets in place. Token column
 * is gpt-tokenizer (o200k) over the same serialized payload:
 *
 *   router        10 tools /   7,120 chars /  1,604 tok  (-95.7% vs full)
 *   state         20 tools /  16,338 chars /  3,727 tok  (-90.0%)
 *   design        21 tools /  22,127 chars /  5,093 tok  (-86.3%)
 *   perf          31 tools /  32,511 chars /  7,557 tok  (-79.7%)
 *   minimal       28 tools /  34,257 chars /  7,857 tok  (-78.9%, shipped default)
 *   review        32 tools /  37,488 chars /  8,638 tok  (-76.8%)
 *   security      35 tools /  41,715 chars /  9,641 tok  (-74.1%)
 *   architecture  41 tools /  44,474 chars / 10,262 tok  (-72.4%)
 *   dev           42 tools /  51,541 chars / 11,904 tok  (-68.0%)
 *   standard      55 tools /  64,814 chars / 14,953 tok  (-59.8%, previous default)
 *   full         158 tools / 161,702 chars / 37,164 tok
 *
 * Two days on from the 2026-09-01 reading the presets are within 0.5% of
 * themselves while `full` grew 151 → 158 tools; the published 67-86% band still
 * holds because the presets held, not because the surface stopped growing.
 *
 * Counts exclude framework-gated tools, which `captureAllTools` does not
 * register — `design` and `standard` each name five of them, so a project with
 * the matching framework detected pays more than the row above.
 *
 * `load_tools` itself is 905 of those chars — 0.6% of the full surface, and
 * what makes the other 123k optional.
 *
 * These sit below the TRA-250 live-daemon measurement (minimal 32,914 /
 * standard 68,818 / full 187,790 chars) because that path serialized through a
 * daemon with framework-gated tools active; the ratios, which is what these
 * ceilings guard, match. Headroom is ~10-15%: enough for a tool or two, not
 * enough to hide a preset drifting back toward the full surface.
 */
const PRESET_CHAR_CEILINGS: Record<string, number> = {
  // TRA-675. Membership is empty, so this is exactly UNGATED_META_TOOLS:
  // 10 tools / 7,120 chars / 1,604 tok against this reconstruction — 95.6%
  // below `full` (161,652 / 37,145) and 79.2% below the `minimal` default
  // (34,207 / 7,838). The ceiling leaves room for a meta-tool or two and none
  // for the preset quietly acquiring members.
  router: 8_000,
  // TRA-596 shipped this preset without a ceiling and nothing failed, because
  // the loop below used to iterate this map instead of TOOL_PRESETS — so the
  // preset went unguarded from #715 until now. 16,338 chars / 3,727 tok today.
  state: 19_000,
  minimal: 38_000,
  review: 42_000,
  dev: 58_000,
  security: 46_000,
  design: 25_000,
  perf: 37_000,
  architecture: 50_000,
  standard: 71_000,
};

describe('per-preset tools/list budget (TRA-402)', () => {
  const full = presetPayloadChars('full');

  it('measures a full surface consistent with the always-on schema budget', () => {
    expect(full.tools).toBeGreaterThan(140);
  });

  // Iterate the presets, not the ceilings: a preset added without a ceiling is
  // exactly the case this file exists to catch, and iterating the ceilings made
  // it invisible (TRA-596's `state` preset shipped unguarded that way).
  for (const preset of Object.keys(TOOL_PRESETS)) {
    if (preset === 'full') continue;
    const ceiling = PRESET_CHAR_CEILINGS[preset];
    it(`keeps the "${preset}" tools/list payload under ${ceiling ?? '<no ceiling>'} chars`, () => {
      const { chars, tools } = presetPayloadChars(preset);
      expect(
        ceiling,
        `The "${preset}" preset has no entry in PRESET_CHAR_CEILINGS, so nothing stops it drifting ` +
          `back toward the full surface. It is ${chars} chars across ${tools} tools today — add a ` +
          'ceiling with ~10-15% headroom over that.',
      ).toBeDefined();
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
