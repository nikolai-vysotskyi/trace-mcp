# trace-mcp

**Framework-aware code intelligence MCP server for Laravel / Vue / Inertia / Nuxt stacks.**

> Your AI agent reads `UserController.php` and sees a class.
> trace-mcp reads it and sees a route → controller → FormRequest → Eloquent model → Inertia render → Vue page → child components — **in one graph.**

---

## The problem

AI coding agents are language-aware but **framework-blind**.

They don't know that `Inertia::render('Users/Show', $data)` connects a Laravel controller to `resources/js/Pages/Users/Show.vue`. They don't know that `$user->posts()` means the `posts` table defined three migrations ago. They can't trace a request from URL to rendered pixel.

So they brute-read files, guess at relationships, and miss cross-language edges entirely. The bigger the project, the worse it gets.

## The solution

trace-mcp builds a **cross-language dependency graph** from your source code — PHP, TypeScript, Vue SFCs, Blade templates — and exposes it through the [Model Context Protocol](https://modelcontextprotocol.io). Any MCP-compatible agent (Claude Code, Cursor, Windsurf, etc.) gets framework-level understanding out of the box.

| Without trace-mcp | With trace-mcp |
|---|---|
| Agent reads 15 files to understand a feature | Agent calls `get_feature_context` — gets relevant code in one shot |
| Agent doesn't know which Vue page a controller renders | Agent sees `routes_to → renders_component → uses_prop` edges |
| "What breaks if I change this model?" — agent guesses | `get_change_impact` traverses reverse dependencies across PHP + Vue |
| Schema? Agent needs a running database | Migrations are parsed — schema reconstructed from code |
| Prop mismatch between PHP and Vue? Discovered in production | Detected at index time — PHP data vs. `defineProps` |

---

## What you get

| Capability | How it works |
|---|---|
| **Request flow tracing** | URL → Route → Middleware → Controller → FormRequest → Model → Inertia → Vue Page → Props |
| **Component trees** | Parent → Child render hierarchy with props / emits / slots |
| **Schema from migrations** | Table structure reconstructed from migration files — no DB connection needed |
| **Event chains** | Event → Listener → Job fan-out across async boundaries |
| **Prop mismatch detection** | PHP `Inertia::render()` data vs. Vue `defineProps` — catch type drift before production |
| **Change impact analysis** | "What breaks if I touch this?" — reverse dependency traversal across languages |
| **Feature context assembly** | Describe a feature in plain English → get all relevant code within a token budget |

---

## Supported frameworks

| Layer | Frameworks | What's extracted |
|---|---|---|
| **Backend** | Laravel 6–13 | Routes, controllers, Eloquent relations, migrations, FormRequests, events/listeners, middleware |
| **Templates** | Blade | `@extends`, `@include`, `@component`, `<x-*>` directives, template inheritance |
| **Bridge** | Inertia.js | `Inertia::render()` calls, controller ↔ Vue page mapping, prop extraction & validation |
| **Frontend** | Vue 2 (Options API), Vue 3 (Composition API) | `defineProps`, `defineEmits`, composables, component render trees |
| **Meta-framework** | Nuxt 3 | File-based routing, auto-imports, `useFetch` / `useAsyncData`, server API routes |
| **Languages** | PHP, TypeScript, JavaScript, Vue SFC | Full symbol extraction via tree-sitter |

---

## MCP tools

### Project

| Tool | What it does |
|---|---|
| `get_project_map` | Project overview — detected frameworks, directory structure, entry points |
| `get_index_health` | Index stats — file count, symbol count, edge count, errors |
| `reindex` | Trigger full or incremental re-indexing |

### Navigation

| Tool | What it does |
|---|---|
| `search` | Full-text search (FTS5 + BM25) with kind / language / file pattern filters |
| `get_symbol` | Look up a symbol by ID or FQN — returns source code |
| `get_file_outline` | All symbols in a file — signatures only, no bodies |

### Framework intelligence

| Tool | What it does |
|---|---|
| `get_component_tree` | Build Vue/Blade component render tree from a root file |
| `get_change_impact` | Reverse dependency graph — what depends on this file or symbol |
| `get_feature_context` | NLP-driven context assembly — describe a feature, get relevant code within a token budget |

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

The server auto-indexes on first tool call. No configuration needed for standard Laravel + Vue projects.

```
> Use get_project_map to see what frameworks are detected
> Use get_feature_context to find code related to "user registration"
> Use get_change_impact on app/Models/User.php to see what depends on it
```

---

## How it works

```
Source files (PHP, TS, Vue, Blade)
    │
    ▼
┌──────────────────────────────────────────┐
│  Pass 1 — Per-file extraction            │
│  tree-sitter → symbols                   │
│  framework plugins → routes, components, │
│    migrations, events, Eloquent models   │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│  Pass 2 — Cross-file resolution          │
│  PSR-4 · ES modules · Vue components    │
│  Inertia bridge · Blade inheritance      │
│  → unified directed edge graph           │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│  SQLite (WAL mode) + FTS5               │
│  nodes · edges · symbols · routes       │
│  components · migrations                 │
└────────────────────┬─────────────────────┘
                     │
                     ▼
              MCP stdio server
              9 tools · 2 resources
```

**Incremental by default** — files are content-hashed; unchanged files are skipped on re-index.

**Plugin architecture** — language plugins (symbol extraction) and framework plugins (semantic edges) are loaded based on project detection. Adding a new framework = implementing `FrameworkPlugin` with `detect()`, `extractNodes()`, and `resolveEdges()`.

---

## Configuration

Optional. Works out of the box for standard Laravel + Vue projects.

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
| Parsing | [tree-sitter](https://tree-sitter.github.io/) (PHP, TypeScript), [@vue/compiler-sfc](https://github.com/vuejs/core) (Vue SFCs) |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — WAL mode, FTS5 full-text search |
| Module resolution | [oxc-resolver](https://github.com/nicolo-ribaudo/oxc-resolver) (ESM/CJS), PSR-4 (PHP autoloading) |
| Validation | [Zod](https://zod.dev) — config + input validation |
| Error handling | [neverthrow](https://github.com/supermacro/neverthrow) — Rust-style `Result<T, E>` types |
| MCP | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| Build | tsup · vitest · TypeScript 5.7 |

---

## Security

- **Path traversal protection** — all file access validated against project root
- **Symlink detection** — prevents escape from project boundary
- **Secret pattern filtering** — configurable regex patterns
- **File size limits** — per-file byte cap
- **Artisan whitelist** — only safe artisan commands allowed (when Laravel integration is enabled)

---

## Development

```bash
git clone https://github.com/nickvysotskyi/trace-mcp.git
cd trace-mcp
npm install
npm run build
npm test            # 286 tests
npm run dev         # watch mode (tsup)
npm run serve       # start MCP server (dev)
```

### Project structure

```
src/
├── db/                     # SQLite schema, store, FTS5
├── indexer/
│   ├── plugins/
│   │   ├── language/       # PHP, TypeScript, Vue parsers
│   │   └── framework/      # Laravel, Vue, Inertia, Nuxt, Blade
│   ├── resolvers/          # PSR-4, ES module resolution
│   └── pipeline.ts         # Two-pass indexing engine
├── tools/                  # MCP tool implementations
├── scoring/                # PageRank, BM25, hybrid scoring
├── plugin-api/             # Plugin registry + executor
├── server.ts               # MCP server setup
├── config.ts               # Cosmiconfig + Zod
└── cli.ts                  # Commander CLI
```

---

## Best for

- Laravel + Vue / Inertia / Nuxt full-stack projects
- Teams using AI agents (Claude, Cursor, Windsurf) for day-to-day development
- Projects where PHP ↔ JavaScript boundaries create blind spots
- CI/CD environments where a running database isn't available
- Large codebases where agents waste tokens re-reading files

---

## License

[Elastic License 2.0](LICENSE) — free for personal and internal use. See LICENSE for full terms.

---

Built by [Nikolai Vysotskyi](https://github.com/nickvysotskyi)
