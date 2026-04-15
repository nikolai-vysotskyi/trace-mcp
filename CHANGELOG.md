# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).


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
