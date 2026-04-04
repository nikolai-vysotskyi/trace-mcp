# trace-mcp

**Framework-aware code intelligence MCP server — 48+ framework integrations across 44 languages.**

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
| Agent reads 15 files to understand a feature | `get_feature_context` — relevant code in one shot |
| Agent doesn't know which Vue page a controller renders | `routes_to → renders_component → uses_prop` edges |
| "What breaks if I change this model?" — agent guesses | `get_change_impact` traverses reverse dependencies across languages |
| Schema? Agent needs a running database | Migrations parsed — schema reconstructed from code |
| Prop mismatch between PHP and Vue? Discovered in production | Detected at index time — PHP data vs. `defineProps` |

---

## Key capabilities

- **Request flow tracing** — URL → Route → Middleware → Controller → Service, across 18 backend frameworks
- **Component trees** — render hierarchy with props / emits / slots (Vue, React, Blade)
- **Schema from migrations** — no DB connection needed
- **Event chains** — Event → Listener → Job fan-out (Laravel, Django, NestJS, Celery, Socket.io)
- **Change impact analysis** — reverse dependency traversal across languages
- **Feature context assembly** — describe a feature in English → get relevant code within a token budget
- **Call graph & DI tree** — bidirectional call graphs, NestJS dependency injection
- **ORM model context** — relationships, schema, metadata for 7 ORMs
- **Dead code & test gap detection** — find untested exports, dead code, coverage gaps
- **AI-powered analysis** — symbol explanation, test suggestions, change review, semantic search (optional)

### Supported stack

**Languages (44):** PHP, TypeScript/JavaScript, Python, Go, Java, Kotlin, Ruby, Rust, C, C++, C#, Swift, Objective-C, Dart, Scala, Groovy, Elixir, Erlang, Haskell, Gleam, Bash, Lua, Perl, GDScript, R, Julia, Nix, SQL, HCL/Terraform, Protocol Buffers, Vue SFC, HTML, CSS/SCSS/SASS/LESS, XML/XUL/XSD, YAML, JSON, TOML, Assembly, Fortran, AutoHotkey, Verse, AL, Blade, EJS

**Frameworks:** Laravel (+ Livewire, Nova, Filament, Pennant), Django (+ DRF), FastAPI, Flask, Express, NestJS, Fastify, Hono, Next.js, Nuxt, Rails, Spring, tRPC

**ORMs:** Eloquent, Prisma, TypeORM, Drizzle, Sequelize, Mongoose, SQLAlchemy

**Frontend:** Vue, React, React Native, Blade, Inertia, shadcn/ui, Nuxt UI, MUI, Ant Design, Headless UI

**Other:** GraphQL, Socket.io, Celery, Zustand, Pydantic, Zod, n8n, React Query/SWR, Playwright/Cypress/Jest/Vitest/Mocha

> Full details: [Supported frameworks](docs/supported-frameworks.md) · [All 38 tools](docs/tools-reference.md)

---

## Quick start

```bash
npm install -g trace-mcp
trace-mcp init        # one-time global setup (MCP clients, hooks, CLAUDE.md)
trace-mcp add         # register current project for indexing
```

**Step 1: `init`** — one-time global setup. Configures your MCP client (Claude Code, Cursor, Windsurf, or Claude Desktop), installs the guard hook, and adds a tool routing guide to `~/.claude/CLAUDE.md`.

**Step 2: `add`** — registers a project. Detects frameworks and languages, creates the index database, and adds the project to the global registry. Run this in each project you want trace-mcp to understand.

All state lives in `~/.trace-mcp/` — nothing is stored in your project directory.

Start your MCP client and use:
```
> get_project_map to see what frameworks are detected
> get_feature_context to find code related to "user registration"
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

After updating trace-mcp (`npm update -g trace-mcp`), run:

```bash
trace-mcp upgrade
```

This runs database migrations and reindexes **all registered projects** with the latest plugins. To upgrade a specific project:

```bash
trace-mcp upgrade /path/to/project
```

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
  index/
    my-app-a1b2c3d4e5f6.db  # per-project databases (named by project + hash)
```

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
| Context for a task | `get_feature_context` | reading 15 files |
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
         38 tools · 2 resources
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

## Best for

- **Full-stack projects** in any supported framework combination
- Teams using AI agents (Claude, Cursor, Windsurf) for day-to-day development
- **Multi-language codebases** where PHP ↔ JavaScript ↔ Python boundaries create blind spots
- **Monorepos** with multiple services and shared libraries
- Large codebases where agents waste tokens re-reading files

---

## License

[Elastic License 2.0 + Ethical Use Addendum](LICENSE) — free for personal and internal use. See LICENSE for full terms.

---

Built by [Nikolai Vysotskyi](https://github.com/nickvysotskyi)
