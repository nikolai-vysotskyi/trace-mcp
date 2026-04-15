# Tools reference

trace-mcp exposes 44+ MCP tools and 2 resources.

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
| `get_dead_exports` | Find exported symbols never imported by any other file (dead code candidates) |
| `get_untested_exports` | Find exported public symbols with no matching test file (test coverage gaps) |
| `get_untested_symbols` | Find ALL symbols (not just exports) lacking test coverage. Classifies as "unreached" (no test imports the source) or "imported_not_called" (test imports file but never references symbol). More thorough than `get_untested_exports` |
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

Decisions auto-enrich code intelligence: `get_change_impact` shows `linked_decisions`, `plan_turn` shows `related_decisions`, `get_session_resume` shows `active_decisions`.

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
| "Find untested code" | `get_untested_symbols` — deep analysis with "unreached"/"imported_not_called" classification. Or lighter: `get_untested_exports` + `self_audit` |
| "Explain this complex service" | `explain_symbol` — AI-generated explanation with context |
| "What repos call this endpoint?" | `get_subproject_clients("/api/users")` — all client calls across repos |
| "Will this API change break anything?" | `get_subproject_impact` — cross-repo impact with symbol resolution |
| "Show me all service connections" | `get_subproject_graph` — repos, edges, stats |
| "Starting work on a task" | `get_task_context("fix the login bug")` — full execution context adapted to bugfix/feature/refactor |
| "PR impact report" | `trace-mcp ci-report --base main --head HEAD` — blast radius, risk score, test gaps |
| "How much am I spending on tokens?" | `get_session_analytics` — full breakdown by tool, file, model |
| "Where am I wasting tokens?" | `get_optimization_report` — detects repeated reads, bash-grep, large files |
| "How much would trace-mcp save?" | `get_real_savings` — compares actual reads vs compact alternatives |
| "Quick efficiency benchmark" | `benchmark_project` — 92%+ reduction on typical projects |
| "What tech isn't covered?" | `get_coverage_report` — gaps in plugin coverage for your deps |
