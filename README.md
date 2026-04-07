# trace-mcp

**Framework-aware code intelligence MCP server — 14 frameworks, 7 ORMs, 12 UI libraries, 20+ other integrations (53 total) across 68 languages. Up to 99% token reduction.**

> Your AI agent reads `UserController.php` and sees a class.
> trace-mcp reads it and sees a route → controller → FormRequest → Eloquent model → Inertia render → Vue page → child components — **in one graph.**

---

## The problem

AI coding agents are language-aware but **framework-blind**.

They don't know that `Inertia::render('Users/Show', $data)` connects a Laravel controller to `resources/js/Pages/Users/Show.vue`. They don't know that `$user->posts()` means the `posts` table defined three migrations ago. They can't trace a request from URL to rendered pixel.

So they brute-read files, guess at relationships, and miss cross-language edges entirely. The bigger the project, the worse it gets.

## The solution

trace-mcp builds a **cross-language dependency graph** from your source code and exposes it through the [Model Context Protocol](https://modelcontextprotocol.io). Any MCP-compatible agent (Claude Code, Cursor, Windsurf, etc.) gets framework-level understanding out of the box.

| Without trace-mcp | With trace-mcp |
|---|---|
| Agent reads 15 files to understand a feature | `get_task_context` — optimal code subgraph in one shot |
| Agent doesn't know which Vue page a controller renders | `routes_to → renders_component → uses_prop` edges |
| "What breaks if I change this model?" — agent guesses | `get_change_impact` traverses reverse dependencies across languages |
| Schema? Agent needs a running database | Migrations parsed — schema reconstructed from code |
| Prop mismatch between PHP and Vue? Discovered in production | Detected at index time — PHP data vs. `defineProps` |

---

## How trace-mcp compares

trace-mcp is not just a code intelligence server — it combines **code graph navigation**, **cross-session memory**, and **real-time code understanding** in a single tool. Other projects solve one of these; trace-mcp unifies all three.

_Last updated: April 2026. Based on public documentation and GitHub repos. If you maintain one of these projects and see an inaccuracy, [open an issue](https://github.com/nicovs-ai/trace-mcp/issues)._

### vs. token-efficient code exploration

Tools that help AI agents read code with fewer tokens — AST parsing, outlines, context packing.

| Capability | trace-mcp | Repomix | Context Mode | code-review-graph | jCodeMunch | codebase-memory-mcp |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 23K | 6.6K | 5.1K | 1.5K | 1.3K |
| Tree-sitter AST parsing | ✅ 68 languages | ✅ compress only (~20) | ❌ no code parsing | ✅ | ✅ ~40 languages | ✅ 66 languages |
| Token-efficient symbol lookup | ✅ outlines, symbols, bundles | ❌ packs entire files | ✅ sandboxed output | ✅ | ✅ core focus | ✅ |
| Cross-file dependency graph | ✅ directed edge graph | ❌ | ❌ | ✅ knowledge graph | ✅ import graph | ✅ knowledge graph |
| Framework-aware edges | ✅ 53 integrations (14 frameworks, 7 ORMs, 12 UI libs) | ❌ | ❌ | ❌ | partial (4 frameworks) | partial (REST routes) |
| Impact analysis | ✅ reverse dep traversal | ❌ | ❌ | ❌ | ✅ blast radius | ✅ detect_changes |
| Call graph | ✅ bidirectional | ❌ | ❌ | ❌ | ✅ class hierarchy | ✅ trace_call_path |
| Refactoring tools | ✅ rename, extract, dead code, codemod | ❌ | ❌ | ❌ | ❌ (dead code detect only) | ❌ |
| Security scanning | ✅ OWASP Top-10, taint | ✅ Secretlint | ❌ | ❌ | ❌ | ❌ |
| Multi-repo federation | ✅ cross-repo API linking | ✅ remote repos | ❌ | ❌ | ✅ GitHub repos | ❌ |
| Session memory | ✅ built-in | ❌ | ✅ SQLite journal | ❌ | ✅ index persistence | ✅ persistent graph |
| Written in | TypeScript | TypeScript | TypeScript | Python | Python | C |

### vs. AI session memory

Tools that persist context across AI agent sessions — activity logs, knowledge graphs, memory compression.

| Capability | trace-mcp | claude-mem | OpenMemory | engram | ConPort | memory-bank-mcp |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 45.7K | 3.9K | 2.3K | 761 | 892 |
| Cross-session context carryover | ✅ `get_session_resume` | ✅ core focus | ✅ | ✅ | ✅ | ✅ |
| Session journal (what was explored) | ✅ tool calls, files, dead ends | ✅ tool call capture | ❌ | partial | ❌ | ❌ |
| Context compaction snapshot | ✅ ~200 tokens | ✅ AI-compressed | ✅ decay engine | unverified | ❌ | ❌ |
| Code-graph-aware memory | ✅ tied to symbols & deps | ❌ text-only | ❌ text-only | ❌ text-only | ❌ text-only | ❌ text-only |
| Token usage analytics | ✅ per-tool cost breakdown | partial | ❌ | ❌ | ❌ | ❌ |
| Optimization recommendations | ✅ waste detection, A/B savings | ❌ | ❌ | ❌ | ❌ | ❌ |
| Code intelligence included | ✅ 100+ tools | ❌ | ❌ | ❌ | ❌ | ❌ |
| Knowledge graph | ✅ code dependency graph | ❌ | ✅ temporal | ❌ | ✅ project-level | ❌ |
| Works as standalone memory | ❌ code-focused | ❌ Claude-specific | ✅ agent-agnostic | ✅ agent-agnostic | ✅ project-scoped | ✅ general-purpose |
| Written in | TypeScript | TypeScript | TS + Python | Go | Python | TypeScript |

> **Key difference:** General-purpose memory tools remember *what you said*. trace-mcp remembers *what you explored in the codebase* — which symbols you read, what searches found nothing, which files you edited — and ties it to the dependency graph. When you resume, the agent gets structural context, not just conversation history.

### vs. documentation generation & RAG

Tools that generate docs from code or provide embedding-based code search for AI retrieval.

| Capability | trace-mcp | Repomix | DeepContext | smart-coding-mcp | mcp-local-rag¹ | knowledge-rag¹ |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 23K | 274 | 193 | 204 | 44 |
| Real-time code understanding | ✅ live graph, always current | ❌ snapshot at pack time | ❌ manual reindex | partial (opt-in watcher) | ❌ | partial (file watcher) |
| Auto-generated project docs | ✅ `generate_docs` from graph | ❌ raw file dump | ❌ | ❌ | ❌ | ❌ |
| Semantic code search | ✅ `search` + `query_by_intent` | ❌ no search | ✅ Jina embeddings | ✅ nomic embeddings | ✅ vector search | ✅ hybrid + reranking |
| Framework-aware context | ✅ routes, models, components | ❌ | ❌ | ❌ | ❌ | ❌ |
| Task-focused context | ✅ `get_task_context` — code subgraph | ❌ packs everything | ❌ | ❌ | ❌ | ❌ |
| No doc maintenance needed | ✅ derived from code | ✅ repacks on demand | ❌ manual reindex | partial (auto on startup) | ❌ manual ingest | partial (auto-reindex) |
| Works offline, no embeddings | ✅ graph + FTS5 | ✅ | ❌ requires cloud API | ❌ requires local embeddings | ❌ requires local embeddings | ❌ requires local embeddings |
| Incremental updates | ✅ file watcher, content hash | ❌ full repack | ✅ SHA-256 hashing | ✅ file hash + opt-in watcher | ❌ | ✅ mtime + dedup |
| Written in | TypeScript | TypeScript | TypeScript | JavaScript | TypeScript | Python |

_¹ mcp-local-rag and knowledge-rag are document RAG tools (PDF, DOCX, Markdown) — not code-specific. Included for comparison as they occupy adjacent mindshare._

> **Key difference:** RAG tools answer "find code similar to this query." trace-mcp answers "show me the execution path, the dependencies, and the tests for this feature." Graph traversal finds structurally relevant code that embedding similarity misses — and never returns stale results because the graph updates incrementally with every file save.

### vs. code graph MCP servers

| Capability | trace-mcp | code-review-graph | codebase-memory-mcp | SocratiCode | Narsil-MCP | Roam-Code |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Languages | 68 | ~10 | 66 | ~15 | 32 | ~10 |
| Framework integrations | 53 (14 fw + 7 ORM + 12 UI + 20 other) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cross-language edges | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| MCP tools | 100+ | ~15 | ~20 | ~25 | 90 | 139 |
| Session memory | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| CI/PR reports | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Multi-repo federation | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Security scanning | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Refactoring tools | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Architecture governance | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Token savings tracking | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Written in | TypeScript | Python | C | TypeScript | Rust | Python |

> **Why framework awareness matters:** A graph that knows `UserController` exists but doesn't know it renders `Users/Show.vue` via Inertia is missing the edges that matter most. Framework integrations turn a syntax graph into a **semantic** graph — the agent sees the same connections a developer sees.

---

## Up to 99% token reduction — real-world benchmark

AI agents burn tokens reading files they don't need. trace-mcp returns **precision context** — only the symbols, edges, and signatures relevant to the query.

**Benchmark: trace-mcp's own codebase** (651 files, 3,342 symbols):

```
Task                  Without trace-mcp    With trace-mcp    Reduction
─────────────────────────────────────────────────────────────────────
Symbol lookup              41,211 tokens     2,098 tokens      94.9%
File exploration           16,366 tokens       762 tokens      95.3%
Search                     22,860 tokens     8,000 tokens      65.0%
Impact analysis            96,717 tokens     4,841 tokens      95.0%
Call graph                178,661 tokens    10,723 tokens      94.0%
Composite task             71,076 tokens     2,033 tokens      97.1%
─────────────────────────────────────────────────────────────────────
Total                     426,891 tokens    28,457 tokens      93.3%
```

**93% fewer tokens** to accomplish the same code understanding tasks. That's ~398K tokens saved per exploration session — more headroom for actual coding, fewer context window evictions, lower API costs.

**Savings scale with project size.** On a 650-file project, trace-mcp saves ~398K tokens. On a 5,000-file enterprise codebase, savings grow **non-linearly** — without trace-mcp, the agent reads more wrong files before finding the right one. With trace-mcp, graph traversal stays O(relevant edges), not O(total files).

**Composite tasks deliver the biggest wins.** A single `get_task_context` call replaces a chain of ~10 sequential operations (search → get_symbol × 5 → Read × 3 → Grep × 2). That's **one round-trip instead of ten**, with 90%+ token reduction.

<details>
<summary>Methodology</summary>

Measured using `benchmark_project` — runs six real task categories (symbol lookup, file exploration, text search, impact analysis, call graph traversal, composite task context) against the indexed project. "Without trace-mcp" = estimated tokens from equivalent Read/Grep/Glob operations (full file reads, grep output). "With trace-mcp" = actual tokens returned by trace-mcp tools (targeted symbols, outlines, graph results). Token counts estimated using trace-mcp's built-in savings tracker.

Reproduce it yourself:
```
# Via MCP tool
benchmark_project  # runs against the current project

# Or via CLI
trace-mcp benchmark /path/to/project
```
</details>

---

## Key capabilities

- **Request flow tracing** — URL → Route → Middleware → Controller → Service, across 18 backend frameworks
- **Component trees** — render hierarchy with props / emits / slots (Vue, React, Blade)
- **Schema from migrations** — no DB connection needed
- **Event chains** — Event → Listener → Job fan-out (Laravel, Django, NestJS, Celery, Socket.io)
- **Change impact analysis** — reverse dependency traversal across languages
- **Graph-aware task context** — describe a dev task → get the optimal code subgraph (execution paths, tests, types), adapted to bugfix/feature/refactor intent
- **CI/PR change impact reports** — automated blast radius, risk scoring, test gap detection, architecture violation checks on every PR
- **Call graph & DI tree** — bidirectional call graphs, NestJS dependency injection
- **ORM model context** — relationships, schema, metadata for 7 ORMs
- **Dead code & test gap detection** — find untested exports, dead code, coverage gaps
- **Multi-repo federation** — link graphs across separate repos via API contracts; cross-repo impact analysis
- **AI-powered analysis** — symbol explanation, test suggestions, change review, semantic search (optional)

### Supported stack

**Languages (68):** PHP, TypeScript/JavaScript, Python, Go, Java, Kotlin, Ruby, Rust, C, C++, C#, Swift, Objective-C, Dart, Scala, Groovy, Elixir, Erlang, Haskell, Gleam, Bash, Lua, Perl, GDScript, R, Julia, Nix, SQL, HCL/Terraform, Protocol Buffers, Vue SFC, HTML, CSS/SCSS/SASS/LESS, XML/XUL/XSD, YAML, JSON, TOML, Assembly, Fortran, AutoHotkey, Verse, AL, Blade, EJS, Zig, OCaml, Clojure, F#, Elm, CUDA, COBOL, Verilog/SystemVerilog, GLSL, Meson, Vim Script, Common Lisp, Emacs Lisp, Dockerfile, Makefile, CMake, INI, Svelte, Markdown, MATLAB, Lean 4, FORM, Magma, Wolfram/Mathematica

**Frameworks:** Laravel (+ Livewire, Nova, Filament, Pennant), Django (+ DRF), FastAPI, Flask, Express, NestJS, Fastify, Hono, Next.js, Nuxt, Rails, Spring, tRPC

**ORMs:** Eloquent, Prisma, TypeORM, Drizzle, Sequelize, Mongoose, SQLAlchemy

**Frontend:** Vue, React, React Native, Blade, Inertia, shadcn/ui, Nuxt UI, MUI, Ant Design, Headless UI

**Other:** GraphQL, Socket.io, Celery, Zustand, Pydantic, Zod, n8n, React Query/SWR, Playwright/Cypress/Jest/Vitest/Mocha

> Full details: [Supported frameworks](docs/supported-frameworks.md) · [All tools](docs/tools-reference.md)

---

## Quick start

```bash
npm install -g trace-mcp
trace-mcp init        # one-time global setup (MCP clients, hooks, CLAUDE.md)
trace-mcp add         # register current project for indexing
```

**Step 1: `init`** — one-time global setup. Configures your MCP client (Claude Code, Cursor, Windsurf, or Claude Desktop), installs the guard hook, and adds a tool routing guide to `~/.claude/CLAUDE.md`.

**Step 2: `add`** — registers a project. Detects frameworks and languages, creates the index database, and adds the project to the global registry. Run this in each project you want trace-mcp to understand.

All state lives in `~/.trace-mcp/` — nothing is stored in your project directory (unless you add a `.traceignore` or `.trace-mcp/.config.json`).

Start your MCP client and use:
```
> get_project_map to see what frameworks are detected
> get_task_context("fix the login bug") to get full execution context for a task
> get_change_impact on app/Models/User.php to see what depends on it
```

### Adding more projects

```bash
cd /path/to/another/project
trace-mcp add
```

Or specify a path directly:
```bash
trace-mcp add /path/to/project
```

List all registered projects:
```bash
trace-mcp list
```

### Upgrading

After updating trace-mcp (`npm update -g trace-mcp`), re-run init in your project directory:

```bash
trace-mcp init
```

This runs database migrations, updates MCP client configuration, and reindexes the project with the latest plugins.

### Manual setup

If you prefer manual control, see [Configuration](docs/configuration.md) for all options. You can skip specific init steps:

```bash
trace-mcp init --skip-hooks --skip-claude-md --skip-mcp-client
```

### Indexing details

**Automatic:** `trace-mcp serve` starts background indexing immediately and launches a file watcher. The server is ready for tool calls right away — results improve as indexing progresses. If the project isn't registered yet, `serve` auto-registers it.

**Manual:** index a project without starting the server:
```bash
trace-mcp index /path/to/project          # incremental (skips unchanged files)
trace-mcp index /path/to/project --force   # full reindex
```

Files are content-hashed (MD5). On re-index, unchanged files are skipped. Both `serve` and `serve-http` start a file watcher that debounces rapid changes (300ms) and processes deletions immediately.

### Global directory structure

All trace-mcp state is centralized:

```
~/.trace-mcp/
  .config.json              # global config + per-project settings
  registry.json             # registered projects
  topology.db               # cross-service topology + federation graph
  index/
    my-app-a1b2c3d4e5f6.db  # per-project databases (named by project + hash)
```

### Excluding files from indexing (.traceignore)

Place a `.traceignore` file in the project root to skip files/directories from indexing entirely (gitignore syntax):

```gitignore
# Skip generated code
generated/
*.generated.ts

# Skip protobuf output
*_pb2.py
*.pb.go

# Negation — re-include a specific path
!generated/keep-this.ts
```

Common directories (`node_modules`, `.git`, `dist`, `build`, `vendor`, etc.) are skipped automatically.

You can also configure ignore rules in `~/.trace-mcp/.config.json` (global) or `project/.trace-mcp/.config.json` (per-project):

```jsonc
{
  "ignore": {
    "directories": ["proto", "generated"],
    "patterns": ["**/fixtures/**"]
  }
}
```

> Details: [Configuration — .traceignore](docs/configuration.md#traceignore)

---

## Getting the most out of trace-mcp

trace-mcp works on three levels to make AI agents use its tools instead of raw file reading:

### Level 1: Automatic (works out of the box)

The MCP server provides **instructions** and **tool descriptions** with routing hints that tell AI agents when to prefer trace-mcp over native Read/Grep/Glob. This works with any MCP-compatible client — no configuration needed.

### Level 2: CLAUDE.md (recommended)

Add this block to your project's `CLAUDE.md` (or `~/.claude/CLAUDE.md` for global use) to reinforce tool routing:

```markdown
## Code Navigation Policy

Use trace-mcp tools for code intelligence — they understand framework relationships, not just text.

| Task | trace-mcp tool | Instead of |
|------|---------------|------------|
| Find a function/class/method | `search` | Grep |
| Understand a file before editing | `get_outline` | Read (full file) |
| Read one symbol's source | `get_symbol` | Read (full file) |
| What breaks if I change X | `get_change_impact` | guessing |
| All usages of a symbol | `find_usages` | Grep |
| Starting work on a task | `get_task_context` | reading 15 files |
| Quick keyword context | `get_feature_context` | reading 15 files |
| Tests for a symbol | `get_tests_for` | Glob + Grep |
| HTTP request flow | `get_request_flow` | reading route files |
| DB model relationships | `get_model_context` | reading model + migrations |

Use Read/Grep/Glob for non-code files (.md, .json, .yaml, config).
Start sessions with `get_project_map` (summary_only=true).
```

### Level 3: Hook enforcement (Claude Code only)

For hard enforcement, install the **PreToolUse guard hook** that blocks Read/Grep/Glob on source code files and redirects the agent to trace-mcp tools with specific suggestions. The hook is installed globally by `trace-mcp init`, or manually:

```bash
trace-mcp setup-hooks --global    # install
trace-mcp setup-hooks --uninstall # remove
```

This copies the guard script to `~/.claude/hooks/` and adds the hook to your Claude Code settings.

**What the hook does:**
- **Blocks** Read/Grep/Glob/Bash on source code files (`.ts`, `.py`, `.php`, `.go`, `.java`, `.rb`, etc.)
- **Allows** non-code files (`.md`, `.json`, `.yaml`, `.env`, config)
- **Allows** Read before Edit — first Read is blocked with a suggestion, retry on the same file is allowed (the agent needs full content for editing)
- **Allows** safe Bash commands (git, npm, build, test, docker, etc.)
- **Redirects** with specific trace-mcp tool suggestions in the denial message

---

## How it works

```
Source files (PHP, TS, Vue, Python, Go, Java, Kotlin, Ruby, HTML, CSS, Blade)
    │
    ▼
┌──────────────────────────────────────────┐
│  Pass 1 — Per-file extraction            │
│  tree-sitter → symbols                   │
│  integration plugins → routes,           │
│    components, migrations, events,       │
│    models, schemas, variants, tests      │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│  Pass 2 — Cross-file resolution          │
│  PSR-4 · ES modules · Python modules    │
│  Vue components · Inertia bridge         │
│  Blade inheritance · ORM relations       │
│  → unified directed edge graph           │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│  SQLite (WAL mode) + FTS5               │
│  nodes · edges · symbols · routes       │
│  + optional: embeddings · summaries     │
└────────────────────┬─────────────────────┘
                     │
                     ▼
         MCP server (stdio or HTTP/SSE)
         44+ tools · 2 resources
```

**Incremental by default** — files are content-hashed; unchanged files are skipped on re-index.

**Plugin architecture** — language plugins (symbol extraction) and integration plugins (semantic edges) are loaded based on project detection, organized into categories: framework, ORM, view, API, validation, state, realtime, testing, tooling.

> Details: [Architecture & plugin system](docs/architecture.md)

---

## Documentation

| Document | Description |
|---|---|
| [Supported frameworks](docs/supported-frameworks.md) | Complete list of languages, frameworks, ORMs, UI libraries, and what each extracts |
| [Tools reference](docs/tools-reference.md) | All 38 MCP tools with descriptions and usage examples |
| [Configuration](docs/configuration.md) | Config options, AI setup, environment variables, security settings |
| [Architecture](docs/architecture.md) | How indexing works, plugin system, project structure, tech stack |
| [Development](docs/development.md) | Building, testing, contributing, adding new plugins |

---

## Multi-repo federation

Real projects are not a single repository. trace-mcp can **link dependency graphs across separate repos** — if microservice A calls an API endpoint in microservice B, trace-mcp knows that changing that endpoint in B breaks clients in A.

### How it works

Federation is **automatic by default**. Every time a project is indexed (`serve`, `serve-http`, or `index`), trace-mcp:

1. **Registers** the project in the global federation (`~/.trace-mcp/topology.db`)
2. **Discovers** services (Docker Compose, workspace detection)
3. **Parses** API contracts — OpenAPI/Swagger, GraphQL SDL, Protobuf/gRPC
4. **Scans** code for HTTP client calls (fetch, axios, Http::, requests, http.Get, gRPC stubs, GraphQL operations)
5. **Links** discovered calls to known endpoints from previously indexed repos
6. **Creates** cross-repo dependency edges

### Example

```bash
# Index two separate repos
cd ~/projects/user-service && trace-mcp add
cd ~/projects/order-service && trace-mcp add

# order-service has: axios.get('/api/users/{id}')
# user-service has: openapi.yaml with GET /api/users/{id}
# → trace-mcp automatically links them

# Check cross-repo impact
trace-mcp federation impact --endpoint=/api/users
# → "GET /api/users/{id} is called by 2 client(s) in 1 repo(s)"
#   [order-service] src/services/user-client.ts:42 (axios, confidence: 85%)
```

### Federation CLI

```bash
trace-mcp federation add --repo=../service-b [--contract=openapi.yaml]
trace-mcp federation remove <name-or-path>
trace-mcp federation list [--json]
trace-mcp federation sync           # re-scan all repos
trace-mcp federation impact --endpoint=/api/users [--method=GET] [--service=user-svc]
```

### MCP tools

| Tool | What it does |
|---|---|
| `get_federation_graph` | All federated repos, their connections, and stats |
| `get_federation_impact` | Cross-repo impact: what breaks if endpoint X changes (resolves to symbol level) |
| `get_federation_clients` | Find all client calls across repos that call a specific endpoint |
| `federation_add_repo` | Add a repo to the federation via MCP |
| `federation_sync` | Re-scan all federated repos |

> Federation builds on top of the topology system. See [Configuration](docs/configuration.md#topology--federation) for options.

---

## CI/PR change impact reports

trace-mcp can generate automated change impact reports for pull requests — blast radius, risk scoring, test coverage gaps, architecture violations, and dead code detection.

### CLI usage

```bash
# Generate a markdown report for changes between main and HEAD
trace-mcp ci-report --base main --head HEAD

# Output to file
trace-mcp ci-report --base main --head HEAD --format markdown --output report.md

# JSON output
trace-mcp ci-report --base main --head HEAD --format json

# Fail CI if risk level >= high
trace-mcp ci-report --base main --head HEAD --fail-on high

# Index before generating (for CI environments without pre-built index)
trace-mcp ci-report --base main --head HEAD --index
```

### GitHub Action

Add this workflow to get automatic impact reports on every PR:

```yaml
# .github/workflows/ci.yml (impact-report job runs after build-and-test)
- name: Index project
  run: node dist/cli.js index . --force

- name: Generate impact report
  run: |
    node dist/cli.js ci-report \
      --base ${{ github.event.pull_request.base.sha }} \
      --head ${{ github.event.pull_request.head.sha }} \
      --format markdown \
      --output report.md

- name: Post PR comment
  uses: marocchino/sticky-pull-request-comment@v2
  with:
    path: report.md
```

The full workflow is in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — it runs `build → test → impact-report` on every PR.

### Report sections

| Section | What it shows |
|---|---|
| **Summary** | Changed files, affected files count, risk level, gap counts |
| **Blast Radius** | Files transitively affected by changes (depth-2 reverse dependency traversal) |
| **Test Coverage Gaps** | Affected symbols with no matching test file |
| **Risk Analysis** | Per-file composite score: 30% complexity + 25% churn + 25% coupling + 20% blast radius |
| **Architecture Violations** | Layer rule violations involving changed files (auto-detects clean architecture / hexagonal presets) |
| **Dead Code** | New exports in changed files that nothing imports |

---

## Best for

- **Full-stack projects** in any supported framework combination
- Teams using AI agents (Claude, Cursor, Windsurf) for day-to-day development
- **Multi-language codebases** where PHP ↔ JavaScript ↔ Python boundaries create blind spots
- **Monorepos** with multiple services and shared libraries
- **Microservice architectures** where API changes ripple across repos
- Large codebases where agents waste tokens re-reading files

---

## License

[Elastic License 2.0 + Ethical Use Addendum](LICENSE) — free for personal and internal use. See LICENSE for full terms.

---

Built by [Nikolai Vysotskyi](https://github.com/nikolai-vysotskyi)
