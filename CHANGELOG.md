# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).


## [1.37.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.36.1...v1.37.0) (2026-05-15)


### Features

* **tools:** toon output format for tabular MCP responses (30-60% fewer tokens) ([2e359ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2e359bab2159d3d7ec7e2cfce81edd20c0f810b9))


### Bug Fixes

* **analysis:** restore findDuplicateSymbols helper that check_duplication relied on ([8d49139](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8d4913953d92d70d3d1b06e6f68dae17969f0aff))
* **benchmark:** honest synthetic-estimator labelling + tokenizer calibration + multi-sample variance ([279f619](https://github.com/nikolai-vysotskyi/trace-mcp/commit/279f61930f9f121112fd294eb66b2fad1ec1d9e6))
* **daemon:** cap remaining unbounded long-lived caches and stores ([f7b7044](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f7b7044ab367275f1f66a110044bb1e0a5140b27))
* **daemon:** plug FileWatcher re-entry leak + pass_cache TTL + progress-throttle pruning ([cc4f155](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cc4f155888d23bb08b8701f50b45185dc0ae2c1c))
* **daemon:** restore /mcp routing for stdio clients + scope teardown to removed projects ([4a708a2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4a708a2f52c8d14ffd114e0c83bc0967ad9fd998))
* **db:** add v11 domain tables to fresh-DB DDL ([12e4e05](https://github.com/nikolai-vysotskyi/trace-mcp/commit/12e4e0588945d98ae008b9b976bd472b28259dec))
* **db:** mirror remaining v11+ migration tables in fresh-DB DDL + parity guard ([c0c052d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c0c052d89188c8a3cedb692c90bc8e0614ceda6e))
* **intent:** add missing domains JOINs in getCrossDomainDependencies ([b39b5b3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b39b5b3d778b899a1604bb42ac48d89275f84016))
* **pipeline:** bound per-project resource accumulation across project lifecycle ([61fcd70](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61fcd703b3587833c1dd2fada9754ff4782b55b6))
* **scoring:** drop stale-prone in-process cache from ranking_pins lookups ([d5de560](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d5de560ecbc25309b64dd06a43c41e087a86f6de))
* **telemetry:** bound OTLP/Langfuse sink memory under unreachable export endpoint ([20397a4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/20397a468a009cf6d7bca58031cfca128ba35900))
* **test:** bump bundles searchBundles limit-case timeout to 30s ([06e0df5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/06e0df5bf2041b38ad63dbe131848803425d709d))
* **tools:** invert source/target check in get_cross_workspace_impact ([5597781](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5597781dda4938634cacc1985b32c67484b27418))
* **topology:** apply contractType filter to endpoints in get_api_contract ([db91b91](https://github.com/nikolai-vysotskyi/trace-mcp/commit/db91b9113ed87e6239337272bc1d745d460ef47d))
* **topology:** replace stale fr.* alias with sp.* in client-call queries ([f304139](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f304139f144ef09dfffcae3988fb809c416e6806))


### Tests

* **tools:** behavioural coverage for api-contract and service tools ([f8c8872](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f8c887298735b07799478b926e2f8a0d05e23210))
* **tools:** behavioural coverage for compare and suggest tools ([61b07cf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61b07cfff37dbfb6c39643d52d531efde4e3b051))
* **tools:** behavioural coverage for context and complexity tools ([8334270](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8334270247278252e6bac49e405128cb932ed734))
* **tools:** behavioural coverage for corpus and packaging tools ([c23eb2d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c23eb2db468b887c821e3600551aa469c7557db0))
* **tools:** behavioural coverage for cross-domain and edge tools ([7557689](https://github.com/nikolai-vysotskyi/trace-mcp/commit/75576891539bbe1829e3e956aef149a71b64e1b0))
* **tools:** behavioural coverage for decision lifecycle tools ([fd102ae](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fd102ae6e5e5db5d26eccf7bf459c52960e3a202))
* **tools:** behavioural coverage for graph-traversal and analysis tools ([1ca1b1a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ca1b1aac92be45ee1b0ffa4750d07e600957756))
* **tools:** behavioural coverage for graph/relationship tools ([ac22e25](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ac22e25e901b1908b1f747476d5a55b3653a5383))
* **tools:** behavioural coverage for health and risk tools ([acfb835](https://github.com/nikolai-vysotskyi/trace-mcp/commit/acfb835bc33c6561b8ab7ab58e2a6cc31452ccfd))
* **tools:** behavioural coverage for history and coupling tools ([30b46fa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/30b46fa45ffdb3fe823895707e9a1a7bf1dbddb7))
* **tools:** behavioural coverage for index, embedding, and perf tools ([330a20c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/330a20ca509eb9209e39024d5422b822fc1e0e39))
* **tools:** behavioural coverage for ownership and tech-debt tools ([0ce20be](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0ce20bebfe9eeef6408a0c8451d18f6aa29b98d4))
* **tools:** behavioural coverage for quality and security tools ([9987aed](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9987aeda6763d5f79ca34d26598a8d3375839439))
* **tools:** behavioural coverage for quality/coverage tools ([d6d6d26](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d6d6d262ba350ef4e80136954286ca9a7a4ffae0))
* **tools:** behavioural coverage for refactoring tools ([347d107](https://github.com/nikolai-vysotskyi/trace-mcp/commit/347d107d8a2a6281ea5ae28bf01ac16149d7821a))
* **tools:** behavioural coverage for security and refactor tools ([68d6171](https://github.com/nikolai-vysotskyi/trace-mcp/commit/68d6171f2720b90dabb737408b2529a1316f386f))
* **tools:** behavioural coverage for session and analytics tools ([fdc0288](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fdc0288cfab3f4f58081cca9d765abd98546bf7b))
* **tools:** behavioural coverage for session and analytics tools ([a1d87ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a1d87baf7872fee4a38cd4c531f85fd2ee976401))
* **tools:** behavioural coverage for snapshot and maintenance tools ([eb949d7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eb949d7601c67505ce93dca9a19a31f872b2e1a9))
* **tools:** behavioural coverage for subproject and api-surface tools ([83c3300](https://github.com/nikolai-vysotskyi/trace-mcp/commit/83c3300d2f3247c01680f54afcebee8d9bf31e85))
* **tools:** behavioural coverage for trend and visualization tools ([2fcae49](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2fcae49ab675a52529ebe67b1b70581f5b2c6ee4))
* **tools:** behavioural coverage for workspace and architecture tools ([8496a18](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8496a186c6a706fd5901e05b4a9fff058f2eda29))
* **tools:** behavioural test coverage for search/get_outline/find_usages/get_change_impact/pin/query_decisions ([2379ed1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2379ed1f21292ea9ea3e4c536400d0d2b216666c))
* **tools:** skip discover_claude_sessions fixture on Windows ([6ea757e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6ea757e3f74b5d7a8519427ded12af84d2cf8891))

## [1.36.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.36.0...v1.36.1) (2026-05-14)


### Bug Fixes

* **daemon:** auto-recover from FK-violating stale data on initial index ([ea8b7a6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ea8b7a6b2df57ecf8884f974969710359ffdb33b))
* **daemon:** require explicit ?project= when multiple projects registered ([58e25a2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/58e25a2241e135a255acdf1cc96fa242d27b37b2))
* **indexer:** density-based binary detection in isBinaryBuffer ([df7b3d8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/df7b3d88d21ce5578abcca04bb3ccb2c38c33c02))
* **retrieval:** search_with_mode passes both `text` and `query` fields ([6abaea5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6abaea5b50bd7e23315887dddf6e75397008960b))
* **test:** bump cli-smoke DB-schema test timeout to 30s for Windows runners ([539ae09](https://github.com/nikolai-vysotskyi/trace-mcp/commit/539ae09db54d043abede98eace37f941ee10f4e5))
* **test:** skip eval-run smoke cases when project is not indexed ([039aced](https://github.com/nikolai-vysotskyi/trace-mcp/commit/039aced08809fbb472318be37508ee46669de6f8))
* **test:** widen XML perf guard threshold from 500ms to 1500ms ([ddb5d84](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ddb5d842a8ac104ab989376c76c6fb3dd27999ec))


### Documentation

* release 1.36.0 consistency fixes ([a604678](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a60467820b8a9b013b6b299d5d45ef5646f5b19a))
* **tools:** align check_claudemd_drift return shape with auditConfig ([af2f7e4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/af2f7e4ed87b66541355908bb31e134eace3e32d))


### Tests

* **db:** pin ranking_pins/pass_cache in fresh-DB schema guard ([10b8e82](https://github.com/nikolai-vysotskyi/trace-mcp/commit/10b8e82a9847e1c3856921a8e10b33fca0ce2f6a))
* **integration:** smoke-test eval CLI list/run/baseline ([ab5bebf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ab5bebf3fd648fd7faf35408676f7979998aa44b))
* **smoke:** MCP-tools end-to-end smoke script for new session tools ([3a362d8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3a362d8727b882b3ceea4f77e329485be68c6fe3))

## [1.36.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.35.1...v1.36.0) (2026-05-13)


### Features

* **app:** insights tab surfacing drift, pagerank, and risk hotspots ([b080e2d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b080e2ddc0851ba1db3a6f0e388e99ae61a4a543))
* **app:** notebook scratchpad tab for ad-hoc tool queries ([7eedb15](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7eedb157ced0538b2f7c80dad03501128e62a6ad))
* **daemon:** pipeline-lifecycle SSE events + Electron consumer ([dcff9f3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dcff9f398929ab41250092736f22d09593805903))
* **eval:** code-intelligence benchmark harness with CLI subcommand ([64bca2a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/64bca2af80a14b7f21000a32bf862813eaf08408))
* **memory:** remember_decision MCP tool for live agent writes ([11fd07c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/11fd07cd07de353e14349dcad6a5795dad5c7fff))
* **pipeline:** composable Task DAG with idempotency keys ([c33a4ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c33a4ba4ebe71c6afe1b5e51a3a4d7ff79e0a4c0))
* **pipeline:** persisted task-cache via SQLite pass_cache table ([266bbfd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/266bbfdd4aaeb0f04023f592f704ae1ff87a1ec3))
* **presets:** decision-memory quartet on minimal + standard ([f384672](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f384672c6f21632cc2a61605deda0c5c315eb64d))
* **quality:** CLAUDE.md drift detection + check_claudemd_drift tool ([faf5d07](https://github.com/nikolai-vysotskyi/trace-mcp/commit/faf5d07b782c09bb8a2ec59b16103fd69fa62de1))
* **retrieval:** BaseRetriever protocol foundation with 2 adapters ([d0d9f0c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d0d9f0cef22f157555ed4c72f0a7eb8665a89999))
* **retrieval:** emit routing telemetry from feeling_lucky retriever ([e79b5bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e79b5bfb189c82f5f80b0b03b448e711ec077f23))
* **retrieval:** graph_completion retriever — vector hit + 1-hop expansion ([3fcaab1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3fcaab11ac252bf43ea50e8485851d9993e467fe))
* **retrieval:** named search-mode taxonomy + search_with_mode MCP tool ([a8250e1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a8250e11722ba7d51f7abea8ae03d0e57bb4160f))
* **scoring:** ranking pins — user-supplied importance weights for PageRank ([704d66c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/704d66cd4fc615f14e13684a23bf352a01fee1d3))
* **telemetry:** observability bridge with OTLP and Langfuse sinks ([bae0fb2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bae0fb2bd5c504c12c71f0d6bc63f4449d34e6e7))


### Bug Fixes

* **ci:** normalize CRLF in DaemonEvent union guardrail for Windows runners ([71815ce](https://github.com/nikolai-vysotskyi/trace-mcp/commit/71815ce49f06044431836cf671dd3de66ee1138e))
* **ci:** unbreak notebook test under frozen-lockfile + register project before eval indexing ([7522bc8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7522bc8682cd3a2b8371c2bf8be3bd82dc6cb270))
* **telemetry:** wire observability bridge into server bootstrap + ship local OTLP recipe ([e03d75b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e03d75b34c46d8ee109145e530660824e9e3ac0f))


### Performance

* **indexer:** Phase 4+5+7 — incremental edges, cold-start, telemetry ([8a1ed45](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8a1ed45179c3968fb9e41d74be341911989fb4bf))


### Refactoring

* **indexer:** migrate 3 pipeline passes onto Task DAG ([c4a6afb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c4a6afbf606ba0ab6a3c71329a4cd44746a18ca7))
* **retrieval:** migrate search MCP tool onto BaseRetriever ([61b9663](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61b9663013a5dff30f91f88e131c944058b01c2e))
* **retrieval:** migrate search_text, search_bundles, search_sessions onto BaseRetriever ([8da5ab9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8da5ab9c5805374daeb89952c18005582f5160f5))


### Tests

* **daemon:** pipeline-lifecycle SSE integration test + drift firewall ([0976c38](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0976c3823d517a1487bd9fcee4496ec608512456))
* **quality:** cover dead_skill_ref and dead_command_ref drift categories ([e46d0a8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e46d0a8c7d66c82db75e75039a13ee26e29e689b))


### CI/CD

* **eval:** baseline-regression check + GitHub workflow ([d902af6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d902af6f0e4cd658ce601d745a257234c16fea74))

## [1.35.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.35.0...v1.35.1) (2026-05-11)


### Bug Fixes

* **daemon:** normalize reindex paths to POSIX so Windows tests + cross-path dedup work ([7f61983](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7f61983a59a2df3fa36905820c3d1fe2a032eb14))


### Performance

* **indexer:** daemon-first reindex, AI-call coalescing, shared/warm worker pool, content-hash gate ([dfd8e4f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dfd8e4f62552971248919f28f876d610605f4dac))

## [1.35.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.34.2...v1.35.0) (2026-05-10)


### Features

* **app:** four new tabs — Activity, Memory, Ask v2, Dashboard ([acdd9a5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/acdd9a55523e7aeb4cd33144aa86e530249521c7))
* **app:** four tabs v2 — stats, write actions, slash-commands, real metrics ([42857d1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/42857d1356fca8a1828b40d2c038b3137a8d1594))
* **memory:** lifecycle hooks, branch-aware decisions, stats modal, filter bar, recall harness ([62d010a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/62d010aed298c3c79f1c19a90e8c6e6334f64145))
* **memory:** tiered retrieval modes + decision confidence/review queue ([eb58bc0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eb58bc039cc487249126a5eb621d1c0e06fa4651))


### Bug Fixes

* **server:** keep stdin in Buffer mode — setEncoding crashes MCP SDK ([bbfb7bb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bbfb7bb106ffd2d116ff636c701869165e4c980c))

## [1.34.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.34.1...v1.34.2) (2026-05-10)


### Bug Fixes

* **ci:** pin npm publish back to npx npm@11 — pnpm provenance flow broken ([a052a62](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a052a625c4b22f81258e2b9dce6fb138709ceca0))

## [1.34.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.34.0...v1.34.1) (2026-05-10)


### Bug Fixes

* **release:** sync Claude Code plugin manifests with package.json on bump ([404c4bd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/404c4bddce2d28512acc5cc2bb28e17ea019bbd3))

## [1.34.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.33.0...v1.34.0) (2026-05-10)


### Features

* **ai:** classified provider errors + retry helper with exp backoff ([9d0f513](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9d0f513cf6dbdd455b9a1609e4be85acf663cece))
* **ai:** consent gate for outbound LLM provider traffic ([6ec8630](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6ec8630923daa708f6cd379cb19984d4b52819a6))
* **ai:** detect local LLM endpoints (Ollama / LM Studio / llama.cpp) ([be6075e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/be6075e1a9f3e2102ae5e4308c0fd8407f1754c2))
* **ai:** one-shot stderr warning before cloud-bound embeddings ([2753856](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2753856e498a6f0614983e5e4c649459ae3ced49))
* **ai:** per-provider quota / auth circuit-breaker ([c82fea1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c82fea15ac9df09cadade72870fb1a1c4dfd5250))
* **ai:** stamp embedding provider on the index, refuse cross-provider mix ([1ee2a11](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ee2a11910f6441cc1700c87c82b92ec4382681b))
* **ai:** tier-router helper + tier-separated default models ([d0e2848](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d0e28486bebb7ef9a04d93748dfbf862d006c618))
* **analysis:** rank cross-community edges by surprise score ([9c184f5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9c184f50c15b52112f6da728d5401e3e2b6410c4))
* **communities:** seed Leiden PRNG so community IDs are deterministic ([8dff326](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8dff3263cde7cc12fd68deb69da44205b5db953b))
* **communities:** split low-cohesion mega-clusters in a second Leiden pass ([3fa7078](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3fa7078db59ddc63cf27b0af4994a65a3cd46387))
* **config:** add TRACE_MCP_DATA_DIR + TRACE_MCP_REPO_ROOT env overrides ([f326a81](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f326a81494e1f6f093b6c70ca3aa77fbef33e1a9))
* **daemon:** add stdio handshake watchdog ([f0d82ea](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f0d82eae0160dfc6c05dfd2c9942977a1fafd554))
* **daemon:** proxy-backend routes worktree paths to canonical indexed repo ([2b22c11](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2b22c116af0084a754f330b28ea53ce27dedc876))
* **db:** verify_index + repair_index MCP tools ([f66fe32](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f66fe325df16a2e66eda14faf8571743148702c2))
* **dead-code:** drop framework entry points from the candidate set ([25a7825](https://github.com/nikolai-vysotskyi/trace-mcp/commit/25a78253d78d856624f93eac3e13072a9feedd37))
* **dead-code:** seed reachability with package.json#exports entries ([da7c69d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/da7c69df37a7c80cacf0a1b7f08b54c73120ab14))
* **find_usages:** drop text_matched edges into ambiguously-named targets ([1407af2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1407af2fd4f6ebdef94f4ee9d116ad53602d709f))
* **graph:** add float edge confidence on top of resolution_tier ([92d7190](https://github.com/nikolai-vysotskyi/trace-mcp/commit/92d7190d35245975cd34d229d213d8dd9da1e78d))
* **hooks:** guard v0.9 — block bare directory walks + .md doc-tour hint ([45a9be2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/45a9be29a1d09bfc8d63a05926bcf1a570cd7d23))
* **impact,refs:** surface resolution_tier on find_usages and get_change_impact ([4eff222](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4eff2228df9631864c72c6eb32f67e223d9c0a15))
* **indexer:** add postprocess level knob (full / minimal / none) ([cab7e90](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cab7e90aeb961122714fff9c3ea14b73c8c95865))
* **indexer:** detect file renames by content hash and skip re-extraction ([46ca974](https://github.com/nikolai-vysotskyi/trace-mcp/commit/46ca974e33449289aec020c37bcacd395002b111))
* **indexer:** force-include files declared as package.json entry points ([83cada2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/83cada2342e0683df8453ee8554031cfa5e08fb4))
* **indexer:** per-target PID-guard for reindex / embed_repo ([656efe4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/656efe4286c42930db1c60c72288088cbdfdf42f))
* **indexer:** warn when a full reindex shrinks the graph by more than half ([eb43ee9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eb43ee94c66a0a785bea17b7aabc50434ad1f63e))
* **insights:** add generate_insights_report MCP tool ([50a4820](https://github.com/nikolai-vysotskyi/trace-mcp/commit/50a48206238d5a2f48849ee28ccb8b61a0efe984))
* **memory:** canonicalise decision file_path to repo-relative on store + query ([8d4cdfd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8d4cdfdfca72a524e9f1739669f3d0bdd083b07b))
* **memory:** CorpusBuilder — materialise corpora via packContext ([5e34f59](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5e34f59e7af4a9019d6813eb2d76a7d34bdbc5ab))
* **memory:** CorpusStore — persistent code-context corpora on disk ([6425e26](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6425e264e1cd546ca0d95b630479046503f78574))
* **memory:** privacy filter for mine_sessions strips internal payloads ([1134509](https://github.com/nikolai-vysotskyi/trace-mcp/commit/11345095262761a9f2a1cee0fb0fa8b971486e43))
* **memory:** worktree adoption — mine_sessions files decisions under parent ([9d9b836](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9d9b836139d993a299334b8a581a1f6ee1c83e82))
* **perf:** cooperative yield from heavy CPU loops to keep stdio responsive ([6f40b78](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6f40b7823fba7be84d1f6cfdc9242e10053fd9b4))
* **plugin-api:** support async extractNodes in framework plugins ([1b6095e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1b6095ea00a9d89845aeec80f62e3b0c2fa2424f))
* **plugin:** add Claude Code plugin manifest for one-step install ([b1f3719](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b1f37190e257152ebeae56d0b309ad0320f27383))
* **plugins:** add class-validator, passport, react-table; expand NestJS WS ([50c17ec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/50c17ec5db7fa6fda0d1802146892015a445e2fa))
* **plugins:** add Kafka producer/consumer indexer (Spring, kafkajs, Python) ([6c80def](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6c80defbf79a6689e4d0cd6ca37803c651aa5e4c))
* **plugins:** index .luau (Roblox Lua) and .qmd (Quarto) files ([ccc9c2d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ccc9c2d143a4a8e8f90b2c801aee17c7fc1c65fc))
* **plugins:** index extensionless scripts via #! shebang fallback ([39abbfd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/39abbfdfc2b843568fe6e37773b8d0fdf65cd186))
* **registry:** add git-worktree probe primitives ([a7d489c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a7d489c346f0afb6cb56707caf79839c4d4d70da))
* **registry:** worktree-aware project resolution ([9f4bda3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9f4bda33b8c9297d308ef8aa9f3d252c4ea3c48d))
* **security:** add SSRF guard utility for outbound fetches ([c8204c5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c8204c57044fb0ff8ef4414fa79817843faaba59))
* **security:** add wall-clock budget to searchText regex iteration ([b651b90](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b651b90d79022fef9d3f0b0a64e83236772ce7b7))
* **security:** extend git env hardening to predictive + impact paths ([848c23a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/848c23a7cecc98e2eba98811fee7fb787658650f))
* **security:** harden git env in workspace-spawned commands ([124bdd0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/124bdd04c900aca0eadb0f0d3aa23e8f6eed28e6))
* **server:** expose project state through six MCP resources ([59b4267](https://github.com/nikolai-vysotskyi/trace-mcp/commit/59b426716da1d9b684619a598e8e0f46dbf8a24f))
* **server:** sanitize MCP tool output against prompt injection ([4331183](https://github.com/nikolai-vysotskyi/trace-mcp/commit/433118357a2325ad2cc7df5d892db38b252f3cfe))
* **server:** UTF-8 + stdout-guard hardening for the MCP stdio transport ([2fa4a4d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2fa4a4ded4256a0ed62a9373df459a13ba5670b0))
* **session:** Codex CLI session provider for mine_sessions / discover ([207152d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/207152d2ed6fa6557557f302dcb84185abf3a1fe))
* **shared:** centralised path accessors + invariant test ([3a32cc8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3a32cc823d04bb8214d86f08dbf63535d7d520af))
* **spring:** enrich @Autowired/constructor metadata with call-site hints ([469534e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/469534e0574113f78bae5d64839db76e570da38c))
* **ssrf-guard:** add allowPrivateNetworks opt-in for local LLM endpoints ([46ac4d3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/46ac4d36076b00ab5f36ca2b993605adf5b7106a))
* **subproject:** add a remote repo as a subproject in one shot via git_url ([dd440bc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dd440bc5abbe46957675b2cdadde21062746a40c))
* **tools:** add detail_level=minimal knob on search/get_outline/find_usages ([b5af6ef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b5af6ef5c2b353bbe95ffaecdef78e321968411f))
* **tools:** add get_minimal_context — single-call orientation entrypoint ([b02a2a1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b02a2a1fc72aa2548c692d6f26d0d8971dd4f817))
* **tools:** add get_suggested_questions for ranked review checklists ([c6090c3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c6090c3804f55466feb6938e0c8935b0e7ef794e))
* **tools:** add named graph snapshots + diff for tracking evolution ([22d6e4b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/22d6e4b7ab10685eb78f5c688b4a4f2a71667c56))
* **tools:** add traverse_graph BFS walker with token budget ([7485574](https://github.com/nikolai-vysotskyi/trace-mcp/commit/748557457cb54c141b436e5b3a1ac76410ced98e))
* **tools:** coerce empty-string MCP args to undefined for filter fields ([0357e7c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0357e7ce25f09cdad1017b7ce179282b22fe3d3f))
* **tools:** export the dependency graph as GraphML / Cypher / Obsidian ([6c72ff1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6c72ff1dc029eb5628cf5f885d3da55808bf9cdc))
* **tools:** Knowledge Agent MCP surface — build/list/query/delete corpus ([3401e9d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3401e9d198016db50b13e4cee96bb81d209b6409))
* **topology:** cross-project topic tunnels via entity registry ([7360aee](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7360aee3050e434bf759ffa60ea29220f185b6d6))
* **utils:** atomicWriteJson helper + apply at all state-file write sites ([470b83f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/470b83fdb826727f058221dde86638a0dda18ba5))
* **viz:** community-aggregation helper for large-graph visualisation ([0c36fb3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0c36fb3a26c9390e2b39fead4232a329133799f9))
* **vscode-extension:** on-save reindex extension ([45d53a1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/45d53a137699e29541ac42ed689b4ab1c0164b69))


### Bug Fixes

* **ai:** classify caller-driven aborts in withRetry as kind=aborted ([c01a854](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c01a854f650ed762b3f815c12195b7d68e325dfe))
* **app:** declare @types/node directly so tsc -p tsconfig.main.json works under pnpm ([49e5502](https://github.com/nikolai-vysotskyi/trace-mcp/commit/49e5502bb7eb2de94b20c5a760d6872aedb0c1a5))
* **config:** atomic write for global JSONC config mutations ([d22be14](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d22be14a99fc6abd9aeff78d8e56d549323a858d))
* **daemon:** atomic write for PID file + atomic stale-lock takeover ([5c0f5ea](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5c0f5ea70fca706a7c6719c962add53ec37e3bce))
* **daemon:** identity-token PID-reuse guard for daemon lifecycle ([e948a22](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e948a229dfc61efde3191aaa6b12a215797c7adb))
* **db:** bound WAL growth and add periodic checkpoint to long-lived stores ([68b4157](https://github.com/nikolai-vysotskyi/trace-mcp/commit/68b41575528b05f51c487103fe04a5ba269fac1e))
* **db:** centralise symbols_fts DDL so repair-fts cannot drift from schema ([89a1bea](https://github.com/nikolai-vysotskyi/trace-mcp/commit/89a1beab080f46e32c001b8022d862ffd6283dfe))
* **dead-code:** never flag symbols that have any incoming call/ref edge ([a3fc0e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a3fc0e0b805b134ce03b69325dd11d2cb13e3370))
* **git-worktree:** use fs.realpathSync.native for Win32 8.3-shortname normalisation ([b3d5f41](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b3d5f41076600684920ea5c0a8192e65d0faaf46))
* **indexer:** normalize relTarget separators when resolving import edges ([fc28bfb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fc28bfbcab057ffc5c480cdc12443b52e51594fe))
* **indexer:** parse tsconfig.json as JSONC to recover path aliases ([3ac3cd9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3ac3cd94c08d1e44e629c344755a2aa959da3677))
* **indexer:** serialize register_edit and reindex through the same lock ([918921f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/918921f5233faff5077db40aa35a18b84c4cb672))
* **indexer:** suppress shrinkWarning + execFileSync for git rev-parse ([5f0cbf1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5f0cbf1a742c55fc7de61cff2964450ad867db32))
* **navigation:** explicit degradation signal for semantic search without AI ([6bbeb53](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6bbeb53a21ee5354582208ec329c0877bf3b2059))
* pin zod to 4.3.6 via pnpm.overrides (4.4.x breaks dist/cli.js) ([4cf12c7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4cf12c76d24bd90ab5ccccf050948b29d1fbf4a0))
* **refactoring:** normalize result paths to forward slashes for cross-platform consistency ([848f668](https://github.com/nikolai-vysotskyi/trace-mcp/commit/848f6680fa5ffeb5efb49f3be442be56790f6afe))
* **resolver:** parse tsconfig.json as JSONC, not strict JSON ([5cadb07](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5cadb07814b17904b4c06753ea0d1c29cb29eeed))
* **security:** chmod 0700 on ~/.trace-mcp and 0600 on local SQLite stores ([0c0fac2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0c0fac263a630ac0b23d0ff1be1eb6d423b263b9))
* **security:** keep hook source lookup inside the trace-mcp install tree ([32bcda7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/32bcda76043c84aff801a759f233e97d92cd136b))
* **security:** validate git refs and replace shell-mode execSync with execFileSync ([3b08ed0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3b08ed0d4094f25914911274fc5437faa7cc7c00))
* **security:** validate git_ref before passing to git --branch in subproject_add_repo ([e197184](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e197184d85f8a6e35bd44c7409b350a22e98f512))
* **security:** wire SSRF guard into AI provider fetches and git-clone path ([b7fb294](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b7fb294748c04144b2ac0e0c7fa35680bfdb2af9))
* **ssrf-guard:** import LookupAddress from node:dns instead of node:dns/promises ([8f1e184](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8f1e184ecd2bbc8371ef93a4ec981530186a340f))


### Documentation

* bump headline figures to 99% and refresh hero copy ([43d12e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/43d12e096f4f86fb86763a0f84e0630747cd4dee))
* **confidence:** clarify trigger contract + add SQL-level regression tests ([f4a85bd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f4a85bd0ce5c12bebf9050eabcb0a7708635d8eb))
* **readme:** add CI status badge ([33169e4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/33169e445fcd39fbdefb6e9566c5b437d8b9bad5))
* update contributor instructions for pnpm ([3a4344a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3a4344a5c9f5c6f04e1084362755f44f4e367d4d))


### Tests

* **ci:** align test-side realpath with production native binding ([782097b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/782097bbd0146626fc60cc05134d8d556c7bb328))
* **ci:** fix 7 baseline Windows-only failures (path separators + 8.3 names) ([82ab7eb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/82ab7eb9bb58df917e588a40e0fdfe7096c7c30c))
* cover remaining Windows-runner failures from cross-platform CI ([086aedd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/086aedd4054908aff66b2fa96014bb2e93c5beae))
* cover the long-tail Windows-runner failures from cross-platform CI ([6075495](https://github.com/nikolai-vysotskyi/trace-mcp/commit/60754951f75e0bd2e4c4d60fa05aaf4ec714bfc9))
* **docs:** regression test for numeric README claims + sync stale numbers ([1b18d46](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1b18d46fecf7b363a54f25aacd45b37c1101a42a))
* **impact,refs:** cover resolution_tier surfacing ([4915eb1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4915eb19208a4ccf11e220f3c2a3394564d56ab3))
* **markdown:** include .qmd in supportedExtensions assertion ([a38c18a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a38c18a796bad25fdc854e2bf6316193e6b4fe5d))
* **perf:** de-flake batched-inserts benchmark across CI runners ([c9f8988](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c9f8988091fa7150db51e23e76ee2d37438827d8))
* **perf:** re-deflake batched-inserts benchmark — loosen to regression guard ([d524b1e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d524b1ef295860ea2d164f801b6e3d8a8a4fc482))
* **perf:** skip batched-inserts benchmark on Windows runner ([a434dcf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a434dcfcfa4d20434a684965e280fd5938d6c078))
* **security:** cover hook-source path-traversal validators ([d414327](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d4143273c07e910d6a0270f1925b8e405be75875))
* **security:** make path expectations Windows-safe ([61e3345](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61e33451775e4e76056bd8fbb2ae5a4ed40081b2))


### Chores

* **app:** migrate packages/app from npm to pnpm ([3d75a19](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3d75a19e14f92b6bb960e667bd8075b8d23a7d37))
* migrate root package manager from npm to pnpm ([d36486c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d36486c2e3355f40554dbd67bc2bb36a96c9d50f))
* **security:** drop unused restrictHomeDirPerms helper ([4b5b827](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4b5b827441bd651a821d4e1433bc13015e7260de))
* **wip:** version-stamp init helper + daemon session change ([cd45cde](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cd45cde8400d091713ad39a411866b9dc5311faf))


### CI/CD

* also run on push to master ([c2382ca](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c2382ca0913a7dccee7647bdab8240c34321f5aa))
* switch CI install path to pnpm + add cross-platform test matrix ([6bc2f7a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6bc2f7aa76a6ba5004ca9bc13e18830f89bbf4e8))

## [1.33.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.7...v1.33.0) (2026-04-30)


### Features

* **app:** Sprint 1B — per-project guard mode toggle on the project list ([20c1fd4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/20c1fd4e54482b11815c69f295da521b33224eb3))
* **app:** Sprint 2 — onboarding, coach default, version contract, uninstall ([39b262f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/39b262f8af00a01be164e2c28b7f479c29ced796))
* **guard:** add manual bypass + auto-degradation for unresponsive MCP ([4709803](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4709803072e457a2e14e9731158358ecd65a53eb))
* **guard:** Sprint 1A — rich status sentinel + hook v0.8 (modes + stall detection) ([c857cab](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c857cab2c698025b7cb1c70d5d9a6b28978696dd))
* **guard:** v0.9 — doc-tour hint for .md reads in source dirs + deny ls on source paths ([465dd50](https://github.com/nikolai-vysotskyi/trace-mcp/commit/465dd50a9b9f15ad7fca5922b8165855fa18c7a4))
* **plugins:** add Anthropic (Python + npm) and react-router coverage ([104c47a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/104c47a2eff889658b5c25b2a2b04a9bacc1d987))
* **retrieval:** output-token efficiency phases 1-5 ([3120c6a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3120c6a41b483f207a92655104775d55ee39dd8d))


### Bug Fixes

* **app:** open Request links in default browser via shell.openExternal ([dad18cf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dad18cf28abe3506b2e03cef7a96255ffaeca31b))
* **app:** show "Restart to install" after npm-install update ([ed82585](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ed825850e5984dd1b3f237b06e972f66baa45bb0))
* **guard:** close retry-bypass loophole, add heartbeat fallback ([9741210](https://github.com/nikolai-vysotskyi/trace-mcp/commit/974121098ada837c3618079628189f97bffc650f))


### Documentation

* **landing:** tighten hero CTA, add trust line, reword metrics ([decdf45](https://github.com/nikolai-vysotskyi/trace-mcp/commit/decdf4563ad547999fb7f0b05a6a35aff0ae922a))


### Chores

* **guard:** cross-platform hook resolution + Sprint 2 cleanups ([937621a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/937621a7c7515600a5d4644419dd76eb11b301ef))

## [1.32.7](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.6...v1.32.7) (2026-04-29)


### Features

* **app:** MCP Clients screen — show "Update" when on-disk entry drifted ([eab5423](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eab5423bc932c5b88f3334ef936dd715dae45bec))
* **init:** generic per-client config status + `trace-mcp clients status` ([ecee7e7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ecee7e7987cf832f5d2a24e502c2622dd29becc2))


### Bug Fixes

* **daemon:** keep registered projects on graceful shutdown ([fb40795](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fb40795e9ef15ff016a03847f8ec18d91e61b36c))
* **landing:** tighten hero, lift red CTA above the fold, move metrics to proof strip ([6255652](https://github.com/nikolai-vysotskyi/trace-mcp/commit/62556521a4a34cbfff6831c376fef7bdaaea8816))
* **mcp:** keep trace-mcp tools eager in Claude Code via alwaysLoad ([1e739ce](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1e739ce555c94fe51ffb46eabe5909c4e4603fb1))


### Chores

* release 1.32.7 ([128a6cc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/128a6cc08d82309a3d533fb8012fd24beca7d494))

## [1.32.6](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.5...v1.32.6) (2026-04-29)


### Bug Fixes

* **app:** augment PATH + prefer existing node version for in-app updates ([5452d11](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5452d11d4f872316feb19749894918149e189957))

## [1.32.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.4...v1.32.5) (2026-04-28)


### Bug Fixes

* **daemon:** auto-register project on first MCP connect ([ac112c6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ac112c6a4b563590c39e254bda9367f76dad46c8))

## [1.32.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.3...v1.32.4) (2026-04-28)


### Bug Fixes

* **cli:** import detectGuardHook + detectProject + missing types in init ([e293a78](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e293a780624362909d643029a1448acf49a1353f))

## [1.32.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.2...v1.32.3) (2026-04-28)


### Bug Fixes

* **cli:** import detectMcpClients in init command ([cd4871f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cd4871f31d4ea61ca787e8872305acf7ac147a04))
* **install:** drop simple-git-hooks from postinstall ([c3286d7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c3286d7e588fe0a3c47b5dac81b03b7cede21131))

## [1.32.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.1...v1.32.2) (2026-04-28)


### Bug Fixes

* **app:** coalesce remaining res.statusCode → number ?? 0 ([#116](https://github.com/nikolai-vysotskyi/trace-mcp/issues/116)) ([3482f8f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3482f8f21d350382a072c3b44a97588c5706e748))

## [1.32.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.0...v1.32.1) (2026-04-28)


### Bug Fixes

* **app:** drop duplicate resolveNpmBin/Root + tighten statusCode types ([#115](https://github.com/nikolai-vysotskyi/trace-mcp/issues/115)) ([627ec43](https://github.com/nikolai-vysotskyi/trace-mcp/commit/627ec4395319a4c4b747e7c81de768580760e339))


### Chores

* **landing:** bump 'up to 97%' to 'up to 99%' in remaining copy ([0fc5534](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0fc5534cfa80cb4473e27c51e103ddf32dbce47a))

## [1.32.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.31.0...v1.32.0) (2026-04-28)


### Features

* **docs:** full SEO meta, favicon set from electron tray icon, PWA manifest ([7217e11](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7217e11feab6d919e2335375da86490d030188c3))
* **homepage:** mobile above-the-fold CTA, trust badges, red primary CTA ([8b6a897](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8b6a89787f8b3bfa0e820d7d1fec045d3fd8ff8a))
* **init:** add AMP, Warp, Factory Droid MCP clients ([#111](https://github.com/nikolai-vysotskyi/trace-mcp/issues/111)) ([9235afb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9235afb41e29b3cb3f3486cc58ffabdbcfa11223))
* recomputation narrative + knowledge-graph markdown indexing ([#112](https://github.com/nikolai-vysotskyi/trace-mcp/issues/112)) ([b68f61f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b68f61fd15c82d988a26e73099adbc6854852257))


### Bug Fixes

* **homepage:** eliminate horizontal scroll on mobile ([c97eab0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c97eab06468c84281829b15a10d50dc537cf4d05))
* **landing:** collapse hero to single column on mobile ([af7bb71](https://github.com/nikolai-vysotskyi/trace-mcp/commit/af7bb71c988bc9f75c67a63b5cec5ead45d78785))
* **landing:** mobile hero — make 40–50% the lead metric with a value-prop label ([589393f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/589393fea609fddeda0b73c4efca51f78b7a661e))
* **landing:** mobile hero — promote 99% as the single hero metric ([3a6475a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3a6475a82b375be56ccde51b9471beafd1594d2e))
* **landing:** mobile overflow on use cases grid and install terminal ([bb588cd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bb588cdaf1d2660d8940805e260fd7aa3b710c49))
* **landing:** split 'up to' off the giant Doto numeral on mobile ([fbce556](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fbce556441dd63fc87e5ceb6854bfa7d1f34722e))
* **merge:** drop duplicate imports + restore missing path import ([#113](https://github.com/nikolai-vysotskyi/trace-mcp/issues/113)) ([d06e42d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d06e42d26d187e1571b06adc0a67010087ed4a8c))


### Documentation

* **homepage:** restructure around "code intelligence layer for AI agents" positioning ([a99118d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a99118d662ecc3aa49a6c020bd99076c4965390e))
* **landing:** drop pilot CTAs, send users straight to install/repo ([6c44b7c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6c44b7c7daaa6ede4420e58f03346bd977966b42))
* **positioning:** reframe as optimization layer for LLM apps, honest token numbers ([3b552c3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3b552c3506db658c932b07604e4f185c118645dd))
* **readme:** add Star History chart ([614cf32](https://github.com/nikolai-vysotskyi/trace-mcp/commit/614cf32d6819c7ba26cbd20ffd0c3fdd8fc020d7))


### Chores

* **ci:** hold off on electron major bumps ([861c75a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/861c75ac8f7808d9c413c0c1d58cfb66335e790f))
* **ci:** hold off on vite + plugin-react major bumps in app ([02cafac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/02cafacb9ea67d8e2911c8b8dc7d7532bbad9442))
* **ci:** hold off on web-tree-sitter minor/major bumps ([45b303f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/45b303f1d6a4929e1e9c745d508cbaa7d562ae4e))
* **ci:** ignore major bumps for @types/node ([20702a3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/20702a3141db964a46a8f3b632da17ae7b85858a))
* **ci:** include chore/ci/build in release-please changelog ([135e1ce](https://github.com/nikolai-vysotskyi/trace-mcp/commit/135e1ce8d8122c77c155fb9fbb66eb7eabc37a38))
* **deps:** bump typescript to 6.0.3 (root + app) ([#103](https://github.com/nikolai-vysotskyi/trace-mcp/issues/103)) ([836d4cf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/836d4cfaae6cad0e081fd646a4f16e550ebfb480))
* **deps:** bump zod from 3.24 to 4.3.6 ([#105](https://github.com/nikolai-vysotskyi/trace-mcp/issues/105)) ([3e774ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3e774acd3971861429d8b1d6a123071fc013f73b))
* **security:** bump electron to 41.3.0, drop stale pnpm-lock ([#109](https://github.com/nikolai-vysotskyi/trace-mcp/issues/109)) ([4b45f87](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4b45f87a9e4e555f643f65a555516b7ef66af59a))
* **tooling:** introduce Biome as formatter (root) ([#110](https://github.com/nikolai-vysotskyi/trace-mcp/issues/110)) ([7149fa5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7149fa5886dd370ef13330ac1fea66128590e502))


### CI/CD

* **release:** sign Electron release artifacts with SLSA provenance ([#108](https://github.com/nikolai-vysotskyi/trace-mcp/issues/108)) ([1ac88ec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ac88ec15d7973346b2c9cc5e16367ee3290ea0a))
* **security:** add CodeQL, Semgrep, OSSF Scorecard, Dependabot ([f252ce2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f252ce2dc656a1e75b6a3d6436f1832587872ba9))
* **security:** pin all GitHub Actions by SHA, add top-level read perms ([71253c0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/71253c0c538eb9c73f3c1f8d54415467ab7a8972))

## [1.31.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.30.0...v1.31.0) (2026-04-24)


### Features

* **init:** Hermes Agent as a supported MCP client ([a8a19ef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a8a19ef0e9e6ac39433d225f000cce8ffff22b32))
* **session-providers:** Hermes Agent session provider + SessionProvider interface ([b44edbc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b44edbc0756566f7f5cc7fba69b3fd4d91a3fa5f))


### Bug Fixes

* **updater:** skip auto-update in dev checkouts ([a439fb6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a439fb6fde700e2dd739f1f423b8232497d8d9e4))


### Refactoring

* **init:** extract shared md-block helper from claude-md.ts ([869f42f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/869f42f1cd25b072bf5f5b8a10720ec6ce37fa8e))


### Documentation

* **benchmark:** update with v1.30 results (92.8% reduction) ([15ea976](https://github.com/nikolai-vysotskyi/trace-mcp/commit/15ea976d75dfea258b0683cf3b562e963e77954e))

## [1.30.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.29.0...v1.30.0) (2026-04-23)


### Features

* **ai:** add Vertex AI and Voyage providers, retrieval task hint ([c566738](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c566738fc739dc5f023d13a5ee0ec957f12d3b11))
* **analysis:** symbol-level bottlenecks + Stress Test hotspots UI ([1ea7b7a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ea7b7a5f54d2a62c5b6607733ece0808aca4369))
* **plugins:** add aws-s3 / supabase / sortable, Laravel sub-plugins, expanded coverage ([9586790](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9586790c1f4280d7341bca07f20925959e70e663))


### Bug Fixes

* **code-smells:** skip markdown and other non-code files ([1199783](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1199783281822653615f164777ba98e71d1bb656))
* **darwin:** prime amfid for prebuilt native modules ([f78e838](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f78e838b15b2fdf6860f7c1422e14da5d7bbd965))


### Refactoring

* **plugin-api:** add PluginRegistry.createWithDefaults factory ([e8964ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e8964acae941d053406ad864a8731b49b29381ae))


### Documentation

* **plan:** session-providers implementation plan ([f6b4d0a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f6b4d0ae545fd173e75eee62f9924866ffd7550e))

## [1.29.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.28.0...v1.29.0) (2026-04-22)


### Features

* **analysis:** edge bottlenecks + app Quality tab + bottleneck graph overlay ([872d535](https://github.com/nikolai-vysotskyi/trace-mcp/commit/872d5357217910f2403432b36d36052fb7fcf75f))
* **plugins:** add ioredis, jose, nodemailer, redis-py, gunicorn, uvicorn plugins ([522c43c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/522c43c931f9c455f695098332e037087fc146d9))
* **plugins:** expand php-ecosystem coverage to 12 more packages ([d87e621](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d87e621868739397ac0aeafba48c2eed9c10aba1))
* **quality:** add debug-artifact smell, size/complexity antipatterns, AST clone detector ([c05ac2b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c05ac2b5a2ae365320dd590acb24d1be7fa2c1a3))
* **server:** add tools.agent_behavior config for discipline rules ([8984118](https://github.com/nikolai-vysotskyi/trace-mcp/commit/89841185d684f1320e8bd36ceebcf5911845ac80))
* **subproject:** cross-service endpoint literal scan + Nuxt/httpx/aiohttp/urllib ([21537e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/21537e0ec2c4819ecddca443935f55a4fb43437e))


### Bug Fixes

* **ai:** stamp embedding model+dim and reindex on mismatch ([2f2d923](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2f2d9237a43095f61bae9378c8233a518d71b7fe))
* **app:** harden pending-update lifecycle ([cd998d3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cd998d362b49c65351ebdcb5416262ea17336bcc))
* **env-indexer:** strip **/.env* patterns from fast-glob ignore list ([d057ffe](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d057ffe6cb78cd8437a4d2c96a6582f6d93372f6))
* **hooks:** exempt .env.example/.env.sample templates from guard ([217e9ec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/217e9eca95f0c9930a43a3812b1e28e41c968f91))


### Documentation

* add Max-tier agent behavior, app gallery, and refreshed comparisons ([10f29b7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/10f29b7041ec9d3c6aed4317b5db3580b2e819f3))

## [1.28.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.27.0...v1.28.0) (2026-04-21)


### Features

* **plugins:** add Python ecosystem integration plugins ([741b092](https://github.com/nikolai-vysotskyi/trace-mcp/commit/741b092910ed074a6add0a2a27696c30b649786e))


### Bug Fixes

* **indexer:** resolve asset imports and TS re-exports across the graph ([6f76025](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6f76025c8028347c3ce7329e7deb0be08028b131))


### Performance

* **app:** custom FPS overlay + disable halo to lift graph FPS ([3fa4038](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3fa4038cab5379608017bbbe0b1c1a936f499d17))
* **app:** re-enable GPU compositing for graph explorer ([6633456](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6633456805e9eddff7ea21fd90b52181d5ee4431))
* **app:** upgrade cosmos.gl to 3.0 beta and rework label placement ([601e069](https://github.com/nikolai-vysotskyi/trace-mcp/commit/601e0690ab94f328ee45ca0ba3bf98c3a62cb1a7))

## [1.27.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.26.0...v1.27.0) (2026-04-20)


### Features

* **app:** open selected graph node in installed IDE ([4ca5e22](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4ca5e22ff0dbe966c392f38e0a25712dff8e31c9))


### Bug Fixes

* **app:** robust Update button with scratch cleanup, --force, and visible errors ([9028793](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9028793c9a0eae2a5b5dc839403e08c765bb0d1f))
* **build:** bundle deps via createRequire to survive spaced install paths ([65e9f3f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/65e9f3f3f4c0ff622371c6d0de138b52038aa29f))
* **postinstall:** match new release asset naming (-arm64-mac.zip / -mac.zip) ([27200ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/27200bad183f1e425b4f6fa4f5c80ed7ce03412d))
* **updater:** pre-clean scratch dirs and back off on repeated failures ([b7a647c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b7a647c092450784013946f13e5110ad016cf70f))

## [1.26.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.25.0...v1.26.0) (2026-04-20)


### Features

* **ai:** per-capability gates and empty-string config hygiene ([ad7f5e8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ad7f5e857d6e1bbb2d0fde048cedf4e02a13dae7))
* **app:** Ollama control panel in Settings ([2e5d374](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2e5d37435ad62f892e45ea7018eb92f16e6b0076))
* **app:** tinted edge colors and camera-interaction lock in graph explorer ([7ca42db](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7ca42db50710837ce28d222da4795ed843c8b036))
* **init:** stable launcher shim for MCP registration ([1b6eb25](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1b6eb25ac1e8820afeb914c47e82747680425614))


### Bug Fixes

* **app:** capture streaming buffer before setState in AskTab ([558ebc7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/558ebc78235749b94332c45bc6714e9482512d5e))
* **daemon:** launchd bootstrap/kickstart + startup health wait ([c78115a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c78115a03b0722cdf7ac753e3e1c93e13d5d19f6))
* **db:** idempotent file upsert via ON CONFLICT ([1440d9f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1440d9fcc9f00edbd38d1fb3eaadbaf1c8688b53))
* **init:** drop stale {{tool_name}} template and clean up legacy hooks ([250d586](https://github.com/nikolai-vysotskyi/trace-mcp/commit/250d586d87606df03b7e403300d0b9df3c98d275))


### Documentation

* add dark-mode graph screenshot and refresh app images ([e3ab628](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e3ab6284bd6740edf1935736d191447db8812f61))


### Tests

* **launcher:** accept either probe failure on CI ([d83d14c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d83d14c16a671f02d77e738a206057558c5ba996))

## [1.25.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.24.0...v1.25.0) (2026-04-18)


### Features

* **app:** graph explorer expansion and renderer UI polish ([c763318](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c7633186e1dacacaa66d748f3290c01cbc8e54e5))
* **app:** hardened staged auto-update with SHA-256 + Gatekeeper ([757061a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/757061a8bba07f56acfdcc28671fe8dd0b6b19a7))
* **daemon:** unified lifecycle, idle auto-exit, and subdir→parent routing ([317a792](https://github.com/nikolai-vysotskyi/trace-mcp/commit/317a7923deea9b00cf274cc4e98a2e17b75d96c3))
* **indexer:** isolate workspaces in framework and file-projection edges ([1021f5b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1021f5b785215c9a0fe0c628e6caa8d93c37a5ab))
* **viz:** derive community labels from dominant path prefix ([b676c17](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b676c17bb30ce186ab2e7cdc041d2a8820cf0382))


### Performance

* **indexer:** parallel file extraction via worker pool ([a8f886d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a8f886df85c0503175f0c74c6cf3368d96d1d20f))


### Documentation

* README refresh, desktop app section, comparisons page ([a725773](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a725773699008e369b3350b83388d80ff458aa01))

## [1.24.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.23.1...v1.24.0) (2026-04-17)


### Features

* add landing page for trace-mcp.com ([a515c6c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a515c6c587c12388185d353d8c4899686fa88c0b))
* **ai:** track AI request activity + rename ollama default model ([259afe4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/259afe435d6972a8891fe4f676f306e709fac1b7))
* **app:** GPU-accelerated graph explorer (cosmos.gl) ([3ce00e2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3ce00e20b67dfc53e065cfabd7c5c10e417081d1))
* **blade:** extract script src asset references ([e250acc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e250acc5dee1192f4a7782e26f4344e639fc0126))
* **daemon:** unified stdio session with proxy⇄full auto-switching ([52d5392](https://github.com/nikolai-vysotskyi/trace-mcp/commit/52d5392125debfa64d3999a50437d3897cae59b2))
* **indexer:** phantom externals + file-level projection + TS call/type edges ([69ce68e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/69ce68ec4ce8b39c40b292f6896d1685ca2b46ce))
* js-viz (Chart.js/vue-chartjs/marked) + php-ecosystem (symfony-dom-crawler/google-apiclient/laravel-ai) plugins ([cb61078](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cb61078aa1e043aeed617fdf95001e9b19778baa))
* **landing:** add ASK/GET examples, cross-language edge diagram, FAQ, use cases ([a5418c5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a5418c5ce1753f2deb8a0f96ff9b33485692c0a8))
* **laravel:** medialibrary + eloquent-sortable + composer Package Discovery ([35cb8b8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/35cb8b8de6908945b86c10b16fb6efaebbb2f621))
* **nextjs:** file-based entry point edges for App/Pages Router + metadata ([deca9b4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/deca9b4f171e57ef39452d86c682df88dba7592c))
* Nuxt 3/4 entry points, custom prefix parsing, improved detection ([a475856](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a4758563a6f5459ee356e3d1c85ce7795284c667))
* **nuxt:** middleware/layout/plugin/route auto-registration edges ([8401327](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8401327377ecec6b9de6d649e7c5cc27378a17cf))
* PHP call graph resolver — symbol-level calls/heritage edges ([653818f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/653818f9af4d87d1ff2549bd14b0d3a07701370f))
* PHP property and constant access edge resolution ([8f4f66f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8f4f66f74d7828c5eefb6fc28c44bab0d28017a9))
* PHP type-aware call resolution + class references ([f114291](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f1142918651f39283f6737a9d325b0c113edeaf0))
* scan Blade templates for PHP function calls + workspace-aware resolution ([928fec1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/928fec19dbf9eae2f15c8e63f7d48f97411987db))
* structural member_of edges + class-fallback for unresolved methods ([6ff4e88](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6ff4e889801b9e27059e3bc96aad25375a38cef1))
* Vue dynamic component references via TS/JS/Vue content scanning ([fcb8112](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fcb8112097ea212f7738bcfb96e3c3df6eb3b0d0))
* **vue:** Laravel Nova + Blade component entry points, SSR marker ([33e5f55](https://github.com/nikolai-vysotskyi/trace-mcp/commit/33e5f559d7f617c33e951fef28aa58707b3661d6))


### Bug Fixes

* **db:** schema v20 backfills seed edge types on existing DBs ([a1a5e6f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a1a5e6fe4c258d539e6988a6309a291de81ae078))
* eliminate client call scanner false positives ([7248443](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7248443a1a6605c3415b80c946ab37fc65fb4035))
* **init:** detect running Claude Desktop to avoid config overwrite ([6d02023](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6d02023cee31762a642a7843a2bbc84c2ee4945c))
* **landing:** dynamic version from npm registry + terminal whitespace ([1b0911f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1b0911ff4397e3d365ff9f52d9732c658ade823a))
* **landing:** improve readability — body text uses primary, headings beefed up ([0470041](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0470041cd6268834848fa4069219264f7fadb28d))
* make dir argument optional in index command, default to cwd ([cd7ee1e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cd7ee1e485a4b5f8abeb2eec8687eaebce6dacd5))
* self-first endpoint matching for client calls ([227d59d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/227d59dabd75a814271a7869a5a1afbc963246e4))
* strict project_group isolation — ungrouped services no longer leak ([5d828ee](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5d828ee63e617b46525662cb8e6dcbb308331da3))
* workspace assignment on fast path + broader default include patterns ([65d7433](https://github.com/nikolai-vysotskyi/trace-mcp/commit/65d743375e1beb7a7010a55f6cedb65d0448d17c))
* workspace naming, parent DB route fallback, and client_calls FK migration ([42517e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/42517e0427f46245bf17a63d786bdc8d737ea8a3))


### Refactoring

* community labels show dominant dir, pack-context models/feature-scope use FTS ([a9d089e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a9d089e33ebfd2c4a9bb928781c8d0786c3cf472))
* redesign landing page in Nothing design system ([4f4bda1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4f4bda148c17b0d72dcb85f15d9da8d6f4998512))

## [1.23.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.23.0...v1.23.1) (2026-04-15)


### Bug Fixes

* **app:** remove unused trace-mcp runtime dependency ([7ac57c7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7ac57c7827b1d6358e80072cfeebc55be6c32629))

## [1.23.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.22.0...v1.23.0) (2026-04-15)


### Features

* add Anthropic, Gemini, and OpenAI-compatible AI providers ([960eb13](https://github.com/nikolai-vysotskyi/trace-mcp/commit/960eb1318ec897d7be4b98b22c9a3db0183daa16))
* add PHP import edge resolver for use statement resolution ([836d10a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/836d10a71ae2b379e25658f20093539a241f6b27))
* add service group management UI and API ([4646230](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4646230bf397476eae7072ab7c73a54c2465c973))
* **app:** add model-select and multiselect controls for AI settings ([25bb2bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/25bb2bf42084e9454bbc3e252ccfbfca442e4c80))


### Bug Fixes

* add workspace isolation to PHP import resolver ([5c8d9cf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5c8d9cf4cda00e68a45cfccc7e79f6f572b0bb05))
* isolate cross-service endpoint matching by project_group ([0630908](https://github.com/nikolai-vysotskyi/trace-mcp/commit/06309081423a49fc13673adbd1a49bbffd69d7ec))
* prevent topology contract duplication, false endpoints, and stale edges ([79f2ad1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/79f2ad1d7b229da9daf564c1794e3bd23d61a3b5))


### Tests

* add tests for topology fixes and PHP import resolver ([11a4ddb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/11a4ddbfe5c0dff5f5b9699bb03cdd788ee51803))

## [1.22.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.21.2...v1.22.0) (2026-04-15)


### Features

* add MCP ToolAnnotations to all tools for Glama TDQS scoring ([5be916b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5be916b2b648f03cd4fc92ea2d83a065dc84bfbc))
* add security context export for MCP server analysis ([7b685c4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7b685c49e48a2caa106c5af0b0138dda6513eba9))
* add stdio proxy mode and lifecycle management ([722579e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/722579e1f96f6bfc4e0ecea00884102bdd365b0d))
* redesign AskTab with provider setup CTA and settings deep-linking ([d55226e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d55226ee3610cdd46683ff00a7e0ebd6687f7131))


### Bug Fixes

* add pre-flight check in GraphExplorer to prevent raw error display ([eb1e06b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eb1e06b633799c3f8b8329c42a78ca43ba948ce1))
* match LICENSE text to SPDX Elastic-2.0 canonical template ([717951d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/717951d35ac5a812d79afeb8a2c85dfec8b19dee))
* move frameRequested declaration before first use in visualize ([ee86d7b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ee86d7bb68e0f6ea66e0782dd8adbb9180e5a4d8))
* remove extra text from LICENSE for exact SPDX template match ([6b0a6e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6b0a6e08151a86e87538c3e20f4e841b37b28f18))
* split license into standard ELv2 + ethical addendum ([0a9ccd3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0a9ccd32b3026a7f679c754ed25fac845ceff12d))
* unset ELECTRON_RUN_AS_NODE in electron dev script ([1c2c21c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1c2c21cede2e4df820565e1e1ba8019a302bacc9))
* use valid SPDX license identifier for Elastic-2.0 ([11e128b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/11e128b399a07218109fedc0100be682093ed370))


### Documentation

* add usage guidelines and output format to all tool descriptions ([2b544a5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2b544a5cffee2209febbb4960d702d102880ae4a))

## [1.21.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.21.1...v1.21.2) (2026-04-14)


### Bug Fixes

* **ci:** pass --repo to gh commands in release notes step ([8b1b9a1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8b1b9a1aecb092d4da925ea01f7ed49f5b9d7652))

## [1.21.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.21.0...v1.21.1) (2026-04-14)


### Bug Fixes

* sync lock file and make serve the default command ([0e2dd5a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0e2dd5a635d13f62173378314c5e89131804c501))

## [1.21.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.20.1...v1.21.0) (2026-04-14)


### Features

* **ai:** add streaming inference and ask command with code context ([d96fe86](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d96fe8642e15388238981d760be50235c98b5b4c))
* **analytics:** expand known-packages catalog with deprecation tracking ([538e479](https://github.com/nikolai-vysotskyi/trace-mcp/commit/538e4793375abfb6ec30bdb85373de9a0e1c5c1e))
* **app:** add Windows platform support with custom tab bar and installer ([5ff2bda](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5ff2bda4c5e6e539b7cf95d8adeaecbfccce1c42))
* **app:** extract daemon-lifecycle module and auto-start daemon from tray ([a255a6e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a255a6ea209c18d65f66ab68ba040681cb3c53a6))
* **lang:** add 10 new language plugins (Ada, Apex, D, Nim, Pascal, PL/SQL, PowerShell, Solidity, Tcl, VHDL) ([42dca87](https://github.com/nikolai-vysotskyi/trace-mcp/commit/42dca878f89778a049f2a18ffbb80bdd42ccc619))
* **lang:** enhance regex-base with scope tracking, doc comments, and multi-line signatures ([1c6b6ae](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1c6b6ae52a1c744a98d9f43b43e06df09cb5f300))
* **lang:** improve regex-based plugins for Clojure, COBOL, Common Lisp, and 7 others ([354023b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/354023bcda01f885cc25e060270a3ea63cd15d26))
* rename "federation" to "subproject" across entire codebase ([a8ec5ab](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a8ec5ab8853049881d4bfb591faaa77f60a8aee2))
* **server:** add compact_schemas option to reduce tool schema token overhead ([b9f98ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b9f98ac1630d82c1a66457b523337566a5ace602))

## [Unreleased]

### Breaking Changes

* **rename: "federation" → "subproject"** — The concept formerly called "federation" is now "subproject". A subproject is any working repository that is part of your project's ecosystem: microservices, frontends, backends, shared libraries, CLI tools, etc. This affects:
  - CLI: `trace-mcp federation` → `trace-mcp subproject` (alias `sub`)
  - MCP tools: `get_federation_graph` → `get_subproject_graph`, `get_federation_impact` → `get_subproject_impact`, `federation_add_repo` → `subproject_add_repo`, `federation_sync` → `subproject_sync`, `get_federation_clients` → `get_subproject_clients`, `visualize_federation` → `visualize_subproject_topology`
  - Config: `topology.auto_federation` → `topology.auto_discover`
  - REST API: `/api/projects/federation` → `/api/projects/subprojects`
  - DB table: `federated_repos` → `subprojects` (auto-migrated)
  - Source directory: `src/federation/` → `src/subproject/`

## [1.20.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.20.0...v1.20.1) (2026-04-13)


### Bug Fixes

* resolve SQLite migration crashes and daemon PATH for launchd ([33ea80a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/33ea80ae96f34b8c941027c7164674be68cc2b90))

## [1.20.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.19.0...v1.20.0) (2026-04-13)


### Features

* add Class Hierarchy Analysis (CHA) for polymorphic call resolution ([#55](https://github.com/nikolai-vysotskyi/trace-mcp/issues/55)) ([7b193ca](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7b193ca67c95a12ea61beab8122df1b93b678d1e))


### Bug Fixes

* align get_tests_for with graph test_covers edges ([#56](https://github.com/nikolai-vysotskyi/trace-mcp/issues/56)) ([1cfde2e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1cfde2e6ba44653f7a44c5d650515dc58d1d9569))
* exclude CLI entry points from get_dead_exports false positives ([#53](https://github.com/nikolai-vysotskyi/trace-mcp/issues/53)) ([3abf971](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3abf971ed54ee609eee1b2ed5456f11c3ef5007c))
* resolve method calls on parameter-annotated instances ([#54](https://github.com/nikolai-vysotskyi/trace-mcp/issues/54)) ([46c3cbe](https://github.com/nikolai-vysotskyi/trace-mcp/commit/46c3cbe99884c24334a7b4f5d8c2c4966f6ceceb))

## [1.19.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.18.0...v1.19.0) (2026-04-12)


### Features

* add decision memory system for cross-session knowledge ([292a824](https://github.com/nikolai-vysotskyi/trace-mcp/commit/292a8246b415a11d2ba4fa9e411c67295d382e01))
* add Filament and Electron framework plugins ([dbf16fa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dbf16fa72fa56e2b3d0db6e2790100d130d4e68c))
* add move, change-signature, and plan-refactoring tools ([5e2f4ae](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5e2f4aea886e92a6023cbeb71cdc17594400f7bc))
* add technology coverage, service management, and UI improvements ([56817aa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/56817aa0986fd9d627b19f67e243ccb0d2376ddd))
* scope federations to projects with auto-discovery ([ca430c6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ca430c6f5acb3c85bad0fea03abc2e804691208e))


### Bug Fixes

* update tool registrations and fix visualize test assertions ([6d59011](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6d590118ca431f6df28a457f555e3d8d88502f01))


### Documentation

* update documentation for refactoring tools and decision memory ([423675d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/423675d9b057583ce305e83c98ea36e74b6d5d1d))

## [1.18.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.17.0...v1.18.0) (2026-04-12)


### Features

* pin app to macOS Dock after install ([85b2b63](https://github.com/nikolai-vysotskyi/trace-mcp/commit/85b2b633fe3aa2b5674281a09c17fd3cc2953afb))


### Bug Fixes

* include assets and icon in electron-builder package files ([ace9a85](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ace9a8577cf84f941a0219f5423594a05da13507))

## [1.17.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.16.1...v1.17.0) (2026-04-12)


### Features

* default to max enforcement level, add install-app CLI command with retry ([f156305](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f1563058e69c23265ba8f83a934370158dd6bd9b))


### Bug Fixes

* handle nullable topoStore in visualize tool ([e955361](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e955361e95e0b04b238e0b985be82ee283e54178))

## [1.16.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.16.0...v1.16.1) (2026-04-12)


### Bug Fixes

* package.json ([4497e51](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4497e5160de456eb59fe599117e3c67f0273c878))
* resolve TypeScript errors in visualize modules ([10f846f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/10f846f75f53aa3c2422a30aae23a14c2bc31519))

## [1.16.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.15.2...v1.16.0) (2026-04-12)


### Features

* add CORS headers to HTTP server for Electron renderer ([9a39031](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9a3903122c45b7eb7a8d0fb241858de84a8c964e))


### Bug Fixes

* exclude vendor dirs from graph visualization and clear state on error ([73e46ef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/73e46efd4223e907a6e9e0d65446801dff0ae428))
* simplify artifact upload glob and remove redundant arch from yml ([01a2660](https://github.com/nikolai-vysotskyi/trace-mcp/commit/01a266067841d40a56beaf3a9d8f1aeabc3fdaf0))

## [1.15.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.15.1...v1.15.2) (2026-04-12)


### Bug Fixes

* correct electron-builder artifact glob for macOS zip upload ([1c92616](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1c92616c40847d0d6c2a2e128a493277debc3aa8))

## [1.15.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.15.0...v1.15.1) (2026-04-12)


### Bug Fixes

* consolidate electron-builder config to prevent asar packaging failure ([02dfb8f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/02dfb8f6f3fc9625074dda98b7e4c327f751feb3))

## [1.15.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.14.1...v1.15.0) (2026-04-12)


### Features

* add --granularity, --symbol-kinds, --hide-isolated flags to CLI visualize ([ec71946](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ec719460b9ebf80da050e7e23bf06925e28776ae))
* async DB + pytest integration plugins ([48e0ab9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/48e0ab916b54aede6f1b6c39fcbb6c0c25f8f347))
* clean topology data (federation, services) on project removal ([9fffa26](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9fffa2687bed9bc28ca83246fb8806d87a544b15))
* daemon mode — multi-project serve-http with REST API, SSE events, and stdio daemon awareness ([9900500](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9900500f25850270159f6cdff35a2f8589b8959a))
* Electron app — auto-updater, GPU crash recovery, file browser, federation panel ([95b6c79](https://github.com/nikolai-vysotskyi/trace-mcp/commit/95b6c798ff1f16184af95c283df27f5cef18c3d2))
* Electron app — redesigned icons, settings UI overhaul, clients tab, graph explorer improvements ([9232066](https://github.com/nikolai-vysotskyi/trace-mcp/commit/92320665764b96c1f62cf0ce536481cfa0e5fff5))
* federated graph visualization, session landmarks, daemon client naming ([c88a257](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c88a257e68bf3a8cc38380f5255c0ce21ead62aa))
* get_untested_symbols tool + per-symbol test reach in change impact ([7cb554c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7cb554ce62ec69c6419135ab62d62aae3bf369b5))
* graph visualization — light/dark theming, minimap, BFS highlight depth ([2f3bbc0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2f3bbc07ee9da2f7835e3145f6065201d5e26874))
* implicit workspace detection + per-workspace framework plugin activation ([6129f59](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6129f59bd5ac3401d9068cb56a487fa2f643bddb))
* LSP enrichment — 4-tier edge resolution confidence, schema v19, SQLite batch chunking ([acf0ec4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/acf0ec45152976f745ba912f61f9133922467785))
* menu bar app — Electron tray app, installer, init wizard integration, CI release workflow ([63bda06](https://github.com/nikolai-vysotskyi/trace-mcp/commit/63bda0679fa924156bfb0d9a52b0ebcd9cdcd428))
* Next.js plugin — optional catch-all routes, 2-level intercepting routes, route segment config, use client/cache directives ([8b39280](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8b392808acbcafb478a7f8c4bc5627b75f1815b5))
* Next.js plugin — src/ prefix support, new file conventions (forbidden, unauthorized, metadata, instrumentation, proxy) ([e623fd1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e623fd1ae9fcd96d512b2232fa551ef44f0a23a5))
* ONNX local embeddings + Signal Fusion search — zero-config semantic search with multi-channel WRR ranking ([b0ce8e3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b0ce8e38b1815237f3bd95246a987b0eb25744a0))
* post-update migrations — auto-migrate hooks, config, CLAUDE.md, and reindex after version change ([aba1f9c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aba1f9cc5292ff432d5b9ad8d3228fa2dabddd3d))
* Python language support — edge resolvers, CFG patterns, visibility, docstrings ([23953ed](https://github.com/nikolai-vysotskyi/trace-mcp/commit/23953ed892a5256d3de1f6bf44c87b0bb476e04c))
* symbol-level graph, isolated-node filter, monorepo federation fix ([8f3e55b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8f3e55ba8cd3ea44fe5a7ee3191c583df2d3d04a))
* workspace-aware module resolution + config exclude normalization ([0376ae1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0376ae19aaa816670fb2830aeede03565988716f))


### Bug Fixes

* replace dynamic await import() with static http import in postinstall-app.mjs ([67330b9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/67330b9d23bbb475dbfc0d01ba3caa3eddf9cfc8))
* set renders_component edge type category to 'nuxt' in NuxtPlugin ([967c613](https://github.com/nikolai-vysotskyi/trace-mcp/commit/967c61345014087ce418458fadfe210498048b65))
* visualize_graph file mode now seeds by symbol nodes, collapses to file edges ([e36e321](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e36e321d3805b36360866e23cbaf9bcd9e6f56bd))


### Performance

* eliminate redundant queries in graph visualization ([b4d7dfa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b4d7dfa05260f40ee1fe9ca1825d420f3d28cf01))


### Refactoring

* extract setupProject, add REST API endpoints, consolidate CI ([3b6c23f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3b6c23fc26d5da8e483f62248360120078a6c8cf))
* extract shared resolveSymbolInput utility, improve tool robustness ([3fa2e0c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3fa2e0c228c13a83a92523a580c79662a65eafd3))


### Documentation

* update README, CLAUDE.md, configuration, and MCP instructions for LSP, ONNX, Signal Fusion, untested symbols ([5ed61af](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5ed61afc8f0f9e6bbb166fce4a660705eabec7a8))

## [1.14.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.14.0...v1.14.1) (2026-04-09)


### Refactoring

* Improve project root detection logic ([03ba367](https://github.com/nikolai-vysotskyi/trace-mcp/commit/03ba3673984f6efd33f3c71c853f4fc6f7fc317c))

## [1.14.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.13.0...v1.14.0) (2026-04-09)


### Features

* add workspace/monorepo fallback with deep glob patterns when root has no direct source files ([c62d89c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c62d89c80a0666e3d809854904f3994b723985e6))


### Bug Fixes

* use result.isErr() instead of result.ok for neverthrow Result check ([62edec8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/62edec879463ca9d03dff1cc8f3e601a3406eb07))

## [1.13.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.12.0...v1.13.0) (2026-04-09)


### Features

* add auto-updater with configurable check interval ([b26c851](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b26c8513a7b2fa761d639926d7fca11fbdd06f8a))
* add budget defaults, improve analytics and tool-gate ([ea48038](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ea48038de4d77d7fc240f01cba7d20813766a81c))
* add confidence levels and methodology disclosure to analytical tools ([dc6a9d8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dc6a9d8122f6da0bff36d2d69acae8c1aca5eec4))
* add discover_claude_sessions for multi-project federation ([4bde3fe](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4bde3fecf77d81b762f5eb195cf98fbe2c86d60b))
* add git worktree support, visualize CLI command, and auto-update serve flow ([de755c3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/de755c336a92c2cbab4c4b9cc902d644f20288f0))
* add pack-context strategies (core_first, compact) and budget reporting ([e539609](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e539609113c5ac426fa4282e04f2d46e41cebbfe))
* add plan_turn opening-move router with insertion-point suggestions ([9ee62bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9ee62bfca42d7fca92e445e27f441954d80be3b9))
* add semantic search modes, LRU result cache, and embed_repo tool ([b4002c2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b4002c260752cb6e0b7593308c0c979b2b92a3ba))
* add skills directory with trace-mcp usage guides ([ef37023](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ef37023f3a59b579b50d32d970720def964b198f))
* enrich empty-result evidence with isolation verdict and relation tool suggestions ([726e6a8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/726e6a8939186c8c58e69e4e8b96886ab21b9bb6))
* refactor Dart plugin and improve CSS/JSON/YAML/Python/Kotlin language plugins ([e19c338](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e19c3382c7a73b5870cc6ef7f0519041b4788f49))
* refactor federation manager into focused modules ([1d29a02](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1d29a02739356a25a9722433c1e25661ce6c2999))
* upgrade hooks to v0.6.0 with per-session repeat-read dedup ([8675b60](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8675b600698f77ec0d191570b3fb00f5aa98510b))


### Bug Fixes

* remove DENY_MARKER cycle from guard hook, write initial state on first deny ([1f96374](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1f96374753189c1cf4ba972a6fdd30b1e9eede0f))
* swap stat order in file_mtime to prevent multi-line output on Linux ([c5f6416](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c5f64167e144a415ad60a2ee2cdcf71f5fcbb14d))


### Refactoring

* remove file-watcher module ([dfe1e0d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dfe1e0dc56cbd1f9c4f872f3577cea3e11ab03f8))


### Documentation

* update README with new tools and feature highlights ([7106537](https://github.com/nikolai-vysotskyi/trace-mcp/commit/71065378c6a66a0ed34172ba5d5b33fcd34a088e))

## [1.12.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.11.0...v1.12.0) (2026-04-07)


### Features

* add configurable file logging with rotation ([3215186](https://github.com/nikolai-vysotskyi/trace-mcp/commit/32151868998a9470713e90afa05c783994d9820c))
* add decorator/annotation extraction and filtering ([c0f6646](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c0f6646c48eaab9ca0f99fddbdd4a33e3a1f1b43))
* add Laravel Horizon, Cashier, Scout, and Socialite plugins ([24089c0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/24089c01435477efa855d1ba87779e8eae2f6fd4))
* add Tailwind CSS integration plugin ([bbbb2bb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bbbb2bb24e483db3c79ad220d75b220db7a1ef49))
* expand project root markers, add progress tables, improve evidence ([d6c77db](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d6c77db10d7d4930128c0141480ba2aa87bb504c))


### Documentation

* update README comparison table for accuracy ([aff2dd6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aff2dd6072404f477f3ad34cce2a2bfe67bf137a))

## [1.11.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.10.0...v1.11.0) (2026-04-07)


### Features

* add recursive multi-project technology coverage detection ([606d753](https://github.com/nikolai-vysotskyi/trace-mcp/commit/606d753b02bc4e0bdec03517fd0886dbba64c1a6))


### Refactoring

* Improve project root detection logic ([38d31e6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/38d31e6e12cb392c123785ee04bc2471c3f7e38e))

## [1.10.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.9.0...v1.10.0) (2026-04-07)


### Features

* add CI project-aware reports with domain, ownership, and deployment analysis ([54a2efa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/54a2efafc26b55b58a0b28b5d5a4bd3be1b34ed7))


### Refactoring

* extract federation manager helper methods ([e3739a2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e3739a2b14ce9b2ec5c1628d4413b91b07d7c549))
* extract indexer pipeline and file-persister helper methods ([e064db3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e064db3683a43271676c448c270cdcbd631a7dcd))


### Tests

* add topology DB and contract parser tests ([c791bcc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c791bccf683e3c4b527a6eb37e870e8eb2ffb34f))

## [1.9.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.8.0...v1.9.0) (2026-04-07)


### Features

* add advanced .traceignore ([2f2e5b5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2f2e5b531a8e777542a866aab1d65a7902785bba))
* add federation schema diffing, contract versioning, and federated search ([e43e590](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e43e590a1d618977a411bd5065362d00175d746f))
* add Junie, JetBrains AI Assistant, and Codex MCP client support ([c25aa38](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c25aa387e6833e161896fe205b46701b918012f4))
* add server PID tracking, improved status output, and tweakcc integration ([a7ec015](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a7ec01519c107036dfc08e47f2b4a9c8b70a6eed))
* migrate 16 language plugins from regex to tree-sitter ([3616b2d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3616b2db698947e488e637b24b5b461ec63147c6))


### Refactoring

* extract Laravel edge resolvers into sub-modules ([ca88696](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ca886968ade4691d025151f2011eb2955c4d0f80))


### Documentation

* strengthen apply_codemod enforcement rule in CLAUDE.md ([bd4e571](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bd4e571218159fe42136171b68ad435ff67b01c2))
* update benchmarks to 11 categories and refresh tool counts to 120+ ([e2aa5cb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e2aa5cb67d223c9faa3426c73c48961ba0e0c828))


### Tests

* add server tool-gate, explored-tracker, and consultation-markers tests ([703ef1b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/703ef1b007727e99739ec0a6057680dd04b06cc8))

## [1.8.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.7.0...v1.8.0) (2026-04-07)


### Features

* add JSONC-safe config read/write with migration support ([7ee246b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7ee246b7fbd8a8bba4078a3ccd4884561b626fc8))


### Performance

* optimize context bundle token efficiency ([53a5d38](https://github.com/nikolai-vysotskyi/trace-mcp/commit/53a5d385f0b5d5ed52c536bb982e10704635cd57))

## [1.7.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.6.1...v1.7.0) (2026-04-07)


### Features

* add benchmark scenarios for find_usages, context_bundle, type_hierarchy, tests_for ([d2a85d5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d2a85d53e8b2efd0d1e49e26874cf549d922c6a9))
* add indexing progress tracking with CLI status/remove commands ([ca1b539](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ca1b539f682ee5d57ef97a901e9e51e1d0b9c483))
* block Agent(Explore) subagents in guard hook v0.5.0 ([8796857](https://github.com/nikolai-vysotskyi/trace-mcp/commit/879685700b7888a0717f4c1017dbb19c5e965d74))
* seed JSONC config template with all parameters on first run ([5cb13fb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5cb13fbd01bd2579dc30f35963ae162b702e9d7d))
* support async extractSymbols in LanguagePlugin interface ([3a92d9e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3a92d9e195d66a132acaddc01b736c4682c4ca72))


### Bug Fixes

* align benchmark SQL with normalized edge_types table ([2c7e472](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2c7e4720ee0f9085b05bbcb856693f14875174a4))
* correct TypeScript typing in hook entry filter callback ([47b4159](https://github.com/nikolai-vysotskyi/trace-mcp/commit/47b415941408e29753c6f90be2e19579b1e0da08))
* update prompt templates to match current API response shapes ([9e8cea2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9e8cea2a883c401751389dd14e60c356a10406cc))


### Documentation

* add tweakcc system prompt routing guide ([a5633c8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a5633c820a444f2d4ac5a710b7d2d96f35fbcbed))
* expand CLAUDE.md with Agent anti-pattern table and Read-before-Edit optimization ([7e4f930](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7e4f9303e531ff5f46ef7a5047712eb9895399c1))

## [1.6.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.6.0...v1.6.1) (2026-04-06)


### Bug Fixes

* deduplicate trigram batch by symbolId to prevent INSERT OR REPLACE conflicts ([2fd4dfa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2fd4dfa30619521471874d76cdf7a70a971d0bdc))
* skip missing child directories in multi-root workspace builds ([270f114](https://github.com/nikolai-vysotskyi/trace-mcp/commit/270f1146e4c6d1bb3995c33975e1e33f196cb119))
* wrap CLI upgrade operations in try/catch for graceful error handling ([a481bb5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a481bb5dd555a8cbd7920bab40dec79c26438d72))

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
