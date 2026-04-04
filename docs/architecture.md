# Architecture

## Indexing pipeline

trace-mcp uses a two-pass indexing pipeline:

```
Source files (PHP, TS, Vue, Python, Go, Java, Kotlin, Ruby, HTML, CSS, Blade)
    │
    ▼
┌──────────────────────────────────────────┐
│  Pass 1 — Per-file extraction            │
│  Language plugins (tree-sitter) →        │
│    symbols (functions, classes, etc.)     │
│  Integration plugins →                   │
│    routes, components, migrations,       │
│    events, models, schemas, variants     │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│  Pass 2 — Cross-file resolution          │
│  Module resolvers:                       │
│    PSR-4 · ES modules · Python modules  │
│  Integration plugins resolveEdges():     │
│    Vue component references              │
│    Inertia render → page mapping         │
│    Blade template inheritance            │
│    ORM relationship resolution           │
│    Route → controller binding            │
│  → unified directed edge graph           │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│  SQLite (WAL mode) + FTS5               │
│  nodes · edges · symbols · routes       │
│  + optional: embeddings · summaries     │
└──────────────────────────────────────────┘
```

**Incremental by default** — files are content-hashed; unchanged files are skipped on re-index.

When AI is enabled, a background pipeline runs after indexing to generate summaries and embeddings for key symbols.

### Storage

All state is centralized in `~/.trace-mcp/`:

```
~/.trace-mcp/
  .config.json              # global config + per-project settings
  registry.json             # project registry (all added projects)
  index/
    my-app-a1b2c3d4e5f6.db  # per-project SQLite databases
    api-server-b2c3d4e5.db
```

Each project gets its own SQLite database, named `<project-basename>-<sha256-hash-of-path>.db`. The project registry tracks which projects are registered, their root paths, and last index time. Nothing is stored in the project directory itself.

---

## Plugin system

Plugins are the core extensibility mechanism. There are two types:

### Language plugins

Located in `src/indexer/plugins/language/`. Each plugin handles symbol extraction for one language using tree-sitter.

Registered plugins: PHP, TypeScript/JavaScript, Vue, Python, Go, Java, Kotlin, Ruby, HTML, CSS.

### Integration plugins

Located in `src/indexer/plugins/integration/`, organized by category:

| Category | Plugins | What they do |
|---|---|---|
| `framework/` | Laravel, Django, Rails, Spring, NestJS, Express, FastAPI, Flask, Hono, Fastify, Nuxt, Next.js | Route, controller, middleware extraction |
| `orm/` | Prisma, TypeORM, Sequelize, Mongoose, SQLAlchemy, Drizzle | Model, relationship, migration extraction |
| `view/` | React, Vue, React Native, Blade, Inertia, shadcn, MUI, Ant Design, Headless UI, Nuxt UI | Component tree, prop, render analysis |
| `api/` | GraphQL, tRPC, DRF | Schema, endpoint, resolver extraction |
| `validation/` | Zod, Pydantic | Schema definition extraction |
| `state/` | Zustand | Store, action, selector extraction |
| `realtime/` | Socket.io | Event handler, namespace extraction |
| `testing/` | Testing | Test suite, fixture, coverage analysis |
| `tooling/` | Celery, n8n, data-fetching | Task, workflow, query hook extraction |

### Plugin interface

Every integration plugin implements `FrameworkPlugin`:

```typescript
interface FrameworkPlugin {
  manifest: PluginManifest;           // name, version, priority, dependencies
  detect(ctx: ProjectContext): boolean; // returns true if framework detected
  registerSchema(): NodeTypes & EdgeTypes; // declares symbol/edge types
  extractNodes?(filePath, content, language): FileParseResult; // extract symbols
  resolveEdges?(ctx: ResolveContext): RawEdge[]; // resolve inter-symbol edges
}
```

Detection runs once on startup. Only plugins whose `detect()` returns `true` participate in indexing.

Plugins are loaded in topological order (respecting dependencies) and by priority (lower = earlier).

---

## Module resolution

Three module resolvers handle cross-file imports:

| Resolver | Languages | What it resolves |
|---|---|---|
| **ES modules** | TypeScript, JavaScript, Vue | `import` / `require` with tsconfig paths, barrel exports |
| **PSR-4** | PHP | Namespace-based autoloading per `composer.json` |
| **Python modules** | Python | Relative/absolute imports, `__init__.py` packages |

---

## Scoring & ranking

`src/scoring/` contains algorithms for ranking search results and context assembly:

- **BM25** — full-text relevance via FTS5
- **PageRank** — symbol importance based on the dependency graph
- **Hybrid scoring** — combines BM25 + graph signals
- **Structured assembly** — assembles context within a token budget, maximizing coverage

---

## Tech stack

| Component | Technology |
|---|---|
| Parsing | [tree-sitter](https://tree-sitter.github.io/) (PHP, TS, Python, Go, Java, Kotlin, Ruby, HTML, CSS), [@vue/compiler-sfc](https://github.com/vuejs/core) |
| Database | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — WAL mode, FTS5, vector storage |
| Module resolution | [oxc-resolver](https://github.com/nicolo-ribaudo/oxc-resolver) (ESM/CJS), PSR-4, Python modules |
| AI | Ollama / OpenAI — embeddings, summarization, reranking, inference caching |
| Validation | [Zod](https://zod.dev) — config + input validation |
| Error handling | [neverthrow](https://github.com/supermacro/neverthrow) — Rust-style `Result<T, E>` |
| Logging | [pino](https://getpino.io/) — structured JSON logging |
| MCP | [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) |
| Build | tsup · vitest · TypeScript 5.7 |

---

## Project structure

```
src/
├── ai/                     # Embeddings, reranker, summarization, vector store, inference caching
├── db/                     # SQLite schema, store, FTS5
├── indexer/
│   ├── plugins/
│   │   ├── language/       # PHP, TypeScript, Vue, Python, Go, Java, Kotlin, Ruby, HTML, CSS
│   │   └── integration/    # 48 plugins organized by category:
│   │       ├── framework/  #   Laravel, Django, Rails, Spring, NestJS, Express, FastAPI,
│   │       │               #   Flask, Hono, Fastify, Nuxt, Next.js
│   │       ├── orm/        #   Prisma, TypeORM, Sequelize, Mongoose, SQLAlchemy, Drizzle
│   │       ├── view/       #   React, Vue, React Native, Blade, Inertia, shadcn, MUI,
│   │       │               #   Ant Design, Headless UI, Nuxt UI
│   │       ├── api/        #   GraphQL, tRPC, DRF
│   │       ├── validation/ #   Zod, Pydantic
│   │       ├── state/      #   Zustand
│   │       ├── realtime/   #   Socket.io
│   │       ├── testing/    #   Playwright, Cypress, Jest, Vitest, Mocha
│   │       └── tooling/    #   Celery, n8n, data-fetching
│   ├── resolvers/          # PSR-4, ES module, Python module resolution
│   ├── pipeline.ts         # Two-pass indexing engine
│   ├── watcher.ts          # File change watcher
│   └── monorepo.ts         # Monorepo workspace detection
├── tools/                  # 38 MCP tool implementations
├── scoring/                # PageRank, BM25, hybrid scoring, structured assembly
├── plugin-api/             # Plugin registry, loader, executor, test harness
├── utils/                  # Env parser, hasher, security, source reader, token counter
├── server.ts               # MCP server factory
├── config.ts               # Cosmiconfig + Zod validation
├── errors.ts               # Error types (neverthrow)
├── logger.ts               # Pino logger setup
└── cli.ts                  # Commander CLI (serve, serve-http, index)
```
