/**
 * Overlapping tool families — sets of tools an agent could plausibly reach for
 * interchangeably. Every member's description must name at least one sibling of
 * each family it belongs to, so the description text keeps steering the agent to
 * the right tool.
 *
 * This matters because the description is the ONLY routing mechanism that
 * reaches every client: the PreToolUse guard hook is Claude Code only,
 * `src/init/ide-rules.ts` covers Cursor/Windsurf, and a large share of installs
 * report a client we cannot identify at all.
 *
 * Enforced by `src/tools/register/__tests__/family-routing-drift.test.ts`.
 * Also read by `src/server/tool-gate-helpers.ts`, which keeps the routing
 * sentence when `tools.description_verbosity` collapses descriptions.
 */
export const TOOL_FAMILIES: Record<string, readonly string[]> = {
  search: ['search', 'search_text', 'find_usages', 'get_feature_context'],
  context: [
    'get_task_context',
    'get_feature_context',
    'get_context_bundle',
    'get_symbol',
    'get_outline',
  ],
  impact: ['get_call_graph', 'get_change_impact', 'find_usages'],
};

/** Families `tool` belongs to, as sibling lists (the tool itself excluded). */
export function familySiblings(tool: string): string[][] {
  return Object.values(TOOL_FAMILIES)
    .filter((members) => members.includes(tool))
    .map((members) => members.filter((m) => m !== tool));
}

/** Flat set of every family sibling of `tool`, across all its families. */
export function allSiblings(tool: string): string[] {
  return [...new Set(familySiblings(tool).flat())];
}

/**
 * Does `text` route the reader to `sibling`, as opposed to merely containing
 * its name?
 *
 * A bare substring test is not enough in either direction. `search_text`'s own
 * first sentence — "Full-text search across all indexed files" — contains the
 * word "search", which would let the drift gate pass a description that lost
 * its routing clause. And `get_task_context` mentions `get_symbol` mid-sentence
 * while narrating what it replaces ("replaces manual chaining of search →
 * get_symbol → Read"), which is not the sentence a collapsed description should
 * keep.
 *
 * So the convention is the imperative the existing hints already use: a routing
 * clause reads "… use / prefer / with <tool>". Write new hints that way.
 */
export function routesTo(text: string, sibling: string): boolean {
  return new RegExp(`\\b(?:use|prefer|with)\\s+${sibling}\\b`, 'i').test(text);
}
