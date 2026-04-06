# trace-mcp Development Guide

## What this project is

trace-mcp is a framework-aware code intelligence MCP server. It indexes source code into a dependency graph with full-text search, understanding 48+ frameworks across 68 languages. It exposes MCP tools for navigation, impact analysis, and framework-specific queries.

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
| Project overview | `get_project_map` (summary_only=true) | ~~Bash ls~~ |
| List files in a directory | `get_outline` or `search` | ~~Bash ls/find~~ ~~Glob~~ |
| Find where something is defined | `search` | ~~Grep~~ |
| Understand project structure | `get_project_map` | ~~Bash find~~ |

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

**Use `get_task_context` instead of Agent subagents** for code exploration. It returns focused context within a token budget.

**Monitor waste:** Run `get_optimization_report` to detect repeated reads, Bash grep usage, and missed trace-mcp opportunities.

**After editing a file:** Call `register_edit` { file_path: "path/to/file" } to reindex that single file and invalidate caches. Much lighter than full `reindex`. Do this after every Edit/Write to keep the index fresh. If `_duplication_warnings` appears in the response, review the referenced symbols — you may be duplicating existing logic.

**Before creating new functions/classes:** Call `check_duplication` { name: "functionName", kind: "function" } to verify no similar symbol exists. Prevents reinventing existing logic.

### The ONLY cases where native tools are allowed

- **Read**: ONLY for non-code files (.md, .json, .yaml, .env, config), OR immediately before using Edit on a file you need to modify
- **Grep**: ONLY for searching non-code file content (config, markdown, yaml)
- **Glob**: ONLY for finding non-code files by name pattern
- **Bash**: ONLY for running builds (`npm run build`), tests (`npm test`), git commands, or other CLI operations — NEVER for code exploration

### Plugin architecture

- Language plugins: `src/indexer/plugins/lang/` — one per language (ts, python, go, etc.)
- Integration plugins: `src/indexer/plugins/integration/` — framework-specific (api/, framework/, orm/, etc.)
- Each plugin implements `LanguagePlugin` or `FrameworkPlugin` interface from `src/plugin-api/types.ts`
- Plugin registry: `src/plugin-api/registry.ts`

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
2. `apply_rename` { symbol_id, new_name } — renames across ALL files (definition + imports)
3. NEVER rename manually via Edit with replace_all — it misses import sites and cross-file references

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
