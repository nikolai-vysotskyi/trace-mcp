# Session Analytics & Coverage Intelligence

trace-mcp includes a built-in analytics engine that parses AI agent session logs, tracks token savings, detects wasteful patterns, and assesses technology coverage.

---

## How it works

```
Session logs (JSONL)                   Project manifests
  Claude Code: ~/.claude/projects/       package.json, composer.json,
  Claw Code: <project>/.claw/sessions/  requirements.txt, go.mod, ...
         │                                        │
         ▼                                        ▼
┌─────────────────────────┐         ┌──────────────────────────┐
│  Log Parser             │         │  Tech Detector           │
│  Extracts:              │         │  Parses manifests,       │
│  - tool calls + results │         │  classifies deps,        │
│  - token usage          │         │  matches against         │
│  - model info           │         │  known-packages catalog  │
│  - target files         │         │  (~200 packages)         │
└──────────┬──────────────┘         └──────────┬───────────────┘
           │                                   │
           ▼                                   ▼
┌─────────────────────────┐         ┌──────────────────────────┐
│  Analytics DB (SQLite)  │         │  Coverage Report         │
│  ~/.trace-mcp/          │         │  covered / gaps /        │
│    analytics.db         │         │  unknown deps            │
│  Tables:                │         └──────────────────────────┘
│  - sessions             │
│  - tool_calls           │
│  - sync_state           │
└──────────┬──────────────┘
           │
     ┌─────┴──────┬──────────────┬─────────────────┐
     ▼            ▼              ▼                  ▼
 Analytics    Optimization    Real Savings       Benchmark
 Report       Report          Analysis           Engine
 (per tool,   (8 rules,       (Read vs           (synthetic,
  per file,    savings est.)   get_symbol)        5 scenarios)
  per model)
```

### Supported clients

| Client | Session log location | Config files |
|--------|---------------------|--------------|
| **Claude Code** | `~/.claude/projects/<encoded-path>/<session-id>.jsonl` | `CLAUDE.md`, `.claude/settings.json` |
| **Claw Code** | `<project>/.claw/sessions/<session-id>.jsonl` | `.claw.json`, `.claw/settings.json` |

Both formats are auto-detected during sync. No configuration needed.

### JSONL format differences

| | Claude Code | Claw Code |
|--|-------------|-----------|
| Record types | `{type: "assistant"}`, `{type: "user"}` | `{type: "message"}` with `message.role` |
| Tool result delivery | Embedded in `user` message | Separate `tool` role message |
| Tool input format | JSON object | JSON string (parsed automatically) |
| Session metadata | `timestamp`, `sessionId` on each record | `{type: "session_meta"}` header record |

---

## MCP Tools

### `get_session_analytics`

Token usage, cost breakdown by tool/server, top files, models used. Auto-syncs logs before querying.

```
get_session_analytics({ period?: "today" | "week" | "month" | "all" })
```

Returns: session count, total tokens (input/output/cache), estimated cost, breakdown by tool server (builtin, trace-mcp, jcodemunch, phpstorm, ...), top tools by token output, top files by read tokens, models used.

### `get_optimization_report`

Detects wasteful tool call patterns and recommends trace-mcp alternatives.

```
get_optimization_report({ period?: "today" | "week" | "month" | "all" })
```

**8 built-in rules:**

| Rule | Severity | Detects | Recommends |
|------|----------|---------|------------|
| `repeated-file-read` | high | Same file Read 3+ times per session | `get_outline` + `get_symbol` |
| `bash-grep` | high | `Bash` with grep/rg/ack commands | `search` tool |
| `bash-cat` | medium | `Bash` with cat/head/tail commands | `get_symbol` or `Read` |
| `large-file-read` | medium | `Read` with output > 5000 chars | `get_outline` → `get_symbol` |
| `phpstorm-read-indexed` | medium | PhpStorm file read on indexed files | `get_symbol` |
| `phpstorm-search-indexed` | medium | PhpStorm text search on indexed project | `search` |
| `unused-trace-tools` | low | Sessions without trace-mcp but with Read/Grep | Enable trace-mcp tools |
| `agent-for-indexed` | medium | Agent subagent calls (~50K tokens each) | `get_feature_context` / `get_task_context` |

### `get_real_savings`

Analyzes actual session logs to compute how much could be saved by using trace-mcp instead of raw file reads. For each `Read`/`Bash cat`/PhpStorm read, finds the file in the index and estimates the compact alternative cost.

```
get_real_savings({ period?: "today" | "week" | "month" | "all" })
```

Returns: per-file breakdown (reads, current tokens, alternative tokens, savings %), tool replacement stats, and A/B comparison (sessions with vs without trace-mcp).

### `benchmark_project`

Synthetic benchmark comparing raw file reads vs trace-mcp compact responses.

```
benchmark_project({ queries?: number, seed?: number, format?: "json" | "markdown" })
```

**5 scenarios:** symbol lookup, file exploration, search, impact analysis, call graph. Uses actual index data with seeded randomness for reproducibility.

### `get_coverage_report`

Technology profile — which dependencies are covered by trace-mcp plugins and which are not.

```
get_coverage_report()
```

Parses: `package.json`, `composer.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Gemfile`. Classifies each dependency by category (framework/orm/ui/testing/infra/utility) and priority (high/medium/low/none). Reports covered deps, gaps, and unknowns.

### `get_usage_trends`

Daily token usage trends over time.

```
get_usage_trends({ days?: number })
```

Returns daily breakdown: sessions, tokens, estimated cost, tool calls. Good for spotting cost spikes and tracking optimization progress.

### `get_session_stats`

Real-time token savings of the current trace-mcp session (in-memory tracker, no log parsing).

```
get_session_stats()
```

### `audit_config`

Audit AI agent config files (CLAUDE.md, .cursorrules, .claw.json, etc.) for stale references, dead paths, token bloat, scope leaks, and redundancy.

```
audit_config()
```

---

## CLI Commands

All analytics commands are under `trace-mcp analytics`:

```bash
# Sync session logs into analytics DB
trace-mcp analytics sync [--full]

# Token usage report
trace-mcp analytics report [--period today|week|month|all] [--format text|json]

# Optimization recommendations
trace-mcp analytics optimize [--period today|week|month|all] [--format text|json]

# Real savings analysis
trace-mcp analytics savings [--period today|week|month|all] [--format text|json]

# Synthetic benchmark
trace-mcp analytics benchmark [--queries 10] [--seed 42] [--format text|json|markdown]

# Technology coverage
trace-mcp analytics coverage [--format text|json]

# Usage trends
trace-mcp analytics trends [--days 30] [--format text|json]
```

---

## Storage

Analytics data lives in `~/.trace-mcp/analytics.db` (separate from project indexes):

```sql
sessions       — one row per parsed session (tokens, model, timestamps)
tool_calls     — one row per tool call (name, server, output size, target file)
sync_state     — file paths + mtime for incremental sync
```

Session savings (in-memory tracker) persist to `~/.trace-mcp/savings.json`.

### Incremental sync

`analytics sync` only re-parses files whose mtime has changed since last sync. Use `--full` to force a complete rescan. Sync runs automatically before every analytics tool call.

---

## Example output

### `trace-mcp analytics report`

```
📊 Session Analytics (week)

Sessions: 24
Tool calls: 1203
Input tokens: 346,523
Output tokens: 1,200,000
Cache read: 8,500,000
Estimated cost: $61.86

Top tools:
  Read: 380 calls (~350,000 tokens)
  Bash: 290 calls (~95,000 tokens)
  Edit: 180 calls (~12,000 tokens)
  mcp__trace-mcp__search: 45 calls (~8,000 tokens)

Top files:
  src/server.ts: 35 reads (~45,000 tokens)
  src/db/store.ts: 22 reads (~32,000 tokens)
```

### `trace-mcp analytics optimize`

```
🔍 Optimization Report (week)

Current usage: 1,200,000 tokens (~$6.00)

[high] repeated-file-read: 85 occurrences
  Current: 350,000 tokens → Potential: 70,000 tokens
  Savings: 280,000 tokens (80%)
  Use get_outline + get_symbol instead of reading the full file repeatedly.

[high] bash-grep: 42 occurrences
  Current: 95,000 tokens → Potential: 19,000 tokens
  Savings: 76,000 tokens (80%)
  Use trace-mcp search tool instead of Bash grep/rg.

Total potential savings: 400,000 tokens (~$2.00, 33%)
```

### `trace-mcp analytics benchmark`

```
⚡ Token Efficiency Benchmark

Project: /Users/me/my-app
Index: 554 files, 2840 symbols

symbol_lookup: 53,988 → 2,023 tokens (96.3% reduction)
file_exploration: 18,969 → 954 tokens (95.0% reduction)
search: 22,860 → 8,000 tokens (65.0% reduction)
impact_analysis: 110,918 → 5,551 tokens (95.0% reduction)
call_graph: 157,334 → 9,444 tokens (94.0% reduction)

Total: 364,069 → 25,972 (92.9% reduction)
```
