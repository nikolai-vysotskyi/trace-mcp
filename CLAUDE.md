# trace-mcp Development Guide

## What this project is

trace-mcp is a framework-aware code intelligence MCP server. It indexes source code into a dependency graph with full-text search, understanding 48+ frameworks across 68 languages. It exposes MCP tools for navigation, impact analysis, and framework-specific queries.

## Agent Behavior — read before every task

These rules override tool routing and workflow checklists when in conflict.

### No flattery, no filler
Skip openers: "Great question", "You're absolutely right", "Excellent idea", "I'd be happy to", "Absolutely!". Start the response with the answer or the action. No ceremonial closings.

### Disagree when the premise is wrong
If the user's request rests on a false assumption, say so before doing the work. Agreeing with wrong premises to be polite is worse than pushback. Example: user asks to optimize a function that's not on the hot path — say that, then ask whether to proceed anyway.

### Never fabricate
Not file paths, not symbol names, not API signatures, not test output, not commit hashes. If unsure, call `search` / `get_symbol` / run the command. "I don't know, let me check" beats a plausible-sounding guess.

### Stop when confused
If the task has two plausible interpretations and the choice materially changes the diff, ask. Do not pick silently and proceed. Trivial/reversible tasks (typo, rename local var) — proceed.

### Goal-driven execution
Rewrite vague asks into verifiable goals before writing code:
- "Add validation" → "Write failing tests for invalid inputs (empty, malformed, oversized), make them pass."
- "Fix the bug" → "Write a failing test reproducing the symptom, make it pass."
- "Refactor X" → "Ensure existing test suite passes before and after, no public API changes."
- "Make it faster" → "Benchmark current hot path, identify bottleneck with profiling, show benchmark improved."

Never report "done" based on a plausible-looking diff. Run the test/build/typecheck. Plausibility is not correctness.

### 2-strike session rule
After two failed attempts at the same issue, stop. Summarize what was tried, what was learned, and ask the user to reset the session with a sharper prompt. Do not grind through a third attempt in a polluted context — fresh session + better prompt beats long session + accumulated failures.

### English only in code and content
All text committed to the repository — UI strings, button labels, tooltips, error messages, log output, code comments, docstrings, README/docs, commit messages — MUST be in English. This is a hard rule even when the user is chatting with you in another language. If the user writes in Russian, answer them in Russian, but every string you put in a file is English. No exceptions, including ad-hoc test fixtures or TODO comments. If unsure whether a fixture counts, default to English.

## Build & Test

```bash
npm run build          # TypeScript compilation
npm test               # Vitest (all tests)
npm test -- --run <pattern>  # Run specific test
```

## trace-mcp Tool Routing — MANDATORY (for AI agents working ON this codebase)

**HARD RULE: NEVER use Read, Grep, Glob, or Bash (ls, find, cat, head, tail) to explore or navigate source code (.ts, .js, .py, etc.). ALWAYS use trace-mcp tools instead. This is not a suggestion — it is a requirement. Violations waste tokens and produce worse results.**

Since trace-mcp is its own MCP server, when developing it you MUST use trace-mcp tools to navigate the codebase:

### Decision Matrix — USE THESE, NOT native tools

| Task | trace-mcp tool | NEVER use |
|------|---------------|-----------|
| Find a function/class/method | `search` | ~~Grep~~ ~~Glob~~ |
| Understand a file before editing | `get_outline` | ~~Read (full file)~~ |
| Read one symbol's source | `get_symbol` | ~~Read (full file)~~ |
| What breaks if I change X | `get_change_impact` | ~~guessing~~ |
| Who calls this / what does it call | `get_call_graph` | ~~Grep~~ |
| Find all usages of a symbol | `find_usages` | ~~Grep~~ |
| Get context for a task | `get_feature_context` | ~~reading 15 files with Read~~ |
| Find tests for a symbol | `get_tests_for` | ~~Glob + Grep~~ |
| Find untested symbols (deep) | `get_untested_symbols` (classifies "unreached" vs "imported_not_called") | ~~manual audit~~ |
| Project overview | `get_project_map` (summary_only=true) | ~~Bash ls~~ |
| List files in a directory | `get_outline` or `search` | ~~Bash ls/find~~ ~~Glob~~ |
| Find where something is defined | `search` | ~~Grep~~ |
| Understand project structure | `get_project_map` | ~~Bash find~~ |
| Move a symbol between files | `apply_move` { symbol_id, target_file } | ~~manual cut/paste + Edit~~ |
| Move/rename a file | `apply_move` { source_file, new_path } | ~~manual mv + Edit imports~~ |
| Change function signature | `change_signature` { symbol_id, changes } | ~~manual Edit across files~~ |
| Preview any refactoring | `plan_refactoring` { type, ... } | ~~guessing~~ |

### Token optimization — MANDATORY

**Use `batch` for multiple independent queries.** When you need 2+ independent tool calls, combine them into a single `batch` call. This saves round-trips and reduces context overhead.

```
batch({ calls: [
  { tool: "get_outline", args: { path: "src/server.ts" } },
  { tool: "get_outline", args: { path: "src/config.ts" } },
  { tool: "search", args: { query: "registerTool", kind: "method" } }
] })
```

**Use `get_context_bundle` instead of get_symbol chains.** When you need a symbol + its imports, or multiple symbols at once:
- Single: `get_context_bundle({ symbol_id: "..." })` — returns symbol + imports
- Batch: `get_context_bundle({ symbol_ids: ["...", "..."] })` — deduplicates shared imports

**NEVER read the same file twice.** Use `get_outline` once → then `get_symbol` for specific symbols.

**NEVER use Agent(Explore) or Agent(general-purpose) for code exploration/understanding/review.** This is the single largest source of token waste — each Agent subprocess loads full system prompt + CLAUDE.md + memory (~50K tokens overhead) before doing anything. Use trace-mcp tools instead:

| Instead of Agent… | Use this |
|---|---|
| "Explore codebase structure" | `get_project_map` (summary_only=true) |
| "Explore/analyze/review module X" | `get_task_context` { task: "understand module X" } |
| "Find where X is used" | `find_usages` or `get_call_graph` |
| "Understand how feature Y works" | `get_feature_context` { query: "feature Y" } |
| "Check architecture of Z" | `get_task_context` { task: "architecture of Z" } |
| Multiple independent lookups | `batch` with multiple tool calls |

Agent is ONLY acceptable for: writing code in parallel (background workers), running tests, web research, or Plan mode.

**Monitor waste:** Run `get_optimization_report` to detect repeated reads, Bash grep usage, and missed trace-mcp opportunities.

**After editing a file:** Call `register_edit` { file_path: "path/to/file" } to reindex that single file and invalidate caches. Much lighter than full `reindex`. Do this after every Edit/Write to keep the index fresh. If `_duplication_warnings` appears in the response, review the referenced symbols — you may be duplicating existing logic.

**Before creating new functions/classes:** Call `check_duplication` { name: "functionName", kind: "function" } to verify no similar symbol exists. Prevents reinventing existing logic.

### The ONLY cases where native tools are allowed

- **Read**: ONLY for non-code files (.md, .json, .yaml, .env, config), OR immediately before using Edit on a file you need to modify
- **Grep**: ONLY for searching non-code file content (config, markdown, yaml)
- **Glob**: ONLY for finding non-code files by name pattern
- **Bash**: ONLY for running builds (`npm run build`), tests (`npm test`), git commands, or other CLI operations — NEVER for code exploration
- **Edit**: ONLY for unique, one-off changes. If you are about to make the same kind of change (same pattern/intent) **2 or more times** — whether in one file or across files — STOP and use `apply_codemod` instead. This includes: adding async/await, updating function signatures, fixing import paths, adding/removing keywords, wrapping calls. **No exceptions. No "it's just a few edits". Use apply_codemod.**

### Read-before-Edit optimization (saves ~80K tokens/day)

When you need to Edit a file, minimize what you Read:
1. **Use `get_outline` first** to find the line range of the symbol you need to edit
2. **Read only the relevant range**: `Read { file_path, offset: startLine, limit: endLine - startLine + 10 }` — not the whole file
3. **Never re-read a file you already read** in this session unless it was modified since. If you need a reminder of structure, use `get_outline`
4. **For files >200 lines**: ALWAYS use offset/limit. Reading a 500-line file to edit 5 lines wastes ~400 lines of tokens
5. **After Edit**: call `register_edit` to reindex — do NOT re-read the file to verify (Edit tool confirms success)

### Plugin architecture

- Language plugins: `src/indexer/plugins/lang/` — one per language (ts, python, go, etc.)
- Integration plugins: `src/indexer/plugins/integration/` — framework-specific (api/, framework/, orm/, etc.)
- Each plugin implements `LanguagePlugin` or `FrameworkPlugin` interface from `src/plugin-api/types.ts`
- Plugin registry: `src/plugin-api/registry.ts`

### LSP enrichment subsystem

- `src/lsp/` — separate subsystem (not a plugin) for compiler-grade call graph enrichment
- **Opt-in** via `lsp.enabled: true` in config. Disabled by default, zero overhead when off.
- Pipeline integration: Pass 3 (after tree-sitter indexing + edge resolution, before env indexing)
- Key files:
  - `src/lsp/bridge.ts` — orchestrator (entry point)
  - `src/lsp/client.ts` — JSON-RPC client over stdio (Content-Length framing)
  - `src/lsp/lifecycle.ts` — LSP server process management (lazy start, concurrent limits, shutdown)
  - `src/lsp/enrichment.ts` — core algorithm: callHierarchy/prepare → outgoingCalls → edge upgrade/insert
  - `src/lsp/mappers.ts` — symbol ↔ LSP position mapping
  - `src/lsp/config.ts` — auto-detection of available servers (tsserver, pyright, gopls, rust-analyzer)
  - `src/lsp/protocol.ts` — hand-written LSP type definitions (zero external deps)
- Edges have a `resolution_tier` column: `lsp_resolved` > `ast_resolved` > `ast_inferred` > `text_matched`
- Config schema: `lsp` section in `TraceMcpConfigSchema` (`src/config.ts`)

## Workflow Checklists — MANDATORY

These workflows define which trace-mcp tools MUST be used at each stage. Follow them — they are not optional.

### Starting any task
1. `get_project_map` (summary_only=true) — orient yourself
2. `get_task_context` { task: "description of what you're doing" } — get all relevant code in one call
3. Do NOT read files one by one. `get_task_context` replaces manual chaining of search → get_symbol → Read.

### Before refactoring
1. `assess_change_risk` { file_path / symbol_id } — understand risk level before touching anything
2. `get_refactor_candidates` — find what actually needs refactoring (don't guess)
3. `get_change_impact` — know what breaks before you break it
4. `get_complexity_report` { file_path } — quantify current complexity

### Renaming a symbol
1. `check_rename` { symbol_id, target_name } — collision detection FIRST
2. `apply_rename` { symbol_id, new_name } — renames across ALL files (definition + imports). Also scans non-code files (YAML/JSON/env) for mentions.
3. Review `non_code_suggestions` in the result — apply manually if relevant
4. NEVER rename manually via Edit with replace_all — it misses import sites and cross-file references

### Moving a symbol or file
1. `plan_refactoring` { type: "move", symbol_id, target_file } — preview all edits FIRST
2. Review the edit plan: import rewrites, barrel updates, sibling dependency imports
3. `apply_move` { symbol_id, target_file, dry_run: false } — apply the move
4. Or for file moves: `apply_move` { source_file, new_path, dry_run: false } — moves file + rewrites all import paths
5. `register_edit` for all modified files after the move

### Changing a function signature
1. `plan_refactoring` { type: "signature", symbol_id, changes } — preview all edits FIRST
2. Review: definition changes + all call site updates
3. `change_signature` { symbol_id, changes, dry_run: false } — apply changes
4. Changes: `add_param`, `remove_param`, `rename_param`, `reorder_params`
5. Params with `default_value` don't require call site changes; params without get `undefined` placeholder

### Previewing any refactoring
- `plan_refactoring` { type: "rename"|"move"|"extract"|"signature", ... } — returns all {old_text, new_text} pairs without applying
- Always use this before destructive refactoring to review the blast radius

### Bulk mechanical changes (add async/await, update patterns, fix imports across many files)
1. `apply_codemod` { pattern, replacement, file_pattern, dry_run: true } — preview changes first (dry_run is default)
2. Review the preview — check matched files, context lines, replacement correctness
3. `apply_codemod` { pattern, replacement, file_pattern, dry_run: false } — apply changes
4. If >20 files affected, must add `confirm_large: true`
5. Use `filter_content` to narrow scope (e.g. only files containing "extractNodes")
6. Use `multiline: true` for patterns spanning multiple lines
7. NEVER use Edit for the same mechanical change 2+ times — use apply_codemod. This is a HARD RULE, not a guideline. Even "just 3 edits" is a violation.

### Deleting code
1. `get_dead_code` { file_pattern } — verify code is actually dead (multi-signal detection)
2. `get_dead_exports` { file_pattern } — find unused exports
3. `remove_dead_code` { symbol_id } — safe removal with orphan import detection
4. NEVER delete code without verifying it's dead first

### Before PR / commit
1. `scan_security` { rules: ["all"] } — OWASP Top-10 vulnerability scan
2. `check_quality_gates` { scope: "changed" } — quality gate validation
3. `detect_antipatterns` {} — performance antipattern scan
4. `compare_branches` { branch: "current" } — symbol-level diff for PR description
5. Fix any critical/high findings before committing

### Bug fixing
1. `predict_bugs` {} — prioritize which files to investigate
2. `get_risk_hotspots` {} — high complexity + high churn = likely bug location
3. `get_task_context` { task: "fix the bug description" } — get relevant code
4. `taint_analysis` {} — if security-related, trace untrusted data flows

### Upgrading dependencies
1. `plan_batch_change` { package: "name", from_version, to_version } — impact analysis
2. Review all affected files and import references
3. `check_quality_gates` { scope: "changed" } — verify no degradation after upgrade

### Periodic health checks (once per session)
1. `audit_config` {} — check for stale references in CLAUDE.md/settings
2. `self_audit` {} — dead exports, untested code, hotspots
3. `get_tech_debt` {} — per-module tech debt grades
