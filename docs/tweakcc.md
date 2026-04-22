# System Prompt Routing via tweakcc

> **Requires:** [tweakcc](https://github.com/Piebald-AI/tweakcc) — a tool that patches Claude Code's system prompts directly.

---

## Why system prompt routing?

The common failure mode with trace-mcp routing isn't forgetting — it's **skipping**. Claude sees the CLAUDE.md policy and reaches for `Read` or `Grep` anyway because native tools feel faster under pressure or in long sessions — especially after context compression drops the CLAUDE.md block.

trace-mcp has three enforcement layers:

| Layer | Mechanism | Strength |
|-------|-----------|----------|
| **Base** — CLAUDE.md policy | Soft rules in project instructions | Weakest — ignored under cognitive load or after context compression |
| **Standard** — hooks | PreToolUse guards intercept tool calls at runtime | Medium — stderr warnings, allows Read for edits, catches violations |
| **Max** — system prompt rewrites (this doc) + agent behavior rules | Patch Claude's core tool descriptions via tweakcc; inject anti-sycophancy + goal-driven discipline rules via MCP instructions | Strongest — model internalizes the preference from the start, behaves like a senior engineer by default |

Each layer **adds on top** of the previous ones — nothing gets removed. tweakcc is an optional amplifier, not a replacement.

Picking **Max** during `trace-mcp init` does two things beyond Standard:
1. Installs tweakcc system-prompt rewrites (the 8 files below).
2. Writes `tools.agent_behavior: "strict"` to your global config — this is delivered via MCP instructions to every client (Claude Code, Cursor, Codex, Windsurf), not just CC. See [Agent behavior rules](configuration.md#agent-behavior-rules).

---

## Architecture

### Base (CLAUDE.md only)

```
CLAUDE.md (soft)
  routing policy tables
```

### Standard (current default after `trace-mcp init`)

```
CLAUDE.md (soft)  →  PreToolUse guard (hard)  →  PostToolUse reindex (auto)
  routing policy      blocks Read/Grep/Glob/     index-file after Edit/Write
                      Bash on code files +
                      Agent(Explore) subagents

                  →  PreCompact hook (auto)   →  Worktree hook (auto)
                      injects session snapshot    registers new worktrees
```

### Max (Standard + tweakcc + agent_behavior rules)

```
System prompts (deep)   →  MCP instructions (every session)  →  CLAUDE.md (soft)  →  PreToolUse guard (hard)  →  PostToolUse/PreCompact/Worktree (auto)
  routing built into        tool routing + agent_behavior=       full policy          catches remaining 5%        unchanged
  core tool descriptions    "strict" (anti-sycophancy,            (reinforcement)
                            goal-driven, 2-strike rule)
```

All existing hooks stay. tweakcc adds the deepest layer — the model never sees "use Grep for code search" in its tool descriptions; it sees "use trace-mcp search" from the start. `agent_behavior: "strict"` runs in parallel via MCP instructions, making the agent behave like a senior engineer by default: no flattery, disagreement on wrong premises, no fabrication, no drive-by refactors, verification before reporting "done".

---

## Prompt Rewrites (8 files)

All files are tweakcc prompt fragments. Only the content below the YAML frontmatter is replaced.

### 1. Read files (`system-prompt-tool-usage-read-files.md`)

```
Before reading any source code file, call trace-mcp get_outline to see its
structure first. To read specific symbols, use get_symbol (by symbol_id or fqn)
or get_context_bundle (symbol + its imports, or batch multiple symbol_ids) instead
of reading the whole file. Use Read for non-code files (.md, .json, .yaml, .toml,
.env, .txt, .html, images, PDFs) and when you need complete file content before
editing with Edit/Write. Never use cat, head, tail, or sed to read any file.
```

### 2. Search content (`system-prompt-tool-usage-search-content.md`)

```
To search code by symbol name (function, class, method, variable), use trace-mcp
search — narrow with kind=, language=, file_pattern=, implements=, extends=.
To search for strings, comments, TODOs, or patterns in source code, use trace-mcp
search_text (supports regex, context_lines for surrounding code). For semantic
usages (imports, calls, renders, dispatches), use find_usages. Use Grep only for
searching non-code file content (.md, .json, .yaml, .txt, .env, config files).
Never invoke grep or rg via Bash.
```

### 3. Search files (`system-prompt-tool-usage-search-files.md`)

```
To browse project structure, use trace-mcp get_project_map (summary_only for
overview, or full for detailed structure). To find symbols in specific paths, use
search with file_pattern= filter. To see what's in a specific file, use
get_outline. Use Glob only when finding non-code files by name pattern. Never use
find or ls via Bash for file discovery.
```

### 4. Reserve Bash (`system-prompt-tool-usage-reserve-bash.md`)

```
Reserve Bash exclusively for system commands and terminal operations: builds
(npm run build), tests (npm test, vitest, pytest), git commands, package managers,
docker, kubectl, and similar. Never use Bash for code exploration — do not run
grep, rg, find, cat, head, or tail on source code files through it. Use trace-mcp
MCP tools for all code reading and searching. If unsure whether a dedicated tool
exists, default to the dedicated tool.
```

### 5. Direct search (`system-prompt-tool-usage-direct-search.md`)

```
For directed codebase searches (finding a specific function, class, or method),
use trace-mcp search directly — it is faster and more precise than text search.
Narrow results with kind= (function, class, method, interface, type, variable),
language=, file_pattern=, implements=, extends=. For text pattern searches in
code, use trace-mcp search_text. Use native search tools only for non-code files.
```

### 6. Delegate exploration (`system-prompt-tool-usage-delegate-exploration.md`)

```
For broader codebase exploration, start with trace-mcp: get_project_map for
project overview, get_task_context for all-in-one task context (replaces manual
chaining of search → get_symbol → Read). When the project is unfamiliar, call
suggest_queries for orientation. Never spawn Agent(Explore) subagents for code
exploration — use get_task_context or get_feature_context instead (50x cheaper).
Agent subagents are only for: writing code in parallel, running tests, web research.
```

### 7. Subagent guidance (`system-prompt-tool-usage-subagent-guidance.md`)

```
Use subagents only for tasks that require actual execution: writing code in
parallel (background workers), running tests, web/external research, or Plan mode.
Never use Agent(Explore) or Agent(general-purpose) for code exploration, review,
or analysis — each subprocess costs ~50K tokens in overhead. Instead use trace-mcp:
get_task_context (all-in-one task context), get_feature_context (NL query),
batch (multiple lookups in one call), find_usages, get_call_graph.
```

### 8. Read first (`system-prompt-doing-tasks-read-first.md`)

```
Do not propose changes to code you haven't understood. Before modifying code, use
trace-mcp to build context: get_outline to see the file's structure, get_symbol
or get_context_bundle to read the relevant symbols, and get_change_impact to
understand the blast radius. For complete task context in one call, use
get_task_context with a natural language description of your task.

Use batch to combine multiple independent trace-mcp calls into a single request
(e.g., get_outline for 3 files + search for a symbol).

For non-code files (.md, .json, .yaml, .toml, .env, .txt, .html), use Read
directly.
```

---

## Verification

After installing the tweakcc rewrites, verify with these test prompts:

| Test prompt | Expected behavior |
|---|---|
| "Find the main function in this project" | Uses trace-mcp `search`, not `Grep` |
| "What does UserService do?" | Uses `get_outline` + `get_symbol`, not `Read` |
| "Show me the project structure" | Uses `get_project_map`, not `Glob` or `ls` |
| "Search for TODO comments" | Uses `search_text`, not `Grep` |
| "Read the README" | Uses `Read` (non-code file — correct) |
| "Search package.json for the version" | Uses `Grep` or `Read` (non-code file — correct) |
| Edit a `.ts` file | PostToolUse hook fires, re-indexes automatically |
| "What breaks if I change this function?" | Uses `get_change_impact`, not guessing |
| "Explore the plugin architecture" | Uses `get_task_context`, not Agent(Explore) |
| "Analyze the indexing pipeline" | Uses `get_task_context`/`get_feature_context`, not Agent |

---

## Combining with hooks (recommended)

System prompt routing and hooks are **complementary**, not exclusive. Run both for maximum enforcement:

- **tweakcc prompts** handle the 95% case — Claude reaches for trace-mcp by default
- **PreToolUse guard** catches the remaining 5% under cognitive load or in very long sessions
- **PostToolUse reindex** keeps the index fresh (zero model overhead)
- **PreCompact hook** injects session snapshot to prevent compaction amnesia
- **Worktree hook** auto-registers new worktrees

This layered approach gives the strongest enforcement with the least friction.

---

## Rollback

To revert: restore original tweakcc prompt files. No changes to CLAUDE.md, hooks, or settings are needed — the existing Standard setup continues to work independently.
