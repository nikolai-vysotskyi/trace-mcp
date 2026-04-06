# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.6.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.4...v1.6.0) (2026-04-06)


### Features

* add apply_codemod tool for bulk regex find-and-replace ([eeed93b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eeed93b5651d5d089cd34dae123e34389db1d159))
* add multi-root project support ([858fc7f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/858fc7f1c5313b69bc7b1eb74a8f462a1902142c))


### Refactoring

* migrate from native tree-sitter to web-tree-sitter WASM ([3544f0b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3544f0b4e94098ad6274450794dd3ef80d7ab36a))

## [1.5.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.3...v1.5.4) (2026-04-06)


### Refactoring

* Update hook finding logic ([7f5f4e5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7f5f4e55971aa7fbf21e4d031be6544f753b127b))

## [1.5.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.2...v1.5.3) (2026-04-06)


### Bug Fixes

* **ci:** use npx npm@11 for publish instead of global npm upgrade ([4d82eb7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4d82eb7fd3ea23361d85822e6e826ce8eb8a4e0f))

## [1.5.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.1...v1.5.2) (2026-04-06)


### Bug Fixes

* **ci:** move TSUP_TARGET to job-level env and install latest npm for OIDC ([b671be6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b671be6375f197ca3635f8d89421e025c8397b39))

## [1.5.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.0...v1.5.1) (2026-04-06)


### Bug Fixes

* **ci:** set node22 tsup target for npm OIDC publish compatibility ([ebb45f7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ebb45f78798687032b4c29340895910ddd5561b2))

## [1.5.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.4.1...v1.5.0) (2026-04-06)


### Features

* add .traceignore support and shared ignore-pattern parser ([0eae92d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0eae92dfad64096590e4a36a49c9c007309c5334))
* add AI concurrency config, expand known packages, simplify CI ([0025c57](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0025c5711b3161a0dbdfbb8cb2f50b25bce322b7))
* add consultation markers, explored tracker, and guard hook v0.4.0 ([eb87a86](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eb87a864a152fe53cc49e8a54ee9267a42f0532b))
* add duplication checking guidance to tools and instructions ([53779fd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/53779fd2daa5ebde372f4769ce2b07fa8c23fd1d))
* add memory leak detector and inter-procedural taint analysis ([aa752fd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aa752fd5f5c97a4a5bfa330af2bfe39edd168bb7))
* add session dedup, resume, and adaptive token budget ([628a6bc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/628a6bca5ebeee6184947396d5cede1fcd4fb389))
* add session snapshot, precompact hook, and worktree hooks ([fd0a0f2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fd0a0f25a0b3c3228c0d7419e9c5972c42d3e154))
* enhance init with competing tool cleanup and error handling ([4f6aa4a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4f6aa4a4cd4b02719ab49c6ad25314d11b4980ec))


### Bug Fixes

* **ci:** improve risk scoring and split code/non-code file sections ([2325f82](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2325f82626d2012aa94750572771020a53718ec6))
* **ci:** use last release tag as base for impact report ([e9d12bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e9d12bf0f9c4cb4172820c8b1276ceb8cce8cee9))
* improve dead export detection accuracy ([e4d8728](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e4d87286f41cbddb98eb18d6fedcee013c838ae6))
* store original export names in import specifiers across all languages ([4d92110](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4d92110c071e0f397b05a3cd1b10b7176d533f20))


### Refactoring

* extract pipeline file persistence and edge resolution ([cf91a9f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cf91a9f0919189fb550e308781d7f01080bf7bf2))
* extract server tool registration into modular register files ([80baf81](https://github.com/nikolai-vysotskyi/trace-mcp/commit/80baf81835fff26cd6681f5bd7aa55094e3b811e))
* extract shared test utilities into tests/test-utils.ts ([13938c4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/13938c4fda8fb8592e02d115fa3a9df48df9b0be))
* extract Store into repository pattern ([0f43ee2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0f43ee27b1d3537d6af88a8256cfef4b69952638))
* narrow export visibility and minor cleanups across codebase ([fc79331](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fc79331da7069c5a40e94162c80d9c50d1e97ec5))
* remove dead code and narrow export visibility ([ff2c930](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ff2c9309460b4085d9a27cfe1133004419a1fd67))
* reorganize source tree into domain subdirectories ([279f583](https://github.com/nikolai-vysotskyi/trace-mcp/commit/279f583a0ff1b449d85dc617f49a0c2d9c2a53ff))


### Documentation

* add token reduction stat to README tagline ([00dc91f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/00dc91f860458975cd16f536b900d949ede4dbee))
* update README with comparison tables, benchmarks, and .traceignore ([4b8d84a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4b8d84a988c4fdafe9e6089a01d39d1a9e7e2307))


### Tests

* add tests for init, runtime, tools, and AI pipeline ([9219e2d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9219e2d0e8a07091f60f94d01002a87848e3eb34))
* expand conflict-detector coverage with fixture-based tests ([8db3009](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8db3009f795eed581a680a0b6e72cf27cb8df30f))

## [1.4.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.4.0...v1.4.1) (2026-04-05)


### Bug Fixes

* **ci:** upgrade to Node 24 and conditionally upgrade npm ([d0484df](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d0484df53617330f90c5e6eb08b2a4723fecf5bc))

## [1.4.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.3.1...v1.4.0) (2026-04-05)


### Features

* add token optimization guidance to server instructions and hints ([7487bfc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7487bfc09b4c2193bdd8d6b2179798b920751fff))

## [1.3.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.3.0...v1.3.1) (2026-04-05)


### Bug Fixes

* **ci:** restore npm upgrade for Trusted Publishing OIDC support ([d4e1d92](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d4e1d9252d23da731111d670947bf93d726a285d))

## [1.3.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.2.2...v1.3.0) (2026-04-05)


### Features

* add 10 integration plugins (mcp-sdk, raw-sql, commander, tree-sitter, etc.) ([a89feef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a89feefad8905c6ad0f00c046c3ec264b847438b))
* enriched change impact with risk scoring, breaking changes, and diff-aware mode ([511b474](https://github.com/nikolai-vysotskyi/trace-mcp/commit/511b474a001bad8a2a8f3ce08017f3aadc233228))
* reduce tool calls and token waste across 7 optimizations ([24ff690](https://github.com/nikolai-vysotskyi/trace-mcp/commit/24ff690e379884116cb3ecb5a41425a5482f7b96))
* safer conflict resolution — comment-out instead of delete, scope to selected clients ([8308564](https://github.com/nikolai-vysotskyi/trace-mcp/commit/830856407a10bab28efb7aa5ffdf10c1bf2950cf))
* scan .github/workflows in project context discovery ([3411e8a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3411e8acc644aad1d8a2a06bd9cc4b73b0ccce08))
* token efficiency improvements + .env security guard ([1b22425](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1b224251a4464208d1b7fed67ef90b6b04d19934))
* Windows support for guard and reindex hooks ([edaaaf5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/edaaaf5c7ef4ab6fb977a6fc47f3d6e1930b6346))


### Bug Fixes

* **ci:** bump Node from 20 to 22 to fix tsup DTS build ([1ceb6d5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ceb6d5e6c20d9a0d05e9762dedc787aec62d320))

## [1.2.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.2.1...v1.2.2) (2026-04-05)


### Bug Fixes

* **ci:** auto-trigger CI on release-please PR branches ([caa4edf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/caa4edfdc5a081811f1b4ffea2a4e577ae1f3dba))

## [1.2.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.2.0...v1.2.1) (2026-04-05)


### Bug Fixes

* merge import specifiers on conflict instead of silently dropping ([cd02674](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cd026745c95df8258a88a37d0ce174333c38930e))
* restore parseError used by 20 language/integration plugins ([579c1fa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/579c1fa3cba63c8c71ec7aacefbb6469d37aafba))

## [1.2.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.1.0...v1.2.0) (2026-04-05)


### Features

* add analytics system with benchmarks and session tracking ([8a6650c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8a6650ccd54bbdffb66176bce93c244fe50508c2))
* add bundle management, file watcher, and health check CLI ([220bc9c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/220bc9cea4b5f3b80773fa6d8ac77b9925e4ae31))
* add claw-code MCP client support ([0559ba8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0559ba85c7db7347419e09bd113debe266718d1d))
* add quality gates, taint analysis, and evidence tools ([23bf3a2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/23bf3a2bc850efb4aedc3b8c029be71515c9f4ee))
* integrate new features into server, CLI, and config ([fbaf1d7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fbaf1d7a268ed9e4297efb502edb28d913242570))


### Bug Fixes

* **ci:** support impact reports for release-please auto-PRs ([1bd53ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1bd53ac31fa703f6e2f5439693630acd381263ca))


### Performance Improvements

* optimize indexer with concurrent extraction and FTS5 batch mode ([c19273f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c19273f1646805f86db4186a18cb84769de13560))

## [1.1.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.11...v1.1.0) (2026-04-05)


### Features

* add code smells scanner, consolidate imports, improve tool routing docs ([9a2b66e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9a2b66ef3fb7251a24ac7e852f6bfe3444fb5feb))

## [1.0.11](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.10...v1.0.11) (2026-04-05)


### Bug Fixes

* **deps:** suppress tree-sitter peer dependency warnings ([0c5b030](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0c5b030884f33aab41d0895ae0321cdf3c092c9f))
* **server:** remove duplicate plan_batch_change tool registration ([0e1143d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0e1143d9db58e28fca92dcf391826448de800086))

## [1.0.10](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.9...v1.0.10) (2026-04-05)


### Bug Fixes

* **db:** add missing workspace/is_cross_ws columns in migration v9 ([8b263bd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8b263bd131940566f739187a0187df10ddcb8288))

## [1.0.9](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.8...v1.0.9) (2026-04-05)


### Bug Fixes

* **ci:** upgrade npm for Trusted Publishing OIDC support (requires &gt;=10.9.2) ([21069cc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/21069ccd9a0a0736fda8d05ff6bdc7920167bc18))

## [1.0.8](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.7...v1.0.8) (2026-04-05)


### Bug Fixes

* **ci:** restore registry-url for npm OIDC auth ([c2c66aa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c2c66aae7d6ca052d4d3a1bac55d3274c20db83b))

## [1.0.7](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.6...v1.0.7) (2026-04-05)


### Bug Fixes

* **ci:** remove registry-url to let npm use OIDC for Trusted Publishing ([a361917](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a361917aac5f029339f23914cf045c4612b18eb6))

## [1.0.6](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.5...v1.0.6) (2026-04-05)


### Bug Fixes

* **ci:** use npm Trusted Publishing (OIDC) instead of NPM_TOKEN ([fe83e53](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fe83e532821dea5a7f484fd5b7e9006dffc1cc4a))

## [1.0.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.4...v1.0.5) (2026-04-05)


### Bug Fixes

* **ci:** sync package-lock.json with fastest-levenshtein dependency ([638e87a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/638e87aab073002a744e1a6cbc9c16d681756701))

## [1.0.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.3...v1.0.4) (2026-04-05)


### Bug Fixes

* **ci:** add .npmrc with legacy-peer-deps for tree-sitter conflicts ([bcf5c78](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bcf5c786b2189162f560d24e37901343eff6760c))

## [1.0.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.2...v1.0.3) (2026-04-05)


### Bug Fixes

* **ci:** chain publish job to release-please via outputs ([09c0be3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/09c0be37bd0aabcedfac384489a9d57065faf7b0))

## [1.0.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.1...v1.0.2) (2026-04-05)


### Bug Fixes

* **ci:** trigger publish on GitHub Release instead of tag push ([90dfb5d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/90dfb5d756f4560adcc0bd1a009d9fd0b951db7e))

## [1.0.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.0...v1.0.1) (2026-04-05)


### Bug Fixes

* fix allowList key casing in .clabot for cla-assistant ([6ca67a9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6ca67a95970bee6a19f4ec8603d15f32c7947e6d))

## [1.0.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v0.1.1...v1.0.0) (2026-04-05)


### ⚠ BREAKING CHANGES

* get_task_context replaces manual chaining of search → get_symbol → get_context_bundle as the recommended workflow for AI agents starting work on a task. Server instructions updated to route agents to this tool first.

### Features

* add 23 new analysis tools — control flow, dataflow, SBOM, security, co-changes, history ([0ba05dc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0ba05dccc100005e97915fcbdcfe630150d7dc6a))
* add 24 new language plugins and improve existing parsers ([c527bdd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c527bdde16ea9f347d4a68c48fbd4748eb69ccf0))
* add get_task_context — graph-aware context engine for AI agents ([fb7594f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fb7594f464aa407ce69a4c597949b96ecbd13fd5))
* CI/PR change impact reports — blast radius, risk scores, test gaps ([b88a2bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b88a2bf8b773b13048a5351c1c47bf3c0152e6aa))
* doctor command, conflict detection, init improvements ([ef57785](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ef57785f705249709cdbda418119562ee761367a))
* enhance existing tools — call-graph, components, events, flow, introspect, model ([e68c344](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e68c344295dff7e95db96d472fcee643069c4326))
* federation system — cross-repo graph linking and fuzzy search ([54e0008](https://github.com/nikolai-vysotskyi/trace-mcp/commit/54e0008e5e6bff6643ceb1aaefe4fca700ee35ee))
* PostToolUse auto-reindex hook + index-file command ([dd31cc9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dd31cc949dbe0d20b5ccbe0a74afb579c9f67cbb))
* runtime improvements, session tracking, savings telemetry, prompt system ([44e7cdf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/44e7cdffc17cb6b329fed0b03aaefe51e807bc0c))

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
