# trace-mcp

**Framework-aware code intelligence MCP server — supports 35+ frameworks across 8 languages.**

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
| Agent reads 15 files to understand a feature | Agent calls `get_feature_context` — gets relevant code in one shot |
| Agent doesn't know which Vue page a controller renders | Agent sees `routes_to → renders_component → uses_prop` edges |
| "What breaks if I change this model?" — agent guesses | `get_change_impact` traverses reverse dependencies across languages |
| Schema? Agent needs a running database | Migrations are parsed — schema reconstructed from code |
| Prop mismatch between PHP and Vue? Discovered in production | Detected at index time — PHP data vs. `defineProps` |

---

## What you get

| Capability | How it works |
|---|---|
| **Request flow tracing** | URL → Route → Middleware → Controller → Service — works across Laravel, Express, NestJS, Django, FastAPI, Flask, Rails, Spring, and more |
| **Component trees** | Parent → Child render hierarchy with props / emits / slots (Vue, React, Blade) |
| **Schema from migrations** | Table structure reconstructed from migration files — no DB connection needed |
| **Event chains** | Event → Listener → Job fan-out across async boundaries (Laravel, Django signals, NestJS, Celery, Socket.io) |
| **Prop mismatch detection** | PHP `Inertia::render()` data vs. Vue `defineProps` — catch type drift before production |
| **Change impact analysis** | "What breaks if I touch this?" — reverse dependency traversal across languages |
| **Feature context assembly** | Describe a feature in plain English → get all relevant code within a token budget |
| **Call graph** | Bidirectional call graph centered on any symbol — who it calls + who calls it |
| **DI tree** | NestJS dependency injection tree — what a service injects + who injects it |
| **Navigation graph** | React Native navigation tree with screens, navigators, and deep links |
| **Model context** | Full ORM model context: relationships, schema, metadata — Eloquent, Prisma, TypeORM, Drizzle, Mongoose, Sequelize, SQLAlchemy |
| **Test coverage analysis** | Find tests covering a symbol, detect untested exports, coverage gaps |
| **Dead code detection** | Find exported symbols never imported by any other file |
| **Self audit** | One-shot project health: dead exports, untested code, dependency hotspots |

---

## Supported frameworks & languages

### Languages

| Language | Parser | What's extracted |
|---|---|---|
| **PHP** | tree-sitter | Classes, interfaces, traits, enums, functions, methods, properties, constants, namespaces |
| **TypeScript / JavaScript** | tree-sitter | Functions, classes, variables, types, interfaces, enums, exports, JSX/TSX |
| **Python** | tree-sitter | Functions, classes, decorators, attributes, module variables |
| **Go** | tree-sitter | Functions, methods, types (structs), constants, variables, packages |
| **Java** | tree-sitter | Classes, interfaces, enums, annotation types, methods, fields |
| **Kotlin** | tree-sitter | Classes, functions, properties |
| **Ruby** | tree-sitter | Classes, modules, methods, constants |
| **Vue SFC** | tree-sitter + @vue/compiler-sfc | Components, script setup symbols, template analysis |

### Backend frameworks

| Framework | What's extracted |
|---|---|
| **Laravel** | Routes, controllers, Eloquent relations, migrations, FormRequests, events/listeners, middleware, broadcasting |
| **Laravel Livewire** | Components, properties, actions, events, views, child components |
| **Laravel Nova** | Resources, fields, actions, filters, lenses, metrics |
| **Filament** | Resources, relation managers, panels, widgets |
| **Spatie Laravel Data** | Data objects, transformations |
| **Laravel Pennant** | Feature flag definitions |
| **Django** | Models, URL patterns, views (CBV + FBV), admin registrations, signals, forms |
| **Django REST Framework** | Serializers, ViewSets, API endpoints |
| **FastAPI** | Route definitions, path/query parameters, request models |
| **Flask** | Routes, blueprints, request handlers |
| **Express** | Routes, middleware, error handlers, param handlers |
| **NestJS** | Controllers, modules, services, decorators, DI tree |
| **Fastify** | Routes, hooks, plugins |
| **Hono** | Routes, middleware |
| **Next.js** | API routes, pages, `getServerSideProps`, `getStaticProps` |
| **Rails** | Routes, controllers, models, migrations, associations |
| **Spring** | Beans, controllers, services, JPA entities |
| **tRPC** | Routers, procedures, type definitions |

### Frontend frameworks

| Framework | What's extracted |
|---|---|
| **Vue** | Components (Options + Composition API), `defineProps`, `defineEmits`, composables, render trees |
| **Nuxt** | File-based routing, auto-imports, `useFetch` / `useAsyncData`, server API routes, layouts, middleware |
| **React** | Components (functional + class), hooks, props |
| **React Native** | Native components, navigation patterns, screens, deep links, platform variants |
| **Blade** | `@extends`, `@include`, `@component`, `<x-*>` directives, template inheritance |
| **Inertia.js** | `Inertia::render()` calls, controller ↔ Vue page mapping, prop extraction & validation |

### Data & ORM

| Library | What's extracted |
|---|---|
| **Eloquent** (Laravel) | Models, relationships, scopes, casts, schema from migrations |
| **Prisma** | Data models from `schema.prisma`, relations |
| **TypeORM** | Entities, relations, repositories |
| **Drizzle** | Schema definitions, table relations |
| **Sequelize** | Models, associations, migrations |
| **Mongoose** | Schemas, models, middleware |
| **SQLAlchemy** | ORM models, relationships, columns, constraints |

### Other

| Plugin | What's extracted |
|---|---|
| **GraphQL** | Schemas, resolvers, type definitions |
| **Socket.io** | Event handlers, namespaces, rooms |
| **Celery** | Task definitions, routing, schedules |
| **Zustand** | Store definitions, actions, selectors |
| **Pydantic** | BaseModel subclasses, field types, ORM mode references |
| **Zod** | Schema definitions |
| **n8n** | Workflow nodes, connections, parameters, credentials |
| **Data fetching** | React Query, SWR — query hooks, mutations, cache config |
| **Testing** | Playwright, Cypress, Jest, Vitest, Mocha — test suites, fixtures |

---

## MCP tools

### Project

| Tool | What it does |
|---|---|
| `get_project_map` | Project overview — detected frameworks, directory structure, entry points |
| `get_index_health` | Index stats — file count, symbol count, edge count, errors |
| `reindex` | Trigger full or incremental re-indexing |
| `get_env_vars` | List environment variable keys from `.env` files with inferred value types |
| `get_plugin_registry` | List all registered indexer plugins and the edge types they emit |

### Navigation

| Tool | What it does |
|---|---|
| `search` | Full-text search (FTS5 + BM25) with kind / language / file pattern filters |
| `get_symbol` | Look up a symbol by ID or FQN — returns source code |
| `get_file_outline` | All symbols in a file — signatures only, no bodies |
| `find_references` | Find all places that reference a symbol or file (imports, calls, renders, dispatches) |

### Framework intelligence

| Tool | What it does |
|---|---|
| `get_component_tree` | Build Vue/Blade component render tree from a root file |
| `get_change_impact` | Reverse dependency graph — what depends on this file or symbol |
| `get_feature_context` | NLP-driven context assembly — describe a feature, get relevant code within a token budget |
| `get_request_flow` | Trace request flow for a URL+method: route → middleware → controller → service |
| `get_middleware_chain` | Trace middleware chain for a route URL |
| `get_event_graph` | Event/signal/task dispatch graph (Laravel events, Django signals, NestJS events, Celery tasks, Socket.io) |
| `get_model_context` | Full model context: relationships, schema, metadata (Eloquent / Prisma / TypeORM / Drizzle / Mongoose / Sequelize / SQLAlchemy) |
| `get_schema` | Database schema reconstructed from migrations or ORM definitions |
| `get_livewire_context` | Full Livewire component context: properties, actions, events, view, children |
| `get_nova_resource` | Full Laravel Nova resource context: model, fields, actions, filters, lenses, metrics |
| `get_state_stores` | List Zustand stores and Redux Toolkit slices with state, actions, and dispatch sites |

### NestJS

| Tool | What it does |
|---|---|
| `get_module_graph` | Build NestJS module dependency graph (modules → imports → controllers → providers → exports) |
| `get_di_tree` | Trace NestJS dependency injection tree (what a service injects + who injects it) |

### React Native

| Tool | What it does |
|---|---|
| `get_navigation_graph` | Build navigation tree from screens, navigators, and deep links |
| `get_screen_context` | Full screen context: navigator, navigation edges, deep link, platform variants, native modules |

### Code analysis

| Tool | What it does |
|---|---|
| `get_dependency_graph` | File-level dependency graph: what a file imports and what imports it |
| `get_call_graph` | Bidirectional call graph centered on a symbol (who it calls + who calls it) |
| `get_tests_for` | Find test files and test functions that cover a given symbol or file |
| `get_implementations` | Find all classes that implement or extend a given interface/base class |
| `get_type_hierarchy` | Walk TypeScript class/interface hierarchy: ancestors and descendants |
| `get_api_surface` | List all exported symbols (public API) of a file or matching files |
| `get_dead_exports` | Find exported symbols never imported by any other file (dead code candidates) |
| `get_untested_exports` | Find exported public symbols with no matching test file (test coverage gaps) |
| `self_audit` | One-shot project health: dead exports, untested code, dependency hotspots, heritage metrics |

### Resources

| Resource | URI | Description |
|---|---|---|
| Project map | `project://map` | JSON project overview |
| Index health | `project://health` | Index status |

---

## When does it help?

| Scenario | Without trace-mcp | With trace-mcp |
|---|---|---|
| "Add a new field to the User model" | Agent edits model, misses migration, FormRequest, and Vue form | `get_change_impact` shows all dependents — model, migration, request validation, Vue props |
| "What components does this page use?" | Agent greps for import statements, misses dynamic components | `get_component_tree` returns full render tree with props/slots |
| "Refactor the auth flow" | Agent reads files one by one, burns tokens | `get_feature_context("authentication")` assembles relevant code in one call |
| "Does the Vue page match the controller response?" | Manual comparison, easy to miss fields | Prop mismatch detection flags drift automatically |
| "What's the DB schema?" | Need a running database or read raw SQL | Migrations parsed — `get_schema` returns reconstructed tables |
| "Trace a request end-to-end" | Manually follow imports across files | `get_request_flow("/api/users", "GET")` returns the full chain |
| "What NestJS modules does this depend on?" | Manually read module imports | `get_module_graph` shows the full dependency tree |
| "Find untested code" | Manual review | `get_untested_exports` + `self_audit` flag coverage gaps |

---

## Quick start

### 1. Install

```bash
npm install -g trace-mcp
```

### 2. Add to your MCP client

**Claude Code:**
```bash
claude mcp add trace-mcp -- trace-mcp serve
```

**Claude Desktop / Cursor / Windsurf** (MCP config JSON):
```json
{
  "mcpServers": {
    "trace-mcp": {
      "command": "trace-mcp",
      "args": ["serve"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

### 3. Start using it

The server auto-indexes on first tool call. No configuration needed for standard projects.

```
> Use get_project_map to see what frameworks are detected
> Use get_feature_context to find code related to "user registration"
> Use get_change_impact on app/Models/User.php to see what depends on it
```

---

## How it works

```
Source files (PHP, TS, Vue, Python, Go, Java, Kotlin, Ruby, Blade)
    │
    ▼
┌──────────────────────────────────────────┐
│  Pass 1 — Per-file extraction            │
│  tree-sitter → symbols                   │
│  framework plugins → routes, components, │
│    migrations, events, models, schemas   │
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
│  components · migrations · models       │
└────────────────────┬─────────────────────┘
                     │
                     ▼
         MCP server (stdio or HTTP/SSE)
         33+ tools · 2 resources
```

**Incremental by default** — files are content-hashed; unchanged files are skipped on re-index.

**Plugin architecture** — language plugins (symbol extraction) and framework plugins (semantic edges) are loaded based on project detection. Adding a new framework = implementing `FrameworkPlugin` with `detect()`, `extractNodes()`, and `resolveEdges()`.

---

## CLI

```bash
trace-mcp serve              # Start MCP server (stdio transport)
trace-mcp serve-http          # Start HTTP/SSE server (default: 127.0.0.1:3741)
  -p, --port <port>           # Custom port
  --host <host>               # Custom host
trace-mcp index <dir>         # Index a project directory
  -f, --force                 # Force reindex all files
```

---

## Configuration

Optional. Works out of the box for standard projects.

Create `.trace-mcp.json` in your project root (or add a `"trace-mcp"` key to `package.json`):

```jsonc
{
  "root": ".",
  "include": [
    "app/**/*.php",
    "routes/**/*.php",
    "resources/**/*.vue",
    "resources/views/**/*.blade.php",
    "src/**/*.{ts,js,vue}"
  ],
  "exclude": [
    "vendor/**",
    "node_modules/**",
    "storage/**"
  ],
  "db": {
    "path": ".trace-mcp/index.db"
  },
  "frameworks": {
    "laravel": {
      "artisan": { "enabled": true, "timeout": 10000 },
      "graceful_degradation": true
    }
  },
  "security": {
    "max_file_size_bytes": 524288
  }
}
```

Config is loaded via [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) — supports `.trace-mcp.json`, `.trace-mcp.yaml`, `package.json`, and more. All values validated with [Zod](https://zod.dev). Environment variable overrides available.

---

## Tech stack

| Component | Technology |
|---|---|
| Parsing | [tree-sitter](https://tree-sitter.github.io/) (PHP, TypeScript, Python, Go, Java, Kotlin, Ruby), [@vue/compiler-sfc](https://github.com/vuejs/core) (Vue SFCs) |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — WAL mode, FTS5 full-text search |
| Module resolution | [oxc-resolver](https://github.com/nicolo-ribaudo/oxc-resolver) (ESM/CJS), PSR-4 (PHP), Python module resolution |
| Validation | [Zod](https://zod.dev) — config + input validation |
| Error handling | [neverthrow](https://github.com/supermacro/neverthrow) — Rust-style `Result<T, E>` types |
| Logging | [pino](https://getpino.io/) — structured JSON logging |
| MCP | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| Build | tsup · vitest · TypeScript 5.7 |

---

## Security

- **Path traversal protection** — all file access validated against project root
- **Symlink detection** — prevents escape from project boundary
- **Secret pattern filtering** — configurable regex patterns
- **File size limits** — per-file byte cap
- **Artisan whitelist** — only safe artisan commands allowed (when Laravel integration is enabled)
- **HTTP rate limiting** — 60 req/min per IP (HTTP/SSE transport)

---

## Development

```bash
git clone https://github.com/nickvysotskyi/trace-mcp.git
cd trace-mcp
npm install
npm run build
npm test            # 1553 tests
npm run dev         # watch mode (tsup)
npm run serve       # start MCP server (dev)
```

### Project structure

```
src/
├── ai/                     # Embeddings, reranker, summarization, vector store
├── db/                     # SQLite schema, store, FTS5
├── indexer/
│   ├── plugins/
│   │   ├── language/       # PHP, TypeScript, Vue, Python, Go, Java, Kotlin, Ruby
│   │   └── framework/      # Laravel, Vue, Nuxt, Inertia, Blade, Express, NestJS,
│   │                       # Django, FastAPI, Flask, Rails, Spring, Next.js, React,
│   │                       # React Native, Prisma, TypeORM, Drizzle, Sequelize,
│   │                       # Mongoose, SQLAlchemy, GraphQL, tRPC, Socket.io, Celery,
│   │                       # Zustand, Pydantic, Zod, Hono, Fastify, n8n, DRF,
│   │                       # Filament, Nova, Livewire, Pennant, data-fetching, testing
│   ├── resolvers/          # PSR-4, ES module, Python module resolution
│   └── pipeline.ts         # Two-pass indexing engine
├── tools/                  # 33+ MCP tool implementations
├── scoring/                # PageRank, BM25, hybrid scoring
├── plugin-api/             # Plugin registry + executor
├── utils/                  # Env parser, hasher, security, token counter
├── server.ts               # MCP server setup
├── config.ts               # Cosmiconfig + Zod
└── cli.ts                  # Commander CLI
```

---

## Best for

- **Full-stack projects** in any supported framework combination
- Teams using AI agents (Claude, Cursor, Windsurf) for day-to-day development
- **Multi-language codebases** where PHP ↔ JavaScript ↔ Python boundaries create blind spots
- **Monorepos** with multiple services and shared libraries
- CI/CD environments where a running database isn't available
- Large codebases where agents waste tokens re-reading files

---

## License

[Elastic License 2.0 + Ethical Use Addendum](LICENSE) — free for personal and internal use. See LICENSE for full terms.

---

Built by [Nikolai Vysotskyi](https://github.com/nickvysotskyi)
