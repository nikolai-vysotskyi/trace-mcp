---
name: trace-mcp
description: Use trace-mcp tools for code navigation, impact analysis, and framework-aware queries instead of Read/Grep/Glob/Bash. Activate whenever the agent needs to explore, understand, or modify a codebase that has trace-mcp indexed.
---

# trace-mcp — Code Intelligence Routing

trace-mcp is a framework-aware code intelligence MCP server. It exposes 120+ tools that return semantic, structured results over a cross-language dependency graph. When trace-mcp is available, it is almost always cheaper and more accurate than native file tools.

## When to Use

Activate this skill whenever you need to:
- Find a function, class, method, route, component, or any symbol
- Understand a file, module, or feature before editing
- Determine what breaks if you change something
- Trace a request flow, call graph, or data flow
- Audit architecture, dead code, tests, or security

**Do not use** `Read`, `Grep`, `Glob`, or shell `ls`/`find`/`cat`/`head`/`tail` for exploring source code (`.ts`, `.js`, `.py`, `.php`, `.go`, `.rb`, `.java`, etc.). Use trace-mcp tools instead. Native tools stay allowed only for non-code files (`.md`, `.json`, `.yaml`, configs) or immediately before an `Edit` on a known file.

## Start-of-Session Checklist

1. `get_project_map` with `summary_only=true` — orient yourself to the project structure
2. `get_task_context` with `task: "<natural-language description>"` — gather all relevant code in a single call instead of chaining `search` → `get_symbol` → `Read`

## Decision Matrix

| Task | trace-mcp tool | Instead of |
|---|---|---|
| Find a symbol by name | `search` | Grep |
| Understand a file before editing | `get_outline` | Read (full file) |
| Read one symbol's source | `get_symbol` | Read (full file) |
| Multiple symbols + shared imports | `get_context_bundle` | chained `get_symbol` |
| What breaks if I change X | `get_change_impact` | guessing |
| Who calls this / what does it call | `get_call_graph` | Grep |
| All usages of a symbol | `find_usages` | Grep |
| Implementations of an interface | `get_type_hierarchy` | Grep / ls |
| Classes implementing X | `search` with `implements` filter | Grep |
| Tests for a symbol or file | `get_tests_for` | Glob + Grep |
| Project overview | `get_project_map` (summary_only) | Bash ls/find |
| Context for a task | `get_task_context` / `get_feature_context` | reading many files |
| HTTP request flow | `get_request_flow` | reading route + controller files |
| DB model relationships | `get_model_context` | reading model + migrations |
| Component tree | `get_component_tree` | reading component files |
| Circular dependencies | `get_circular_imports` | manual tracing |
| Dead code / dead exports | `get_dead_code` / `get_dead_exports` | Grep for unused |
| Project health / coverage gaps | `self_audit` | manual inspection |
| Complexity / hotspots | `get_complexity_report` / `get_risk_hotspots` | guessing |

## Token-Efficiency Rules

1. **Batch independent queries.** Use `batch` when you need 2+ independent tool calls:
   ```
   batch({ calls: [
     { tool: "get_outline", args: { path: "src/foo.ts" } },
     { tool: "get_outline", args: { path: "src/bar.ts" } },
     { tool: "search",      args: { query: "handleRequest", kind: "function" } }
   ]})
   ```
2. **Never read the same file twice.** Use `get_outline` once, then `get_symbol` for specific pieces.
3. **Prefer `get_context_bundle`** over chained `get_symbol` calls — it deduplicates shared imports.
4. **Read-before-Edit optimization.** When you must `Read` a file to edit it:
   - Call `get_outline` first to find the line range of the target symbol.
   - Read only that range with `offset` + `limit`. Never read a 500-line file to edit 5 lines.
5. **Do not delegate code exploration to subagents.** Agent subprocesses carry ~50k tokens of overhead before doing anything. Use trace-mcp tools in the main conversation instead.

## After Editing a File

- Call `register_edit` with the edited `file_path` to reindex just that file and invalidate caches. This is much lighter than a full `reindex` and keeps subsequent queries accurate.
- If the response includes `_duplication_warnings`, review the referenced symbols — you may be duplicating existing logic.
- Do **not** re-read the file to "verify" the edit. The `Edit` tool already confirmed success.

## Before Creating New Symbols

- Call `check_duplication` with `{ name, kind }` to verify no similar symbol exists. Prevents reinventing existing logic.

## Health Checks (Once Per Session)

- `audit_config` — stale references in CLAUDE.md / settings
- `self_audit` — dead exports, untested code, hotspots
- `get_tech_debt` — per-module tech-debt grades
- `get_optimization_report` — detects repeated reads, Bash grep usage, missed trace-mcp opportunities

## Related Skills

- `trace-mcp-refactoring` — safe refactoring workflow (risk assessment → rename → impact check)
- `trace-mcp-codemod` — bulk mechanical changes via `apply_codemod`
- `trace-mcp-pre-commit` — security, quality-gate, and antipattern checks before commit
