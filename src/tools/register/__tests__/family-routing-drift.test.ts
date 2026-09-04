/**
 * Drift guardrail: every member of a declared tool family (src/tools/tool-families.ts)
 * must name at least one sibling of THAT family in its description. Catches a new
 * family member that points at nobody, and a description trimmed for token budget
 * that lost its routing clause.
 *
 * Modelled on toon-drift.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_FAMILIES, familySiblings, routesTo } from '../../tool-families.js';
import { captureAllTools } from './_capture-tools.js';

describe('cross-tool routing hint drift guardrail', () => {
  const tools = captureAllTools();
  const byName = new Map(tools.map((t) => [t.name, t.description]));

  it('every declared family member is a registered tool', () => {
    const missing = Object.entries(TOOL_FAMILIES).flatMap(([family, members]) =>
      members.filter((m) => !byName.has(m)).map((m) => `${family}: ${m}`),
    );
    expect(missing).toEqual([]);
  });

  it('every family member names at least one sibling of that family', () => {
    const gaps: string[] = [];
    for (const [family, members] of Object.entries(TOOL_FAMILIES)) {
      for (const member of members) {
        const description = byName.get(member);
        if (!description) continue;
        const siblings = members.filter((m) => m !== member);
        if (!siblings.some((s) => routesTo(description, s))) {
          gaps.push(`  - ${member} (family "${family}") names none of: ${siblings.join(', ')}`);
        }
      }
    }
    if (gaps.length > 0) {
      throw new Error(
        `Routing hint drift — a tool description lost (or never had) its sibling pointer:\n${gaps.join('\n')}\n\n` +
          'Fix by adding a natural routing clause to the description, e.g.\n' +
          '  "For raw text/comment search use search_text; for references to a known symbol use find_usages."\n' +
          'It must read "use / prefer / with <tool>" — see routesTo() for why a bare mention is not enough.\n' +
          'Keep it prose, not a mechanical list — and keep net description bytes flat by trimming elsewhere.\n' +
          'If the tool genuinely does not overlap, remove it from TOOL_FAMILIES in src/tools/tool-families.ts.',
      );
    }
  });

  it('familySiblings() reports every family a multi-family tool belongs to', () => {
    // find_usages sits in both the search and impact families; its description
    // must satisfy each independently.
    expect(familySiblings('find_usages')).toHaveLength(2);
  });
});
