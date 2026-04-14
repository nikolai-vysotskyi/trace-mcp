# Decision memory

trace-mcp includes a persistent decision knowledge graph that captures architectural decisions, tech choices, bug root causes, preferences, and conventions — linked to the code they're about.

## Why

Every conversation with an AI agent produces decisions that disappear when the session ends. Six months of daily AI use = thousands of decisions lost. General-purpose memory tools (MemPalace, OpenMemory, Mem0) store these as text. trace-mcp stores them **linked to code symbols and files** — so when you ask "what breaks if I change this?", you also see *why it was built that way*.

## Architecture

```
Session JSONL logs (Claude Code / Claw Code)
    │
    ▼
┌─────────────────────────────────────────────┐
│  Conversation Miner                         │
│  8 extraction patterns (0 LLM calls)        │
│  → architecture decisions, tech choices,    │
│    bug root causes, preferences,            │
│    tradeoffs, discoveries, conventions      │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Decision Store (decisions.db)              │
│  SQLite + FTS5 (porter stemming)            │
│  ┌───────────────┐  ┌───────────────────┐   │
│  │  decisions     │  │  session_chunks   │   │
│  │  (code-linked, │  │  (cross-session   │   │
│  │   temporal)    │  │   content search) │   │
│  └───────────────┘  └───────────────────┘   │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Enrichment Layer                           │
│  get_change_impact → linked_decisions       │
│  plan_turn         → related_decisions      │
│  get_session_resume→ active_decisions       │
└─────────────────────────────────────────────┘
```

## Decision types

| Type | What it captures | Example |
|---|---|---|
| `architecture_decision` | Structural choices | "Migrating from REST to GraphQL" |
| `tech_choice` | Technology selections | "PostgreSQL over MySQL for JSONB support" |
| `bug_root_cause` | Why bugs happened | "Missing null check in auth middleware" |
| `preference` | Team/personal preferences | "Always use named exports" |
| `tradeoff` | Acknowledged tradeoffs | "Accept higher latency for stronger consistency" |
| `discovery` | New learnings | "Discovered that Prisma doesn't support CTEs" |
| `convention` | Coding conventions | "From now on, use snake_case for DB columns" |

## MCP tools

### Mining & indexing

| Tool | Description |
|---|---|
| `mine_sessions` | Scan Claude Code / Claw Code JSONL logs, extract decisions using pattern matching. Skips already-processed sessions. No LLM calls needed. |
| `index_sessions` | Index conversation content (chunked) for cross-session search. Enables `search_sessions`. |

### Read & write

| Tool | Description |
|---|---|
| `add_decision` | Manually record a decision. Accepts `title`, `content`, `type`, `service_name`, `symbol_id`, `file_path`, `tags`. |
| `query_decisions` | Query with filters: `type`, `service_name`, `symbol_id`, `file_path`, `tag`, `search` (FTS5), `as_of` (temporal). |
| `invalidate_decision` | Mark a decision as superseded. It remains in the graph for historical queries. |
| `get_decision_timeline` | Chronological view of decisions for a project, symbol, or file. |
| `get_decision_stats` | Overview: total/active/invalidated, by type, by source, mined/indexed session counts. |

### Search & orientation

| Tool | Description |
|---|---|
| `search_sessions` | Full-text search across all past session conversations. "What did we discuss about auth last month?" |
| `get_wake_up` | Compact orientation (~300 tokens) at session start: project identity + active decisions + memory stats. Auto-mines on first call if store is empty. |

## Code linkage

Decisions can be linked to:

- **Symbols** — `symbol_id: "src/auth/provider.ts::AuthProvider#class"` — any symbol in the code graph
- **Files** — `file_path: "src/auth/provider.ts"` — a specific file
- **Services** — `service_name: "auth-api"` — a service/subproject within the project

When linked, decisions automatically surface in code intelligence tools:

```
get_change_impact(symbol_id="src/auth/provider.ts::AuthProvider#class")
→ {
    ...impact analysis...,
    linked_decisions: [
      { id: 42, title: "Use Clerk for auth", type: "tech_choice",
        symbol: "src/auth/provider.ts::AuthProvider#class", when: "2025-06-01" }
    ]
  }
```

## Temporal validity

Every decision has a `valid_from` timestamp (when it was made) and an optional `valid_until` (when it was superseded):

- **Active decisions** — `valid_until IS NULL` — currently in effect
- **Invalidated decisions** — `valid_until IS NOT NULL` — superseded but preserved for history

Query modes:

```
query_decisions()                              # active only (default)
query_decisions(as_of="2025-01-15T00:00:00Z")  # what was active on Jan 15
query_decisions(include_invalidated=true)       # full history
```

## Service scoping

In projects with multiple services (subprojects), decisions can be scoped to a specific service:

```
add_decision(
  title="Use JWT for service-to-service auth",
  service_name="auth-api",
  type="tech_choice"
)

query_decisions(service_name="auth-api")     # only auth-api decisions
query_decisions()                            # all project decisions
get_decision_stats()                         # shows available_services
```

## Extraction patterns

The conversation miner uses 8 regex-based patterns to extract decisions from assistant messages:

| Pattern | Matches | Type | Confidence |
|---|---|---|---|
| "decided to", "going with", "chose X" | Architecture choices | `architecture_decision` | 0.85 |
| "using X because", "picked X for" | Technology selections | `tech_choice` | 0.80 |
| "X instead of Y", "X over Y" | Comparisons | `tech_choice` | 0.75 |
| "the bug was", "root cause", "caused by" | Bug analysis | `bug_root_cause` | 0.85 |
| "prefer", "always use", "never use" | Preferences | `preference` | 0.70 |
| "tradeoff", "downside is" | Tradeoffs | `tradeoff` | 0.75 |
| "discovered that", "turns out" | Learnings | `discovery` | 0.80 |
| "from now on", "the rule is" | Conventions | `convention` | 0.80 |

Context boosters ("because", "reasoning", "pros and cons", "architecture") increase confidence by 5% each.

Auto-tagging detects topics: auth, database, api, testing, performance, security, devops, typescript, refactoring, migration.

## CLI

```bash
trace-mcp memory mine [--project=.] [--force] [--min-confidence=0.6]
trace-mcp memory index [--project=.] [--force]
trace-mcp memory search "query" [--project=.] [--limit=20]
trace-mcp memory decisions [--project=.] [--type=tech_choice] [--search="query"] [--json]
trace-mcp memory stats [--project=.] [--json]
trace-mcp memory timeline [--project=.] [--file=path] [--symbol=id]
```

## Storage

All decision memory is stored in `~/.trace-mcp/decisions.db` (SQLite, WAL mode). Tables:

- `decisions` — decision records with code linkage, temporal validity, service scoping
- `decisions_fts` — FTS5 virtual table for full-text search over decisions
- `session_chunks` — chunked conversation content from session logs
- `session_chunks_fts` — FTS5 virtual table for cross-session content search
- `mined_sessions` — tracking which sessions have been processed
