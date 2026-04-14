<p align="center">
  <img src="packages/app/build/icon-256.png" alt="trace-mcp logo" width="128" />
</p>

<h1 align="center">trace-mcp</h1>

<p align="center">
  <a href="https://glama.ai/mcp/servers/nikolai-vysotskyi/trace-mcp"><img src="https://glama.ai/mcp/servers/nikolai-vysotskyi/trace-mcp/badges/score.svg" alt="Glama score" /></a>
  <a href="https://www.npmjs.com/package/trace-mcp"><img src="https://img.shields.io/npm/v/trace-mcp" alt="npm version" /></a>
  <img src="https://img.shields.io/node/v/trace-mcp" alt="Node.js version" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
</p>

<p align="center">
  <strong>Framework-aware code intelligence MCP server — 14 frameworks, 7 ORMs, 12 UI libraries, 20+ other integrations (53 total) across 68 languages. Up to 99% token reduction.</strong>
</p>

> Your AI agent reads `UserController.php` and sees a class.
> trace-mcp reads it and sees a route → controller → FormRequest → Eloquent model → Inertia render → Vue page → child components — **in one graph.**

---

## What trace-mcp does for you

| You ask | trace-mcp answers | How |
|---|---|---|
| "What breaks if I change this model?" | Blast radius across languages + risk score + linked architectural decisions | `get_change_impact` — reverse dependency graph + decision memory |
| "Why was auth implemented this way?" | The actual decision record with reasoning and tradeoffs | `query_decisions` — searches the decision knowledge graph linked to code |
| "I'm starting a new task" | Optimal code subgraph + relevant past decisions + dead-end warnings | `plan_turn` — opening-move router with decision enrichment |
| "What did we discuss about GraphQL last month?" | Verbatim conversation fragments with file references | `search_sessions` — FTS5 search across all past session content |
| "Show me the request flow from URL to rendered page" | Route → Middleware → Controller → Service → View with prop mapping | `get_request_flow` — framework-aware edge traversal |
| "Find all untested code in this module" | Symbols classified as "unreached" or "imported but never called in tests" | `get_untested_symbols` — test-to-source mapping |
| "What's the impact of this API change on other services?" | Cross-subproject client calls with confidence scores | `get_subproject_impact` — topology graph traversal |
| "Orient me — I just opened this project" | Project identity + active decisions + memory stats in ~300 tokens | `get_wake_up` — layered context assembly |

**Three things no other tool does:**

1. **Framework-aware edges** — trace-mcp understands that `Inertia::render('Users/Show')` connects PHP to Vue, that `@Injectable()` creates a DI dependency, that `$user->posts()` means a `posts` table from migrations. 53 integrations across 14 frameworks, 7 ORMs, 12 UI libraries.

2. **Code-linked decision memory** — when you record "chose PostgreSQL for JSONB support", it's linked to `src/db/connection.ts::Pool#class`. When someone runs `get_change_impact` on that symbol, they see the decision. MemPalace stores decisions as text; trace-mcp ties them to the dependency graph.

3. **Cross-session intelligence** — past sessions are mined for decisions and indexed for search. When you start a new session, `get_wake_up` gives you orientation in ~300 tokens; `plan_turn` shows relevant past decisions for your task; `get_session_resume` carries over structural context from previous sessions.

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

_Last updated: April 2026. Based on public documentation and GitHub repos. If you maintain one of these projects and see an inaccuracy, [open an issue](https://github.com/nikolai-vysotskyi/trace-mcp/issues)._

### vs. token-efficient code exploration

Tools that help AI agents read code with fewer tokens — AST parsing, outlines, context packing.

| Capability | trace-mcp | Repomix | Context Mode | code-review-graph | jCodeMunch | codebase-memory-mcp | cymbal |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 23K | 6.6K | 5.1K | 1.5K | 1.3K | 137 |
| Tree-sitter AST parsing | ✅ 68 languages | ✅ compress only (~20) | ❌ no code parsing | ✅ | ✅ ~40 languages | ✅ 66 languages | ✅ 22 languages |
| Token-efficient symbol lookup | ✅ outlines, symbols, bundles | ❌ packs entire files | ✅ sandboxed output | ✅ | ✅ core focus | ✅ | ✅ outline/show/context |
| Cross-file dependency graph | ✅ directed edge graph | ❌ | ❌ | ✅ knowledge graph | ✅ import graph | ✅ knowledge graph | ✅ refs/importers |
| Framework-aware edges | ✅ 53 integrations (14 frameworks, 7 ORMs, 12 UI libs) | ❌ | ❌ | ❌ | ✅ 21 frameworks (route/middleware) | partial (REST routes) | ❌ |
| Impact analysis | ✅ reverse dep traversal + decorator filter | ❌ | ❌ | ❌ | ✅ blast radius + decorator filter | ✅ detect_changes | ✅ impact command |
| Call graph | ✅ bidirectional, graph-based | ❌ | ❌ | ❌ | ✅ AST-based, bidirectional | ✅ trace_call_path | ✅ refs/importers |
| Refactoring tools | ✅ rename, extract, dead code, codemod | ❌ | ❌ | ❌ | ❌ (dead code detect only) | ❌ | ❌ |
| Security scanning | ✅ OWASP Top-10, taint | ✅ Secretlint | ❌ | ❌ | ❌ | ❌ | ❌ |
| Multi-repo subprojects | ✅ cross-repo API linking | ✅ remote repos | ❌ | ❌ | ✅ GitHub repos | ❌ | ❌ |
| Session memory | ✅ built-in | ❌ | ✅ SQLite journal | ❌ | ✅ index persistence | ✅ persistent graph | ❌ |
| Written in | TypeScript | TypeScript | TypeScript | Python | Python | C | Go |

### vs. AI session memory

Tools that persist context across AI agent sessions — activity logs, knowledge graphs, memory compression.

| Capability | trace-mcp | MemPalace | claude-mem | OpenMemory | engram | ConPort |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 43K | 45.7K | 3.9K | 2.3K | 761 |
| Cross-session context carryover | ✅ `get_session_resume` + decisions | ✅ wings/rooms | ✅ core focus | ✅ | ✅ | ✅ |
| Cross-session content search | ✅ `search_sessions` FTS5 | ✅ ChromaDB semantic | ❌ | ✅ | ❌ | ❌ |
| Decision knowledge graph | ✅ temporal, code-linked | ✅ temporal (text-only) | ❌ | ✅ temporal | ❌ | ✅ project-level |
| Code-graph-aware memory | ✅ decisions → symbols & files | ❌ text-only | ❌ text-only | ❌ text-only | ❌ text-only | ❌ text-only |
| Auto-extraction from sessions | ✅ pattern-based (0 LLM calls) | ✅ via hooks | ✅ AI-compressed | ❌ | ❌ | ❌ |
| Wake-up context | ✅ ~300 tok (code-linked decisions) | ✅ ~170 tok (AAAK) | ❌ | ❌ | ❌ | ❌ |
| Decision enrichment in tools | ✅ impact/plan_turn/resume | ❌ standalone | ❌ | ❌ | ❌ | ❌ |
| Service/subproject scoping | ✅ decisions per service | ✅ wings per project | ❌ | ❌ | ❌ | ❌ |
| Token usage analytics | ✅ per-tool cost breakdown | ❌ | partial | ❌ | ❌ | ❌ |
| Code intelligence included | ✅ 130+ tools | ❌ | ❌ | ❌ | ❌ | ❌ |
| Works as standalone memory | ❌ code-focused | ✅ general-purpose | ❌ Claude-specific | ✅ agent-agnostic | ✅ agent-agnostic | ✅ project-scoped |
| Written in | TypeScript | Python | TypeScript | TS + Python | Go | Python |

> **Key difference:** MemPalace stores "decided to use PostgreSQL" as text in ChromaDB. trace-mcp stores the same decision **linked to `src/db/connection.ts::Pool#class`** — and when you run `get_change_impact` on that symbol, the decision shows up in `linked_decisions`. General-purpose memory tools remember *what you said*. trace-mcp remembers *what you said* AND *which code it's about*.

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
| Works offline, no API keys | ✅ graph + FTS5 + bundled ONNX embeddings | ✅ | ❌ requires cloud API | ❌ requires local embeddings | ❌ requires local embeddings | ❌ requires local embeddings |
| Incremental updates | ✅ file watcher, content hash | ❌ full repack | ✅ SHA-256 hashing | ✅ file hash + opt-in watcher | ❌ | ✅ mtime + dedup |
| Written in | TypeScript | TypeScript | TypeScript | JavaScript | TypeScript | Python |

_¹ mcp-local-rag and knowledge-rag are document RAG tools (PDF, DOCX, Markdown) — not code-specific. Included for comparison as they occupy adjacent mindshare._

> **Key difference:** RAG tools answer "find code similar to this query." trace-mcp answers "show me the execution path, the dependencies, and the tests for this feature." Graph traversal finds structurally relevant code that embedding similarity misses — and never returns stale results because the graph updates incrementally with every file save.

### vs. code graph MCP servers

| Capability | trace-mcp | Serena | code-review-graph | codebase-memory-mcp | SocratiCode | Narsil-MCP | Roam-Code |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 22.6K | 5.1K | 1.3K | — | — | — |
| Languages | 68 | ~20 (via LSP) | ~10 | 66 | ~15 | 32 | ~10 |
| Framework integrations | 53 (14 fw + 7 ORM + 12 UI + 20 other) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cross-language edges | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| MCP tools | 120+ | ~35 | ~15 | ~20 | ~25 | 90 | 139 |
| Session memory | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| CI/PR reports | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Multi-repo subprojects | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Security scanning | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Refactoring tools | ✅ | ✅ rename, symbol editing | ❌ | ❌ | ❌ | ❌ | ❌ |
| Architecture governance | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Token savings tracking | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Written in | TypeScript | Python | Python | C | TypeScript | Rust | Python |

> **Why framework awareness matters:** A graph that knows `UserController` exists but doesn't know it renders `Users/Show.vue` via Inertia is missing the edges that matter most. Framework integrations turn a syntax graph into a **semantic** graph — the agent sees the same connections a developer sees.

---

## Up to 99% token reduction — real-world benchmark

AI agents burn tokens reading files they don't need. trace-mcp returns **precision context** — only the symbols, edges, and signatures relevant to the query.

**Benchmark: trace-mcp's own codebase** (694 files, 3,831 symbols):

```
Task                  Without trace-mcp    With trace-mcp    Reduction
─────────────────────────────────────────────────────────────────────
Symbol lookup              42,518 tokens     7,353 tokens      82.7%
File exploration           27,486 tokens       548 tokens      98.0%
Search                     22,860 tokens     8,000 tokens      65.0%
Find usages                11,430 tokens     1,720 tokens      85.0%
Context bundle             12,847 tokens     4,164 tokens      67.6%
Batch overhead             16,831 tokens     9,031 tokens      46.3%
Impact analysis            49,141 tokens     2,461 tokens      95.0%
Call graph                178,345 tokens    10,704 tokens      94.0%
Type hierarchy             94,762 tokens     1,030 tokens      98.9%
Tests for                  22,590 tokens     1,150 tokens      94.9%
Composite task             93,634 tokens     3,836 tokens      95.9%
─────────────────────────────────────────────────────────────────────
Total                     572,444 tokens    49,997 tokens      91.3%
```

**91% fewer tokens** to accomplish the same code understanding tasks. That's ~522K tokens saved per exploration session — more headroom for actual coding, fewer context window evictions, lower API costs.

**Savings scale with project size.** On a 650-file project, trace-mcp saves ~522K tokens. On a 5,000-file enterprise codebase, savings grow **non-linearly** — without trace-mcp, the agent reads more wrong files before finding the right one. With trace-mcp, graph traversal stays O(relevant edges), not O(total files).

**Composite tasks deliver the biggest wins.** A single `get_task_context` call replaces a chain of ~10 sequential operations (search → get_symbol × 5 → Read × 3 → Grep × 2). That's **one round-trip instead of ten**, with 90%+ token reduction.

**Per-task breakdown** — what it actually costs to answer common questions:

| Question | Naive approach | trace-mcp tool | Tokens (naive) | Tokens (trace-mcp) | Reduction |
|---|---|---|---|---|---|
| "Where is `registerTool` defined?" | Grep all .ts files | `search` | ~12,400 | ~800 | **93%** |
| "What calls `getDeadCodeV2`?" | Grep + Read 8 files | `get_call_graph` | ~18,200 | ~1,100 | **94%** |
| "What breaks if I rename `Store`?" | Manual trace across 40+ files | `get_change_impact` | ~62,000 | ~2,400 | **96%** |
| "Find all tests for `extractOpenAPI`" | Glob + Read 12 test files | `get_tests_for` | ~14,800 | ~650 | **96%** |
| "Understand the indexing pipeline" | Read 15 source files | `get_task_context` | ~89,000 | ~7,200 | **92%** |
| "Unused exports in src/tools/" | Read + Grep all files | `get_dead_code` | ~38,000 | ~1,800 | **95%** |
| "All OpenAPI endpoints in the project" | Find + Read all .yaml/.json | `search` (kind=function, yamlKind=endpoint) | ~22,000 | ~900 | **96%** |

<details>
<summary>Methodology</summary>

Measured using `benchmark_project` — runs eleven real task categories (symbol lookup, file exploration, text search, find usages, context bundle, batch overhead, impact analysis, call graph traversal, type hierarchy, tests-for, composite task context) against the indexed project. "Without trace-mcp" = estimated tokens from equivalent Read/Grep/Glob operations (full file reads, grep output). "With trace-mcp" = actual tokens returned by trace-mcp tools (targeted symbols, outlines, graph results). Token counts estimated using trace-mcp's built-in savings tracker.

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
- **Change impact analysis** — reverse dependency traversal across languages, enriched with linked architectural decisions
- **Decision memory** — mine sessions for decisions, link them to code symbols/files, query with temporal validity. Decisions auto-surface in `get_change_impact`, `plan_turn`, and `get_session_resume`
- **Cross-session search** — "what did we discuss about auth?" — FTS5 search across all past session content
- **Graph-aware task context** — describe a dev task → get the optimal code subgraph (execution paths, tests, types) + relevant past decisions, adapted to bugfix/feature/refactor intent
- **CI/PR change impact reports** — automated blast radius, risk scoring, test gap detection, architecture violation checks on every PR
- **Call graph & DI tree** — bidirectional call graphs with 4-tier resolution confidence, optional LSP enrichment for compiler-grade accuracy, NestJS dependency injection
- **ORM model context** — relationships, schema, metadata for 7 ORMs
- **Dead code & test gap detection** — find untested exports/symbols (with "unreached" vs "imported_not_called" classification), dead code, per-symbol test reach in impact analysis
- **Multi-service subprojects** — link graphs across services via API contracts; cross-service impact analysis; service-scoped decisions
- **AI-powered analysis** — semantic search with zero-config local ONNX embeddings (no API keys needed), plus optional LLM summarization via Ollama/OpenAI

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

### Enabling semantic search

Semantic search works out of the box — just enable AI in your config:

```jsonc
// ~/.trace-mcp/.config.json or project/.trace-mcp/.config.json
{ "ai": { "enabled": true } }
```

The default provider (`onnx`) uses a bundled local model (`Xenova/all-MiniLM-L6-v2`, ~23 MB) — no API keys, no external services, fully offline after first model download. Run `embed_repo` once or just use `search` with `semantic: "on"` and embeddings will be computed on demand.

For LLM-powered summarization, switch to `ollama` or `openai` provider — see [AI configuration](docs/configuration.md#ai-configuration).

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
  topology.db               # cross-service topology + subproject graph
  decisions.db              # decision memory + session content (cross-session knowledge graph)
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
│  Pass 3 — LSP enrichment (opt-in)       │
│  tsserver · pyright · gopls ·           │
│  rust-analyzer → compiler-grade         │
│  call resolution, 4-tier confidence     │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│  SQLite (WAL mode) + FTS5               │
│  nodes · edges · symbols · routes       │
│  + embeddings (local ONNX by default)   │
│  + optional: LLM summaries              │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│  Decision Memory (decisions.db)         │
│  decisions · session chunks · FTS5      │
│  temporal validity · code linkage       │
│  auto-mined from session logs           │
└────────────────────┬─────────────────────┘
                     │
                     ▼
         MCP server (stdio or HTTP/SSE)
         130+ tools · 2 resources
```

**Incremental by default** — files are content-hashed; unchanged files are skipped on re-index.

**Plugin architecture** — language plugins (symbol extraction) and integration plugins (semantic edges) are loaded based on project detection, organized into categories: framework, ORM, view, API, validation, state, realtime, testing, tooling.

> Details: [Architecture & plugin system](docs/architecture.md)

---

## Documentation

| Document | Description |
|---|---|
| [Supported frameworks](docs/supported-frameworks.md) | Complete list of languages, frameworks, ORMs, UI libraries, and what each extracts |
| [Tools reference](docs/tools-reference.md) | All 130+ MCP tools with descriptions and usage examples |
| [Configuration](docs/configuration.md) | Config options, AI setup, environment variables, security settings |
| [Architecture](docs/architecture.md) | How indexing works, plugin system, project structure, tech stack |
| [Decision memory](docs/decision-memory.md) | Decision knowledge graph, session mining, cross-session search, wake-up context |
| [Analytics](docs/analytics.md) | Session analytics, token savings tracking, optimization reports, benchmarks |
| [System prompt routing](docs/tweakcc.md) | Optional tweakcc integration for maximum tool routing enforcement |
| [Development](docs/development.md) | Building, testing, contributing, adding new plugins |

---

## Decision memory

Every conversation with an AI agent produces decisions, discoveries, and preferences that disappear when the session ends. trace-mcp's **decision memory** captures them and links them to the code they're about.

### How it works

1. **Mine** — `mine_sessions` scans Claude Code / Claw Code JSONL logs and extracts decisions using pattern matching (no LLM calls). Detects architecture decisions, tech choices, bug root causes, preferences, tradeoffs, discoveries, and conventions.

2. **Link** — each decision can be linked to a code symbol (`src/auth/provider.ts::AuthProvider#class`) or file. When you run `get_change_impact` on that symbol, the decision shows up automatically.

3. **Search** — `query_decisions` supports FTS5 full-text search, filtering by type/service/symbol/file/tag, and temporal queries ("what was true in January?"). `search_sessions` searches raw conversation content across all past sessions.

4. **Surface** — decisions auto-enrich code intelligence tools:
   - `get_change_impact` → `linked_decisions` on the target + affected files
   - `plan_turn` → `related_decisions` matched by task description + target files
   - `get_session_resume` → `active_decisions` for project orientation

### Decision memory MCP tools

| Tool | What it does |
|---|---|
| `mine_sessions` | Extract decisions from session logs (pattern-based, 0 LLM calls) |
| `add_decision` | Manually record a decision with code linkage + service scoping |
| `query_decisions` | Query by type/service/symbol/file/tag + FTS5 search |
| `invalidate_decision` | Mark a decision as superseded (preserved for history) |
| `get_decision_timeline` | Chronological history of decisions for a symbol/file |
| `get_decision_stats` | Knowledge graph overview |
| `index_sessions` | Index session content for cross-session search |
| `search_sessions` | FTS5 search: "what did we discuss about auth?" |
| `get_wake_up` | Compact orientation (~300 tokens): project + decisions + stats |

### Decision memory CLI

```bash
trace-mcp memory mine                           # mine sessions for decisions
trace-mcp memory index                          # index session content for search
trace-mcp memory search "GraphQL migration"     # search past conversations
trace-mcp memory decisions --type tech_choice   # list decisions
trace-mcp memory stats                          # knowledge graph overview
trace-mcp memory timeline --file src/auth.ts    # decision history for a file
```

### Temporal validity

Decisions have `valid_from` / `valid_until` timestamps. When a decision is superseded, `invalidate_decision` preserves it for historical queries while excluding it from active results:

```
query_decisions()                              → only active decisions
query_decisions(as_of="2025-01-15")            → what was true on Jan 15
query_decisions(include_invalidated=true)       → full history
```

### Service scoping

In projects with multiple services (subprojects), decisions can be scoped:

```
add_decision(title="Use JWT", service_name="auth-api")
query_decisions(service_name="auth-api")       → only auth-api decisions
query_decisions()                              → all project decisions
```

> Details: [Decision memory](docs/decision-memory.md)

---

## Subprojects

A **subproject** is any working repository that is part of your project's ecosystem: microservices, frontends, backends, shared libraries, CLI tools, etc.

Each directory with its own root marker (`package.json`, `composer.json`, `go.mod`, etc.) is a subproject. A project contains one or more subprojects; the project itself is not a subproject.

trace-mcp **links dependency graphs across subprojects** — if subproject A calls an API endpoint in subproject B, trace-mcp knows that changing that endpoint in B breaks clients in A. Subprojects can live inside the project directory or be added from outside.

### How it works

Subproject discovery is **automatic by default**. Every time a project is indexed (`serve`, `serve-http`, or `index`), trace-mcp:

1. **Detects subprojects** within the project root:
   - **Docker Compose** — parses `docker-compose.yml` / `compose.yml`
   - **Flat workspace** — first-level subdirs with root markers (e.g. `project/frontend/` + `project/backend/`)
   - **Grouped workspace** — two-level structure (e.g. `project/org/service-a/`)
   - **Monolith fallback** — treats root as a single subproject
2. **Registers** each subproject bound to the project in `~/.trace-mcp/topology.db`
3. **Parses** API contracts — OpenAPI/Swagger, GraphQL SDL, Protobuf/gRPC
4. **Scans** code for HTTP client calls (fetch, axios, Http::, requests, http.Get, gRPC stubs, GraphQL operations)
5. **Links** discovered calls to known endpoints from other subprojects
6. **Creates** cross-subproject dependency edges

### Example

```bash
# Index a project — subprojects are auto-detected
cd ~/projects/my-app && trace-mcp add
# → auto-detects: my-app/user-service (has openapi.yaml)
# →               my-app/order-service (has axios.get('/api/users/{id}'))
# → links order-service → user-service via /api/users/{id}

# Or add an external subproject manually
trace-mcp subproject add --repo=~/projects/external-auth --project=~/projects/my-app

# Check cross-subproject impact
trace-mcp subproject impact --endpoint=/api/users
# → "GET /api/users/{id} is called by 2 client(s) in 1 subproject(s)"
#   [order-service] src/services/user-client.ts:42 (axios, confidence: 85%)
```

### Subproject CLI

```bash
# Add a subproject (inside or outside project dir)
trace-mcp subproject add --repo=../service-b --project=. [--contract=openapi.yaml] [--name=my-service]
trace-mcp subproject remove <name-or-path>
trace-mcp subproject list [--project=.] [--json]
trace-mcp subproject sync           # re-scan all subprojects
trace-mcp subproject impact --endpoint=/api/users [--method=GET] [--service=user-svc]
```

### MCP tools

| Tool | What it does |
|---|---|
| `get_subproject_graph` | All subprojects, their connections, and stats |
| `get_subproject_impact` | Cross-subproject impact: what breaks if endpoint X changes (resolves to symbol level) |
| `get_subproject_clients` | Find all client calls across subprojects that call a specific endpoint |
| `subproject_add_repo` | Add a subproject via MCP (bound to current project, or specify `project`) |
| `subproject_sync` | Re-scan all subprojects |

> Subproject management builds on top of the topology system. See [Configuration](docs/configuration.md#topology--subprojects) for options.

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
| **Test Coverage Gaps** | Affected symbols with no matching test file. Per-symbol `hasTestReach` shows whether tests actually reference each specific symbol |
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

[MIT](LICENSE)

---

Built by [Nikolai Vysotskyi](https://github.com/nikolai-vysotskyi)
