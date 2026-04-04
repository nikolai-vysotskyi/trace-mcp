# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v0.1.0...v0.1.1) (2026-04-04)


### Features

* 11 self-development MCP tools + TypeScript heritage graph + ESM import resolution ([01b34d4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/01b34d4488b32d189e0d9ca22c48c23b37febfe1))
* 15 new analysis tools — graph, git, complexity, dead code, rename safety ([0e39503](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0e39503844c0f835630371de1134babce8cfe4d9))
* 34 new language plugins + version feature detection ([631f938](https://github.com/nikolai-vysotskyi/trace-mcp/commit/631f938b47a5a437a0940daeaaec7913fe68a16f))
* 5 new MCP tools + search async upgrade ([e93c247](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e93c24793014e4e6390e1a66c5f5ce603dc43a6b))
* add monorepo support, external plugins, E2E tests ([3e08490](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3e084905bf40a8ca6e55cd009fed3222f2a8a16b))
* add NestJS, Next.js, Express framework plugins ([2d45fca](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2d45fca196743de9f2033d17dc330e2ddba4862d))
* add optional AI semantic search (Ollama + vector store) ([6088a0c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6088a0c0420170d30e3af26736b65105a4b19346))
* **ai:** OpenAI embedding provider ([a880ad7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a880ad780a60bba97c7c201ac089e7abd0dbb9aa))
* call graph tests, hybrid search tests, seed edge types fix, PageRank cache fix ([6364f79](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6364f79ae7520c07132184a23caddf0a5bc33689))
* core infra — TS heritage extraction, store introspection, watcher debounce ([44247f8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/44247f84ef76b94384dde265294e356d6ce02441))
* DB schema v12, BM25 tuning, pipeline batching, binary/gitignore filtering ([7f203b9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7f203b9850b96f8de3ee968b6b80a1092954cd53))
* expand MCP server — 30+ new tool registrations, improved descriptions ([5c4778d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5c4778d0e3bc8524cb4d654a7c8964fb413a9b87))
* file watcher + hot-reload indexing in CLI ([6037836](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6037836dd157216059ad53181700f853a072bf11))
* Gin, Echo, Angular, Svelte integration plugins ([e7fb8f8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e7fb8f86c86e2f408b3f1a87b2e2b1d9545991f1))
* global config, project registry, CLI init/add/upgrade commands ([dbfc4cf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dbfc4cf523384d4d6987a1b29a6a7740e20778f7))
* Laravel sub-plugins, new tools, Expo Router, integration tests ([6c10709](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6c10709733cb413dcc46bfa235465f1c957bbac9))
* **laravel:** Filament v3 plugin — resources, panels, widgets, relation managers ([8ecece4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8ecece4b39763830a09e8b77495a74a948f2df65))
* **laravel:** Livewire v2/v3 plugin integration ([dde7fb0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dde7fb0fb7b68819d730ed05d53f4be42d63bb06))
* Mongoose, Sequelize, React Native plugins + 4 new tools ([8571d81](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8571d8199c7d88c29989db4f0b808c076462cd1d))
* Nova, Expo Router, find_references + integration tests ([88a741c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/88a741ce11851fe8e54703c0600817fefcd368ca))
* organize integration plugins into category subdirectories ([6e3e42f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6e3e42fb5a8fa794fe12027fa94c90fd5f43c999))
* perf optimizations, Java extends fix, new plugins (Go/Kotlin/Rails/Zod) ([c07ed57](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c07ed57366614109aa8fd006b02e537e6d7b07e8))
* predictive intelligence, intent classification, runtime tracing, topology ([0a9f9d9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0a9f9d9f5e1d49124f5da29a501cb931f6e4777e))
* Prisma, TypeORM, Drizzle, GraphQL plugins + ORM e2e tests ([8e94a0a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8e94a0ab69ec8c26bf46338442d0cd38a689ba86))
* Python ecosystem — Django, Flask, FastAPI, Celery, DRF, Pydantic, SQLAlchemy ([acdcaf2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/acdcaf262e876b3104f329e2c09db6337fc06abe))
* reorganize plugin system — versioned languages, categorized integrations ([c7d60c6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c7d60c6eede249e9440b920a149cd4d9d604c354))
* security hardening, batch DB ops, dependency graph, dead export detection ([6eda537](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6eda537c9fbef32064bfd38e8887be33255ce6bc))
* Spring/Rails plugins, platform-specific RN edges, expanded dynamic tool registration ([96d543b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/96d543b8272e5a24ed42c8f6dd53bfc746cc2996))
* testing framework plugin + edge types for test coverage analysis ([36271b9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/36271b9e19d9ed4c30a27b2a303c4e80198aa292))
* tRPC, Fastify, Socket.io, Zustand, React plugins + Django registration + fixes ([5988e93](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5988e9310d8bf828d029c0e8765ff93c585a66de))
* wire EmbeddingPipeline into CLI serve command ([4ecaa40](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4ecaa4055c51ba616ff95690ec147f74d5e673ce))
* zustand/redux state tool, security utils, dead-exports/references/hierarchy tests ([a3c0f5f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a3c0f5f438ff8683f1d77b7bcb56a565fe0b0bb6))


### Bug Fixes

* add missing handler/metadata fields to RouteRow and null-check file_id ([4d942bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4d942bf2f8e54ab76012ed658e4bace866c55d36))
* align n8n plugin tests with current implementation ([cda3915](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cda3915223f4302ed9fb44b2748b04427853b80d))
* Inertia edge resolution + integration tests exposing real bugs ([c6fc041](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c6fc041d795bf7867a152ae6dd47123bc702a375))
* Kotlin heritage regex + Go/n8n/tRPC improvements ([a649977](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a649977f353a040ab16b8711698a599a127c5fc2))
* ORM-specific edge type resolution in pipeline ([62c7905](https://github.com/nikolai-vysotskyi/trace-mcp/commit/62c7905d5360c6a8582c141bb2f5f5c0f5e0e020))

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
