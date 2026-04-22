/** Builds the MCP server instructions string based on verbosity level. */
export function buildInstructions(
  detectedFrameworks: string,
  verbosity: 'full' | 'minimal' | 'none',
  agentBehavior: 'strict' | 'minimal' | 'off' = 'off',
): string {
  const behaviorBlock = buildBehaviorBlock(agentBehavior);

  if (verbosity === 'none') return behaviorBlock;

  if (verbosity === 'minimal') {
    const core = [
      `trace-mcp: framework-aware code intelligence. Detected: ${detectedFrameworks}.`,
      'Use trace-mcp tools instead of Read/Grep/Glob for source code.',
      'Key tools: search, get_outline, get_symbol, get_task_context, get_change_impact, find_usages, batch.',
      'Use batch for 2+ independent queries. Use get_task_context to start tasks.',
      'Use Read/Grep only for non-code files (.md, .json, .yaml) or before Edit.',
    ].join(' ');
    return behaviorBlock ? `${core}\n\n${behaviorBlock}` : core;
  }

  return [
    `trace-mcp is a framework-aware code intelligence server for this project. Detected frameworks: ${detectedFrameworks}.`,
    '',
    'IMPORTANT: For ANY code exploration task, ALWAYS use trace-mcp tools first. NEVER fall back to Read/Grep/Glob/Bash(ls,find) for navigating source code — trace-mcp gives semantic, structured results that are cheaper in tokens and more accurate.',
    '',
    'WHEN TO USE trace-mcp tools:',
    '',
    'Navigation & search:',
    '- Finding a function/class/method → `search` (understands symbol kinds, FQNs, language filters; use `implements`/`extends` to filter by interface). Set `fusion=true` for best ranking — Signal Fusion combines BM25, PageRank, embeddings, and identity match via Weighted Reciprocal Rank fusion.',
    '- Understanding a file before editing → `get_outline` (signatures only — cheaper than Read)',
    '- Reading one symbol\'s source → `get_symbol` (returns only the symbol, not the whole file)',
    '- Quick keyword context → `get_feature_context` (NL query → relevant symbols + source)',
    '- Starting work on a task → `get_task_context` (NL task → full execution context with tests)',
    '',
    'Relationships & impact:',
    '- What breaks if I change X → `get_change_impact` (reverse dependency graph)',
    '- Who calls this / what does it call → `get_call_graph` (bidirectional)',
    '- All usages of a symbol → `find_usages` (semantic: imports, calls, renders, dispatches)',
    '- Tests for a symbol/file → `get_tests_for` (understands test-to-source mapping)',
    '',
    'Architecture & meta-analysis:',
    '- All implementations of an interface → `get_type_hierarchy` (walks extends/implements tree)',
    '- All classes implementing X → `search` with `implements` or `extends` filter',
    '- Project health / coverage gaps → `self_audit` (dead exports, untested code, hotspots)',
    '- Deep test coverage gaps → `get_untested_symbols` (all symbols, not just exports; classifies "unreached" vs "imported_not_called")',
    '- Module dependency graph → `get_module_graph` (NestJS) or `get_import_graph`',
    '- Dead code / dead exports → `get_dead_code` / `get_dead_exports`',
    '- Circular dependencies → `get_circular_imports`',
    '- Coupling analysis → `get_coupling`',
    '',
    'Framework-specific:',
    '- HTTP request flow → `get_request_flow` (route → middleware → controller → service)',
    '- DB model details → `get_model_context` (relationships, schema, metadata)',
    '- Database schema → `get_schema` (from migrations/ORM definitions)',
    '- Component tree → `get_component_tree` (React/Vue/Angular)',
    '- State stores → `get_state_stores` (Zustand/Redux/Pinia)',
    '- Event graph → `get_event_graph` (event emitters/listeners)',
    '',
    'Token optimization (IMPORTANT — saves 40-85% tokens):',
    '- **Batch multiple queries** → `batch` combines up to 10 tool calls into 1 MCP request. Use whenever you need 2+ independent queries:',
    '  `batch({ calls: [{ tool: "get_outline", args: { path: "a.ts" } }, { tool: "get_outline", args: { path: "b.ts" } }] })`',
    '- **Bundle symbol + imports** → `get_context_bundle` returns a symbol\'s source + its import dependencies in one call (supports batch via `symbol_ids[]`)',
    '- **Avoid repeated file reads** → use `get_outline` once to understand structure, then `get_symbol` for specific symbols. NEVER read the same file multiple times.',
    '- **Use `get_task_context` instead of Agent subagents** → it returns focused context within a token budget, replacing manual search chains',
    '- Check token waste → `get_optimization_report` detects repeated reads, Bash grep, and unused trace-mcp tools',
    '- Track savings → `get_session_stats` shows per-tool token savings; `get_real_savings` shows actual vs achievable token usage',
    '',
    'After editing files:',
    '- Call `register_edit` { file_path } after Edit/Write to reindex the changed file and invalidate caches. Much lighter than full `reindex`.',
    '- `register_edit` automatically checks for duplicate symbols — if the response includes `_duplication_warnings`, review them before continuing (you may be recreating existing logic).',
    '',
    'Before creating new functions/classes:',
    '- `check_duplication` { name: "functionName", kind: "function" } — checks if similar symbols already exist. Use BEFORE writing new code to avoid reinventing existing logic.',
    '',
    'Refactoring tools:',
    '- Renaming a symbol → `apply_rename` (renames across all files; supports `dry_run`). Also scans YAML/JSON/env files for mentions.',
    '- Moving a symbol to another file → `apply_move` { symbol_id, target_file } — extracts symbol, updates all imports. Dry-run by default.',
    '- Moving/renaming a file → `apply_move` { source_file, new_path } — moves file, rewrites all import paths. Dry-run by default.',
    '- Changing a function signature → `change_signature` { symbol_id, changes } — add/remove/rename/reorder params + updates all call sites. Dry-run by default.',
    '- Extracting code into a function → `extract_function` (detects params and return values).',
    '- Previewing ANY refactoring → `plan_refactoring` { type, ... } — returns all edits without applying. Use to review before committing.',
    '- Safe collision check before rename → `check_rename` { symbol_id, target_name }.',
    '',
    'Bulk mechanical changes (adding async/await, updating patterns, fixing imports across many files):',
    '- `apply_codemod` { pattern, replacement, file_pattern } — regex find-and-replace across files. Dry-run by default (shows preview). Two-step workflow:',
    '  1. Call with dry_run: true (default) → review preview with context lines',
    '  2. Call with dry_run: false → apply changes. Requires confirm_large: true if >20 files affected.',
    '- Use `filter_content` to narrow scope to files containing a specific substring.',
    '- Use `multiline: true` for patterns spanning multiple lines.',
    '- NEVER use dozens of Edit calls for the same regex replacement — use apply_codemod instead.',
    '',
    'WHEN TO USE native tools (Read/Grep/Glob):',
    '- Non-code files (.md, .json, .yaml, .toml, config) → Read/Grep',
    '- Reading a file before editing (Edit needs full content) → Read',
    '- Finding files by name pattern → Glob',
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
    '- Disagree when the user\'s premise is wrong. Agreeing to be polite produces worse outcomes than pushback — say so before doing the work.',
    '- Never fabricate paths, symbols, APIs, signatures, or test output. Call `search` / `get_symbol` / run the command. "I don\'t know, let me check" beats a plausible guess.',
    '- When a task has two plausible interpretations that materially change the diff — ask, don\'t pick silently. For trivial/reversible tasks (typo, local rename), proceed.',
    '- Rewrite vague asks into verifiable goals before coding: "Fix the bug" → write a failing test reproducing the symptom, then fix. "Make it faster" → benchmark first, identify bottleneck, show benchmark improved.',
    '- Never report "done" based on a plausible-looking diff. Run the test/build/typecheck. Plausibility is not correctness.',
    '- After two failed attempts at the same issue, stop. Summarize what was tried and suggest a fresh session — polluted context + third attempt is worse than fresh context + sharper prompt.',
    '- Touch only what the request requires. No drive-by refactors, reformatting, or cleanups of unrelated code while you\'re in the file.',
  ].join('\n');
}
