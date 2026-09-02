---
title: "MCP Tools Reference — code-intelligence tools by task and framework"
description: "The trace-mcp MCP tools you reach for most, grouped by task — navigation, refactoring, impact analysis, security, and framework-aware queries. Every tool is listed in the tool index."
updated: 2026-09-02
---

# Tools reference

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "Tools reference",
  "description": "The most-used of the {{ site.data.counts.tools }} MCP tools and 9 resources trace-mcp exposes, grouped by task and registered dynamically per detected framework.",
  "url": "https://trace-mcp.com/tools-reference.html",
  "datePublished": "2026-04-05",
  "dateModified": "2026-04-15",
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
    "@id": "https://trace-mcp.com/tools-reference.html"
  }
}
</script>
trace-mcp exposes {{ site.data.counts.tools }} MCP tools and 9 resources.

This page groups the ones you reach for by hand. For the complete list —
every registered tool with its one-line description, generated from the
registrations themselves — see the [tool index](tools-index.md).

Tools are registered dynamically based on detected frameworks — you only see tools relevant to your project.

---

## Project

| Tool | What it does |
|---|---|
| `get_project_map` | Project overview — detected frameworks, directory structure, entry points |
| `get_index_health` | Index stats — file count, symbol count, edge count, errors |
| `reindex` | Trigger full or incremental re-indexing |
| `get_env_vars` | List environment variable keys from `.env` files with inferred value types |
| `get_plugin_registry` | List all registered indexer plugins and the edge types they emit |

## Navigation

| Tool | What it does |
|---|---|
| `search` | Full-text search (FTS5 + BM25) with kind / language / file pattern filters |
| `get_symbol` | Look up a symbol by ID or FQN — returns source code |
| `get_outline` | All symbols in a file — signatures only, no bodies |
| `find_usages` | Find all places that reference a symbol or file (imports, calls, renders, dispatches) |

## Framework intelligence

| Tool | What it does | When available |
|---|---|---|
| `get_component_tree` | Build component render tree from a root file | Vue, Nuxt, Inertia |
| `get_change_impact` | Reverse dependency graph — what depends on this file or symbol. Each dependent symbol includes `hasTestReach` (whether any test that covers the file also references that specific symbol) | Always |
| `get_task_context` | **Graph-aware context engine** — describe a dev task, get the optimal code subgraph (execution paths, tests, types) adapted to task type (bugfix/feature/refactor) | Always |
| `get_feature_context` | NLP-driven context assembly — describe a feature, get relevant code within a token budget | Always |
| `get_request_flow` | Trace request flow for a URL+method: route → middleware → controller → service | Express, NestJS, Laravel, FastAPI, Flask, DRF, Spring, Rails, Fastify, Hono, tRPC |
| `get_middleware_chain` | Trace middleware chain for a route URL | Express, NestJS, FastAPI, Flask |
| `get_event_graph` | Event/signal/task dispatch graph | Laravel, NestJS, Django, Celery, Socket.io |
| `get_model_context` | Full model context: relationships, schema, metadata | Eloquent, Prisma, TypeORM, Drizzle, Mongoose, Sequelize, SQLAlchemy |
| `get_schema` | Database schema reconstructed from migrations or ORM definitions | Eloquent, Prisma, TypeORM, Drizzle, Mongoose, Sequelize, SQLAlchemy |
| `get_livewire_context` | Full Livewire component context: properties, actions, events, view, children | Laravel |
| `get_nova_resource` | Full Laravel Nova resource context: model, fields, actions, filters, lenses, metrics | Laravel |
| `get_state_stores` | List stores/slices with state, actions, and dispatch sites | Zustand, Redux |

## NestJS

| Tool | What it does |
|---|---|
| `get_module_graph` | Build module dependency graph (modules → imports → controllers → providers → exports) |
| `get_di_tree` | Trace dependency injection tree (what a service injects + who injects it) |

## React Native

| Tool | What it does |
|---|---|
| `get_navigation_graph` | Build navigation tree from screens, navigators, and deep links |
| `get_screen_context` | Full screen context: navigator, navigation edges, deep link, platform variants, native modules |

## Code analysis

| Tool | What it does |
|---|---|
| `get_import_graph` | File-level dependency graph: what a file imports and what imports it |
| `get_call_graph` | Bidirectional call graph centered on a symbol (who it calls + who calls it) |
| `get_tests_for` | Find test files and test functions that cover a given symbol or file |
| `get_implementations` | Find all classes that implement or extend a given interface/base class |
| `get_type_hierarchy` | Walk TypeScript class/interface hierarchy: ancestors and descendants |
| `get_api_surface` | List all exported symbols (public API) of a file or matching files |
| `get_untested_symbols` | Find ALL symbols (not just exports) lacking test coverage. Returns the "unreached" tier (no test imports the source) by default; `level: "imported_not_called"` / `"all"` opt into the weaker tier, where transitively-exercised symbols also land. Pass `scope: "exports_only"` for the fast exports-only scan |
| `self_audit` | One-shot project health: dead exports, untested code, dependency hotspots, heritage metrics |

## Quality & security

| Tool | What it does |
|---|---|
| `scan_security` | OWASP Top-10 vulnerability scan: SQL injection, XSS, command injection, path traversal, hardcoded secrets, insecure crypto, open redirects, SSRF |
| `taint_analysis` | Track untrusted data from sources (HTTP params, env vars, file reads) to dangerous sinks (SQL, exec, innerHTML). Framework-aware, cross-file |
| `scan_code_smells` | Find TODO/FIXME/HACK comments, empty functions, hardcoded values, magic numbers |
| `detect_antipatterns` | Performance antipattern detection |
| `check_quality_gates` | Quality gate validation against configurable thresholds |
| `export_security_context` | Export security context for MCP server analysis — enrichment JSON for [skill-scan](https://github.com/kkdub/skill-scan): tool registrations with annotations, transitive call graphs classified by security category, sensitive data flows, capability maps |

## Topology & subprojects

Enabled by default (`topology.enabled: true`). See [Configuration](configuration.md#topology--subprojects).

### Service topology

| Tool | What it does |
|---|---|
| `get_service_map` | Map of all services, their APIs, and inter-service dependencies (auto-detects from Docker Compose) |
| `get_cross_service_impact` | Impact of changing an endpoint or event — which services are affected |
| `get_api_contract` | API contract (OpenAPI/gRPC/GraphQL) for a service |
| `get_service_deps` | External service dependencies: outgoing and incoming |
| `get_contract_drift` | Mismatches between API spec and implementation |

### Subprojects

A subproject is any working repository that is part of your project's ecosystem: microservices, frontends, backends, shared libraries, CLI tools, etc. A project auto-detects its subprojects on indexing, or you can add external ones manually.

| Tool | What it does |
|---|---|
| `get_subproject_graph` | All subprojects, cross-subproject connections, and stats |
| `get_subproject_impact` | Cross-subproject impact: find all client code that would break if an endpoint changes. Resolves to symbol level when per-subproject indexes exist |
| `get_subproject_clients` | Find all client calls across subprojects that call a specific endpoint |
| `subproject_add_repo` | Add a subproject, bound to the current project (or specify `project` param for external subprojects) |
| `subproject_sync` | Re-scan all subprojects: contracts, client calls, and re-link |

### Cross-project

Every session is attached to one project, but these two tools reach across to any OTHER project already registered with trace-mcp (`~/.trace/registry.json`) — see [Configuration](configuration.md#cross-project-tools).

| Tool | What it does |
|---|---|
| `list_projects` | List registered project roots (name, type, last-indexed), plus known subprojects |
| `call_project_tool` | Run any other trace-mcp tool against a DIFFERENT registered project's already-indexed data; returns that tool's response verbatim |

## Decision memory

See [Decision memory](decision-memory.md) for full documentation.

| Tool | What it does |
|---|---|
| `mine_sessions` | Extract decisions from Claude Code / Claw Code session logs (pattern-based, 0 LLM calls) |
| `add_decision` | Manually record a decision with code linkage + service scoping |
| `query_decisions` | Query by type/service/symbol/file/tag + FTS5 search + temporal filtering |
| `invalidate_decision` | Mark a decision as superseded (preserved for historical queries) |
| `get_decision_timeline` | Chronological history of decisions for a project/symbol/file |
| `get_decision_stats` | Knowledge graph overview: counts by type, source, sessions mined/indexed |
| `index_sessions` | Index conversation content for cross-session search |
| `search_sessions` | FTS5 search across all past session conversations |
| `get_wake_up` | Compact orientation (~300 tokens): project + active decisions + stats. Auto-mines on first call |

Decisions auto-enrich code intelligence: `get_change_impact` shows `linked_decisions`, `plan_turn` shows `related_decisions`, `get_wake_up` shows `active_decisions`.

## Session Analytics

See [Analytics](analytics.md) for full documentation.

| Tool | What it does |
|---|---|
| `get_session_analytics` | Token usage, cost breakdown by tool/server, top files, models used |
| `get_optimization_report` | Detect token waste patterns (8 rules) with savings estimates |
| `get_real_savings` | Analyze actual sessions: how much trace-mcp saves vs raw file reads |
| `benchmark_project` | Synthetic benchmark: raw reads vs trace-mcp compact responses (5 scenarios) |
| `get_coverage_report` | Technology profile: deps from manifests, coverage by trace-mcp plugins, gaps |
| `get_usage_trends` | Daily token usage trends over time |
| `get_session_stats` | Real-time token savings for the current session |
| `audit_config` | Audit AI agent config files for stale refs, dead paths, bloat, scope leaks |

Supports **Claude Code** and **Claw Code** session logs (auto-detected).

## CI/PR reports (CLI)

Not an MCP tool — a CLI command for CI pipelines:

```bash
trace-mcp ci-report --base main --head HEAD --format markdown --output report.md
trace-mcp ci-report --base main --head HEAD --fail-on high
```

Generates a change impact report with blast radius, risk scores, test coverage gaps, architecture violations, and dead code. See [README](../README.md#cipr-change-impact-reports) for GitHub Action setup.

## Security context export (CLI)

Export security context for MCP server analysis — generates enrichment JSON for [skill-scan](https://github.com/kkdub/skill-scan):

```bash
# Export to file
trace-mcp export-security-context -o enrichment.json

# Limit scope and call graph depth
trace-mcp export-security-context --scope src/tools --depth 4

# Re-index before export
trace-mcp export-security-context --index -o enrichment.json

# Use with skill-scan
trace-mcp export-security-context -o ctx.json && skill-scan scan . --enrich ctx.json
```

Output contains: MCP tool registrations with annotations, transitive call graphs classified by security category (`file_read`, `file_write`, `network_outbound`, `env_read`, `shell_exec`, `crypto`, `serialization`), sensitive data flows, and per-file capability maps.

## AI-powered (optional)

Requires `ai.enabled: true` in config. See [Configuration](configuration.md#ai-configuration).

| Tool | What it does |
|---|---|
| `explain_symbol` | AI-generated explanation of a symbol's purpose and behavior |
| `suggest_tests` | AI-generated test case suggestions for a symbol |
| `review_change` | AI-powered review of a file change |
| `find_similar` | Find semantically similar symbols using vector search + AI reranking |
| `explain_architecture` | AI-powered architecture analysis of a module or feature area |

---

## Resources

| Resource | URI | Description |
|---|---|---|
| Project map | `project://map` | JSON project overview |
| Index health | `project://health` | Index status |

---

## Usage examples

| Scenario | Tool to use |
|---|---|
| "Add a new field to the User model" | `get_change_impact` — shows all dependents: model, migration, request validation, Vue props |
| "What components does this page use?" | `get_component_tree` — full render tree with props/slots |
| "Refactor the auth flow" | `get_task_context("refactor the auth flow")` — intent-aware context with full execution paths |
| "Quick keyword context" | `get_feature_context("authentication")` — assembles relevant code in one call |
| "Does the Vue page match the controller response?" | Prop mismatch detection flags drift automatically at index time |
| "What's the DB schema?" | `get_schema` — reconstructed from migrations, no DB needed |
| "Trace a request end-to-end" | `get_request_flow("/api/users", "GET")` — full chain |
| "What NestJS modules does this depend on?" | `get_module_graph` — full dependency tree |
| "Find untested code" | `get_untested_symbols` — deep analysis with "unreached"/"imported_not_called" classification. Or lighter: `get_untested_symbols { scope: "exports_only" }` + `self_audit` |
| "Explain this complex service" | `explain_symbol` — AI-generated explanation with context |
| "What repos call this endpoint?" | `get_subproject_clients("/api/users")` — all client calls across repos |
| "Will this API change break anything?" | `get_subproject_impact` — cross-repo impact with symbol resolution |
| "Show me all service connections" | `get_subproject_graph` — repos, edges, stats |
| "Starting work on a task" | `get_task_context("fix the login bug")` — full execution context adapted to bugfix/feature/refactor |
| "PR impact report" | `trace-mcp ci-report --base main --head HEAD` — blast radius, risk score, test gaps |
| "How much am I spending on tokens?" | `get_session_analytics` — full breakdown by tool, file, model |
| "Where am I wasting tokens?" | `get_optimization_report` — detects repeated reads, bash-grep, large files |
| "How much would trace-mcp save?" | `get_real_savings` — compares actual reads vs compact alternatives |
| "Quick efficiency benchmark" | `benchmark_project` — synthetic per-category estimate of the structured-task ceiling, not measured savings (use `get_real_savings` for those) |
| "What tech isn't covered?" | `get_coverage_report` — gaps in plugin coverage for your deps |

---

## Migrating from 1.x — retired tools

Seven tools were retired in 2.0. Each had been a deprecated alias for a
superset tool that already covered it; every call is expressible in the
replacement without loss of behaviour or response shape.

| Retired tool (1.x) | Replacement (2.0) |
|---|---|
| `pin_symbol { symbol_id }` | `pin { symbol_id }` |
| `pin_file { file_path }` | `pin { file_path }` |
| `search_with_mode { query, mode }` | `search { query, retriever: mode }` |
| `get_dead_exports { file_pattern }` | `get_dead_code { file_pattern, mode: "exports_only" }` |
| `get_untested_exports { file_pattern }` | `get_untested_symbols { file_pattern, scope: "exports_only" }` |
| `get_session_resume { max_sessions }` | `get_wake_up { scope: "resume", max_sessions }` |
| `get_project_memo { include_history, limit }` | `get_wake_up { scope: "project", include_history, history_limit }` |

`pin` accepts `symbol_id` and `file_path` together, pinning both at the same
weight in one call.

One deliberate difference: both retired export-scanning aliases were
TOON-enabled, but only `get_untested_symbols` inherited `output_format`.
Re-measuring the payloads through their replacements put
`get_untested_symbols { scope: "exports_only" }` at **+21.1%** (table mode —
it keeps TOON), while `get_dead_code { mode: "exports_only" }` came in at
**-17.3%** (list mode, because its rows are not uniform). That is well under
the +15% cutoff the TOON allowlist is built on, so wiring it would have cost
tokens rather than saved them. See [TOON savings](toon-savings.md).

Two rarely-used `search` tuning parameters were also removed. Per-channel
fusion weights now come from `~/.trace/tuning.jsonc` (written by
`tune_weights`) instead of `fusion_weights` on every call, and `fusion_debug`
is gone. The nested `fusion_weights` object was the single most expensive
structure in the whole tool schema, paid by every client on every session.

Together these changes cut the always-on tool surface from 148 to 141
registrations and the serialized schema every MCP client without lazy tool
loading pays at session start from 90,579 to 86,217 characters.

Calling a retired name no longer fails with a bare "not found": the server
answers with the replacement call, so a stale `CLAUDE.md` is a one-line fix
rather than a dead end.

### Policy: consolidations retire the old name, they don't alias it forever

This is settled, so future consolidations don't re-litigate it (TRA-205,
folding in the cancelled TRA-212).

**A tool that is consolidated into a superset tool is removed at the next
major, not kept as a permanent alias.** The alias layer TRA-193 shipped
additively was measured (TRA-239: 171 → 172 tools, schema tax up) and retired
outright in 2.0 (TRA-240). Trimming an alias's prose is not enough — the
registration itself is what every client without deferred tool loading pays
for on connect, and token cost is the product.

**The old name gets a call-time hint instead of a registration.** MCP has no
per-tool deprecation signal — a tool is either in `tools/list` or it is a hard
error — so a removed name would otherwise surface as a bare "not found".
`src/server/retired-tools.ts` rewrites that one message to name the
replacement call. It costs nothing on `tools/list`, which is the whole point:
the migration hint lives on the error path, not in the schema payload.

**Renaming purely for clarity is not worth a registration.** Two similarly
named tools that do different things (`tune_decision_weights` vs
`tune_weights`) are disambiguated in their descriptions, not split into new
names with the old ones aliased — a sentence of prose is free, a second
registration is not.

Reopening this needs evidence a retired name is still costing users more than
its removal saved. `src/tools/register/__tests__/tool-schema-budget.test.ts`
is the gate on any change that grows the always-on surface.

### Migrating to 3.0 — Node 22

3.0 raised the Node floor: Node 20 and 21 are no longer supported, and
`node >= 22` is required. No tool signature or response shape changed. If
`npx -y trace-mcp@latest serve` started failing at startup rather than at a
tool call, check `node --version` first.

Both majors landed within a day of each other (2.0.0 on 2026-08-28, 3.0.0 on
2026-08-29), so an install floating on `latest` may have taken both at once.
Pin a major in your MCP client config (`trace-mcp@3`) if you would rather
adopt them deliberately.
