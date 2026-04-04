# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-04-04

### Added

- **Core engine** — TypeScript AST parser, dependency graph builder, SQLite-backed symbol store
- **MCP server** with 15+ tools: `search`, `get_symbol`, `get_call_graph`, `get_change_impact`, `find_usages`, `get_feature_context`, `get_tests_for`, `get_project_map`, and more
- **CLI** with `index`, `serve`, and `watch` commands
- **File watcher** — hot-reload indexing with debounce

#### Language plugins
- **TypeScript/JavaScript** — heritage extraction, ESM import resolution
- **Python** — Django, Flask, FastAPI, Celery, DRF, Pydantic, SQLAlchemy
- **Go** — version-aware feature detection
- **Java** — extends/implements extraction, Spring Boot plugin
- **Kotlin** — heritage regex, version features
- **Ruby** — Rails plugin, version features
- **CSS** — version feature detection

#### Framework & integration plugins
- **Laravel** — Livewire v2/v3, Filament v3, Nova, Blade, Inertia, sub-plugins
- **Vue / Nuxt** — component graph, Inertia edge resolution
- **React / React Native** — platform-specific edges, Expo Router
- **Next.js / Express / NestJS / Fastify** — route & middleware extraction
- **tRPC / GraphQL / Socket.io** — API edge types
- **Prisma / TypeORM / Drizzle / Mongoose / Sequelize** — ORM-specific edges
- **Zustand / Redux** — state management tool
- **Zod** — schema validation edges
- **n8n** — workflow plugin (25 tests)
- **Testing frameworks** — edge types for test coverage analysis

#### Infrastructure
- **AI semantic search** — Ollama + OpenAI embedding providers, vector store
- **Security hardening** — input validation, security utils
- **Batch DB operations** — optimized SQLite writes
- **Monorepo support** — workspace detection, cross-package edges
- **External plugin system** — dynamic tool registration
- **Plugin reorganization** — versioned languages, categorized integrations

### Fixed

- Inertia edge resolution in integration tests
- Bootstrap routing path normalization
- ORM-specific edge type resolution in pipeline
- Kotlin heritage regex parsing
- Go/n8n/tRPC integration improvements
- Missing `handler`/`metadata` fields in `RouteRow` + null-check `file_id`
- n8n plugin test alignment with implementation
- Seed edge types fix, PageRank cache fix

### Changed

- Pipeline performance optimizations
- Deterministic watcher tests
- Search upgraded to async

[0.1.0]: https://github.com/nicovell3/trace-mcp/releases/tag/v0.1.0
