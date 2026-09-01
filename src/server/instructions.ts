/**
 * How the instructions refer to the host's own file tools.
 *
 * The routing table is written for a host we cannot see, so TRA-512 made it name
 * tools generically — `read`, `content-match`, `glob` — rather than assume Claude
 * Code's. When the `initialize` handshake tells us which host is actually
 * connected we can do better than generic and name its real tools, so these are
 * a per-profile value the client-profile layer swaps on the wire
 * (server/client-profile.ts) rather than literals.
 */
export interface HostToolNames {
  /** Parenthetical after "THE RULE", introducing the host's vocabulary. */
  rubric: string;
  /** File-read tool. */
  read: string;
  /** Content-match tool. */
  grep: string;
  /** File-glob tool. */
  glob: string;
  /** Line-edit tools, as one phrase. */
  edit: string;
}

/** What `buildInstructions` emits, and what an unrecognised host keeps. */
export const HOST_TOOLS_GENERIC: HostToolNames = {
  rubric:
    'host tool names vary — `read`, `content-match`/grep, `glob` mean whatever yours are called',
  read: '`read`',
  grep: '`content-match`',
  glob: '`glob`',
  edit: 'Edit/Write',
};

/**
 * Every instructions line that names a host tool, in a fixed order.
 *
 * Retargeting is a substring swap of this array (generic → profile), so both
 * sides must build from this one function or the swap silently no-ops. Kept
 * honest by client-profile.test.ts.
 */
export function hostToolLines(h: HostToolNames): string[] {
  return [
    `THE RULE (${h.rubric}):`,
    `- Full-file ${h.read} for discovery: not the move. Take \`get_outline\`, then pull the one symbol with \`get_symbol\`. Read the file directly only when you already have the outline and the span you want is a few lines — or the file is not code (.md/.json/.yaml/config), or you are about to edit it.`,
    `- ${h.grep} or ${h.glob} over source: not the move. \`search\` and \`find_usages\` resolve symbol kinds, imports, and call sites; a text scan cannot rank its hits and misses re-exports, aliases, and dynamic dispatch.`,
    `- After every ${h.edit} → \`register_edit\` { file_path } (reindexes one file; far lighter than \`reindex\`). If the reply carries \`_duplication_warnings\`, review them before continuing.`,
    `Use trace-mcp tools instead of ${h.read}/${h.grep}/${h.glob} for source code.`,
    `Use ${h.read}/${h.grep} only for non-code files (.md, .json, .yaml) or before ${h.edit}.`,
  ];
}

/** Builds the MCP server instructions string based on verbosity level. */
export function buildInstructions(
  detectedFrameworks: string,
  verbosity: 'full' | 'minimal' | 'none',
  agentBehavior: 'strict' | 'minimal' | 'off' = 'off',
): string {
  const behaviorBlock = buildBehaviorBlock(agentBehavior);
  const host = hostToolLines(HOST_TOOLS_GENERIC);

  if (verbosity === 'none') return behaviorBlock;

  if (verbosity === 'minimal') {
    const core = [
      `trace-mcp: framework-aware code intelligence. Detected: ${detectedFrameworks}.`,
      host[4],
      'Key tools: search, get_outline, get_symbol, get_task_context, get_change_impact, find_usages, batch.',
      'Use batch for 2+ independent queries. Use get_task_context to start tasks.',
      host[5],
    ].join(' ');
    return behaviorBlock ? `${core}\n\n${behaviorBlock}` : core;
  }

  return [
    `trace-mcp is a framework-aware code intelligence server for this project. Detected frameworks: ${detectedFrameworks}.`,
    '',
    host[0],
    host[1],
    host[2],
    '',
    'If you catch yourself thinking one of these, that is the signal to switch:',
    '- "I already know the path, so one read is cheaper than a lookup." — knowing the path does not shrink the file. The lookup returns the symbol; the read returns everything around it.',
    '- "The read tool\'s description says to use it when I know the file." — it was written for hosts without a symbol index. This project has one.',
    '- "Three of these calls versus one built-in call." — what costs is tokens returned into context, not calls issued. `batch` sends up to 10 as one request.',
    '- "This is a quick check, not exploration." — a quick check on a 500-line file still costs 500 lines; `get_symbol` costs the symbol.',
    '- "I read this file already, re-reading is free." — it is not; call `get_outline` for a structure reminder instead.',
    '',
    'WHEN TO USE trace-mcp tools (tool descriptions carry the details):',
    '',
    'Navigation & search:',
    '- Find a function/class/method → `search` (add `fusion=true` for best ranking; `implements`/`extends` filter by interface)',
    '- Understand a file before editing → `get_outline`',
    "- Read one symbol's source → `get_symbol`; symbol + its imports → `get_context_bundle`",
    '- Quick keyword context → `get_feature_context`; starting a task → `get_task_context`',
    '',
    'Relationships & impact:',
    '- What breaks if I change X → `get_change_impact`',
    '- Who calls this / what it calls → `get_call_graph`',
    '- All usages of a symbol → `find_usages`',
    '- Tests for a symbol/file → `get_tests_for`',
    '',
    'Architecture & meta-analysis:',
    '- Implementations of an interface → `get_implementations`',
    '- Health, dead exports, hotspots → `self_audit`; untested symbols → `get_untested_symbols`',
    '- Dead code → `get_dead_code` (`mode: "exports_only"` for exports)',
    '- Imports → `get_import_graph` (`get_module_graph` on NestJS); cycles → `get_circular_imports`; coupling → `get_coupling`',
    '',
    'Framework-specific: `get_request_flow` (HTTP route→controller), `get_model_context` and `get_schema` (DB), `get_component_tree` (React/Vue/Angular), `get_state_stores`, `get_event_graph`.',
    '',
    'Token optimization:',
    '- 2+ independent queries → `batch` ({ calls: [{ tool, args }, ...] }), up to 10 per request',
    '- `get_task_context` replaces spawning a subagent to explore — same context, one call, inside a token budget',
    '- Check waste → `get_optimization_report`; track savings → `get_session_stats`, `get_real_savings`',
    '',
    'Editing:',
    host[3],
    '- Before writing a new function/class → `check_duplication` { name, kind }',
    '- Rename → `apply_rename`; move a symbol or file → `apply_move`; change params → `change_signature`; delete → `remove_dead_code`. All dry-run by default: review, then re-call with `dry_run: false` (`confirm_large: true` past 20 files). Preview any of them with `plan_refactoring`. `extract_function` is disabled.',
    '- Same mechanical change 2+ times → `apply_codemod` { pattern, replacement, file_pattern }, not a run of edits.',
    '',
    'Start with `get_project_map` (summary_only=true) to orient yourself.',
    ...(behaviorBlock ? ['', behaviorBlock] : []),
  ].join('\n');
}

function buildBehaviorBlock(level: 'strict' | 'minimal' | 'off'): string {
  if (level === 'off') return '';

  if (level === 'minimal') {
    return [
      'Agent Behavior:',
      '- Never fabricate file paths, symbols, APIs, signatures, or test output. Call `search` / `get_symbol` / run the command. "I don\'t know, let me check" beats a plausible guess.',
    ].join('\n');
  }

  return [
    'Agent Behavior (applies to all tasks, not just code exploration):',
    '- No flattery, no filler. Skip openers like "Great question", "You\'re absolutely right", "Excellent idea", "I\'d be happy to". Start with the answer or the action.',
    "- Disagree when the user's premise is wrong. Agreeing to be polite produces worse outcomes than pushback — say so before doing the work.",
    '- Never fabricate paths, symbols, APIs, signatures, or test output. Call `search` / `get_symbol` / run the command. "I don\'t know, let me check" beats a plausible guess.',
    "- When a task has two plausible interpretations that materially change the diff — ask, don't pick silently. For trivial/reversible tasks (typo, local rename), proceed.",
    '- Rewrite vague asks into verifiable goals before coding: "Fix the bug" → write a failing test reproducing the symptom, then fix. "Make it faster" → benchmark first, identify bottleneck, show benchmark improved.',
    '- Never report "done" based on a plausible-looking diff. Run the test/build/typecheck. Plausibility is not correctness.',
    '- After two failed attempts at the same issue, stop. Summarize what was tried and suggest a fresh session — polluted context + third attempt is worse than fresh context + sharper prompt.',
    "- Touch only what the request requires. No drive-by refactors, reformatting, or cleanups of unrelated code while you're in the file.",
  ].join('\n');
}
