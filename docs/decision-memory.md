# Decision memory

trace-mcp includes a persistent decision knowledge graph that captures architectural decisions, tech choices, bug root causes, preferences, and conventions — linked to the code they're about.

## Why

Every conversation with an AI agent produces decisions that disappear when the session ends. Six months of daily AI use = thousands of decisions lost. General-purpose memory tools (MemPalace, OpenMemory, Mem0) store these as text. trace-mcp stores them **linked to code symbols and files** — so when you ask "what breaks if I change this?", you also see *why it was built that way*.

## What "why" actually looks like

The system tries to capture the kinds of reasoning that disappear from the diff but matter when someone returns to the code months later:

- **The alternative that was rejected and the reason** — "went with Postgres JSONB over a separate document store because transactional updates had to span relational and semi-structured data in the same write." Without the rejected branch, future readers re-litigate the same choice.
- **The constraint that forced the hand** — legal, performance budget, deadline, an upstream dependency we don't control. Captured as `tradeoff` decisions with the constraint named, so when the constraint disappears the decision is flagged as revisitable.
- **The failure mode behind a fix** — for `bug_root_cause`, what actually went wrong, not what got patched. "Request body parser ran before auth middleware, so unauthenticated payloads hit the DB," not "added auth check." The fix is in the diff; the failure mode isn't.
- **The thing that was tried first and didn't work** — recovered from session logs by `mine_sessions`, because agents rarely volunteer their own dead ends. This is the highest-value content and the easiest to lose without dedicated capture.
- **The local convention being established** — "all new endpoints go through `withAuth` even if the route looks public." Stops the next agent from reinventing or violating it.

Each of these is linked to the symbol or file it's about, so the next agent who touches that code sees the reasoning surface automatically through `get_change_impact` or `plan_turn` — they don't have to know the decision exists to find it.

## Architecture

```
              ┌──────────────────────────────────────────┐
              │              CAPTURE PATHS                │
              │                                            │
  add_decision│  remember_decision   │   mine_sessions     │
  (manual,    │  (live agent write,  │   (post-hoc, scans  │
   conf=1.0)  │   confidence-scored) │    JSONL logs,      │
              │                      │    pattern-matched) │
              └────────┬──────────────┬──────────┬─────────┘
                       │              │          │
                       ▼              ▼          ▼
              ┌──────────────────────────────────────────┐
              │  Memoir-style review queue                │
              │   confidence ≥ 0.75 → active (default)    │
              │   0.45 ≤ conf < 0.75 → pending review     │
              │   confidence < 0.45  → dropped            │
              │   (approve_decision / reject_decision)    │
              └────────────────┬──────────────────────────┘
                               │
                               ▼
              ┌──────────────────────────────────────────┐
              │  Decision Store (decisions.db)            │
              │  SQLite + FTS5 (porter stemming)          │
              │  ┌────────────┐  ┌────────────────────┐   │
              │  │ decisions  │  │  session_chunks    │   │
              │  │ code-linked│  │  cross-session     │   │
              │  │ temporal   │  │  content search    │   │
              │  │ branch-aware│  │                    │   │
              │  └────────────┘  └────────────────────┘   │
              └────────────────┬──────────────────────────┘
                               │
                               ▼
              ┌──────────────────────────────────────────┐
              │  Enrichment Layer                         │
              │  get_change_impact  → linked_decisions    │
              │  plan_turn          → related_decisions   │
              │  get_session_resume → active_decisions    │
              │  get_wake_up        → orientation context │
              └──────────────────────────────────────────┘
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

## Memoir-style review queue

Not everything an agent observes is worth keeping. The capture pipeline routes every write through a three-tier confidence gate so high-signal decisions enter the graph immediately while borderline ones queue for a human, and noise is dropped:

| Confidence | Routing | `review_status` |
|---|---|---|
| ≥ `review_threshold` (default **0.75**) | Active — visible in `query_decisions` by default | `null` (auto-approved) |
| `[reject_threshold, review_threshold)` | Queued for human approval | `'pending'` |
| < `reject_threshold` (default **0.45**) | Dropped, not persisted | n/a |

Both thresholds are configurable via the `decisions.review_threshold` and `decisions.reject_threshold` keys in config, or per-call on `mine_sessions` and `remember_decision`.

Manage the queue with `approve_decision` / `reject_decision`; inspect it with `query_decisions { include_pending: true }` or `query_decisions { review_status: "pending" }`. `add_decision` bypasses the gate (it's the explicit, human-curated path — confidence is pinned to 1.0).

## Confidence scoring

The score that drives the review queue combines a base prior with multiplicative boosts for signals that correlate with usefulness:

| Signal | Effect |
|---|---|
| Decision is linked to a `symbol_id` or `file_path` | + code-ref boost |
| `content` length ≥ 200 chars | + length boost |
| At least one tag attached | + tags boost |
| Type is high-signal (`architecture_decision`, `bug_root_cause`, `tradeoff`) | + type boost |
| Decision is scoped to a `service_name` | + service boost |

For mined decisions, the pattern's intrinsic confidence (see [Extraction patterns](#extraction-patterns)) is additionally multiplied by `1 + 0.05 × n` where `n` is the number of context boosters (`because`, `reason`, `pros and cons`, `alternative`, `architecture`, `design decision`) found in the surrounding turn.

The implementation lives in [`src/memory/decision-confidence.ts`](../src/memory/decision-confidence.ts).

## MCP tools

### Capture

| Tool | Description |
|---|---|
| `add_decision` | Manually record a decision. Bypasses the review queue (confidence = 1.0). Accepts `title`, `content`, `type`, `service_name`, `symbol_id`, `file_path`, `tags`, `git_branch`. |
| `remember_decision` | Live agent-write path. Confidence-scores the input and routes through the review queue. Per-session dedup + rate-limit so the agent can't spam the store. Use during a session to capture decisions in real time. |
| `mine_sessions` | Scan Claude Code / Claw Code JSONL logs and extract decisions via pattern matching (no LLM calls). Skips already-processed sessions. Results also flow through the review queue. |
| `index_sessions` | Index conversation content (chunked) for cross-session search. Enables `search_sessions`. |

### Review queue

| Tool | Description |
|---|---|
| `approve_decision` | Promote a `pending` decision to active. |
| `reject_decision` | Mark a `pending` decision as rejected (kept for audit, hidden by default). |

### Read & query

| Tool | Description |
|---|---|
| `query_decisions` | Query with filters: `type`, `service_name`, `symbol_id`, `file_path`, `tag`, `search` (FTS5), `as_of` (temporal), `git_branch`, `include_pending`, `review_status`. |
| `invalidate_decision` | Mark a decision as superseded. It remains in the graph for historical queries. |
| `get_decision_timeline` | Chronological view of decisions for a project, symbol, or file. |
| `get_decision_stats` | Overview: total/active/invalidated, by type, by source, mined/indexed session counts. |

### Search & orientation

| Tool | Description |
|---|---|
| `search_sessions` | Full-text search across all past session conversations. "What did we discuss about auth last month?" |
| `get_wake_up` | Compact orientation (~300 tokens) at session start: project identity + active decisions + memory stats. Auto-mines on first call if the store is empty. |
| `get_session_resume` | Cross-session context carryover: focus files, key searches, and dead-end queries from recent past sessions, alongside active decisions. |

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

## What we deliberately don't record

Decision memory is for content that disappears when the chat log is gone. It explicitly avoids storing things that can be recovered from the code or git history:

- **The diff itself** — `git log -p` is authoritative.
- **Who touched what** — `git blame` and `git shortlog` answer this.
- **Current code state** — read the file; the index has an outline.

The mining pipeline also filters non-user content before it reaches the store. Block-tagged regions stripped during ingestion:

| Tag | Reason |
|---|---|
| `<private>…</private>` | User-curated "do not remember this" |
| `<persisted-output>…</persisted-output>` | Tool-output capture, often hundreds of KB of file contents |
| `<system-reminder>…</system-reminder>` | Runtime nudges, not user-authored |
| `<ide_selection>…</ide_selection>` | IDE selection echo (may contain sensitive code) |
| `<task-notification>…</task-notification>` | Autonomous protocol payloads from background agents |
| `<local-command-stdout>…</local-command-stdout>` | Captured shell output (may contain secrets) |

`<command-message>` and `<command-name>` are kept — those wrap real user slash-commands and are part of the conversation. Implementation: `stripPrivacyTags` in [`src/memory/conversation-miner.ts`](../src/memory/conversation-miner.ts).

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

Key columns on `decisions`:

| Column | Purpose |
|---|---|
| `title`, `content`, `type` | The decision itself |
| `project_root`, `service_name` | Where it applies (project + optional subproject) |
| `symbol_id`, `file_path` | What code it's about (drives auto-surfacing in impact tools) |
| `tags` | JSON array for categorization and filtering |
| `valid_from`, `valid_until` | Temporal validity (`valid_until = NULL` means active) |
| `git_branch` | Branch scoping (`NULL` = branch-agnostic, visible everywhere) |
| `source` | `'manual'` (added via `add_decision`), `'mined'` (extracted from logs), or `'auto'` (live agent write) |
| `confidence` | `0..1` score driving the review queue (always `1.0` for `'manual'`) |
| `review_status` | `NULL` = auto-approved, `'pending'` = awaiting review, `'approved'`, `'rejected'` |
| `session_id` | Provenance — which session produced this decision |
