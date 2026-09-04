---
title: "Session Analytics & Coverage Intelligence — token savings, wasteful patterns"
description: "trace-mcp's built-in analytics engine parses AI agent session logs, tracks token savings, detects wasteful patterns, and assesses technology coverage."
updated: 2026-09-04
---

# Session Analytics & Coverage Intelligence

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "Session Analytics & Coverage Intelligence",
  "description": "The built-in engine that parses agent session logs and tracks token savings and waste.",
  "url": "https://trace-mcp.com/analytics.html",
  "datePublished": "2026-04-05",
  "dateModified": "2026-08-10",
  "author": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "publisher": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://trace-mcp.com/analytics.html"
  }
}
</script>
trace-mcp includes a built-in analytics engine that parses AI agent session logs, tracks token savings, detects wasteful patterns, and assesses technology coverage. It measures what your sessions actually cost; [cutting Claude Code token usage](reduce-claude-code-token-usage.md) is the list of levers to pull once the report names the waste, and the [PR review context benchmark](pr-context-benchmark.md) is the same measurement run on somebody else's repositories.

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

### Local-machine scoping

`get_session_analytics`, `get_optimization_report`, `get_real_savings`, and `analyze_perf` (for `window` other than `"session"`) only see session logs that physically exist on the machine running the MCP server — they read `~/.claude/projects/<encoded-path>/` and `<project>/.claw/sessions/` directly, they do not fetch data from any other machine. If you invoke them from a fresh checkout, a remote/cloud agent runtime, or a CI sandbox that never ran a local Claude Code / Claw Code session for this project, there is nothing to find and the tools report that. `get_session_analytics`/`get_optimization_report`/`get_real_savings` distinguish this from "checked, nothing to report" by adding a `_warnings` field when both the discoverable log files and the aggregated result are empty. `analyze_perf` with a persistent `window` additionally requires `telemetry.enabled: true` in [config](configuration.md) (off by default) and returns an explicit `error` when it's off — that flag is the same span emitter documented under [telemetry](telemetry.md).

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

### `get_startup_context_audit`

What the session startup block is made of and what it costs — the context every session pays for before your first message: the harness system prompt, tool schemas, MCP servers, the skill and agent listings, and SessionStart hook output.

```
get_startup_context_audit()
```

No parameters: the look-back window is fixed at 30 days. A parameter here would have to survive `compact_schemas`, which strips non-core params from the schema and so freezes them at their default without saying so.

Returns: the block's size distribution across fresh sessions, a decomposition by source (hooks are named individually), the block's share of the input-side bill, the mid-session cache rebuilds that make it get paid twice and what each cost, MCP servers present at startup alongside how often they were actually called, the instruction files on disk, and `recommendations` — suggestions with a per-start token price and a cost over the window.

Every recommendation rests on **evidence of non-use over a stated observation window**, never on size: an MCP server whose instructions loaded into N startups and whose tools were never called, a skill listed at every start and never invoked, text duplicated between the global and project instruction files. A tool that is missing from the startup block is a tool the agent will not call, so a suggestion made because something is *big* can cost its reader far more than it saves. SessionStart hooks are deliberately excluded from suggestions for the same reason — nothing in the log says whether the model used a hook's output, so there is no evidence of non-use to stand on. They stay in the decomposition, where the reader sees the cost and decides.

Everything is computed locally from `~/.claude/projects/*.jsonl`; nothing leaves the machine. The system prompt, tool schemas and CLAUDE.md are never written to the session log, so they are reported together as one residual row rather than split apart — the payload's `notes` says so too.

#### `textCompression` — where the block says the same thing twice

The audit answers "what does the block cost and what in it went unused". The `textCompression` field on the same payload answers the other half — of the text that is *needed* and stays, how much of it is a rule you already receive from somewhere else?

It rides along on this tool rather than being one of its own: it is the same question, and a second parameterless tool would add schema chars to every session that lists tools while diluting the `compact_schemas` reduction documented in [configuration](configuration.html).

It compares your own `CLAUDE.md`, `AGENTS.md` and `MEMORY.md` against the instruction text that MCP servers, the skill listing and SessionStart hooks *actually sent* at startup — read from the most recent session log of the project you are in — and proposes deletions with a unified diff and a per-session token delta.

**Nothing is written, and nothing is reworded.** The invariant, which the payload states and the tests enforce:

> a line is only proposed for removal when **every sentence on it** is still delivered by another source in the same startup block, and each removal cites that source per sentence. A heading goes only once its whole body has.

The word doing the work is *every*. An earlier version removed a line once 60% of its characters were matched and validated that with a "some sentence matched" check — which deletes the other 40%, text nothing else says. Two independent reviews reproduced it. Any threshold below "every unit" reintroduces it, so the rule is universal and the report proposes less rather than guessing.

That is also why this is not an LLM rewrite. On real instruction files the compressible mass is not verbose prose, it is restatement across sources: a `CLAUDE.md` section that repeats, in the author's own words, a rule an MCP server already sends. Dropping the second copy leaves the instruction present, verbatim, in the block — which is what makes "the meaning survived" checkable instead of a matter of taste.

Matching is on sentences and word overlap, with three guards:

- **Polarity.** "Do not run tests in parallel" and "Run tests in parallel" share every content word and are opposite instructions. A prohibition is never removed on the evidence of a permission.
- **Values.** Digits are kept and compared, so `Node 22` does not prove `Node 18`.
- **Short sentences.** Below five content words, partial overlap means nothing — `Never push to main` and `Never push to prod` are mostly alike — so a short rule must be near-identical to its evidence.

Evidence comes from **one** startup block, not a union across sessions: a server configured last month and removed since must not prove that today's file repeats it. It is scoped to the project, because another project's servers and hooks are not evidence about this one's session.

Text it does not own is never edited — a third party's skill descriptions, another server's instructions, a plugin hook's output. Those are the reference corpus: read to prove duplication, reported in `notCompressible` with their size and the reason.

Measured payload on real projects: 200–1400 tokens, with the diff capped at 200 lines; every removal is listed in `removals` regardless.

Applying a proposal — with a backup and one-action rollback — is separate work; this only shows you the diff.

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

All analytics commands are under `trace analytics` (supports `trace-mcp analytics` alias):

```bash
# Sync session logs into analytics DB
trace analytics sync [--full]

# Token usage report
trace analytics report [--period today|week|month|all] [--format text|json]

# Optimization recommendations
trace analytics optimize [--period today|week|month|all] [--format text|json]

# Real savings analysis
trace analytics savings [--period today|week|month|all] [--format text|json]

# Synthetic benchmark
trace analytics benchmark [--queries 10] [--seed 42] [--format text|json|markdown]

# Technology coverage
trace analytics coverage [--format text|json]

# Usage trends
trace analytics trends [--days 30] [--format text|json]
```

---

## Storage

Analytics data lives in `~/.trace/analytics.db` (or `~/.trace-mcp/analytics.db` fallback, separate from project indexes):

```sql
sessions       — one row per parsed session (tokens, model, timestamps)
tool_calls     — one row per tool call (name, server, output size, target file)
sync_state     — file paths + mtime for incremental sync
```

Session savings (in-memory tracker) persist to `~/.trace/savings.json` (or `~/.trace-mcp/savings.json`).

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
Index: 651 files, 3342 symbols

symbol_lookup: 41,211 → 2,098 tokens (94.9% reduction)
file_exploration: 16,366 → 762 tokens (95.3% reduction)
search: 22,860 → 8,000 tokens (65.0% reduction)
impact_analysis: 96,717 → 4,841 tokens (95.0% reduction)
call_graph: 178,661 → 10,723 tokens (94.0% reduction)
composite_task: 71,076 → 2,033 tokens (97.1% reduction)

Total: 426,891 → 28,457 (93.3% reduction)
```
