# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).


## [3.44.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.44.0...v3.44.1) (2026-11-14)


### Bug Fixes

* **app:** time out stuck daemon CLI commands (TRA-3042) ([#1902](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1902)) ([a7837e5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a7837e5e2aecbf211c5f65b3b5a6ec577df9f467))
* **launcher:** heal stale version metadata after package update ([#1906](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1906)) ([c2e801f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c2e801fd43a4ff16b01d3cb40b561f75d99426cb))

## [3.44.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.43.1...v3.44.0) (2026-11-10)


### Features

* **project:** surface truncation state and diagnostics in orientation tools (TRA-3000) ([#1896](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1896)) ([d39aac8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d39aac8835505fa826023aae7c5af72121952c2c))


### Bug Fixes

* preserve logger receiver in watcher telemetry ([#1897](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1897)) ([1dbcafe](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1dbcafe98d0bab1b54523ebff534bc72c120bd77))
* replace raw NUL bytes in TypeScript sources ([#1900](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1900)) ([2a5bad7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2a5bad79590eed905b1bdcb12fa128188f9386dd))
* **watcher:** include safe project and file context on change handler failure (TRA-3008) ([#1899](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1899)) ([2deab02](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2deab02846c93bb65af8599dcc2b5a7b276962b9))

## [3.43.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.43.0...v3.43.1) (2026-11-09)


### Bug Fixes

* **bb:** stabilize Dependabot dependency updates ([#1885](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1885)) ([2981ee7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2981ee7bab48a241b759b56ce011c8ac6d4e60ec))
* **daemon:** safely sweep orphaned session DBs and handle rollback recovery (TRA-2993) ([#1892](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1892)) ([dd4bdd7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dd4bdd7da585705729767f5364f9ee8b3d5c2c18))
* **doctor:** ignore declared multi-root children in nested repo scan ([#1895](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1895)) ([3f48cfa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3f48cfa61823ee3cb6f5997f8b97fb332a519a90))
* **launcher:** migrate disposable cache configs (TRA-2991) ([#1891](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1891)) ([93068f4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/93068f47ddccf17c72cdb65795be71d6e699b8f3))
* **watcher:** drop out-of-include events before reindex telemetry (TRA-2984) ([#1883](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1883)) ([9241ee4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9241ee463c2d9368163f92e4d811bd1207bf0d81))


### Documentation

* refresh sitemap.xml and lastmod after docs commits on master ([#1881](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1881)) ([c6691a9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c6691a9199cac3b6c74177db228aa356d9854e7b))

## [3.43.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.42.11...v3.43.0) (2026-11-08)


### Features

* **activity:** classify tool errors in journal params_summary (TRA-2981) ([#1882](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1882)) ([fb3decc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fb3decc3ddba0bca03458072fb25a4bcd5bfbff0))


### Bug Fixes

* prevent init from pinning ephemeral CLI caches ([#1874](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1874)) ([3d963d8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3d963d8ff503b99f1752f565e868ee4831c0e55a))
* restore public filename references after history rewrite ([#1879](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1879)) ([c734d02](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c734d023e0bb65f85b15590b893d89606e0c3a07))


### Documentation

* add Supported by section with AssetFeed to README and homepage ([#1878](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1878)) ([dd2d64e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dd2d64e81a014e3bb9eeafef466b0f25cb9d41a7))
* point Supported by links to AssetFeed search ([#1880](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1880)) ([1a03055](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1a03055c1ab21c832372b4c2c871ec6444e83c97))
* restore sanitized public instructions and changelog ([341f9c6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/341f9c675e9cf4840e1bce2d219a69a766f071cd))


### Tests

* **session:** isolate Codex home in provider tests (TRA-2965) ([#1873](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1873)) ([1fd364c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1fd364c0eefb5e094b5e34fffdacdbb52177261b))


### CI/CD

* remove GEO workflow after private migration ([9054bd9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9054bd98d47e4eaf200d686722bbd123113f5c2f))

## [3.42.11](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.42.10...v3.42.11) (2026-11-07)


### Bug Fixes

* **api:** bound and cache coverage route, optimize child project discovery (TRA-2928) ([#1863](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1863))
* **session:** avoid false stall warning on first entry after idle (TRA-2618) ([#1862](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1862))


### Documentation

* record daemon recovery after FSEvents storm ([#1861](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1861))
* record v3.42.10 daemon memory field sample ([#1853](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1853))


### Tests

* **daemon:** isolate test daemon and add live daemon PID guard (TRA-2946) ([#1865](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1865))
* **indexer:** add limit boundary and reconcile regression tests (TRA-2941) ([#1864](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1864))
* **proxy:** retain stdio session across package directory swap (TRA-2951) ([#1866](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1866))


### Chores

* **deps-dev:** bump @biomejs/biome from 2.5.15 to 2.6.3 in the development-minor-patch group ([#1829](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1829))

## [3.42.10](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.42.9...v3.42.10) (2026-11-05)


### Documentation



### Chores

* **app-deps-dev:** bump the development-minor-patch group across 1 directory with 3 updates ([#1849](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1849))
* **app-deps:** bump i18next ([#1827](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1827))
* **ci:** bump the github-actions-minor-patch group with 3 updates ([#1830](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1830))
* **vscode-deps-dev:** bump the development-minor-patch group ([#1831](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1831))

## [3.42.9](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.42.8...v3.42.9) (2026-11-05)


### Bug Fixes

* **daemon:** answer pre-initialize discovery probes locally (TRA-2904) ([#1846](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1846))
* **security:** improve precision for PHP escaped commands, Python constants/qualified tables, and apiBase SSRF (TRA-2900) ([#1843](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1843))
* **updater:** prevent auto-update downgrade and daemon staleness restart loops (TRA-2903) ([#1847](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1847))


### Documentation


## [3.42.8](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.42.7...v3.42.8) (2026-11-04)


### Bug Fixes

* **ai:** classify reranker empty response and add safe diagnostics (TRA-2803) ([#1824](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1824))
* **config:** exclude Nuxt production .output build artifacts from indexing and watcher (TRA-2896) ([#1840](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1840))
* **daemon:** align Windows daemon shim resolution and spawn js entrypoints safely (TRA-2892) ([#1838](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1838))
* **daemon:** route unpersisted project DBs to ephemeral index dir (TRA-2898) ([#1841](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1841))
* **navigation:** fall back to regex outline for existing unindexed files (TRA-2897) ([#1842](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1842))
* **smells:** do not flag CSS custom property names as credentials (TRA-2787) ([#1821](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1821))


### Performance

* **db:** index routes(controller_symbol_id) to eliminate table scan on symbol deletion ([#1822](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1822))


### Documentation


## [3.42.7](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.42.6...v3.42.7) (2026-10-31)


### Documentation


## [3.42.6](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.42.5...v3.42.6) (2026-10-30)


### Bug Fixes

* **daemon:** validate priority_threshold in /api/projects/smells (TRA-2788) ([#1815](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1815))


### Documentation

* record two-project daemon RSS plateau ([#1812](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1812))

## [3.42.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.42.4...v3.42.5) (2026-10-30)


### Documentation


## [3.42.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.42.3...v3.42.4) (2026-10-30)


### Documentation


## [3.42.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.42.2...v3.42.3) (2026-10-29)


### Bug Fixes

* **daemon:** resolve TopologyStore statically in project-artifacts (TRA-2778) ([#1800](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1800))
* **daemon:** tolerate symlink aliases in topology and project removal (TRA-2782) ([#1805](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1805))
* **registry:** tolerate symlink aliases in unregisterProject (TRA-2778) ([#1802](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1802))


### Documentation



### Tests

* **daemon:** restore project removal CI coverage (TRA-2781) ([#1803](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1803))

## [3.42.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.42.1...v3.42.2) (2026-10-29)


### Bug Fixes

* correct Unicode symbol source offsets ([#1791](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1791))
* **daemon:** bound HTTP connection drain on shutdown ([#1789](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1789))
* **daemon:** bound project teardown and memory scheduler drain on shutdown (TRA-1761) ([#1796](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1796))
* **daemon:** bound ProjectRelay cache and align session idle reap (TRA-1719) ([#1797](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1797))
* support umbrella projects with nested git repos in risk hotspots (TRA-1690) ([#1794](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1794))


### Documentation

* record daemon shutdown socket overrun ([#1787](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1787))


### Chores

* **app-deps-dev:** bump the development-minor-patch group across 1 directory with 7 updates ([#1786](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1786))
* **app-deps:** bump the production-minor-patch group ([#1775](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1775))

## [3.42.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.42.0...v3.42.1) (2026-10-28)


### Bug Fixes

* **bb:** generate complete jsdom 30 lockfile (TRA-2739) ([#1778](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1778))
* **bb:** generate complete Vitest 5 lockfile (TRA-2739) ([#1777](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1777))
* **bb:** keep testing-library peer in Dependabot updates (TRA-2739) ([#1773](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1773))
* **indexer:** skip ts-heritage edges with nodes deleted mid-pass (TRA-2756) ([#1785](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1785))
* reject pnpm dlx cache as live launcher source ([#1779](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1779))


### Documentation

* **perf:** separate sleep gaps from post-wake stalls (TRA-2737) ([#1771](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1771))


### Chores

* **ci:** bump the github-actions-minor-patch group across 1 directory with 3 updates ([#1747](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1747))
* **deps-dev:** bump gpt-tokenizer ([#1746](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1746))
* **deps-dev:** bump the development-minor-patch group ([#1774](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1774))
* **deps:** bump the production-minor-patch group across 1 directory with 2 updates ([#1745](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1745))

## [3.42.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.41.0...v3.42.0) (2026-10-27)


### Features

* **cli:** add CLI/daemon version drift diagnostics and document entrypoints (TRA-2721) ([#1765](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1765))


### Bug Fixes

* **indexer:** deterministic truncation, loop prevention and partial index signals (TRA-2639) ([#1760](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1760))
* **indexer:** drop codex ephemeral churn and handle post-discovery enoent races (TRA-2640) ([#1763](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1763))
* **indexer:** preserve legitimate sources under app/ and matching codex churn dirs (TRA-2718) ([#1764](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1764))
* **plugin:** make boto3 AWS calls navigable (TRA-2715) ([#1759](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1759))
* **topology:** report missing service index databases ([#1757](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1757))


### Documentation

* record v3.41.0 daemon RSS field sample ([#1761](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1761))

## [3.41.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.40.0...v3.41.0) (2026-10-26)


### Features

* **plugin:** pymongo collection read/write edges (TRA-2706) ([#1754](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1754))
* **plugins:** add Polars plugin for DataFrame, column, join and UDF edges (TRA-2704) ([#1753](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1753))
* **plugins:** direct AWS service and resource edges for boto3 (GH [#1471](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1471)/[#1473](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1473)) ([#1752](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1752))


### Bug Fixes

* **app:** align MCP client status with disconnect action ([#1750](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1750))
* **daemon,launcher:** make package updates atomic and prevent rollback to app bundle (TRA-2687) ([#1738](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1738))
* **daemon:** GC relief before restart threshold and storage churn exclusion (TRA-2682) ([#1734](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1734))
* **deps:** patch security alerts and add bb Dependabot coverage (TRA-2689) ([#1739](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1739))


### Documentation

* record dropped FSEvents recovery during workspace checkouts ([#1735](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1735))

## [3.40.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.39.0...v3.40.0) (2026-10-25)


### Features

* **analytics:** track prompt-cache hit rate per model and provider (TRA-1681) ([#1676](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1676))


### Bug Fixes

* **cli:** use registered project for search and ask ([#1733](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1733))
* **daemon:** reject failed proxy session recovery (TRA-2665) ([#1726](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1726))
* **daemon:** throttle rapid restarts and protect live daemon from auto-spawn kill (TRA-1954) ([#1677](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1677))
* **docs:** align sitemap lastmod and mark benchmark_lab historical for 3.40.0 (TRA-2673) ([#1729](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1729))
* **proxy:** exit early on --help/--version without session bootstrap (TRA-1739) ([#1680](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1680))


### Documentation


## [3.39.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.38.0...v3.39.0) (2026-10-24)


### Features

* **analytics:** add identical-error-retry rule for failed command loops (TRA-1809) ([#1672](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1672))
* **docs:** add framework landing pages for Laravel, Vue, Nuxt, Django, Spring (TRA-1949) ([#1682](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1682))
* **memory:** deduplicate active decisions during prune ([#1671](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1671))


### Bug Fixes

* **ai:** preserve generic tags in summaries and recover cached failures ([#1718](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1718))
* **daemon:** clean ancestor subtree on nested project add and reconcile on remove (TRA-2558) ([#1687](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1687))
* **deps:** patch Zod audit and record daemon memory (TRA-2643) ([#1715](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1715))
* **indexer:** bidirectional coverage reconcile on deletions and missing_on_disk verify check (TRA-2557) ([#1686](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1686))
* **indexer:** guard against stale file and parent references on symbol insert (TRA-2551) ([#1678](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1678))
* **indexer:** honor include globs for event-driven indexing ([#1717](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1717))
* **indexer:** record and replay pending deletes on closed database (TRA-1998) ([#1679](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1679))
* **indexer:** resolve database lock in resolvePhpImportEdges via immediate transaction and bounded retry (TRA-2552) ([#1674](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1674))
* **indexer:** skip member_of edges with nodes deleted mid-pass (TRA-2649) ([#1720](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1720))
* **init:** refresh version stamp on upgrade and post-update migrations (TRA-1740) ([#1675](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1675))
* **launcher:** pair app runtime with bundled cli after node recovery (TRA-2606) ([#1702](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1702))
* **quality:** distinguish MySQL backtick identifier quotes from PHP execution operator (TRA-1667) ([#1673](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1673))
* resolve production audit advisories ([#1719](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1719))


### Documentation

* **perf:** record session-pinned daemon memory field sample (TRA-2560) ([#1684](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1684))
* **perf:** record sleep-triggered daemon watchdog kill (TRA-2621) ([#1707](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1707))
* **perf:** record v3.38.0 watcher recovery and heap sample ([#1701](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1701))
* **site:** articles catalogue hub with categories (TRA-1952) ([#1683](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1683))

## [3.38.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.37.10...v3.38.0) (2026-10-19)


### Features

* **sql:** PostgreSQL CTE indexing and SQL graph edges (TRA-2253) ([#1482](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1482))


### Bug Fixes

* **daemon:** immediate port bind and restart timeout under indexing load (TRA-2531) ([#1654](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1654))
* **guard:** mark empty-index outline fallback as consulted (TRA-2495) ([#1664](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1664))
* **indexer:** optimize laravel and vue resolveEdges and handle timeout cancellation (TRA-2530) ([#1653](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1653))
* **indexer:** prevent event-loop stalls during bulk indexing and concurrent reindexing (TRA-2524) ([#1648](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1648))
* **indexer:** prevent sqlite closure during in-flight edge tasks (TRA-2439) ([#1627](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1627))
* **navigation:** guard project-basename stripping and forward relocated fqn in get_symbol relay (TRA-2535) ([#1669](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1669))
* **navigation:** resolve cross-project relay, dotted symbols, and auto-indexing for get_symbol (TRA-2535) ([#1655](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1655))


### Documentation

* **perf:** mark response_tokens as historical for 3.38.0 (TRA-2550) ([#1668](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1668))
* **perf:** record v3.37.10 daemon RSS after idle project unload (TRA-2526) ([#1650](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1650))
* **site:** refresh sitemap lastmod and index updated date (TRA-2546) ([#1666](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1666))
* **site:** use concrete category hero copy (TRA-2265) ([#1506](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1506))


### Chores

* **app-deps-dev:** bump the development-minor-patch group ([#1658](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1658))
* **app-deps:** bump i18next ([#1657](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1657))
* **app-deps:** bump source-map-js to patched version (TRA-2527) ([#1652](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1652))
* **ci:** bump the github-actions-minor-patch group with 7 updates ([#1662](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1662))
* **deps-dev:** update development dependencies (TRA-2544) ([#1665](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1665))
* **deps:** bump the production-minor-patch group with 5 updates ([#1659](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1659))
* **deps:** bump tree-sitter-wasm from 2.0.2 to 2.0.4 ([#1661](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1661))

## [3.37.10](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.37.9...v3.37.10) (2026-10-18)


### Bug Fixes

* **memory:** prune expired decisions and deduplicate mined entries (TRA-2521) ([#1647](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1647))
* **registry:** describe excluded descendant roots accurately (TRA-2522) ([#1646](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1646))


### Documentation


## [3.37.9](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.37.8...v3.37.9) (2026-10-18)


### Bug Fixes

* **indexer:** prevent event-loop stalls during incremental postprocessing (TRA-2505) ([#1640](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1640))


### Documentation

* record v3.37.8 daemon idle memory observation ([#1637](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1637))

## [3.37.8](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.37.7...v3.37.8) (2026-10-17)


### Bug Fixes

* **daemon:** aggregate aborted watcher reindex batches on shutdown (TRA-2438) ([#1631](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1631))
* **daemon:** correlate unclean stop diagnosis with PID and time to prevent false OOM attribution (TRA-2443) ([#1630](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1630))
* **daemon:** prevent startup hang and /health starvation after restart (TRA-2442) ([#1629](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1629))
* **indexer:** exclude browser runtime caches from walk and watcher (TRA-2500) ([#1635](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1635))
* **indexer:** prevent event-loop stalls on single-file incremental reindex (TRA-2456) ([#1626](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1626))


### Documentation

* **perf:** record repeated no-change daemon stalls on 3.37.7 ([#1622](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1622))


### Tests

* **app:** deflake Clients Escape sheet dismissal test (TRA-2460) ([#1625](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1625))

## [3.37.7](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.37.6...v3.37.7) (2026-10-16)


### Bug Fixes

* **indexer:** ignore ML checkpoint weights and atomic swaps ([#1621](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1621))
* **indexer:** prune missing files after truncated walks ([#1620](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1620))


### Documentation


## [3.37.6](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.37.5...v3.37.6) (2026-10-16)


### Documentation

* **perf:** record field idle RSS ceiling breach (TRA-2459) ([#1612](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1612))

## [3.37.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.37.4...v3.37.5) (2026-10-15)


### Documentation


## [3.37.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.37.3...v3.37.4) (2026-10-14)


### Bug Fixes

* **frameworks:** make resolveEdges scope-aware to prevent timeouts (TRA-2434) ([#1603](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1603))
* **indexer:** resolve SQLite slow queries and event loop stalls (TRA-2433) ([#1602](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1602))


### Documentation

* **perf:** record v3.37.3 daemon stall baseline (TRA-2437) ([#1606](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1606))

## [3.37.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.37.2...v3.37.3) (2026-10-14)


### Bug Fixes

* **ci:** stabilize Windows full-suite timeouts and contention (TRA-2427) ([#1599](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1599))


### Documentation


## [3.37.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.37.1...v3.37.2) (2026-10-14)


### Bug Fixes

* **guard:** allow bare-origin worktree fallback (TRA-2415) ([#1595](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1595))
* **guard:** propagate consultation markers to target and intermediate project roots (TRA-2426) ([#1598](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1598))

## [3.37.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.37.0...v3.37.1) (2026-10-14)


### Bug Fixes

* **framework:** pre-filter files before event-loop yields in resolveEdges (TRA-2394) ([#1584](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1584))
* **guard:** mark batch sub-call consultations ([#1588](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1588))
* **indexer:** eliminate event loop stalls in rename detection and deep globbing (TRA-2380) ([#1586](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1586))
* **indexer:** skip Claude Code atomic-write siblings ([#1589](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1589))
* keep proxy session alive during package swap ([#1590](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1590))


### Documentation



### Chores

* **app-deps-dev:** bump the development-minor-patch group ([#1568](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1568))
* **deps-dev:** bump vite ([#1569](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1569))
* **deps:** bump pino ([#1567](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1567))
* **vscode-deps-dev:** bump the development-minor-patch group ([#1570](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1570))

## [3.37.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.36.7...v3.37.0) (2026-10-13)


### Features

* **worktree:** serve a linked worktree from its own branch index ([#1490](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1490))


### Bug Fixes

* exclude macOS suspend time from diagnostics and plugin timeout ([#1575](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1575))
* **indexer:** evict deleted directory contents (TRA-2371) ([#1572](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1572))


### Documentation

* distinguish macOS sleep from daemon SQLite stalls ([#1573](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1573))
* **sitemap:** refresh lastmod for configuration and config-index (TRA-2383) ([#1577](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1577))

## [3.36.7](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.36.6...v3.36.7) (2026-10-12)


### Bug Fixes

* **db:** skip FTS integrity write probe on read-only database connections ([#1571](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1571))
* **indexer:** resolve event loop stalls during Laravel & Blade edge resolution (TRA-2351) ([#1561](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1561))


### Documentation


## [3.36.6](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.36.5...v3.36.6) (2026-10-11)


### Bug Fixes

* **indexer:** time-slice Vue framework resolution (TRA-2352) ([#1559](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1559))

## [3.36.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.36.4...v3.36.5) (2026-10-11)


### Bug Fixes

* **gc:** report freed bytes for orphan index sweep (TRA-1650) ([#1556](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1556))

## [3.36.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.36.3...v3.36.4) (2026-10-11)


### Bug Fixes

* **app:** retry transient update checks and add background safety net (TRA-2104) ([#1550](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1550))
* **indexer:** time-slice framework edge insertion in storeRawEdges (TRA-2334) ([#1555](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1555))

## [3.36.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.36.2...v3.36.3) (2026-10-10)


### Bug Fixes

* **daemon:** heap-pressure guard and V8 OOM attribution (TRA-2056) ([#1546](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1546))
* **indexer:** downgrade IndexAbortedError in watcher change handler to warn (TRA-1903) ([#1547](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1547))
* **indexer:** drop ML checkpoint tmp siblings and rate-limit ENOENT warnings (TRA-2326) ([#1542](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1542))
* **tools:** resolve get_outline relative paths to multi-root containers (TRA-2327) ([#1544](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1544))


### Documentation

* **perf:** record live proxy session footprint (TRA-2330) ([#1548](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1548))

## [3.36.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.36.1...v3.36.2) (2026-10-10)


### Documentation

* record bb marketplace admission ([#1541](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1541))

## [3.36.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.36.0...v3.36.1) (2026-10-10)


### Bug Fixes

* **daemon:** evict deleted projects and clean orphan DBs in sweep (TRA-2313) ([#1535](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1535))
* **security:** triage three utility script findings and harden scanner precision (TRA-2258) ([#1509](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1509))


### Documentation


## [3.36.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.35.0...v3.36.0) (2026-10-10)


### Features

* **integrations:** deepen bb context and memory workflow ([#1531](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1531))


### Bug Fixes

* **benchmark-lab:** ship pinned fixtures in distribution package (TRA-2298) ([#1523](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1523))
* **cli:** route index-file to registered container (TRA-2299) ([#1522](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1522))
* **indexer:** ignore cancelled dropped-event reconcile ([#1529](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1529))
* **indexer:** keep daemon responsive during bulk discovery (TRA-2305) ([#1532](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1532))
* **indexer:** recover from SQLITE_BUSY on initial rebuild and use immediate transactions (TRA-2257) ([#1528](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1528))
* **indexer:** skip php-calls edges with nodes deleted mid-pass (TRA-2249) ([#1526](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1526))
* **test:** isolate plugin integration test runner and exclude from root vitest (TRA-2307) ([#1534](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1534))


### Documentation



### CI/CD

* run Semgrep via pipx to avoid Docker Hub rate limit (TRA-2301) ([#1525](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1525))

## [3.35.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.34.8...v3.35.0) (2026-10-09)


### Features

* **integrations:** add bb plugin integration ([#1520](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1520))
* **worktree:** flag results for files a linked worktree changed ([#1483](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1483))


### Bug Fixes

* **daemon:** retry dropped-event FK rescan and report failure (TRA-2276) ([#1513](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1513))
* **deps:** override vulnerable tinypool (TRA-2279) ([#1514](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1514))
* **indexer:** resolve reindexing event-loop stalls and slow SQLite joins (TRA-2282) ([#1515](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1515))
* **indexer:** suppress expected skip warns and aggregate skip counters (TRA-2273) ([#1510](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1510))


### Documentation



### Chores

* **app-deps-dev:** bump the development-minor-patch group across 1 directory with 3 updates ([#1500](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1500))
* **ci:** bump the github-actions-minor-patch group with 3 updates ([#1488](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1488))
* **deps-dev:** bump the development-minor-patch group across 1 directory with 4 updates ([#1501](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1501))
* **vscode-deps-dev:** bump vitest ([#1489](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1489))

## [3.34.8](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.34.7...v3.34.8) (2026-10-08)


### Bug Fixes

* **ai:** skip stale vectors when symbols change during embedding ([#1491](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1491))
* **daemon:** answer reindex-file once queued, stop hook and CLI double-indexing ([#1484](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1484))
* **daemon:** deduplicate project setup and confirm health loss (TRA-2248) ([#1497](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1497))
* **daemon:** exclude watcher aborts from reindex errors ([#1496](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1496))
* **security:** resolve production audit vulnerabilities and document braces exception (TRA-2247) ([#1498](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1498))
* **tools:** resolve get_outline from root sessions (TRA-2243) ([#1495](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1495))


### Documentation

* **distribution:** record 2026-10-08 sweep, classify 8 repos and harden mention-sweep (TRA-2264) ([#1502](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1502))
* **perf:** omit local hardware details from embedding eval (TRA-2239) ([#1492](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1492))
* **site:** restore compact homepage hero (TRA-2265) ([#1503](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1503))
* **site:** show concise claim and product view in hero (TRA-2265) ([#1505](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1505))

## [3.34.7](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.34.6...v3.34.7) (2026-09-30)


### Bug Fixes

* **daemon:** collapse aborted watcher batch to one warn, drop per-file error lines (TRA-2095) ([#1468](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1468))


### Documentation


## [3.34.6](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.34.5...v3.34.6) (2026-09-30)


### Bug Fixes

* **daemon:** reindex-file lock contention returns 503 + warn with holder attribution (TRA-2091) ([#1462](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1462))


### Documentation



### Chores

* **app-deps-dev:** bump the development-minor-patch group across 1 directory with 6 updates ([#1466](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1466))
* **ci:** bump the github-actions-minor-patch group across 1 directory with 3 updates ([#1436](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1436))
* **deps-dev:** bump the development-minor-patch group across 1 directory with 8 updates ([#1435](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1435))
* **deps:** bump the production-minor-patch group across 1 directory with 4 updates ([#1433](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1433))
* **vscode-deps-dev:** bump the development-minor-patch group across 1 directory with 3 updates ([#1437](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1437))


### CI/CD

* **dependabot:** drop include scope so titles parse as conventional commits (TRA-2097) ([#1464](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1464))

## [3.34.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.34.4...v3.34.5) (2026-09-29)


### Bug Fixes

* **daemon:** per-session/project breakdown in GET /debug/memory (TRA-2061) ([#1451](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1451))
* **db:** stop unlinking live 0-byte WAL on open (TRA-2068) ([#1456](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1456))
* **embeddings:** clean vec0 orphans on symbol delete + two-way sync (TRA-2070) ([#1454](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1454))
* **indexer:** drop cache/.reasoning_caps_*.tmp hot-churn siblings (TRA-2057) ([#1446](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1446))
* **indexer:** drop ignored/deleted .env rows on reindex (TRA-2067) ([#1455](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1455))
* **indexer:** per-project framework cache + migration closure return types (TRA-2069) ([#1458](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1458))
* **prune:** canonical-only registry matching + orphan holders sweep (TRA-2055) ([#1443](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1443))
* **reranker,proxy:** numbered scores + scaled budget + busy-stall extension (TRA-2071) ([#1457](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1457))
* **status:** clean heartbeat files of removed projects (TRA-2062) ([#1452](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1452))


### Documentation


## [3.34.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.34.3...v3.34.4) (2026-09-28)


### Bug Fixes

* **daemon:** last-will diagnosis on unclean start (TRA-2037) ([#1432](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1432))


### Documentation


## [3.34.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.34.2...v3.34.3) (2026-09-28)


### Bug Fixes

* **ai:** stop summarization re-billing the same batch forever (GH[#1423](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1423)) ([#1428](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1428))
* **daemon:** byte-cap session journal snapshots, prune pool/bookkeeping residue (TRA-2017) ([#1424](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1424))
* **daemon:** tolerate symlink-alias project roots in reindex-file path (TRA-2032) ([#1431](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1431))
* **indexer:** drop hot-churn atomic tmp siblings before any lock work (TRA-2031) ([#1430](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1430))
* **indexer:** drop hot-churn runtime state before any lock work (TRA-2021) ([#1425](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1425))


### Documentation



### Tests

* **daemon:** harden stall-watchdog quiet test against Windows jitter (TRA-2028) ([#1427](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1427))

## [3.34.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.34.1...v3.34.2) (2026-09-27)


### Bug Fixes

* **daemon:** document /health vs /api/projects status semantics, add resident flag ([#1416](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1416))
* **daemon:** gate proxy-send rescue on daemon liveness, attribute fallback lines (TRA-1997) ([#1418](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1418))
* **db:** materialize heritage edges, kill findImplementors LIKE scan (TRA-2002) ([#1420](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1420))
* **registry:** treat Claude scratch-workspaces as ephemeral project roots (TRA-1999) ([#1419](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1419))
* **stdio:** reindex on fresh projects no longer hits readonly snapshot (TRA-1988) ([#1413](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1413))


### Documentation


## [3.34.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.34.0...v3.34.1) (2026-09-27)


### Bug Fixes

* **ci:** gate GEO live battery via env, secrets unavailable in steps.if (TRA-1986) ([#1412](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1412))


### Documentation


## [3.34.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.33.0...v3.34.0) (2026-09-26)


### Features

* **clients:** per-file project configs, prompts card, Multica agents (TRA-1933) ([#1411](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1411))
* **lab:** Benchmark Lab — measured arm runs in daemon and app (TRA-1951) ([#1403](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1403))
* **mcp:** per-client trace-mcp removal in CLI and app (TRA-1932) ([#1396](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1396))
* **seo:** GEO-battery for AI-answer visibility, baseline 2026-09-25 (TRA-1947) ([#1401](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1401))


### Bug Fixes

* **indexer:** edges-driven file-projection joins + cross-thread stall watchdog (TRA-1957) ([#1406](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1406))
* **launcher:** repoint healthy legacy symlink that misses current shim (TRA-1964) ([#1408](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1408))
* **postinstall:** never downgrade live daemon from stale installs (TRA-1963) ([#1407](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1407))


### Documentation

* **vs:** batch 1 — ast-grep, Continue, Aider head-to-heads (TRA-1948) ([#1400](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1400))
* **vs:** batch 2 — Cody, ripwire, IDE-context head-to-heads (TRA-1948) ([#1410](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1410))

## [3.33.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.32.0...v3.33.0) (2026-09-25)


### Features

* **gc:** TTL sweep for top-level orphan index DBs (TRA-1908) ([#1384](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1384))
* **mcp:** drop deprecated Gemini CLI client, keep Antigravity (TRA-1931) ([#1395](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1395))


### Bug Fixes

* **daemon:** recover from SQLITE_CORRUPT_VTAB + guard bulk-index window (TRA-1923) ([#1392](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1392))
* **daemon:** sync exit breadcrumb + SIGHUP handler so no death is silent (TRA-1911) ([#1387](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1387))
* **indexer:** always re-probe binary head instead of size+mtime negative cache (TRA-1919) ([#1391](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1391))
* **indexer:** drop SQLite sidecars before stat/read, silence ENOENT race (TRA-1943) ([#1399](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1399))
* **indexer:** negative cache for oversized/binary hot reindex loop (TRA-1912) ([#1388](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1388))
* **index:** isolate branch-diverged same-remote checkouts from the shared DB (TRA-1916) ([#1390](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1390))
* **proxy:** log worktree sharing + lock serve/proxy root parity (TRA-1915) ([#1389](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1389))


### Documentation


## [3.32.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.31.5...v3.32.0) (2026-09-24)


### Features

* **config:** auto_register mode + exclude for throwaway checkouts (TRA-1881) ([#1377](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1377))
* **health:** always report embedding coverage in get_index_health (TRA-1904) ([#1382](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1382))


### Bug Fixes

* **indexer:** skip ts-calls edges with nodes deleted mid-pass (TRA-1902) ([#1381](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1381))
* **remove:** keep shared dbPath on remove (TRA-1887) ([#1379](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1379))
* **security:** keep .env secret values out of search_text and rename non-code scan (TRA-1890) ([#1376](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1376))
* **security:** redact .env values in search_text, pack-context, non-code-scanner (TRA-1889) ([#1375](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1375))


### Documentation

* **skills:** route env discovery through get_env_vars, guard prose (TRA-1883) ([#1374](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1374))

## [3.31.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.31.4...v3.31.5) (2026-09-24)


### Bug Fixes

* **activity:** journal every dispatch path and warn on journal silence (TRA-1868) ([#1370](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1370))
* **daemon:** keep multi-root families co-resident and wake unloaded descendants (TRA-1863) ([#1366](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1366))
* **index:** delete whole DB family + sweep stem-less WAL/SHM orphans (TRA-1864) ([#1367](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1367))


### Documentation


## [3.31.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.31.3...v3.31.4) (2026-09-23)


### Bug Fixes

* **daemon:** bound wedged native watcher calls so startup cannot stall in indexing (TRA-1843) ([#1359](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1359))
* **daemon:** slice warmup wait, bail on stalled startup (TRA-1844) ([#1360](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1360))
* **db,indexer:** slow-SQL guard + index-friendly workspace preload (TRA-1834) ([#1352](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1352))
* **graph:** omit service topology without source endpoints (TRA-1748) ([#1327](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1327))
* **indexer,db:** chunk unbounded SQLite IN lists past variable/arg ceilings (TRA-1005) ([#1324](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1324))
* **indexer:** dedupe File too large warn per path (TRA-1841) ([#1357](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1357))
* **init:** scope-aware hermes guard (TRA-1014) ([#1325](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1325))
* reconcile deleted files in subproject indexes (TRA-1746) ([#1329](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1329))
* **security:** confine mutating-tool writes to project root (TRA-1848) ([#1361](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1361))


### Performance

* **tools:** trim fattest tool descriptions, restore schema-budget headroom (TRA-1842) ([#1358](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1358))


### Documentation

* **daemon:** record daemon-as-default decision at auto_spawn_daemon sites (TRA-1832) ([#1353](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1353))


### Tests

* **daemon:** replace snapshot wall-clock budget with causal ordering assert (TRA-1146) ([#1321](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1321))
* **windows:** harden shutdown-abort + ancestor-watcher timing flakes (TRA-1854) ([#1363](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1363))
* **windows:** harden timing-flake trio from TRA-1839 ([#1355](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1355))


### Chores

* **bench:** response-tokens re-measure at 3.31.0 (TRA-1774) ([#1316](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1316))


### CI/CD

* **pr:** fail PRs whose squash message release-please cannot parse (TRA-1039) ([#1326](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1326))
* **release:** migrate SBOM job to async generate-report flow (TRA-908) ([#1320](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1320))

## [3.31.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.31.2...v3.31.3) (2026-09-22)


### Bug Fixes

* **ai:** quiet L50 noise when embedding provider is down at startup (TRA-1798) ([#1341](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1341))
* **daemon,indexer:** refuse ephemeral daemon installs, fail loud on deleted trees (TRA-1807) ([#1343](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1343))
* **guard:** session-aware fallback for unresolvable MCP sessions (TRA-1791) ([#1347](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1347))
* **indexer:** time-slice bulk persist/extract/reconcile + daemon event-loop lag monitor (TRA-1828) ([#1350](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1350))
* **indexer:** time-slice heavy edge-resolution passes so /health stays answerable (TRA-1764) ([#1312](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1312))
* **launcher:** skip ephemeral/tmp roots in pkg-roots, prune dead entries (TRA-1811) ([#1344](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1344))

## [3.31.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.31.1...v3.31.2) (2026-09-21)


### Bug Fixes

* **app:** manual MCP setup hints name the launcher shim, not PATH binary (TRA-1109) ([#1322](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1322))
* **daemon,indexer:** bound daemon shutdown within its 20s deadline (TRA-1017) ([#1328](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1328))
* **graph:** keep Live through drag gestures, overlay inspector without canvas resize (TRA-1783) ([#1337](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1337))
* **memory:** scope Sessions tab to requested project (TRA-1065) ([#1323](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1323))
* **scale:** close non-leading-spread hole in min/max gate (TRA-981) ([#1336](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1336))


### Documentation

* **site:** tell the truth about who runs tweakcc (TRA-979) ([#1319](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1319))

## [3.31.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.31.0...v3.31.1) (2026-09-21)


### Bug Fixes

* **ci:** raise MCP-registry publish timeout above npm wait loop (TRA-1756) ([#1308](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1308))
* **daemon:** count deferred reconcile + bulk indexing in projects_indexing (TRA-1763) ([#1311](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1311))
* **daemon:** stop rescanning deleted roots, report missing in health (TRA-1715) ([#1290](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1290))
* **gc:** sweep ephemeral watcher snapshots, log ephemeral sweep (TRA-1714) ([#1289](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1289))
* **graph:** stabilize zoom gestures and deduplicate hover labels (TRA-1767) ([#1314](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1314))
* **indexer,daemon:** dedup identical language-plugin failures, skip ephemeral roots on update reindex (TRA-1768) ([#1315](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1315))
* **indexer:** purge stale electron cross-file edges on handler/listener removal (TRA-1780) ([#1318](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1318))
* **indexer:** yield between framework edge passes so /health stays answerable (TRA-922) ([#1302](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1302))


### Performance

* **indexer:** scope-aware Pass 2 remainder — electron channel cache, file-projection UNION, ts import-map narrowing (TRA-1729) ([#1313](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1313))

## [3.31.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.30.1...v3.31.0) (2026-09-20)


### Features

* **graph:** dependency navigation, safe tooltips, and monorepo deduplication (TRA-1745) ([#1303](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1303))


### Bug Fixes

* **observation-pack:** compact/legacy ranking parity under budget + bench depth args (TRA-1728) ([#1307](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1307))

## [3.30.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.30.0...v3.30.1) (2026-09-20)


### Bug Fixes

* **daemon:** drain in-flight pipeline work before closing DBs on SIGTERM (TRA-1752) ([#1306](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1306))
* **daemon:** stop relay pinning projects + honest sweep accounting (TRA-1738) ([#1301](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1301))
* **graph:** auto-fit frames point cloud, not simulation space (TRA-1741) ([#1299](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1299))
* **guard:** canonicalize consultation marker keys + root-aware errors (TRA-1737) ([#1305](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1305))
* **observation-pack:** Reviewer C follow-ups from [#1285](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1285) + economics branch coverage (TRA-1700, TRA-1703) ([#1296](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1296))


### Performance

* **indexer:** share workspace plugin detection + throttle ANALYZE (TRA-1543) ([#1304](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1304))


### Documentation

* **distribution:** record TRA-1732 alternative-query venue checks (no submissions) ([#1295](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1295))
* **seo:** jcodemunch on-page + CTR descriptions + internal links + visible breadcrumbs (TRA-1731) ([#1298](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1298))
* **seo:** on-page + CTR for comparisons, configuration, vs/jcodemunch (TRA-1734) ([#1297](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1297))

## [3.30.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.29.0...v3.30.0) (2026-09-20)


### Features

* **clients:** Zed writer, detect, status and UI row (TRA-1658) ([#1277](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1277))
* **daemon:** single-daemon audit, doctor process inventory, stop sweep (TRA-1607) ([#1284](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1284))
* **diagnostics:** evidence-preserving reducer for long outputs (TRA-1702) ([#1291](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1291))
* **observation-pack:** paged recall for get_change_impact (TRA-1700) ([#1285](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1285))
* **refactoring:** then_validate fused validation for mutating tools (TRA-1701) ([#1288](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1288))
* **session:** economic compaction gate for session memory (TRA-1703) ([#1292](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1292))


### Performance

* **onnx,daemon:** ORT mem-pattern tuning + watcher dedup by root (TRA-1608) ([#1286](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1286))


### Documentation

* **measurements:** mark response_tokens historical — measured at 3.23.2, stale since 3.30.0 (TRA-1723) ([#1294](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1294))

## [3.29.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.28.0...v3.29.0) (2026-09-19)


### Features

* **clients,savings,app:** close the value loop from the app — one-click PreToolUse redirect + honest Savings (TRA-1698) ([#1283](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1283))
* **clients:** MiniMax Code writer, detect, status and UI row (TRA-1670) ([#1274](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1274))
* **memory:** one-shot mine CTA and automining flag in Memory empty states (TRA-1689) ([#1281](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1281))
* **overview:** expose security findings list via REST + Overview section (TRA-1675) ([#1279](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1279))


### Bug Fixes

* **daemon:** register endpoint full reindex in stop drain + stopping gate (TRA-1674) ([#1278](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1278))
* **debt:** absolute churn signal + recalibrated A/B cutoffs (TRA-1671) ([#1273](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1273))
* **indexer,app:** surface silent max_files truncation (TRA-1664) ([#1271](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1271))
* **indexer:** EnvIndexer respects descendant excludes and gitignore (TRA-1666) ([#1269](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1269))
* **indexer:** reconcile-storm backoff and run-artifact default excludes (TRA-1665) ([#1270](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1270))
* **quality:** skip PHP __construct DI and empty boilerplate in empty_function (TRA-1672) ([#1275](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1275))


### Documentation


## [3.28.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.27.1...v3.28.0) (2026-09-18)


### Features

* **app,cli:** per-client restart-to-pickup hint after MCP client update (TRA-1647) ([#1267](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1267))
* **clients:** codex TOML drift parity, project-layer guide and tests (TRA-1657) ([#1266](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1266))
* **daemon:** sweep-eligibility observability in vitals (TRA-1625) ([#1250](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1250))
* **init:** add Gemini CLI MCP client support (TRA-1659) ([#1265](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1265))


### Bug Fixes

* **app:** blocked Claude Desktop write opens a sheet with the quit-and-retry steps (TRA-1645) ([#1258](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1258))
* **app:** overview shows not-registered empty state instead of eternal load error (TRA-1643) ([#1257](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1257))
* **daemon:** reap MCP sessions idle &gt;1h so dead clients stop pinning projects (TRA-1627) ([#1251](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1251))
* **errors:** missing target returns VALIDATION_ERROR, not echoable NOT_FOUND (TRA-1633) ([#1254](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1254))
* **indexer:** skip directories instead of erroring (TRA-1649) ([#1259](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1259))
* **navigation:** accept absolute paths and kind-less symbol ids (TRA-1660) ([#1268](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1268))
* **notebook:** friendly state for unregistered projects instead of raw daemon JSON (TRA-1642) ([#1256](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1256))


### Documentation



### Tests

* **e2e:** umbrella indexing lifecycle + unload/reload + watcher-dir regressions ([#1260](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1260))


### CI/CD

* **release:** retry gh release upload with backoff, fail loudly when npm is skipped (TRA-1628) ([#1253](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1253))

## [3.27.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.27.0...v3.27.1) (2026-09-17)


### Bug Fixes

* **memory:** FTS5-escape memory search; gate mined fragments + low-quality sweep (TRA-1619) ([#1247](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1247))

## [3.27.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.26.3...v3.27.0) (2026-09-17)


### Features

* **daemon:** fallback-storm guard — adaptive proxy timeout + cross-process index mutex + fallback counter (TRA-1605) ([#1246](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1246))


### Bug Fixes

* **daemon:** drain and gate single-file reindexes across stopProject (TRA-1553) ([#1241](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1241))


### Performance

* **indexer:** per-pass resolve-context memo + tailwind read gate (TRA-1602) ([#1245](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1245))


### Documentation



### Tests

* **windows:** quarantine timing flakes on loaded CI runners (TRA-1579) ([#1244](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1244))

## [3.26.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.26.2...v3.26.3) (2026-09-16)


### Performance

* **parser:** per-file tree-sitter cache + incremental reparse in watcher (TRA-1577) ([#1237](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1237))
* **weak:** weak-profile stand + full vs low-power numbers (TRA-1578) ([#1236](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1236))


### Documentation


## [3.26.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.26.1...v3.26.2) (2026-09-16)


### Bug Fixes

* **ci:** bound Windows prompt-hook decisions search at 10s, quarantined retries for wall-clock flakes (TRA-1571) ([#1230](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1230))
* **ci:** Windows timeout budget for SQLite-heavy suites, refresh stale sitemap (TRA-1513) ([#1211](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1211))
* **cli:** handle clack cancel symbol for @clack/prompts 1.8 compat (TRA-1558) ([#1227](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1227))


### Performance

* **ai:** ONNX q8 default + true batching for embedBatch (TRA-1538) ([#1220](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1220))
* **db:** FTS trigram-merge + SQLite pragmas audit (TRA-1541) ([#1224](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1224))
* **embeddings:** eval MiniLM vs e5-small vs bge-m3, E5 prefix plumbing (TRA-1539) ([#1231](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1231))
* **indexer:** shared decode + adaptive worker pool (TRA-1537) ([#1222](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1222))
* **indexer:** watcher since-query + git fast-path for incremental discovery (TRA-1576) ([#1234](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1234))
* **parser:** tree-sitter-wasm 2.0.1, full warmup coverage, tree.edit() prototype (TRA-1540) ([#1233](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1233))


### Documentation

* **config:** record the daemon-default decision at auto_spawn_daemon (TRA-1509) ([#1208](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1208))
* **perf:** TRA-1392 startup+size pass at 3.25.1 — no regressions, first_content 89 -&gt; 82ms ([#1214](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1214))
* **sitemap:** refresh lastmod to 2026-09-16 for 14 pages (TRA-1569) ([#1228](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1228))
* **vs:** add /vs/narsil-mcp comparison page and profile CCG competitor (TRA-1234) ([#1163](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1163))


### Chores

* **deps:** fix 2 open Dependabot alerts via pnpm overrides (TRA-1559) ([#1226](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1226))

## [3.26.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.26.0...v3.26.1) (2026-09-15)


### Bug Fixes

* **ux:** name empty root + relay hint in health/empty-hints (TRA-1534) ([#1219](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1219))


### Performance

* **app:** startup-only baseline pass at 3.25.1, no regression (TRA-1347) ([#1215](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1215))
* **indexer:** skip unchanged files before extract dispatch (TRA-1536) ([#1221](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1221))


### Chores

* **deps:** pin tree-sitter-wasm to 1.1.6, take web-tree-sitter 0.27.0 (TRA-1513) ([#1210](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1210))

## [3.26.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.25.1...v3.26.0) (2026-09-15)


### Features

* **indexer:** Lua cross-file require import edge resolver (TRA-1332) ([#1185](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1185))


### Bug Fixes

* **analytics:** book measured tokens in agent-for-indexed, cap savings pct at 100 (TRA-1514) ([#1213](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1213))


### Documentation


## [3.25.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.25.0...v3.25.1) (2026-09-14)


### Bug Fixes

* **analytics,server:** strip execution schema tax, clean poisoned analytics targets, and eliminate false positives in optimization rules (TRA-1350) ([#1191](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1191))
* detect active model for savings and resolve CLAUDE.md drift false positives (TRA-1063) ([#1183](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1183))
* **presets:** add get_untested_symbols to dev preset and audit per-role telemetry (TRA-1366) ([#1194](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1194))


### Documentation

* **seo:** GSC crawl record (homepage recrawled, 24 indexed, +2 discovered), GitNexus link mesh, and Narsil-MCP/Graft deep-dives (TRA-1365) ([#1195](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1195))
* **seo:** GSC crawl record 24 indexed (+2 /vs/ pages), privacy discovery links, and code-graph-mcp ecosystem expansion (TRA-1346) ([#1190](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1190))
* **vs:** add /vs/gitnexus comparison, deep-dive grafel, and update competitor stars (TRA-1361) ([#1193](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1193))


### Tests

* **db:** add comprehensive unit tests for GraphRepository (TRA-1334) ([#1187](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1187))

## [3.25.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.24.0...v3.25.0) (2026-09-09)


### Features

* **cli:** expose blast radius and impact analysis via CLI (TRA-1252) ([#1172](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1172))
* **indexer:** Elixir cross-file import edge resolver and multi-alias expansion (TRA-1227) ([#1162](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1162))
* **plugin:** support @opentelemetry/api for agentic workflows tracing (TRA-1264) ([#1178](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1178))
* **quality:** add get_diagnostics tool to map compiler errors to AST symbols (TRA-1222) ([#1181](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1181))


### Bug Fixes

* **daemon:** heal 0-byte WAL, prevent constructor fd leaks, and fix session refcount leaks (TRA-1233) ([#1165](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1165))
* **docs:** quality-gates defaults, benchmark scenarios, OpenCode client, and test references (TRA-1236) ([#1173](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1173))
* **launcher,updater,cli:** pnpm prefix probing, auto-update lock, and state hygiene sweeps (TRA-1259) ([#1177](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1177))
* **launcher:** multi-version node resolution and client drift healing (TRA-1266) ([#1179](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1179))
* **launcher:** prevent app runtime pairing with incompatible external npm CLI (TRA-1249) ([#1171](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1171))
* **savings:** align savings-report o200k_base count claim with runtime tokenizer reality (TRA-1263) ([#1176](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1176))


### Documentation

* **comparisons:** profile two peers at source, update competitor star counts (TRA-1283) ([#1182](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1182))


### Tests

* **db:** add unit tests for AnalyticsRepository (TRA-1229) ([#1166](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1166))

## [3.24.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.23.2...v3.24.0) (2026-09-08)


### Features

* **app:** auto-growing highlighted json editor and unified theme segmented control (TRA-1066) ([#1141](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1141))
* **client:** opencode client profile, auto-config in init, and neutral tool routing in AGENTS.md (TRA-1204) ([#1150](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1150))
* **context-bundle:** declare a body the budget refused, instead of a bare signature (TRA-1144) ([#1114](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1114))
* **server:** antigravity client profile with host tool retargeting and search suppression (TRA-1216) ([#1153](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1153))


### Bug Fixes

* **analytics,security:** fix bash target_file extraction and root path traversal false-alarm ([#1134](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1134))
* **app:** "Get help" opens a prefilled issue form, not a closed-issue list (TRA-1155) ([#1121](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1121))
* **app:** disambiguate Open/Re-index/Remove aria-labels too (TRA-1058) ([#1123](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1123))
* **cli:** sort recently changed files by mtime_ms DESC NULLS LAST (TRA-1069) ([#1147](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1147))
* **dashboard:** a real grade needs a real sample size (TRA-1057) ([#1124](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1124))
* **docs:** register foreign audit paths, add test-quiet runner, refresh llms-full (TRA-1226) ([#1160](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1160))
* **i18n:** macOS Tahoe terminology and layout fixes for German and Japanese (TRA-1220) ([#1157](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1157))
* **init:** detect and heal drifted Codex MCP launcher path and dynamic home paths (TRA-1224) ([#1161](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1161))
* **launcher,config:** support CRLF in launcher and prune dangerous state directories (TRA-1197) ([#1137](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1137))
* **launcher,gc:** sweep stale session artifacts in softGcSweep and support --preset variations in proxy fast path (TRA-1218) ([#1155](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1155))
* **launcher:** keep the legacy shim path delegating so upgrades reach it ([#1125](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1125))
* **launcher:** resolve probe candidates across candidate homes under isolated HOME (TRA-1206) ([#1145](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1145))
* **launcher:** self-locate state home under isolated HOME and survive update swap window (TRA-1190) ([#1136](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1136))
* **launcher:** survive an MCP client spawned without HOME (TRA-1163) ([#1128](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1128))
* **memory:** ensure mined decision titles are complete statements and preserve wording (TRA-1056) ([#1140](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1140))
* **presets:** compose navigation primitives floor, and account for meta-tools (TRA-1162) ([#1131](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1131))
* **quality:** filter parameter properties from empty_function, ignore backtick TODO tags, and filter DOCTYPE/placeholder/local URLs (TRA-1070) ([#1151](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1151))
* **registry,dangerous-root:** preserve shared index DB and protect state subdirs (TRA-1197) ([#1138](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1138))
* **router:** drop late backend responses for non-pending ids and detach before error synthesis (TRA-1200, TRA-1149) ([#1143](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1143))
* **sweep:** collect leaked tmp symlinks, and bound the shim header read ([#1127](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1127))


### Performance

* **app:** lazy-load GraphExplorerGPU to drop 702KB cosmos chunk from eager startup (TRA-1185) ([#1133](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1133))
* **tools:** shape get_plugin_registry, price field tail, and update response-token benchmark (TRA-1159) ([#1154](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1154))


### Documentation

* **comparisons:** audit what the field measures besides tokens ([#1104](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1104))
* **comparisons:** profile two peers at source, add the benchmark-method gap (TRA-1019) ([#1022](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1022))
* **comparisons:** update competitor star counts and verification pass log (2026-09-08) ([#1158](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1158))
* **seo:** internal link graph reinforcement, GSC 09-08 12:00 UTC crawl record, and /tools-index discovery integration (TRA-1207) ([#1149](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1149))
* **seo:** internal linking overhaul across 11 /vs/ pages, ecosystem expansion in /code-graph-mcp, and GSC 09-08 crawl record (TRA-1184) ([#1132](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1132))
* **vs:** add /vs/jcodemunch comparison page and profile competitor (TRA-1153) ([#1120](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1120))
* **vs:** add /vs/tokensave comparison page and profile competitor (TRA-1166) ([#1130](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1130))


### Tests

* **bench:** add state_patch arm to recall A/B benchmark (TRA-1124) ([#1142](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1142))
* **launcher:** fix test isolation on runners with system node (TRA-1199) ([#1139](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1139))
* **launcher:** force candidate home probing in hostile identity injection test (TRA-1206) ([#1148](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1148))

## [3.23.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.23.1...v3.23.2) (2026-09-07)


### Bug Fixes

* **workspace:** dead registry rows aren't projects (TRA-1054/1057/1077)


### Documentation

* **perf:** measure what the missing changed-symbol bodies are, and what recovering them costs ([#1117](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1117))

## [3.23.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.23.0...v3.23.1) (2026-09-07)


### Bug Fixes

* **app:** drop the false role=grid on the projects list (TRA-1108) ([#1110](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1110))


### Performance

* **context-bundle:** stop shipping the same bytes twice (TRA-1141) ([#1107](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1107))

## [3.23.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.22.0...v3.23.0) (2026-09-07)


### Features

* **docs:** rebalance the row lockup — icon +16%, word -16% (TRA-780) ([#1036](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1036))
* **doctor:** answer 'what would serve index from here' first (TRA-1087) ([#1060](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1060))
* notice the user when the daemon auto-registers a project root ([#936](https://github.com/nikolai-vysotskyi/trace-mcp/issues/936)) ([#1068](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1068))
* **quality:** CI structural gate + release threshold check for context-bundle quality (TRA-1100) ([#1106](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1106))
* **server:** say what the server is in serverInfo (TRA-1119) ([#1084](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1084))
* show the user how much token spend trace-mcp gave back (TRA-1091) ([#1064](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1064))


### Bug Fixes

* **activity:** keep tool-call history on disk so the tab stops reading zero (TRA-1071) ([#1111](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1111))
* **activity:** stop cross-project filter leak and contradictory empty state (TRA-1055) ([#1074](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1074))
* **analysis:** label communities in the Graph tab, not just detect_communities ([#1054](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1054))
* **analysis:** make community labels unique across communities ([#1052](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1052))
* **analytics:** stop reporting stale:false when project freshness is unknown (TRA-1072) ([#1073](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1073))
* **app:** contract-test daemon wire responses; fix pagerank/hotspot/search/get_symbol field drift ([#1055](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1055))
* **app:** disambiguate identically-named projects in Recent/Quick Open (TRA-1058) ([#1050](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1050))
* **context-bundle:** restore symbol bodies under ESM, correct the PR-context figure to 70.5% ([#1066](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1066))
* **daemon:** gate watcher rescans by parallel_initial_index (TRA-1138) ([#1102](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1102))
* **daemon:** lazy-load idle-unloaded projects over HTTP, reconcile status periodically (TRA-1052, TRA-1067) ([#1053](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1053))
* **daemon:** stop /health starvation scaling with the number of indexing projects (TRA-1127) ([#1094](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1094))
* **daemon:** stop reporting a busy daemon as idle, and name the idle RSS ceiling (TRA-1125) ([#1092](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1092))
* **docs:** anchor every count claim to counts.yml, not the registry ([#1061](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1061))
* **guard:** find the heartbeat sentinel from a subdirectory (TRA-1088) ([#1062](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1062))
* **guard:** match shared ancestors across the macOS /private symlink ([#1065](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1065))
* **indexer:** normalize backslash paths in indexFiles/deleteFiles on Windows (TRA-1045) ([#1041](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1041))
* **indexer:** resolve C# using-directive imports (TRA-1027) ([#1028](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1028))
* **indexer:** resolve Kotlin imports, the next language after C# (TRA-451) ([#1039](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1039))
* **init:** pin the tweakcc npx spec and stop detection from installing it (TRA-1133) ([#1099](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1099))
* **launcher:** require a non-empty cli.js before exec (TRA-1132) ([#1097](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1097))
* **launcher:** verify the configured node still runs on every start (TRA-1040) ([#1038](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1038))
* **proxy:** never let a failed local fallback orphan the client handshake ([#1116](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1116))
* **quality:** reject stale spans in get_changed_symbols/compare_branches ([#1049](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1049))
* **registry:** route unregistered one-shot workdirs at the ephemeral index dir (TRA-1136) ([#1101](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1101))
* **registry:** sweep a dead one-shot workdir without the 7-day grace ([#1071](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1071))
* **router:** promote to local mode when a proxy send fails (TRA-1080) ([#1056](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1056))
* **tests:** raise dashboard-routes beforeAll hook timeout for Windows CI ([#1057](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1057))


### Performance

* **dashboard:** serve /api/dashboard/projects from cache, compute in background (TRA-1053) ([#1051](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1051))
* **find_usages:** cap the response tail, and price the tool from a basket (TRA-1049) ([#1045](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1045))
* **register_edit:** stop re-reporting duplicates the edit did not introduce (TRA-1098) ([#1069](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1069))


### Documentation

* **benchmarks:** what share of a subscription can trace-mcp actually save ([#1046](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1046))
* **contributing:** require screen-to-code path for UI defect fixes ([#1072](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1072))
* **language-matrix:** measure import resolution depth per language on real repos (TRA-1145) ([#1109](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1109))
* **perf:** reprice register_edit from the frame, 345 → 219 tokens (TRA-1107) ([#1087](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1087))
* **perf:** republish PR-context coverage under the corrected readability metric ([#1112](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1112))
* **roadmap:** 2026-09-07 revision — the quality arm missed, and it reorders the roadmap ([#1063](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1063))
* **security:** record standing verdicts for js/log-injection and the registry.ts key-write pair ([#1096](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1096))
* **seo:** add /code-graph-mcp landing page and record 09-07 GSC crawl findings (TRA-1083) ([#1058](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1058))
* **seo:** integrate SocratiCode into /code-graph-mcp, carry quality half, and record 09-07 16:00 GSC crawl (TRA-1139) ([#1105](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1105))
* **site:** carry the quality half in the homepage hero, and drop the locality absolutes (TRA-1122) ([#1090](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1090))
* **site:** stop setting the hero's quality evidence as fine print (TRA-1143) ([#1108](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1108))
* stop claiming 100% local, and never publish the saving without the quality half (TRA-1013) ([#1088](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1088))
* **vs:** add /vs/socraticode comparison page and profile competitor (TRA-1114) ([#1085](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1085))
* **vs:** add trace-mcp vs code-review-graph comparison page (TRA-1001) ([#1040](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1040))
* **vs:** head-to-head page for CodeGraphContext, refresh its facts (TRA-1034) ([#1034](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1034))


### Tests

* **bench:** a SKILL.state A/B whose arms can fail — and one does (TRA-1115) ([#1091](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1091))
* **daemon:** close the guard's SQLite handles so Windows can clean up (TRA-1127) ([#1100](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1100))
* **daemon:** unflake the /health starvation guard — compare p99, not max (TRA-1127) ([#1098](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1098))
* **dashboard-routes:** seed in one transaction instead of 2000 commits (TRA-1104) ([#1070](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1070))
* **db:** cover DomainRepository (TRA-1111) ([#1080](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1080))
* **hooks:** raise hook subprocess timeouts 5s -&gt; 30s (TRA-1117) ([#1081](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1081))
* **launcher:** cover the daemon-aware proxy routing (TRA-1050) ([#1044](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1044))
* **proxy:** guard the daemon-death rescue against the built bundle (TRA-1112) ([#1082](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1082))
* **proxy:** wait for the child to exit before removing its sandbox ([#1103](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1103))
* stop subproject-clone ref test from doing a real git clone ([#1083](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1083))


### CI/CD

* run cross-platform tests on any PR touching shipped code (TRA-1048) ([#1043](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1043))

## [3.22.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.21.0...v3.22.0) (2026-09-06)


### Features

* **docs:** the mark and the wordmark as two generated lockups (TRA-780) ([#1029](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1029))


### Bug Fixes

* **app:** give macOS back its dock margin, the icon shipped a fifth too big (TRA-780) ([#1032](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1032))


### Documentation


## [3.21.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.20.0...v3.21.0) (2026-09-06)


### Features

* **daemon:** thin proxy entrypoint cuts connected-session RSS ~175MB→~73MB (TRA-970) ([#1003](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1003))
* **guard:** nudge long sessions into the StateEngine loop (TRA-763) ([#1010](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1010))
* **tools:** verify an existing document against the index (TRA-1023) ([#1027](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1027))


### Bug Fixes

* **launcher:** recover node and cli.js from the app bundle (TRA-996) ([#1011](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1011))
* **postinstall:** stop the daemon only when a new binary was installed (TRA-1015) ([#1020](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1020))


### Documentation

* code graph mcp cluster — landing-target decision, depgraph.ai facts, tracked query set ([#1026](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1026))
* **perf:** generate the per-tool response-token table instead of typing it (TRA-1020) ([#1023](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1023))
* **seo:** link `tools-reference.html` to MCP tracing, record the TRA-1025 re-derivation ([#1025](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1025))


### Tests

* **bench:** measure PR-review quality, not just tokens (TRA-568) ([#1017](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1017))
* **launcher:** a read-only state home must not cost the session (TRA-1016) ([#1021](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1021))
* **launcher:** cover concurrent client starts on the probe+heal path (TRA-1029) ([#1031](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1031))
* **tools:** gate read-only tool output determinism (TRA-858) ([#1015](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1015))


### CI/CD

* cache pnpm activation via corepack instead of re-downloading per job ([#1014](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1014))

## [3.20.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.19.0...v3.20.0) (2026-09-06)


### Features

* **doctor:** validate the launcher path clients actually spawn ([#988](https://github.com/nikolai-vysotskyi/trace-mcp/issues/988))
* **telemetry:** privacy page, first-run disclosure notice, config opt-out ([#992](https://github.com/nikolai-vysotskyi/trace-mcp/issues/992))


### Bug Fixes

* **app:** every Clients row names its own state (TRA-479) ([#1000](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1000))
* **config:** cap unregistered project sections in .config.json (TRA-706) ([#985](https://github.com/nikolai-vysotskyi/trace-mcp/issues/985))
* **indexer:** resolve Astro/Svelte imports, no new pass needed (TRA-451) ([#993](https://github.com/nikolai-vysotskyi/trace-mcp/issues/993))
* **indexer:** scale ExtractPool to zero within 60s of daemon idle (TRA-971) ([#999](https://github.com/nikolai-vysotskyi/trace-mcp/issues/999))
* **launcher:** name control-plane tmp files so the orphan sweeper collects them (TRA-982) ([#1004](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1004))
* **quality:** index the metadata-existence checks in antipatterns.ts (TRA-940) ([#959](https://github.com/nikolai-vysotskyi/trace-mcp/issues/959))
* **registry:** classify &lt;tmp&gt;/multica-task-&lt;id&gt; checkouts as ephemeral (TRA-992) ([#1007](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1007))
* **search:** exclude synthetic module-body pseudo-symbols on every retrieval path (TRA-985) ([#1006](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1006))
* **search:** reduce instead of spreading the FTS result set ([#957](https://github.com/nikolai-vysotskyi/trace-mcp/issues/957)) ([#976](https://github.com/nikolai-vysotskyi/trace-mcp/issues/976))
* **seo:** let the sitemap generator advance lastmod as soon as git does ([#1009](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1009))
* **server:** stop an orphaned server spinning forever on a dead log pipe (TRA-921) ([#986](https://github.com/nikolai-vysotskyi/trace-mcp/issues/986))
* **test:** bump testTimeout in onnx.test.ts past cold-import contention (TRA-961) ([#995](https://github.com/nikolai-vysotskyi/trace-mcp/issues/995))


### Performance

* **bench:** add session-scaling benchmark harness and v3.18.0 baseline (TRA-931) ([#956](https://github.com/nikolai-vysotskyi/trace-mcp/issues/956))
* **bench:** register a sampling frame before measuring response tokens (TRA-993) ([#1008](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1008))
* **daemon:** serve first requests from the index snapshot before the daemon handshake (TRA-948) ([#1001](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1001))
* **graph:** stop the per-file symbol N+1 in the daemon's graph build (TRA-651) ([#1002](https://github.com/nikolai-vysotskyi/trace-mcp/issues/1002))
* **indexer:** measure indexing throughput by stage before optimizing (TRA-936) ([#968](https://github.com/nikolai-vysotskyi/trace-mcp/issues/968))


### Documentation

* **app:** make electron-cdp's header describe the flags it actually has ([#994](https://github.com/nikolai-vysotskyi/trace-mcp/issues/994))
* lead with the claim, not the mechanism (TRA-918) ([#983](https://github.com/nikolai-vysotskyi/trace-mcp/issues/983))
* **registry:** drop the tool count from the server.json storefront (TRA-761) ([#987](https://github.com/nikolai-vysotskyi/trace-mcp/issues/987))
* **seo:** retarget the comparisons hub at the Serena/Repomix query cluster ([#984](https://github.com/nikolai-vysotskyi/trace-mcp/issues/984))
* **seo:** route `mcp tracing` impressions to /telemetry.html (TRA-974) ([#990](https://github.com/nikolai-vysotskyi/trace-mcp/issues/990))
* **site:** give door 2 a page — what `trace init` installs (TRA-919) ([#998](https://github.com/nikolai-vysotskyi/trace-mcp/issues/998))


### Tests

* **logs:** pin the rotation ceiling on every log under ~/.trace (TRA-707) ([#996](https://github.com/nikolai-vysotskyi/trace-mcp/issues/996))
* **scale:** run the real tools against a 150k-symbol index (TRA-977) ([#997](https://github.com/nikolai-vysotskyi/trace-mcp/issues/997))

## [3.19.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.18.0...v3.19.0) (2026-09-05)


### Features

* **app:** ship the reworked icon and retire the bitmap generator (TRA-780) ([#949](https://github.com/nikolai-vysotskyi/trace-mcp/issues/949))


### Bug Fixes

* **app:** a KPI baseline needs an age, and its caption has to keep one (TRA-960) ([#974](https://github.com/nikolai-vysotskyi/trace-mcp/issues/974))
* **app:** tell a busy daemon from a missing one (TRA-939) ([#963](https://github.com/nikolai-vysotskyi/trace-mcp/issues/963))
* **app:** the Chinese guard card stops calling itself two names (TRA-953) ([#975](https://github.com/nikolai-vysotskyi/trace-mcp/issues/975))
* **app:** the Index card states one condition, not two (TRA-964) ([#980](https://github.com/nikolai-vysotskyi/trace-mcp/issues/980))
* **daemon:** share TopologyStore/DecisionStore/StateEngine across the whole daemon, not per project ([#954](https://github.com/nikolai-vysotskyi/trace-mcp/issues/954))
* **daemon:** stop a running daemon from overriding the session's preset (TRA-951) ([#967](https://github.com/nikolai-vysotskyi/trace-mcp/issues/967))
* **indexer:** index the metadata-existence checks in edge resolvers ([#952](https://github.com/nikolai-vysotskyi/trace-mcp/issues/952))
* **indexer:** stop rebuilding the TS/JS call-edge universe with an N+1 per symbol (TRA-923) ([#961](https://github.com/nikolai-vysotskyi/trace-mcp/issues/961))
* **launcher:** reprobe past an app runtime shim whose target is gone ([#982](https://github.com/nikolai-vysotskyi/trace-mcp/issues/982))
* **server:** scope instructions to the session's advertised tool surface ([#947](https://github.com/nikolai-vysotskyi/trace-mcp/issues/947))
* **tools:** publish get_change_impact's optional params as actually optional (TRA-962) ([#979](https://github.com/nikolai-vysotskyi/trace-mcp/issues/979))


### Performance

* **app:** measure and fix time to first useful paint, per screen ([#955](https://github.com/nikolai-vysotskyi/trace-mcp/issues/955))
* **indexer:** make a reindex that finds nothing cost nothing (TRA-935) ([#964](https://github.com/nikolai-vysotskyi/trace-mcp/issues/964))
* **indexer:** stop probing every manifest name with its own syscall ([#950](https://github.com/nikolai-vysotskyi/trace-mcp/issues/950))
* **savings:** close the response-token measurement tail and stop crediting mutations (TRA-945) ([#965](https://github.com/nikolai-vysotskyi/trace-mcp/issues/965))
* **session:** measure the per-session baseline instead of guessing at it (TRA-925) ([#962](https://github.com/nikolai-vysotskyi/trace-mcp/issues/962))
* **tools:** stop three tools answering more than they were asked (TRA-952) ([#969](https://github.com/nikolai-vysotskyi/trace-mcp/issues/969))


### Documentation

* **antipatterns:** record TRA-944 decision — leave detectMemoryLeak's LIKE group unindexed ([#960](https://github.com/nikolai-vysotskyi/trace-mcp/issues/960))
* **comparisons:** read the largest table entry at source for the first time ([#945](https://github.com/nikolai-vysotskyi/trace-mcp/issues/945))
* **comparisons:** the session-memory entry does not index code — it delegates ([#948](https://github.com/nikolai-vysotskyi/trace-mcp/issues/948))
* make the home page eligible for the code graph mcp cluster ([#966](https://github.com/nikolai-vysotskyi/trace-mcp/issues/966))
* recapture the app screenshots so the dark frame stops photographing the harness (TRA-958) ([#978](https://github.com/nikolai-vysotskyi/trace-mcp/issues/978))
* refresh the app screenshots and correct a stale checklist claim (TRA-955) ([#970](https://github.com/nikolai-vysotskyi/trace-mcp/issues/970))


### Tests

* **design-tokens:** cover parseColor edge cases directly ([#971](https://github.com/nikolai-vysotskyi/trace-mcp/issues/971))
* **launcher:** give the node-probe tests a budget that clears CI contention ([#973](https://github.com/nikolai-vysotskyi/trace-mcp/issues/973))
* **manifests:** anchor the PR-benchmark exemption to the claim, not its neighbourhood (TRA-883) ([#914](https://github.com/nikolai-vysotskyi/trace-mcp/issues/914))

## [3.18.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.17.1...v3.18.0) (2026-09-05)


### Features

* **analytics:** apply and roll back startup-context recommendations (TRA-769) ([#869](https://github.com/nikolai-vysotskyi/trace-mcp/issues/869))
* **analytics:** watch the startup block for growth and notify with one number (TRA-865) ([#907](https://github.com/nikolai-vysotskyi/trace-mcp/issues/907))
* **app:** vector masters and a build script for the app icon (TRA-780) ([#925](https://github.com/nikolai-vysotskyi/trace-mcp/issues/925))
* **docs:** the README download buttons fill the column on a phone (TRA-863) ([#901](https://github.com/nikolai-vysotskyi/trace-mcp/issues/901))
* **indexer:** resolve Ruby require/require_relative import edges (TRA-900) ([#934](https://github.com/nikolai-vysotskyi/trace-mcp/issues/934))
* **state:** register the SKILL.state protocol as an MCP prompt (TRA-799) ([#859](https://github.com/nikolai-vysotskyi/trace-mcp/issues/859))
* **tools:** per-call compute ceiling for heavy graph traversals ([#894](https://github.com/nikolai-vysotskyi/trace-mcp/issues/894))


### Bug Fixes

* **ai:** stop retrying a dead embedding endpoint forever, and stop logging a total failure as "completed" (TRA-812) ([#906](https://github.com/nikolai-vysotskyi/trace-mcp/issues/906))
* **analytics:** gate active_users.month while the window is still filling, and give the savings tripwire a receiver (TRA-843) ([#891](https://github.com/nikolai-vysotskyi/trace-mcp/issues/891))
* **ci:** only a claimed issue collides in check-duplicate-pr (TRA-856) ([#897](https://github.com/nikolai-vysotskyi/trace-mcp/issues/897))
* **daemon:** attribute SIGTERM shutdowns with process-side exit context (TRA-809) ([#871](https://github.com/nikolai-vysotskyi/trace-mcp/issues/871))
* **daemon:** never index or watch a dangerous project root (TRA-893) ([#923](https://github.com/nikolai-vysotskyi/trace-mcp/issues/923))
* **daemon:** record who asks for every daemon stop (TRA-850) ([#893](https://github.com/nikolai-vysotskyi/trace-mcp/issues/893))
* **daemon:** stop the file watcher before awaiting the initial index on shutdown ([#881](https://github.com/nikolai-vysotskyi/trace-mcp/issues/881))
* **docs:** dark-appearance app screenshots for the landing gallery (TRA-851) ([#898](https://github.com/nikolai-vysotskyi/trace-mcp/issues/898))
* **guard:** move server↔hook sentinels out of $TMPDIR (TRA-869) ([#908](https://github.com/nikolai-vysotskyi/trace-mcp/issues/908))
* **indexer:** resolve C/C++ imports, the next language after Rust (TRA-832) ([#895](https://github.com/nikolai-vysotskyi/trace-mcp/issues/895))
* **launcher:** pick the newest package backup, not the first one listed (TRA-881) ([#916](https://github.com/nikolai-vysotskyi/trace-mcp/issues/916))
* **launcher:** stop a throwaway TRACE_MCP_HOME from breaking the real MCP launcher path ([#937](https://github.com/nikolai-vysotskyi/trace-mcp/issues/937))
* **mirror:** exempt spill reads, make the rewrite byte-deterministic (TRA-860) ([#903](https://github.com/nikolai-vysotskyi/trace-mcp/issues/903))
* **scripts:** stop verify-upgrade-path.mjs from bouncing the real daemon (TRA-890) ([#921](https://github.com/nikolai-vysotskyi/trace-mcp/issues/921))
* **tools:** report dropped fs events in get_index_health (TRA-813) ([#875](https://github.com/nikolai-vysotskyi/trace-mcp/issues/875))
* **watcher:** stop() must wait for a handler that already started (TRA-808) ([#866](https://github.com/nikolai-vysotskyi/trace-mcp/issues/866))


### Performance

* **app:** stop freezing the whole app for the length of a daemon restart (TRA-806) ([#867](https://github.com/nikolai-vysotskyi/trace-mcp/issues/867))
* **app:** time the synchronous half of every UI action, and record the 3.17.0 baseline (TRA-835) ([#904](https://github.com/nikolai-vysotskyi/trace-mcp/issues/904))
* **daemon:** release idle extract workers instead of holding ~420 MB forever (TRA-811) ([#874](https://github.com/nikolai-vysotskyi/trace-mcp/issues/874))
* **savings:** score token savings against the measured response, not a constant (TRA-880) ([#915](https://github.com/nikolai-vysotskyi/trace-mcp/issues/915))


### Documentation

* **comparisons:** profile the largest unread peer, take its measurement discipline ([#940](https://github.com/nikolai-vysotskyi/trace-mcp/issues/940))
* **comparisons:** profile the last unread large peer at source, file the two mechanisms worth taking ([#880](https://github.com/nikolai-vysotskyi/trace-mcp/issues/880))
* **comparisons:** record the discipline gap as closed, not open ([#944](https://github.com/nikolai-vysotskyi/trace-mcp/issues/944))
* guard the searchable name after the trace rename (TRA-879) ([#911](https://github.com/nikolai-vysotskyi/trace-mcp/issues/911))
* guard the visible home page copy carries trace-mcp (TRA-907) ([#929](https://github.com/nikolai-vysotskyi/trace-mcp/issues/929))
* **init:** route agents to the SKILL.state tools (TRA-884) ([#913](https://github.com/nikolai-vysotskyi/trace-mcp/issues/913))
* link the six /vs/ pages from the README; record the TRA-905 index-coverage decision ([#931](https://github.com/nikolai-vysotskyi/trace-mcp/issues/931))
* **perf:** preregister and version-stamp every published benchmark (TRA-920) ([#943](https://github.com/nikolai-vysotskyi/trace-mcp/issues/943))
* restate every published savings number on the corrected basis (TRA-904) ([#935](https://github.com/nikolai-vysotskyi/trace-mcp/issues/935))
* **roadmap:** revision 2026-09-05 — the savings counter was an identity, presets move 3.5% of the block (TRA-898) ([#927](https://github.com/nikolai-vysotskyi/trace-mcp/issues/927))
* **seo:** retarget the telemetry page at the 'mcp tracing' query (TRA-897) ([#926](https://github.com/nikolai-vysotskyi/trace-mcp/issues/926))
* **seo:** stop conceding a benchmark we now have on three /vs/ pages (TRA-876) ([#910](https://github.com/nikolai-vysotskyi/trace-mcp/issues/910))
* **site:** add Team section ([#920](https://github.com/nikolai-vysotskyi/trace-mcp/issues/920))


### Tests

* **indexer:** stop the crash-loop dedup case from depending on any timer (TRA-885) ([#918](https://github.com/nikolai-vysotskyi/trace-mcp/issues/918))
* **indexer:** stop the crash-loop dedup case from running the idle timer ([#912](https://github.com/nikolai-vysotskyi/trace-mcp/issues/912))
* measure the mechanical share of real agent edits (TRA-862 gate — fails) ([#905](https://github.com/nikolai-vysotskyi/trace-mcp/issues/905))
* **tools:** enforce cross-tool routing hints with a family drift gate (TRA-842) ([#888](https://github.com/nikolai-vysotskyi/trace-mcp/issues/888))


### Chores

* **security:** deny-by-default token permissions in ga4-snapshot + scanner-config ledger (TRA-903) ([#928](https://github.com/nikolai-vysotskyi/trace-mcp/issues/928))


### CI/CD

* **release:** attach provenance bundles and an SPDX SBOM to releases (TRA-902) ([#932](https://github.com/nikolai-vysotskyi/trace-mcp/issues/932))

## [3.17.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.17.0...v3.17.1) (2026-09-04)


### Bug Fixes

* **daemon:** stop reporting requested shutdowns as exit=1 (TRA-849) ([#890](https://github.com/nikolai-vysotskyi/trace-mcp/issues/890))
* **docs:** a narrow banner cut so the README header stays readable on a phone (TRA-827) ([#877](https://github.com/nikolai-vysotskyi/trace-mcp/issues/877))
* **hooks:** let Bash fall back when trace-mcp is unreachable (TRA-845) ([#889](https://github.com/nikolai-vysotskyi/trace-mcp/issues/889))
* **launcher:** refuse to heal launcher.env when the path is not a regular file ([#883](https://github.com/nikolai-vysotskyi/trace-mcp/issues/883))
* **release:** import the Developer ID certificate ourselves (TRA-844) ([#887](https://github.com/nikolai-vysotskyi/trace-mcp/issues/887))
* **state:** bound the global state.db instead of growing it forever (TRA-830) ([#879](https://github.com/nikolai-vysotskyi/trace-mcp/issues/879))
* **watcher:** reconcile the index when the OS drops fs events ([#892](https://github.com/nikolai-vysotskyi/trace-mcp/issues/892))


### Documentation

* regenerate the config index after db.path lost its default (TRA-810) ([#870](https://github.com/nikolai-vysotskyi/trace-mcp/issues/870))

## [3.17.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.16.0...v3.17.0) (2026-09-04)


### Features

* **analytics:** startup-context audit — what every session pays for before the first message ([#843](https://github.com/nikolai-vysotskyi/trace-mcp/issues/843))
* **analytics:** startup-text compressor — drop what the block already says (TRA-770) ([#845](https://github.com/nikolai-vysotskyi/trace-mcp/issues/845))
* **app:** split app and daemon updates into independent checks ([#790](https://github.com/nikolai-vysotskyi/trace-mcp/issues/790))
* **distribution:** publish the site URL to the MCP registry and npm (TRA-792) ([#855](https://github.com/nikolai-vysotskyi/trace-mcp/issues/855))
* **mirror:** default the Read/Bash window to 24/12, add an opt-in char cap (TRA-750) ([#832](https://github.com/nikolai-vysotskyi/trace-mcp/issues/832))
* **site:** red means danger, not brand — monochrome CTA and chrome (TRA-739) ([#840](https://github.com/nikolai-vysotskyi/trace-mcp/issues/840))


### Bug Fixes

* **app:** a number stops breaking in half, and a Korean word stops splitting (TRA-803) ([#865](https://github.com/nikolai-vysotskyi/trace-mcp/issues/865))
* **app:** clamp the sheet to the window so the first-run actions stay reachable (TRA-794) ([#856](https://github.com/nikolai-vysotskyi/trace-mcp/issues/856))
* **app:** the German KPI label no longer truncates and the wizard uses the app's informal tone (TRA-591) ([#838](https://github.com/nikolai-vysotskyi/trace-mcp/issues/838))
* **docs:** correct the stale tool/resource counts in the README diagram (TRA-608) ([#830](https://github.com/nikolai-vysotskyi/trace-mcp/issues/830))
* **docs:** regenerate config-index after db.path lost its schema default
* **docs:** regenerate llms-full.txt alongside the config index
* **docs:** regenerate stale sitemap lastmod ([#858](https://github.com/nikolai-vysotskyi/trace-mcp/issues/858))
* **docs:** stop the sitemap guard failing on merge-date drift (TRA-800) ([#862](https://github.com/nikolai-vysotskyi/trace-mcp/issues/862))
* **hooks:** port the guard v2 navigation gate to Windows (TRA-757) ([#836](https://github.com/nikolai-vysotskyi/trace-mcp/issues/836))
* **launcher:** an unreadable launcher.env must not kill the server (TRA-797) ([#861](https://github.com/nikolai-vysotskyi/trace-mcp/issues/861))
* **launcher:** refuse to start the server on an unsupported node (TRA-755) ([#831](https://github.com/nikolai-vysotskyi/trace-mcp/issues/831))
* **launcher:** resolve node from a prefix only pkg_roots knows (TRA-742) ([#833](https://github.com/nikolai-vysotskyi/trace-mcp/issues/833))
* **server:** report the attached stdio session so the guard stops degrading (TRA-773) ([#846](https://github.com/nikolai-vysotskyi/trace-mcp/issues/846))
* **server:** the client-profile notice was an instruction, not a note (TRA-796) ([#860](https://github.com/nikolai-vysotskyi/trace-mcp/issues/860))
* **state:** sweep orphaned tmp files in state subdirectories (TRA-783) ([#849](https://github.com/nikolai-vysotskyi/trace-mcp/issues/849))
* **tools:** report the real index path in get_index_health (TRA-802) ([#864](https://github.com/nikolai-vysotskyi/trace-mcp/issues/864))
* **web:** left-align comparison table cells kramdown centres (TRA-741) ([#821](https://github.com/nikolai-vysotskyi/trace-mcp/issues/821))


### Documentation

* benchmark_project is an estimator, not measured tool output (TRA-762) ([#837](https://github.com/nikolai-vysotskyi/trace-mcp/issues/837))
* **comparisons:** give CodeGraphContext a real hub summary (TRA-768) ([#847](https://github.com/nikolai-vysotskyi/trace-mcp/issues/847))
* **comparisons:** give each head-to-head peer real coverage on the hub (TRA-767) ([#842](https://github.com/nikolai-vysotskyi/trace-mcp/issues/842))
* generate a complete config index, and fix the preset-default claim (TRA-801) ([#863](https://github.com/nikolai-vysotskyi/trace-mcp/issues/863))
* **seo:** structured data, citable comparison hub, and number-drift guards (TRA-419) ([#841](https://github.com/nikolai-vysotskyi/trace-mcp/issues/841))
* **site:** cobalt accent instead of red, README header as a generated banner ([#839](https://github.com/nikolai-vysotskyi/trace-mcp/issues/839))


### Chores

* **app-deps:** bump fast-uri and @xmldom/xmldom to patched versions ([#852](https://github.com/nikolai-vysotskyi/trace-mcp/issues/852))
* **security:** scope ga4-snapshot permissions to the job, document alert triage ([#818](https://github.com/nikolai-vysotskyi/trace-mcp/issues/818))


### CI/CD

* make the audit gate depend on advisories, not on npm's uptime ([#853](https://github.com/nikolai-vysotskyi/trace-mcp/issues/853))
* unblock the board — audit job timeouts, and the docs lastmod master is red on ([#850](https://github.com/nikolai-vysotskyi/trace-mcp/issues/850))

## [3.16.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.15.0...v3.16.0) (2026-09-03)


### Features

* **analytics:** publish the client-reporting gate in adoption.yml (TRA-748) ([#827](https://github.com/nikolai-vysotskyi/trace-mcp/issues/827))
* **docs:** rebuild the first screen of the site and the README around one download (TRA-738) ([#819](https://github.com/nikolai-vysotskyi/trace-mcp/issues/819))


### Bug Fixes

* **app:** the theme switcher applies without a restart (TRA-754) ([#828](https://github.com/nikolai-vysotskyi/trace-mcp/issues/828))
* **doctor:** stop flagging trace-mcp's own tool names as competitor directives
* **security:** patch fast-uri/qs advisories and enforce the audit invariant in CI (TRA-733) ([#817](https://github.com/nikolai-vysotskyi/trace-mcp/issues/817))


### Documentation

* **roadmap:** calls is a GA4 custom dimension, not a metric ([#826](https://github.com/nikolai-vysotskyi/trace-mcp/issues/826))

## [3.15.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.14.0...v3.15.0) (2026-09-03)


### Features

* **app:** detect a second installed trace-mcp.app bundle (TRA-692) ([#798](https://github.com/nikolai-vysotskyi/trace-mcp/issues/798))
* **app:** surface a second installed app copy in the app menu (TRA-692)
* **app:** WindowTabBar becomes a real tab bar (TRA-700) ([#807](https://github.com/nikolai-vysotskyi/trace-mcp/issues/807))
* **guard:** guard v2 — intervene only where the win is measured (TRA-711) ([#810](https://github.com/nikolai-vysotskyi/trace-mcp/issues/810))
* **hooks:** Read/Bash output mirror prototype (TRA-725, E1') ([#815](https://github.com/nikolai-vysotskyi/trace-mcp/issues/815))
* **plugins:** add Agent Plugins v1.0.0 root manifest and MCP config (TRA-634) ([#791](https://github.com/nikolai-vysotskyi/trace-mcp/issues/791))


### Bug Fixes

* **analytics:** keep session ingestion current and make staleness visible (TRA-695) ([#802](https://github.com/nikolai-vysotskyi/trace-mcp/issues/802))
* collect ~/.trace-mcp state that nothing ever swept (TRA-702) ([#804](https://github.com/nikolai-vysotskyi/trace-mcp/issues/804))
* **daemon:** name the dropped dangerous root instead of re-asking for a hint (TRA-720) ([#814](https://github.com/nikolai-vysotskyi/trace-mcp/issues/814))
* **daemon:** report cleanup-tier failures on project removal (TRA-559) ([#797](https://github.com/nikolai-vysotskyi/trace-mcp/issues/797))
* **hooks:** strip CRLF from mirror hook output on Windows (TRA-743) ([#822](https://github.com/nikolai-vysotskyi/trace-mcp/issues/822))
* **indexer:** stop mangling hyphenated CMake targets and add_subdirectory edges (TRA-622) ([#750](https://github.com/nikolai-vysotskyi/trace-mcp/issues/750))
* **launcher:** resolve cli.js independently of the selected node (TRA-701) ([#806](https://github.com/nikolai-vysotskyi/trace-mcp/issues/806))
* **launcher:** stop the legacy bin path freezing at its install-time shim (TRA-716) ([#809](https://github.com/nikolai-vysotskyi/trace-mcp/issues/809))
* **migration:** copy files byte-for-byte, not through a UTF-8 string (TRA-732) ([#816](https://github.com/nikolai-vysotskyi/trace-mcp/issues/816))
* **navigation:** resolve cwd-relative paths to the indexed file (TRA-693) ([#800](https://github.com/nikolai-vysotskyi/trace-mcp/issues/800))
* **serve:** keep daemon auto-spawn off the stdio handshake path ([#805](https://github.com/nikolai-vysotskyi/trace-mcp/issues/805))
* **serve:** move auto-update off the MCP initialize path (TRA-703) ([#808](https://github.com/nikolai-vysotskyi/trace-mcp/issues/808))
* **web:** sweep the scroll hint, the one label nothing measured (TRA-564) ([#794](https://github.com/nikolai-vysotskyi/trace-mcp/issues/794))


### Performance

* **app:** code-split the four secondary project tabs out of startup (TRA-593) ([#792](https://github.com/nikolai-vysotskyi/trace-mcp/issues/792))
* **hooks:** detach the reindex dispatch so an edit never waits on the daemon ([#801](https://github.com/nikolai-vysotskyi/trace-mcp/issues/801))


### Documentation

* **comparisons:** refresh peer facts and record this pass's source reads ([#777](https://github.com/nikolai-vysotskyi/trace-mcp/issues/777))
* competitor-vs-competitor page — Repomix vs codegraph ([#795](https://github.com/nikolai-vysotskyi/trace-mcp/issues/795))
* **seo:** link source files by GitHub URL instead of paths that 404 on the site ([#793](https://github.com/nikolai-vysotskyi/trace-mcp/issues/793))
* **state:** say that trace_state_* is off the default surface (TRA-723) ([#811](https://github.com/nikolai-vysotskyi/trace-mcp/issues/811))


### Tests

* **presets:** guard every preset's tools/list budget, not just the listed ones (TRA-719) ([#812](https://github.com/nikolai-vysotskyi/trace-mcp/issues/812))


### CI/CD

* verify the Windows update path on a real install ([#775](https://github.com/nikolai-vysotskyi/trace-mcp/issues/775))

## [3.14.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.13.0...v3.14.0) (2026-09-02)


### Features

* **docs:** publish the saved-token counter on the homepage and in the README ([#774](https://github.com/nikolai-vysotskyi/trace-mcp/issues/774))
* **tools:** ship the router preset and make batch-as-door deliberate (TRA-675) ([#785](https://github.com/nikolai-vysotskyi/trace-mcp/issues/785))


### Bug Fixes

* **search:** honor glob wildcards in search's file_pattern filter (TRA-676) ([#784](https://github.com/nikolai-vysotskyi/trace-mcp/issues/784))


### Documentation

* **app:** warn app builds &lt;=3.10.0 they must reinstall (TRA-687) ([#786](https://github.com/nikolai-vysotskyi/trace-mcp/issues/786))
* correct Multica agent mcp_config semantics ([#789](https://github.com/nikolai-vysotskyi/trace-mcp/issues/789))
* lead with the benchmark measured on other people's code (TRA-647) ([#752](https://github.com/nikolai-vysotskyi/trace-mcp/issues/752))

## [3.13.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.12.0...v3.13.0) (2026-09-02)


### Features

* **tools:** explain empty results with a capped, data-derived note (TRA-680) ([#779](https://github.com/nikolai-vysotskyi/trace-mcp/issues/779))


### Bug Fixes

* **site:** generate llms-full.txt, guard llms.txt against page drift (TRA-681) ([#780](https://github.com/nikolai-vysotskyi/trace-mcp/issues/780))


### Performance

* **app:** let the Graph tab go quiet when nobody is watching (TRA-683) ([#783](https://github.com/nikolai-vysotskyi/trace-mcp/issues/783))
* **app:** reconcile both TRA-617 passes, measure the app offscreen, price the idle Graph tab ([#781](https://github.com/nikolai-vysotskyi/trace-mcp/issues/781))


### Documentation

* add TechArticle schema to three pages and guard it in CI ([#776](https://github.com/nikolai-vysotskyi/trace-mcp/issues/776))

## [3.12.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.11.0...v3.12.0) (2026-09-02)


### Features

* **app:** first-run setup wizard with MCP client detection and project guessing (TRA-439) ([#710](https://github.com/nikolai-vysotskyi/trace-mcp/issues/710))
* **app:** flag legacy trace-mcp client entries and offer a one-click Migrate (TRA-614) ([#724](https://github.com/nikolai-vysotskyi/trace-mcp/issues/724))
* **core,cli:** trace bin alias, McpServer identity, config paths, and client auto-migration (TRA-611) ([#730](https://github.com/nikolai-vysotskyi/trace-mcp/issues/730))
* **eval:** measure SKILL.state savings on real sessions, not constants (TRA-600) ([#765](https://github.com/nikolai-vysotskyi/trace-mcp/issues/765))
* **state:** implement SKILL.state linear context engine (TRA-596) ([#715](https://github.com/nikolai-vysotskyi/trace-mcp/issues/715))
* **telemetry:** put a funnel behind active installs (TRA-645) ([#745](https://github.com/nikolai-vysotskyi/trace-mcp/issues/745))
* **telemetry:** read the ping's `calls` to measure use, not just setup (TRA-673) ([#773](https://github.com/nikolai-vysotskyi/trace-mcp/issues/773))
* **telemetry:** report daemon starts and unclean stops in the daily ping (TRA-671) ([#770](https://github.com/nikolai-vysotskyi/trace-mcp/issues/770))
* **telemetry:** report the active preset and advertised tool count, and fix the client-name clobber ([#748](https://github.com/nikolai-vysotskyi/trace-mcp/issues/748))
* **web:** cut the hero to one download and one command (TRA-609) ([#718](https://github.com/nikolai-vysotskyi/trace-mcp/issues/718))


### Bug Fixes

* **analytics,hooks,plugins:** recognize trace as a trace-mcp server key (TRA-641) ([#755](https://github.com/nikolai-vysotskyi/trace-mcp/issues/755))
* **app:** a badge tint is opaque, so its measured contrast is the one it renders ([#731](https://github.com/nikolai-vysotskyi/trace-mcp/issues/731))
* **app:** a file row shows its location whole or not at all (TRA-504) ([#725](https://github.com/nikolai-vysotskyi/trace-mcp/issues/725))
* **app:** enable custom WindowTabBar across all platforms including macOS ([#716](https://github.com/nikolai-vysotskyi/trace-mcp/issues/716))
* **app:** Project Overview states a section failure once, without inventing a cause (TRA-662) ([#762](https://github.com/nikolai-vysotskyi/trace-mcp/issues/762))
* **app:** spawn the CLI through a real executable on Windows (TRA-638) ([#738](https://github.com/nikolai-vysotskyi/trace-mcp/issues/738))
* **app:** the guard card says "not running" once, and says what to do about it (TRA-490) ([#759](https://github.com/nikolai-vysotskyi/trace-mcp/issues/759))
* **ci:** exempt the release PR from the duplicate-work guard ([#736](https://github.com/nikolai-vysotskyi/trace-mcp/issues/736))
* **db:** don't crash reindex on cross-file ORM associations (TRA-663) ([#763](https://github.com/nikolai-vysotskyi/trace-mcp/issues/763))
* **docs:** date sitemap pages by author date, not committer date (TRA-637) ([#729](https://github.com/nikolai-vysotskyi/trace-mcp/issues/729))
* **indexer:** stop mangling multi-target .PHONY lines into one symbol (TRA-618) ([#721](https://github.com/nikolai-vysotskyi/trace-mcp/issues/721))
* **indexer:** stop truncating CMake include/find_package/add_subdirectory paths (TRA-670) ([#772](https://github.com/nikolai-vysotskyi/trace-mcp/issues/772))
* **indexer:** support framework and manifest detection in monorepos ([#705](https://github.com/nikolai-vysotskyi/trace-mcp/issues/705)) ([#711](https://github.com/nikolai-vysotskyi/trace-mcp/issues/711))
* **init:** migrate legacy mcp__trace-mcp__ tool prefix in settings.json (TRA-650) ([#756](https://github.com/nikolai-vysotskyi/trace-mcp/issues/756))
* **release:** sign, notarize and staple the macOS DMG container ([#728](https://github.com/nikolai-vysotskyi/trace-mcp/issues/728))
* **scripts:** resolve the CLI state dir instead of hardcoding ~/.trace-mcp (TRA-667) ([#767](https://github.com/nikolai-vysotskyi/trace-mcp/issues/767))
* **server:** fall back to the default preset, not the full surface, on an unknown preset name (TRA-648) ([#753](https://github.com/nikolai-vysotskyi/trace-mcp/issues/753))
* **tests:** use file:// URLs for the trace-home subprocess harness (TRA-672) ([#769](https://github.com/nikolai-vysotskyi/trace-mcp/issues/769))
* **update:** align Windows NSIS naming, fail-closed channel manifest audit, per-bundle running detection (TRA-592) ([#742](https://github.com/nikolai-vysotskyi/trace-mcp/issues/742))
* **web:** drive the homepage footer from docs_nav, and guard it (TRA-629) ([#733](https://github.com/nikolai-vysotskyi/trace-mcp/issues/733))
* **web:** make the landing footer's doc list read down, and pull /Contact up ([#739](https://github.com/nikolai-vysotskyi/trace-mcp/issues/739))
* **web:** raise --text-disabled and dark --accent to clear 4.5:1 (TRA-539) ([#719](https://github.com/nikolai-vysotskyi/trace-mcp/issues/719))
* **web:** stack the hero's two mono caps rows on a phone (TRA-607) ([#771](https://github.com/nikolai-vysotskyi/trace-mcp/issues/771))


### Performance

* **app:** stop staging 132 MB the embedded daemon cannot reach (TRA-605) ([#743](https://github.com/nikolai-vysotskyi/trace-mcp/issues/743))
* **bench:** measure trace-mcp → trace token savings across 4 tokenizers (TRA-613) ([#720](https://github.com/nikolai-vysotskyi/trace-mcp/issues/720))
* **tools:** land role-based tool presets with re-measured budgets (TRA-603, TRA-601) ([#732](https://github.com/nikolai-vysotskyi/trace-mcp/issues/732))


### Documentation

* **config:** document Multica workspace agent MCP preset wiring (TRA-604) ([#747](https://github.com/nikolai-vysotskyi/trace-mcp/issues/747))
* **configuration:** warn that --preset needs a release that has it (TRA-664) ([#764](https://github.com/nikolai-vysotskyi/trace-mcp/issues/764))
* **contributing:** record why master's protection is not strict ([#751](https://github.com/nikolai-vysotskyi/trace-mcp/issues/751))
* decide the trace rename — command, not project (TRA-644) ([#741](https://github.com/nikolai-vysotskyi/trace-mcp/issues/741))
* link the docs pages into four topical clusters ([#757](https://github.com/nikolai-vysotskyi/trace-mcp/issues/757))
* point the state-directory and CLI references at what the code actually does (TRA-666) ([#766](https://github.com/nikolai-vysotskyi/trace-mcp/issues/766))
* read the PR-benchmark counts from the data file, not by hand ([#760](https://github.com/nikolai-vysotskyi/trace-mcp/issues/760))
* refresh app screenshots at v3.11.0 (TRA-630) ([#746](https://github.com/nikolai-vysotskyi/trace-mcp/issues/746))
* **roadmap:** activation measures setup, not use — read `calls` by client (TRA-668) ([#768](https://github.com/nikolai-vysotskyi/trace-mcp/issues/768))
* **roadmap:** add the evidence item — the one outside measurement is on no entry surface (TRA-616) ([#749](https://github.com/nikolai-vysotskyi/trace-mcp/issues/749))
* **roadmap:** record the State Engine positioning question (TRA-616) ([#754](https://github.com/nikolai-vysotskyi/trace-mcp/issues/754))
* **roadmap:** revise for v3.11.0 — presets supersede tool consolidation, adoption is live (TRA-625) ([#740](https://github.com/nikolai-vysotskyi/trace-mcp/issues/740))


### Tests

* **app:** give the AskTab lazy-import test a timeout that fits what it loads ([#734](https://github.com/nikolai-vysotskyi/trace-mcp/issues/734))
* **app:** wait for the guessed-project card before clicking Change folder (TRA-640) ([#761](https://github.com/nikolai-vysotskyi/trace-mcp/issues/761))


### CI/CD

* fail when waiting_for_release is set against an unmerged PR (TRA-659) ([#758](https://github.com/nikolai-vysotskyi/trace-mcp/issues/758))
* **release:** gate the Apple signing secrets behind a branch-protected environment ([#737](https://github.com/nikolai-vysotskyi/trace-mcp/issues/737))

## [3.11.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.10.0...v3.11.0) (2026-09-01)


### Features

* **topology,memory:** add stale root pruning to topology.db and decisions.db (TRA-595) ([#714](https://github.com/nikolai-vysotskyi/trace-mcp/issues/714))


### Bug Fixes

* **app:** clamp KpiTile label and comparison spans to preserve TILE_H (TRA-492) ([#713](https://github.com/nikolai-vysotskyi/trace-mcp/issues/713))
* **app:** remove broken native macOS tab bar under hiddenInset (TRA-587) ([#708](https://github.com/nikolai-vysotskyi/trace-mcp/issues/708))
* **app:** resolve autoUpdater dynamic export and wrap long menu header status text ([#707](https://github.com/nikolai-vysotskyi/trace-mcp/issues/707))
* **init:** update tool routing table and stale hint references (TRA-579) ([#712](https://github.com/nikolai-vysotskyi/trace-mcp/issues/712))

## [3.10.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.9.0...v3.10.0) (2026-08-31)


### Features

* **app:** the app installs and repairs its own daemon (TRA-438) ([#692](https://github.com/nikolai-vysotskyi/trace-mcp/issues/692))
* **bench:** measure PR-review context cost on 60 real merged PRs (TRA-534) ([#699](https://github.com/nikolai-vysotskyi/trace-mcp/issues/699))
* **docs:** lead with the signed DMG on the site and in the README ([#697](https://github.com/nikolai-vysotskyi/trace-mcp/issues/697))


### Bug Fixes

* **ci:** stop compiling better-sqlite3 — use its bundled prebuilds (TRA-567) ([#700](https://github.com/nikolai-vysotskyi/trace-mcp/issues/700))
* **config:** rewrite the pre-v3.3 `tools.preset: "full"` default on upgrade (TRA-538) ([#693](https://github.com/nikolai-vysotskyi/trace-mcp/issues/693))
* **indexer:** resolve Rust imports, the next language after Java (TRA-565) ([#698](https://github.com/nikolai-vysotskyi/trace-mcp/issues/698))
* **release:** demote an unverified release out of `latest` (TRA-566) ([#701](https://github.com/nikolai-vysotskyi/trace-mcp/issues/701))
* **site:** light-mode disabled text was measured against the wrong background ([#695](https://github.com/nikolai-vysotskyi/trace-mcp/issues/695))


### Tests

* **update:** verify the upgrade path against real releases (TRA-562) ([#694](https://github.com/nikolai-vysotskyi/trace-mcp/issues/694))

## [3.9.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.8.0...v3.9.0) (2026-08-30)


### Features

* **app:** move macOS to electron-updater and delete the staged-zip updater (TRA-437) ([#689](https://github.com/nikolai-vysotskyi/trace-mcp/issues/689))


### Documentation



### Tests

* **app:** cover the restart-budget guard where checkHealth calls it (TRA-558) ([#688](https://github.com/nikolai-vysotskyi/trace-mcp/issues/688))

## [3.8.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.7.0...v3.8.0) (2026-08-30)


### Features

* **analytics:** price the saved-token counter server-side, capped for inflation ([#682](https://github.com/nikolai-vysotskyi/trace-mcp/issues/682))
* **app:** sign and notarize macOS builds, ship DMG per architecture ([#584](https://github.com/nikolai-vysotskyi/trace-mcp/issues/584))


### Bug Fixes

* **app:** a "starting" daemon must not refill the restart budget (TRA-543) ([#683](https://github.com/nikolai-vysotskyi/trace-mcp/issues/683))
* **daemon:** a losing spawn can no longer report the live daemon as dead (TRA-525) ([#663](https://github.com/nikolai-vysotskyi/trace-mcp/issues/663))
* **update:** re-check whether the app is running per bundle (TRA-555) ([#687](https://github.com/nikolai-vysotskyi/trace-mcp/issues/687))
* **update:** update every installed bundle, not just the resolved one (TRA-535) ([#672](https://github.com/nikolai-vysotskyi/trace-mcp/issues/672))


### Documentation

* **vs:** read Serena's source, correct four rows in its favour (TRA-547) ([#684](https://github.com/nikolai-vysotskyi/trace-mcp/issues/684))

## [3.7.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.6.0...v3.7.0) (2026-08-30)


### Features

* **telemetry:** add client and timezone dimensions to the daily ping ([#659](https://github.com/nikolai-vysotskyi/trace-mcp/issues/659))
* **telemetry:** country, model and indexed-repo count; drop raw timezone ([#667](https://github.com/nikolai-vysotskyi/trace-mcp/issues/667))
* **telemetry:** install type, previous version and machine class ([#671](https://github.com/nikolai-vysotskyi/trace-mcp/issues/671))


### Bug Fixes

* **app:** a project tab must not hold a daemon socket while it is off screen ([#670](https://github.com/nikolai-vysotskyi/trace-mcp/issues/670))
* **app:** delete the 20px segmented control, not its latest victim (TRA-522) ([#658](https://github.com/nikolai-vysotskyi/trace-mcp/issues/658))
* **app:** one focus ring per control, on the control's own boundary (TRA-521) ([#662](https://github.com/nikolai-vysotskyi/trace-mcp/issues/662))
* **app:** stop the daemon restart loop the wedged guard was meant to stop (TRA-543) ([#681](https://github.com/nikolai-vysotskyi/trace-mcp/issues/681))
* **app:** the graph filter popover stays inside the graph pane ([#661](https://github.com/nikolai-vysotskyi/trace-mcp/issues/661))
* **app:** the tab bar is 20px, not 36 — lights back on the tab centre line (TRA-523) ([#664](https://github.com/nikolai-vysotskyi/trace-mcp/issues/664))
* **ci:** publish the adoption snapshot to a data branch, not a PR ([#678](https://github.com/nikolai-vysotskyi/trace-mcp/issues/678))
* **ci:** route the adoption snapshot through a PR, not a push to master ([#674](https://github.com/nikolai-vysotskyi/trace-mcp/issues/674))
* **daemon:** decision rows survived project removal in every build (TRA-542) ([#680](https://github.com/nikolai-vysotskyi/trace-mcp/issues/680))
* **docs:** the sitemap generator stops revising published dates backwards ([#652](https://github.com/nikolai-vysotskyi/trace-mcp/issues/652))
* **registry:** stop agent workdirs leaking into the registry and topology store (TRA-527) ([#660](https://github.com/nikolai-vysotskyi/trace-mcp/issues/660))
* restore what [#659](https://github.com/nikolai-vysotskyi/trace-mcp/issues/659) reverted, gate the shape that let it through (TRA-528) ([#665](https://github.com/nikolai-vysotskyi/trace-mcp/issues/665))
* **svelte:** extract $props() destructuring as component props ([#668](https://github.com/nikolai-vysotskyi/trace-mcp/issues/668))
* **web:** label, focus and keyboard-reach the landing quickstart terminal ([#676](https://github.com/nikolai-vysotskyi/trace-mcp/issues/676))


### Performance

* **app:** load the Ask tab's markdown stack with the tab (TRA-532) ([#669](https://github.com/nikolai-vysotskyi/trace-mcp/issues/669))


### Documentation



### CI/CD

* **codeql:** exclude the filesystem-taint rule family (TRA-518) ([#653](https://github.com/nikolai-vysotskyi/trace-mcp/issues/653))
* lockfile, Dependabot and CI coverage for packages/vscode-extension ([#654](https://github.com/nikolai-vysotskyi/trace-mcp/issues/654))

## [3.6.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.5.2...v3.6.0) (2026-08-30)


### Features

* **clients:** report each client's current enforcement level (TRA-498) ([#637](https://github.com/nikolai-vysotskyi/trace-mcp/issues/637))
* **server:** tailor the advertised surface to the connected MCP client (TRA-513) ([#648](https://github.com/nikolai-vysotskyi/trace-mcp/issues/648))


### Bug Fixes

* **app:** MCP clients — the row actions never ran, and six drifted rows took six clicks (TRA-497) ([#638](https://github.com/nikolai-vysotskyi/trace-mcp/issues/638))
* **app:** Project Overview reads all three daemon states, not one (TRA-489) ([#632](https://github.com/nikolai-vysotskyi/trace-mcp/issues/632))
* **app:** shorten the Russian KPI delta caption to one line (TRA-464) ([#630](https://github.com/nikolai-vysotskyi/trace-mcp/issues/630))
* **app:** the KPI strip stops arguing with the banner above it (TRA-488) ([#627](https://github.com/nikolai-vysotskyi/trace-mcp/issues/627))
* **app:** the sidebar file row leads with the filename, not the path (TRA-503) ([#640](https://github.com/nikolai-vysotskyi/trace-mcp/issues/640))
* **clients:** a global MCP registration no longer carries the caller's cwd (TRA-501) ([#639](https://github.com/nikolai-vysotskyi/trace-mcp/issues/639))
* **indexer:** resolve Java imports, the next language after Go (TRA-483) ([#623](https://github.com/nikolai-vysotskyi/trace-mcp/issues/623))
* **search:** scope the subproject fan-out to the requested project (TRA-470) ([#626](https://github.com/nikolai-vysotskyi/trace-mcp/issues/626))
* **site:** a code block that scrolls says so, and every scroll region has a ring (TRA-508) ([#645](https://github.com/nikolai-vysotskyi/trace-mcp/issues/645))
* **tools:** get_untested_symbols reports the actionable tier by default (TRA-515) ([#650](https://github.com/nikolai-vysotskyi/trace-mcp/issues/650))
* **update:** target the running bundle, reclaim orphaned staging ([#644](https://github.com/nikolai-vysotskyi/trace-mcp/issues/644))
* **workspace:** a dead daemon gets one verdict from the KPI strip, not two (TRA-495) ([#633](https://github.com/nikolai-vysotskyi/trace-mcp/issues/633))


### Documentation

* add the scip_resolved tier to the stale resolution-tier tables ([#628](https://github.com/nikolai-vysotskyi/trace-mcp/issues/628))
* **comparisons:** profile the largest LSP-native peer, correct its debugger claim (TRA-511) ([#646](https://github.com/nikolai-vysotskyi/trace-mcp/issues/646))
* **design:** a review run must isolate the daemon, not just the screen (TRA-502) ([#641](https://github.com/nikolai-vysotskyi/trace-mcp/issues/641))
* fifth head-to-head page — trace-mcp vs Context Mode ([#629](https://github.com/nikolai-vysotskyi/trace-mcp/issues/629))
* pin /perf/ with a permalink, undoing a soft 404 from [#635](https://github.com/nikolai-vysotskyi/trace-mcp/issues/635) ([#636](https://github.com/nikolai-vysotskyi/trace-mcp/issues/636))
* publish the tool index — 101 registered tools had no entry anywhere (TRA-505) ([#642](https://github.com/nikolai-vysotskyi/trace-mcp/issues/642))
* publish two orphan pages, noindex three internal ones ([#635](https://github.com/nikolai-vysotskyi/trace-mcp/issues/635))


### Tests

* **init:** cover the Hermes guard-hook installer (TRA-514) ([#649](https://github.com/nikolai-vysotskyi/trace-mcp/issues/649))
* skip POSIX exec-bit assertion on Windows in hermes-hooks ([#651](https://github.com/nikolai-vysotskyi/trace-mcp/issues/651))

## [3.5.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.5.1...v3.5.2) (2026-08-30)


### Bug Fixes

* **app:** the dashboard at rest marks nothing selected (TRA-475) ([#617](https://github.com/nikolai-vysotskyi/trace-mcp/issues/617))
* **app:** the sidebar file list can no longer pulse a skeleton forever (TRA-478) ([#622](https://github.com/nikolai-vysotskyi/trace-mcp/issues/622))


### Documentation

* a settled screenshot is not the only frame worth checking (TRA-465) ([#620](https://github.com/nikolai-vysotskyi/trace-mcp/issues/620))


### CI/CD

* fail a PR that duplicates an open PR on the same issue (TRA-476) ([#618](https://github.com/nikolai-vysotskyi/trace-mcp/issues/618))

## [3.5.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.5.0...v3.5.1) (2026-08-30)


### Bug Fixes

* **app:** a baseline taken while the daemon was silent is not a baseline ([#602](https://github.com/nikolai-vysotskyi/trace-mcp/issues/602))
* **app:** centre the daemon-down pane on Project Overview (TRA-469) ([#614](https://github.com/nikolai-vysotskyi/trace-mcp/issues/614))
* **app:** point the quarantine command at the real install path ([#604](https://github.com/nikolai-vysotskyi/trace-mcp/issues/604))
* **app:** Project Overview says a dead daemon once, not six times (TRA-469) ([#611](https://github.com/nikolai-vysotskyi/trace-mcp/issues/611))
* **app:** the KPI strip is a grid of equal tracks, not a wrapping flexbox (TRA-467) ([#608](https://github.com/nikolai-vysotskyi/trace-mcp/issues/608))
* **app:** the projects table shades what its pinned column covers ([#596](https://github.com/nikolai-vysotskyi/trace-mcp/issues/596))
* **app:** the sidebar file list stops blaming the scope for a dead daemon (TRA-471) ([#615](https://github.com/nikolai-vysotskyi/trace-mcp/issues/615))
* **indexer:** reconcile scope on full reindex, keep git-ignored files out ([#610](https://github.com/nikolai-vysotskyi/trace-mcp/issues/610))
* **site:** a scrollable table says so (TRA-461) ([#606](https://github.com/nikolai-vysotskyi/trace-mcp/issues/606))
* **workspace:** measure the pane before the first paint, not after it ([#612](https://github.com/nikolai-vysotskyi/trace-mcp/issues/612))
* **workspace:** two overlapping KPI sets stop wearing the grammar of a partition (TRA-459) ([#605](https://github.com/nikolai-vysotskyi/trace-mcp/issues/605))


### Documentation

* price the default tool surface on one basis everywhere (TRA-448) ([#597](https://github.com/nikolai-vysotskyi/trace-mcp/issues/597))
* re-measure the standard tool surface on comparisons.md (TRA-455) ([#601](https://github.com/nikolai-vysotskyi/trace-mcp/issues/601))
* **workspace:** two comments in Workspace.tsx that TRA-467 left behind ([#616](https://github.com/nikolai-vysotskyi/trace-mcp/issues/616))


### Chores

* **deps:** unblock i18next 26 + react-i18next 17, restore the commander hold ([#607](https://github.com/nikolai-vysotskyi/trace-mcp/issues/607))

## [3.5.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.4.0...v3.5.0) (2026-08-29)


### Features

* **app:** a pop-up language picker with ten languages ([#594](https://github.com/nikolai-vysotskyi/trace-mcp/issues/594))
* **app:** ship Spanish and Simplified Chinese (TRA-389) ([#592](https://github.com/nikolai-vysotskyi/trace-mcp/issues/592))


### Bug Fixes

* **indexer:** resolve Go imports, stop the matrix overclaiming import edges (TRA-449) ([#593](https://github.com/nikolai-vysotskyi/trace-mcp/issues/593))
* **site:** capability marks are monochrome text, not emoji (TRA-447) ([#591](https://github.com/nikolai-vysotskyi/trace-mcp/issues/591))
* **telemetry:** make GA4 count installs as active users, report tokens saved ([#585](https://github.com/nikolai-vysotskyi/trace-mcp/issues/585))
* **update:** trust the bundle's Info.plist over the version marker ([#589](https://github.com/nikolai-vysotskyi/trace-mcp/issues/589))


### Documentation

* bring the i18n docs back in line with what ships (TRA-379) ([#595](https://github.com/nikolai-vysotskyi/trace-mcp/issues/595))


### Tests

* **docs:** guard the default-surface claims on the vs/ comparison pages (TRA-427) ([#586](https://github.com/nikolai-vysotskyi/trace-mcp/issues/586))

## [3.4.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.3.0...v3.4.0) (2026-08-29)


### Features

* **app:** a Language row in the app menu and in Settings (TRA-388) ([#579](https://github.com/nikolai-vysotskyi/trace-mcp/issues/579))


### Bug Fixes

* **app:** never swap a running bundle, never call an already-installed update stuck ([#581](https://github.com/nikolai-vysotskyi/trace-mcp/issues/581))
* **app:** put the sidebar update card on the Lattice layer ([#582](https://github.com/nikolai-vysotskyi/trace-mcp/issues/582))
* **app:** the AppKit tab bar is 28px, not 36 — lights sat 4px low ([#583](https://github.com/nikolai-vysotskyi/trace-mcp/issues/583))


### Documentation

* add the trace-mcp vs codegraph head-to-head page (TRA-427) ([#578](https://github.com/nikolai-vysotskyi/trace-mcp/issues/578))
* dead evidence anchor in skills/README + verified distribution-ledger rows (TRA-393) ([#575](https://github.com/nikolai-vysotskyi/trace-mcp/issues/575))
* disambiguate tune_decision_weights vs tune_weights, record consolidation-retirement policy (TRA-205) ([#577](https://github.com/nikolai-vysotskyi/trace-mcp/issues/577))
* the menu's control column is an inset, not an x coordinate (TRA-388) ([#580](https://github.com/nikolai-vysotskyi/trace-mcp/issues/580))

## [3.3.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.2.0...v3.3.0) (2026-08-29)


### Features

* **app:** i18n runtime, en/ru catalogues and a check against inline strings (TRA-379) ([#535](https://github.com/nikolai-vysotskyi/trace-mcp/issues/535))
* **app:** read Settings, the config schema and the Guard panels from the catalogue (TRA-383) ([#541](https://github.com/nikolai-vysotskyi/trace-mcp/issues/541))
* **app:** read the exploration tabs from the string catalogue (TRA-385) ([#545](https://github.com/nikolai-vysotskyi/trace-mcp/issues/545))
* **app:** read the overview and activity tabs from the catalogue (TRA-384) ([#543](https://github.com/nikolai-vysotskyi/trace-mcp/issues/543))
* **app:** read the workspace, sidebar, app shell and UI primitives from the catalogue (TRA-387) ([#568](https://github.com/nikolai-vysotskyi/trace-mcp/issues/568))
* **app:** translate the application menu, the tray and the main-process dialog (TRA-386) ([#539](https://github.com/nikolai-vysotskyi/trace-mcp/issues/539))
* **server:** progressive tool disclosure — minimal default + load_tools (TRA-402) ([#553](https://github.com/nikolai-vysotskyi/trace-mcp/issues/553)), closes [#519](https://github.com/nikolai-vysotskyi/trace-mcp/issues/519)


### Bug Fixes

* **app:** bound the sidebar material against --surface in both appearances (TRA-369) ([#529](https://github.com/nikolai-vysotskyi/trace-mcp/issues/529))
* **app:** drive the app without taking the screen (TRA-403) ([#554](https://github.com/nikolai-vysotskyi/trace-mcp/issues/554))
* **app:** every unpackaged build runs as an accessory app (TRA-407) ([#559](https://github.com/nikolai-vysotskyi/trace-mcp/issues/559))
* **app:** give Insights' report picker a narrow form so every report stays reachable ([#534](https://github.com/nikolai-vysotskyi/trace-mcp/issues/534))
* **app:** group the app menu by what an item does, and take the theme pill's proportions from the reference (TRA-376) ([#538](https://github.com/nikolai-vysotskyi/trace-mcp/issues/538))
* **app:** guard setActivationPolicy on darwin, give dev:electron the opt-out ([#567](https://github.com/nikolai-vysotskyi/trace-mcp/issues/567))
* **app:** honour TRACE_MCP_AGENT_RUN as well (TRA-403) ([#557](https://github.com/nikolai-vysotskyi/trace-mcp/issues/557))
* **app:** one state for a slow daemon, and numbers that go stale instead of blank ([#550](https://github.com/nikolai-vysotskyi/trace-mcp/issues/550))
* **app:** report a stale npm root only when MCP clients run it ([#537](https://github.com/nikolai-vysotskyi/trace-mcp/issues/537))
* **app:** the native tab bar is a second top band, not a replacement (TRA-399) ([#552](https://github.com/nikolai-vysotskyi/trace-mcp/issues/552))
* **config:** index every registered language by default (TRA-400) ([#549](https://github.com/nikolai-vysotskyi/trace-mcp/issues/549))
* **daemon:** enforce the loaded-project cap in steady state, not just at boot ([#572](https://github.com/nikolai-vysotskyi/trace-mcp/issues/572))
* **daemon:** stop the health watchdog from killing a busy daemon (TRA-421) ([#573](https://github.com/nikolai-vysotskyi/trace-mcp/issues/573))
* **docs:** install surfaces advertised the 99% peak as the token average (TRA-393) ([#542](https://github.com/nikolai-vysotskyi/trace-mcp/issues/542))
* **docs:** name the seven tools retired in v2.0.0, and hint them at call time (TRA-412) ([#566](https://github.com/nikolai-vysotskyi/trace-mcp/issues/566))
* **docs:** photograph the window, and refuse a frame without its chrome (TRA-390) ([#544](https://github.com/nikolai-vysotskyi/trace-mcp/issues/544))
* **indexer:** register the VHDL language plugin, publish a capability matrix ([#547](https://github.com/nikolai-vysotskyi/trace-mcp/issues/547))
* **logger:** serialize Errors logged under the `error` key ([#571](https://github.com/nikolai-vysotskyi/trace-mcp/issues/571))
* **registry:** stop persisting one-shot agent-run checkouts ([#548](https://github.com/nikolai-vysotskyi/trace-mcp/issues/548))
* **site:** give the landing page the accessibility layer the docs already have (TRA-408) ([#561](https://github.com/nikolai-vysotskyi/trace-mcp/issues/561))
* **site:** show one appearance of the app screenshot, not both (TRA-390) ([#546](https://github.com/nikolai-vysotskyi/trace-mcp/issues/546))
* **update:** stop re-downloading the version already installed ([#556](https://github.com/nikolai-vysotskyi/trace-mcp/issues/556))


### Performance

* **app:** stop shipping react-i18next in app.asar, measure startup on the renderer's own clock (TRA-398) ([#551](https://github.com/nikolai-vysotskyi/trace-mcp/issues/551))


### Documentation

* correct stale tool-surface claims and unhardcode homepage counts ([#569](https://github.com/nikolai-vysotskyi/trace-mcp/issues/569))
* correct the sidebar material's backdrop, with the shot matrix (TRA-404) ([#555](https://github.com/nikolai-vysotskyi/trace-mcp/issues/555))
* measure the sidebar material without hijacking the desktop (TRA-404) ([#558](https://github.com/nikolai-vysotskyi/trace-mcp/issues/558))
* reclassify GA4 telemetry credentials as public by design ([#532](https://github.com/nikolai-vysotskyi/trace-mcp/issues/532))
* rewrite the landing page and README framing in a plain voice (TRA-418) ([#574](https://github.com/nikolai-vysotskyi/trace-mcp/issues/574))
* **site:** put the documentation pages in the Nothing design system ([#540](https://github.com/nikolai-vysotskyi/trace-mcp/issues/540))
* stop citing npm downloads — the count is mirror-inflated (TRA-413) ([#564](https://github.com/nikolai-vysotskyi/trace-mcp/issues/564))
* two more surfaces sold a peak token number as the average (TRA-393) ([#562](https://github.com/nikolai-vysotskyi/trace-mcp/issues/562))


### CI/CD

* **codeql:** exclude js/path-injection, encoding the TRA-301 decision (TRA-381) ([#533](https://github.com/nikolai-vysotskyi/trace-mcp/issues/533))
* drop nosemgrep-suppressed findings from the Semgrep SARIF (TRA-411) ([#563](https://github.com/nikolai-vysotskyi/trace-mcp/issues/563))
* fail on invisible Unicode in prose and AI provenance marks ([#565](https://github.com/nikolai-vysotskyi/trace-mcp/issues/565))
* run cross-platform tests on refactoring path changes ([#530](https://github.com/nikolai-vysotskyi/trace-mcp/issues/530))

## [3.2.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.1.1...v3.2.0) (2026-08-29)


### Features

* **app:** bring the Graph Explorer overlay layer onto the design system (TRA-349) ([#505](https://github.com/nikolai-vysotskyi/trace-mcp/issues/505))
* **app:** collapse the sidebar footer into one row that opens an app menu (TRA-363) ([#516](https://github.com/nikolai-vysotskyi/trace-mcp/issues/516))
* **app:** one top band — the surface's toolbar shares the line with the sidebar toggle (TRA-354) ([#518](https://github.com/nikolai-vysotskyi/trace-mcp/issues/518))
* **app:** Theme is one menu row with an inline switcher (TRA-363) ([#522](https://github.com/nikolai-vysotskyi/trace-mcp/issues/522))
* **app:** update Windows through electron-updater instead of the macOS zip path (TRA-360) ([#513](https://github.com/nikolai-vysotskyi/trace-mcp/issues/513))
* **parser:** migrate to the web-tree-sitter 0.26 API (TRA-330) ([#498](https://github.com/nikolai-vysotskyi/trace-mcp/issues/498))


### Bug Fixes

* **api:** return SQLite indexed_at as ISO-8601 UTC ([#520](https://github.com/nikolai-vysotskyi/trace-mcp/issues/520))
* **app:** a glyph names the action — drop sparkles and speech bubbles (TRA-363) ([#525](https://github.com/nikolai-vysotskyi/trace-mcp/issues/525))
* **app:** correct TRA-355's contrast claim and repoint its guard at a live element ([#508](https://github.com/nikolai-vysotskyi/trace-mcp/issues/508))
* **app:** follow the app's Appearance in the native layer, and floor the sidebar material in light (TRA-369) ([#524](https://github.com/nikolai-vysotskyi/trace-mcp/issues/524))
* **app:** put the traffic lights on the top band's centre line (TRA-370) ([#521](https://github.com/nikolai-vysotskyi/trace-mcp/issues/521))
* **app:** report global npm roots the update never touched (TRA-364) ([#515](https://github.com/nikolai-vysotskyi/trace-mcp/issues/515))
* **app:** say the daemon is unreachable instead of "Failed to fetch" (TRA-356) ([#507](https://github.com/nikolai-vysotskyi/trace-mcp/issues/507))
* **app:** stop a locally built .app from hijacking updates, and never call a stuck bundle "up to date" (TRA-357) ([#510](https://github.com/nikolai-vysotskyi/trace-mcp/issues/510))
* **app:** stop the shared toolbar clipping its controls off-window ([#509](https://github.com/nikolai-vysotskyi/trace-mcp/issues/509))
* **daemon:** build each MCP session from a freshly loaded config (TRA-373) ([#526](https://github.com/nikolai-vysotskyi/trace-mcp/issues/526))
* **refactoring:** apply_move now rewrites ESM .js import specifiers (TRA-374) ([#527](https://github.com/nikolai-vysotskyi/trace-mcp/issues/527))
* **refactoring:** normalize path separators before collapsing barrel imports ([#528](https://github.com/nikolai-vysotskyi/trace-mcp/issues/528))
* **tools:** make compact_schemas cover all 141 tools and stop hiding required params (TRA-346) ([#500](https://github.com/nikolai-vysotskyi/trace-mcp/issues/500))


### Documentation

* fix the framework/language counts on the install surfaces (TRA-361) ([#512](https://github.com/nikolai-vysotskyi/trace-mcp/issues/512))
* re-measure the advertised tool surface and correct the comparison (TRA-372) ([#523](https://github.com/nikolai-vysotskyi/trace-mcp/issues/523))
* **readme:** deep-link in-body doc references to trace-mcp.com pages ([#502](https://github.com/nikolai-vysotskyi/trace-mcp/issues/502))
* regenerate every screenshot from one seeded state (TRA-366) ([#517](https://github.com/nikolai-vysotskyi/trace-mcp/issues/517))
* **seo:** per-competitor /vs/ pages, visible dates, token-usage guide (TRA-351) ([#504](https://github.com/nikolai-vysotskyi/trace-mcp/issues/504))


### Tests

* **update:** prove the .app bundle actually moves on npm install (TRA-359) ([#511](https://github.com/nikolai-vysotskyi/trace-mcp/issues/511))


### CI/CD

* publish server.json to the official MCP Registry on release ([#503](https://github.com/nikolai-vysotskyi/trace-mcp/issues/503))
* **release:** do not publish to npm before the app artifacts exist (TRA-362) ([#514](https://github.com/nikolai-vysotskyi/trace-mcp/issues/514))

## [3.1.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.1.0...v3.1.1) (2026-08-29)


### Bug Fixes

* **app:** abort the model-list fetch on unmount ([#493](https://github.com/nikolai-vysotskyi/trace-mcp/issues/493))
* **app:** make quick open readable — paths and ⌘-hints were 1.88:1 (TRA-344) ([#496](https://github.com/nikolai-vysotskyi/trace-mcp/issues/496))
* **guard:** arm the coach grace period at registration, expire it in the hook (TRA-341) ([#492](https://github.com/nikolai-vysotskyi/trace-mcp/issues/492))
* **scan_security:** kill the false positives whose guard sits above the sink ([#497](https://github.com/nikolai-vysotskyi/trace-mcp/issues/497))
* **tools:** actually strip param descriptions at minimal/none verbosity (TRA-345) ([#499](https://github.com/nikolai-vysotskyi/trace-mcp/issues/499))


### Documentation

* move language and framework counts into counts.yml (TRA-275) ([#495](https://github.com/nikolai-vysotskyi/trace-mcp/issues/495))

## [3.1.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.0.0...v3.1.0) (2026-08-29)


### Features

* **app:** give the guard a UI on Project Overview (TRA-334) ([#490](https://github.com/nikolai-vysotskyi/trace-mcp/issues/490))


### Bug Fixes

* **security:** drop shells and symlink-following from local spawn/temp paths (TRA-337) ([#489](https://github.com/nikolai-vysotskyi/trace-mcp/issues/489))

## [3.0.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.3.0...v3.0.0) (2026-08-29)


### ⚠ BREAKING CHANGES

* Node 20 and 21 are no longer supported; Node >=22 is required.

### Features

* raise the Node floor to 22 and re-ground the dependabot ignores ([#482](https://github.com/nikolai-vysotskyi/trace-mcp/issues/482))


### Bug Fixes

* **app:** close the last hit-target gaps found in the TRA-284 final walk ([#488](https://github.com/nikolai-vysotskyi/trace-mcp/issues/488))
* **daemon:** auto-deregister stale one-shot agent-run workdirs (TRA-335) ([#487](https://github.com/nikolai-vysotskyi/trace-mcp/issues/487))
* **verify:** read embedding_meta as the KV table it actually is ([#485](https://github.com/nikolai-vysotskyi/trace-mcp/issues/485))


### Refactoring

* **app:** retire the legacy palette — one token layer, no ghosts (TRA-315) ([#484](https://github.com/nikolai-vysotskyi/trace-mcp/issues/484))

## [2.3.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.2.0...v2.3.0) (2026-08-29)


### Features

* **app:** migrate Notebook to the macOS 26 layer (TRA-310) ([#473](https://github.com/nikolai-vysotskyi/trace-mcp/issues/473))


### Bug Fixes

* **app:** keep the Ask toolbar in the no-provider setup state (TRA-312) ([#475](https://github.com/nikolai-vysotskyi/trace-mcp/issues/475))
* **app:** make the workspace survive the 640x420 minimum window ([#480](https://github.com/nikolai-vysotskyi/trace-mcp/issues/480))
* **registry:** scope index-DB sharing to sequential use (TRA-304) ([#477](https://github.com/nikolai-vysotskyi/trace-mcp/issues/477))
* **registry:** stop the mtime cache serving a stale registry (TRA-326) ([#479](https://github.com/nikolai-vysotskyi/trace-mcp/issues/479))


### Documentation

* **design:** title design PRs with a real Conventional Commits type ([#474](https://github.com/nikolai-vysotskyi/trace-mcp/issues/474))
* require the repo git identity for agent commits so license/cla resolves ([#478](https://github.com/nikolai-vysotskyi/trace-mcp/issues/478))


### Chores

* **ci:** record why each dependabot ignore exists (TRA-328) ([#481](https://github.com/nikolai-vysotskyi/trace-mcp/issues/481))

## [2.2.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.1.0...v2.2.0) (2026-08-29)


### Features

* **app:** application menu, keyboard shortcuts and the text-selection fix (TRA-297) ([#471](https://github.com/nikolai-vysotskyi/trace-mcp/issues/471))
* **app:** put the sidebar footer on the row system, add Light/Dark/Auto (TRA-305) ([#464](https://github.com/nikolai-vysotskyi/trace-mcp/issues/464))
* **app:** rebuild Ask on the macOS 26 layer (TRA-312) ([#472](https://github.com/nikolai-vysotskyi/trace-mcp/issues/472))
* **app:** rebuild Graph Explorer chrome and Insights on the macOS 26 layer (TRA-296) ([#468](https://github.com/nikolai-vysotskyi/trace-mcp/issues/468))
* **app:** rebuild MCP clients, Settings and the onboarding sheet (TRA-295) ([#469](https://github.com/nikolai-vysotskyi/trace-mcp/issues/469))
* **app:** rebuild Project Overview on the macOS 26 layer (TRA-293) ([#463](https://github.com/nikolai-vysotskyi/trace-mcp/issues/463))
* **app:** rebuild the workspace dashboard and project table on the macOS 26 layer (TRA-292) ([#461](https://github.com/nikolai-vysotskyi/trace-mcp/issues/461))


### Bug Fixes

* **app:** density pass — sidebar footer height, doubled pane inset, off-grid control padding (TRA-306) ([#467](https://github.com/nikolai-vysotskyi/trace-mcp/issues/467))
* **app:** distinguish a project the daemon forgot from one never indexed ([#465](https://github.com/nikolai-vysotskyi/trace-mcp/issues/465))


### Documentation

* write DESIGN.md, the design system this revision converged on (TRA-307) ([#466](https://github.com/nikolai-vysotskyi/trace-mcp/issues/466))

## [2.1.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.0.3...v2.1.0) (2026-08-28)


### Features

* **app:** native vibrancy sidebar + hiddenInset window chrome (TRA-291) ([#453](https://github.com/nikolai-vysotskyi/trace-mcp/issues/453))
* **app:** rewrite the Lattice control primitives on a 20/24/28 capsule scale (TRA-290) ([#456](https://github.com/nikolai-vysotskyi/trace-mcp/issues/456))
* **app:** single macOS 26 token layer, type scale and 4pt geometry ([#458](https://github.com/nikolai-vysotskyi/trace-mcp/issues/458))


### Bug Fixes

* **ci:** give the three full-index jobs real timeout headroom (TRA-298) ([#460](https://github.com/nikolai-vysotskyi/trace-mcp/issues/460))
* **daemon:** require --allow-remote for a non-loopback bind (TRA-301) ([#459](https://github.com/nikolai-vysotskyi/trace-mcp/issues/459))
* **registry:** stable git-remote identity so repeat checkouts reuse one index (TRA-38) ([#450](https://github.com/nikolai-vysotskyi/trace-mcp/issues/450))
* **security:** replace existsSync-then-read/write TOCTOU with safe helpers (TRA-256) ([#452](https://github.com/nikolai-vysotskyi/trace-mcp/issues/452))

## [2.0.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.0.2...v2.0.3) (2026-08-28)


### Bug Fixes

* **ci:** restore RELEASE_PLEASE_TOKEN, dropped by the [#438](https://github.com/nikolai-vysotskyi/trace-mcp/issues/438) squash-merge (TRA-171) ([#448](https://github.com/nikolai-vysotskyi/trace-mcp/issues/448))
* **daemon:** ignore dangerous project hints instead of failing MCP startup (TRA-286) ([#449](https://github.com/nikolai-vysotskyi/trace-mcp/issues/449))


### Performance

* **app:** add a fixed workload fixture for the three unmeasured desktop metrics (TRA-258) ([#446](https://github.com/nikolai-vysotskyi/trace-mcp/issues/446))
* **daemon:** cap eager project loading at startup (TRA-278) ([#445](https://github.com/nikolai-vysotskyi/trace-mcp/issues/445))


### Chores

* **telemetry:** make active installs the adoption metric of record ([#438](https://github.com/nikolai-vysotskyi/trace-mcp/issues/438))

## [2.0.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.0.1...v2.0.2) (2026-08-28)


### Bug Fixes

* **ci:** use RELEASE_PLEASE_TOKEN so release PR checks fire automatically (TRA-171)
* **docs:** refresh stale sitemap lastmod and run the guard in CI (TRA-282) ([#444](https://github.com/nikolai-vysotskyi/trace-mcp/issues/444))
* **update:** recover an app bundle swap interrupted by a reboot (TRA-280) ([#442](https://github.com/nikolai-vysotskyi/trace-mcp/issues/442))

## [2.0.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.0.0...v2.0.1) (2026-08-28)


### Bug Fixes

* **app:** freeze Project and Actions columns in the workspace table (TRA-265) ([#429](https://github.com/nikolai-vysotskyi/trace-mcp/issues/429))
* **daemon:** bound post-update forced reindex attempts (TRA-274) ([#439](https://github.com/nikolai-vysotskyi/trace-mcp/issues/439))
* **docs:** our own surfaces said 85 framework integrations, the registry has 87 (TRA-272) ([#440](https://github.com/nikolai-vysotskyi/trace-mcp/issues/440))
* **docs:** reconcile the README language count and guard every occurrence (TRA-272) ([#437](https://github.com/nikolai-vysotskyi/trace-mcp/issues/437))


### Tests

* **docs:** count MCP tools recursively, not with a top-level glob (TRA-268) ([#433](https://github.com/nikolai-vysotskyi/trace-mcp/issues/433))


### CI/CD

* authenticate release-please with RELEASE_PLEASE_TOKEN (TRA-171) ([#436](https://github.com/nikolai-vysotskyi/trace-mcp/issues/436))

## [2.0.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.51.1...v2.0.0) (2026-08-28)


### ⚠ BREAKING CHANGES

* seven MCP tools are removed. Each was a deprecated alias for a superset tool that already covered it:

| Retired tool (1.x) | Replacement (2.0) |
|---|---|
| `pin_symbol { symbol_id }` | `pin { symbol_id }` |
| `pin_file { file_path }` | `pin { file_path }` |
| `search_with_mode { query, mode }` | `search { query, retriever: mode }` |
| `get_dead_exports { file_pattern }` | `get_dead_code { file_pattern, mode: "exports_only" }` |
| `get_untested_exports { file_pattern }` | `get_untested_symbols { file_pattern, scope: "exports_only" }` |
| `get_session_resume { max_sessions }` | `get_wake_up { scope: "resume", max_sessions }` |
| `get_project_memo { include_history, limit }` | `get_wake_up { scope: "project", include_history, history_limit }` |

Every call is expressible in the replacement without loss of behaviour or response shape. Full notes: [Migrating from 1.x](https://trace-mcp.com/tools-reference.html).

Two rarely-used `search` parameters were also removed: `fusion_weights` (per-channel weights now come from `~/.trace-mcp/tuning.jsonc`, written by `tune_weights`) and `fusion_debug`.

### Features

* retire the 7 deprecated consolidation aliases, cut the search schema (TRA-240) ([#415](https://github.com/nikolai-vysotskyi/trace-mcp/issues/415))


### Bug Fixes

* **app:** don't render a failed metrics fetch as real zeros (TRA-264) ([#428](https://github.com/nikolai-vysotskyi/trace-mcp/issues/428))
* **app:** make Compact denser, sort it like Table, keep the leading / in paths ([#430](https://github.com/nikolai-vysotskyi/trace-mcp/issues/430))
* **app:** make the guard onboarding dialog dismissable and quiet on first launch ([#423](https://github.com/nikolai-vysotskyi/trace-mcp/issues/423))
* **daemon:** honour the tool preset on the daemon-backed path (TRA-250) ([#422](https://github.com/nikolai-vysotskyi/trace-mcp/issues/422))
* **daemon:** record why a silent exit happened (TRA-267) ([#432](https://github.com/nikolai-vysotskyi/trace-mcp/issues/432))
* **docs:** emit og:image on every docs page ([#418](https://github.com/nikolai-vysotskyi/trace-mcp/issues/418))
* **docs:** link every doc page from the shared footer nav ([#419](https://github.com/nikolai-vysotskyi/trace-mcp/issues/419))
* **docs:** refresh sitemap lastmod from git, link docs from README and homepage body ([#426](https://github.com/nikolai-vysotskyi/trace-mcp/issues/426))


### Performance

* **app:** stop shipping node_modules in the artifact, add a perf baseline harness (TRA-257) ([#425](https://github.com/nikolai-vysotskyi/trace-mcp/issues/425))


### Documentation

* **comparisons:** deep-dive pass on the two largest peers + measured tool-surface cost ([#416](https://github.com/nikolai-vysotskyi/trace-mcp/issues/416))
* fix stale language/framework/tool counts in CLAUDE.md and skills (TRA-243) ([#420](https://github.com/nikolai-vysotskyi/trace-mcp/issues/420))
* fix the MCP registry manifest and preset sizes, guard both (TRA-259) ([#427](https://github.com/nikolai-vysotskyi/trace-mcp/issues/427))
* single source of truth for the MCP tool count (TRA-263) ([#431](https://github.com/nikolai-vysotskyi/trace-mcp/issues/431))


### Tests

* **cli:** cover openInBrowser's platform branches and error-swallow (TRA-247) ([#417](https://github.com/nikolai-vysotskyi/trace-mcp/issues/417))


### CI/CD

* **security:** scope CodeQL/Semgrep to shipped code and make Semgrep a real gate ([#424](https://github.com/nikolai-vysotskyi/trace-mcp/issues/424))

## [1.51.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.51.0...v1.51.1) (2026-08-28)


### Bug Fixes

* **guard:** add Windows system directories to the dangerous-root guard (TRA-236) ([#411](https://github.com/nikolai-vysotskyi/trace-mcp/issues/411))
* **hooks:** cut clock spawns in reindex hook, make stats-write flake diagnosable ([#412](https://github.com/nikolai-vysotskyi/trace-mcp/issues/412))


### Performance

* **tools:** stop paying full prose for deprecated consolidation aliases, guard schema size (TRA-239) ([#414](https://github.com/nikolai-vysotskyi/trace-mcp/issues/414))

## [1.51.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.50.0...v1.51.0) (2026-08-28)


### Features

* **plugins:** add click and marshmallow Python framework plugins ([#409](https://github.com/nikolai-vysotskyi/trace-mcp/issues/409))


### Bug Fixes

* **app:** don't render KPI zeros before metrics load; use color tokens ([#400](https://github.com/nikolai-vysotskyi/trace-mcp/issues/400))
* **app:** normalize daemon project_status progress payload ([#401](https://github.com/nikolai-vysotskyi/trace-mcp/issues/401))
* **indexer:** converge coverage after major on-disk change (TRA-231) ([#406](https://github.com/nikolai-vysotskyi/trace-mcp/issues/406))
* **mcp:** strip redundant $schema keyword from tools/list responses ([#398](https://github.com/nikolai-vysotskyi/trace-mcp/issues/398))
* **topology:** route subproject registration through the dangerous-root guard (TRA-232) ([#405](https://github.com/nikolai-vysotskyi/trace-mcp/issues/405))


### Documentation

* **tools:** cross-link overlapping impact and risk tools ([#408](https://github.com/nikolai-vysotskyi/trace-mcp/issues/408))


### Tests

* **tools:** extend schema-budget guard to conditionally-registered tools ([#407](https://github.com/nikolai-vysotskyi/trace-mcp/issues/407))
* **topology:** gate POSIX-only dangerous-root fixtures off Windows ([#410](https://github.com/nikolai-vysotskyi/trace-mcp/issues/410))


### Chores

* **deps:** document commander v15 ignore in dependabot.yml ([#402](https://github.com/nikolai-vysotskyi/trace-mcp/issues/402))

## [1.50.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.49.0...v1.50.0) (2026-08-27)


### Features

* **get_wake_up:** add scope param to unify with get_session_resume / get_project_memo (TRA-206) ([#395](https://github.com/nikolai-vysotskyi/trace-mcp/issues/395))


### Bug Fixes

* **install-app:** verify SHA-256 before extracting or executing release assets (TRA-219) ([#397](https://github.com/nikolai-vysotskyi/trace-mcp/issues/397))

## [1.49.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.48.5...v1.49.0) (2026-08-27)


### Features

* **check_edit_safe:** add depth param to unify with assess_change_risk / get_change_impact (TRA-197) ([#392](https://github.com/nikolai-vysotskyi/trace-mcp/issues/392))
* **get_dead_code:** add exports_only mode, alias get_dead_exports (TRA-199) ([#393](https://github.com/nikolai-vysotskyi/trace-mcp/issues/393))
* **get_untested_symbols:** add scope param, alias get_untested_exports (TRA-203) ([#394](https://github.com/nikolai-vysotskyi/trace-mcp/issues/394))
* **pins:** add unified pin tool, alias pin_file/pin_symbol (TRA-196) ([#391](https://github.com/nikolai-vysotskyi/trace-mcp/issues/391))
* **search:** add retriever param to unify with search_with_mode (TRA-200) ([#388](https://github.com/nikolai-vysotskyi/trace-mcp/issues/388))

## [1.48.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.48.4...v1.48.5) (2026-08-27)


### Bug Fixes

* point app auto-update at trace-mcp releases, not deleted trace-mcp-app-dist ([#386](https://github.com/nikolai-vysotskyi/trace-mcp/issues/386))


### Documentation

* fix remaining stale comments about the deleted app-dist repo ([#387](https://github.com/nikolai-vysotskyi/trace-mcp/issues/387))
* update roadmap — TRA-186 shipped, tool-consolidation scoping is next ([#384](https://github.com/nikolai-vysotskyi/trace-mcp/issues/384))

## [1.48.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.48.3...v1.48.4) (2026-08-27)


### Performance

* **mcp:** trim per-param describe() text, add param-description budget guard (TRA-186) ([#380](https://github.com/nikolai-vysotskyi/trace-mcp/issues/380))

## [1.48.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.48.2...v1.48.3) (2026-08-27)


### Performance

* **mcp:** trim heaviest tool descriptions to cut schema-load token tax (TRA-186) ([#377](https://github.com/nikolai-vysotskyi/trace-mcp/issues/377))

## [1.48.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.48.1...v1.48.2) (2026-08-27)


### Bug Fixes

* **app:** apply staged update on any quit, not just explicit Restart ([#376](https://github.com/nikolai-vysotskyi/trace-mcp/issues/376))
* **daemon:** re-check npm registry periodically, not just at startup ([#372](https://github.com/nikolai-vysotskyi/trace-mcp/issues/372))
* deep-glob fallback masked by unrelated global include pattern (TRA-184) ([#374](https://github.com/nikolai-vysotskyi/trace-mcp/issues/374))
* **registry:** reject /private/tmp as a project root (TRA-185) ([#373](https://github.com/nikolai-vysotskyi/trace-mcp/issues/373))


### Documentation

* refresh product roadmap — 2 items shipped, add tool-schema tax (TRA-188) ([#375](https://github.com/nikolai-vysotskyi/trace-mcp/issues/375))


### CI/CD

* switch release-PR auto-approve to a schedule trigger (TRA-171) ([#370](https://github.com/nikolai-vysotskyi/trace-mcp/issues/370))

## [1.48.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.48.0...v1.48.1) (2026-08-27)


### Bug Fixes

* unify language/framework/tool counts across marketing docs ([#369](https://github.com/nikolai-vysotskyi/trace-mcp/issues/369))


### Documentation

* fix duplicate H1, untargeted titles, unscoped tables, dead-end internal links (TRA-173) ([#368](https://github.com/nikolai-vysotskyi/trace-mcp/issues/368))
* **site:** close AI-search (GEO) gaps — FAQPage schema, TechArticle dates, llms-full.txt (TRA-175) ([#367](https://github.com/nikolai-vysotskyi/trace-mcp/issues/367))


### CI/CD

* auto-approve release-please PR workflow runs (TRA-171) ([#365](https://github.com/nikolai-vysotskyi/trace-mcp/issues/365))

## [1.48.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.47.1...v1.48.0) (2026-08-27)


### Features

* add detail_level to get_feature_context / get_task_context (GH [#334](https://github.com/nikolai-vysotskyi/trace-mcp/issues/334)) ([#353](https://github.com/nikolai-vysotskyi/trace-mcp/issues/353))
* **ci:** SARIF upload for quality gates + security scan (TRA-127) ([#349](https://github.com/nikolai-vysotskyi/trace-mcp/issues/349))
* **config:** add tools.default_detail_level global verbosity default (TRA-168) ([#364](https://github.com/nikolai-vysotskyi/trace-mcp/issues/364))
* **mcp:** add list_projects + call_project_tool cross-project relay (TRA-93) ([#357](https://github.com/nikolai-vysotskyi/trace-mcp/issues/357))


### Bug Fixes

* **app:** migrate status dots to Lattice tokens, delete duplicate StatusDot ([#352](https://github.com/nikolai-vysotskyi/trace-mcp/issues/352))
* **app:** replace emoji glyphs + hardcoded colors with Lattice Icon/Badge ([#351](https://github.com/nikolai-vysotskyi/trace-mcp/issues/351))
* **doctor:** don't silently drop coverage when --fix removes overlap containers ([#338](https://github.com/nikolai-vysotskyi/trace-mcp/issues/338))
* **hooks:** catch recursive/pathless grep-cat in trace-mcp-guard ([#361](https://github.com/nikolai-vysotskyi/trace-mcp/issues/361))
* **init:** stop writing alwaysLoad:true, flag it as stale instead (TRA-142) ([#355](https://github.com/nikolai-vysotskyi/trace-mcp/issues/355))
* **release:** enforce Conventional Commit PR titles (TRA-104) ([#335](https://github.com/nikolai-vysotskyi/trace-mcp/issues/335))
* replace insecure /tmp literal paths in test fixtures with /nonexistent (CodeQL js/insecure-temporary-file [#247](https://github.com/nikolai-vysotskyi/trace-mcp/issues/247)) ([#358](https://github.com/nikolai-vysotskyi/trace-mcp/issues/358))
* resolve CodeQL js/redos and js/insecure-temporary-file alerts in source-reader.ts ([#356](https://github.com/nikolai-vysotskyi/trace-mcp/issues/356))
* resolve mocked project roots via path.resolve in call_project_tool tests ([#360](https://github.com/nikolai-vysotskyi/trace-mcp/issues/360))
* **site:** self-host fonts, fix heading order, contrast, a11y name mismatch ([#347](https://github.com/nikolai-vysotskyi/trace-mcp/issues/347))
* **test:** resolve mocked project paths via path.resolve on Windows (TRA-151) ([#359](https://github.com/nikolai-vysotskyi/trace-mcp/issues/359))


### Performance

* **memory:** batch git commit-lookup in decision staleness verification ([#348](https://github.com/nikolai-vysotskyi/trace-mcp/issues/348))


### Documentation

* add product roadmap (TRA-124) ([#343](https://github.com/nikolai-vysotskyi/trace-mcp/issues/343))
* deep-dive the two flagged 60K+-star entrants (Graphify, Headroom) ([#362](https://github.com/nikolai-vysotskyi/trace-mcp/issues/362))
* document solo-maintainer review model ([#346](https://github.com/nikolai-vysotskyi/trace-mcp/issues/346))
* refresh competitor star counts (verified via GitHub API) ([#344](https://github.com/nikolai-vysotskyi/trace-mcp/issues/344))
* refresh competitor stars, add repo-context-mcp entrant, add profiling tracker (TRA-162) ([#363](https://github.com/nikolai-vysotskyi/trace-mcp/issues/363))
* **security:** document code-scanning alert triage policy ([#350](https://github.com/nikolai-vysotskyi/trace-mcp/issues/350))
* **site:** link docs pages internally, fix sitemap, add llms.txt ([#345](https://github.com/nikolai-vysotskyi/trace-mcp/issues/345))

## [1.47.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.47.0...v1.47.1) (2026-08-16)


### Bug Fixes

* **analytics:** surface _warnings when session data source is unreachable (TRA-76) ([#319](https://github.com/nikolai-vysotskyi/trace-mcp/issues/319))
* **deps:** patch Dependabot alerts reintroduced by packages/app restore ([#309](https://github.com/nikolai-vysotskyi/trace-mcp/issues/309))
* **watcher:** apply .gitignore filtering to file-watcher events (TRA-85) ([#327](https://github.com/nikolai-vysotskyi/trace-mcp/issues/327))


### Chores

* add .gitattributes forcing LF line endings ([#326](https://github.com/nikolai-vysotskyi/trace-mcp/issues/326))

## [1.47.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.46.2...v1.47.0) (2026-08-09)


### Features

* **app:** port the Lattice design system foundation from Codechats, restyle the sidebar shell ([#281](https://github.com/nikolai-vysotskyi/trace-mcp/issues/281))
* **init:** add --scope project|global for MCP config target ([#282](https://github.com/nikolai-vysotskyi/trace-mcp/issues/282)) ([#284](https://github.com/nikolai-vysotskyi/trace-mcp/issues/284))
* **plugin:** add Codex CLI plugin, document one-step install in README ([#278](https://github.com/nikolai-vysotskyi/trace-mcp/issues/278))
* **telemetry:** anonymous opt-out active-install ping (GA4 Measurement Protocol) ([#280](https://github.com/nikolai-vysotskyi/trace-mcp/issues/280))


### Bug Fixes

* **config:** scaffold preset:standard in default global config (TRA-67) ([#305](https://github.com/nikolai-vysotskyi/trace-mcp/issues/305))
* **guard:** distinguish stdio vs http heartbeat, treat 0 sessions as dead ([#301](https://github.com/nikolai-vysotskyi/trace-mcp/issues/301))
* **memory:** drop bare "over" from tech_choice mining pattern (TRA-34) ([#276](https://github.com/nikolai-vysotskyi/trace-mcp/issues/276))
* **memory:** scope mined-session count to project, not global ([#303](https://github.com/nikolai-vysotskyi/trace-mcp/issues/303))
* **memory:** scope session discovery to the target project (TRA-48) ([#293](https://github.com/nikolai-vysotskyi/trace-mcp/issues/293))
* **memory:** stop CLI mine defaulting stricter than the tuned reject floor ([#272](https://github.com/nikolai-vysotskyi/trace-mcp/issues/272))
* **plugin:** bump .codex-plugin manifest versions to match package.json (1.46.2) ([#295](https://github.com/nikolai-vysotskyi/trace-mcp/issues/295))
* **registry:** doctor --fix-interactive handles registry issues too ([#291](https://github.com/nikolai-vysotskyi/trace-mcp/issues/291))
* **registry:** stamp lastIndexed on daemon-driven and CLI index runs (TRA-59) ([#302](https://github.com/nikolai-vysotskyi/trace-mcp/issues/302))
* **topology:** reject and self-heal filesystem-root subproject repo_root ([#273](https://github.com/nikolai-vysotskyi/trace-mcp/issues/273)) ([#275](https://github.com/nikolai-vysotskyi/trace-mcp/issues/275))


### Documentation

* surface benchmark command and clarify synthetic estimate vs real savings ([#283](https://github.com/nikolai-vysotskyi/trace-mcp/issues/283)), closes [#277](https://github.com/nikolai-vysotskyi/trace-mcp/issues/277)


### Chores

* **deps:** bump undici and postcss overrides to close 6 Dependabot alerts ([#300](https://github.com/nikolai-vysotskyi/trace-mcp/issues/300))
* **deps:** ignore better-sqlite3 major bumps (13.x prebuilds segfault) ([#296](https://github.com/nikolai-vysotskyi/trace-mcp/issues/296))

## [1.46.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.46.1...v1.46.2) (2026-07-29)


### Bug Fixes

* **init:** doctor false-positives on CLAUDE.md files that reject a competing tool ([#266](https://github.com/nikolai-vysotskyi/trace-mcp/issues/266))
* **memory:** reject narration noise in mined decisions (title_narration) ([#268](https://github.com/nikolai-vysotskyi/trace-mcp/issues/268)), closes [#17](https://github.com/nikolai-vysotskyi/trace-mcp/issues/17)
* **registry:** doctor --fix/--dry-run clean up stale entries and overlaps ([#267](https://github.com/nikolai-vysotskyi/trace-mcp/issues/267))

## [1.46.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.46.0...v1.46.1) (2026-07-27)


### Bug Fixes

* auto-index unindexed files on get_outline NOT_FOUND miss ([#260](https://github.com/nikolai-vysotskyi/trace-mcp/issues/260))
* **config:** index .cs files at arbitrary .NET project roots ([#242](https://github.com/nikolai-vysotskyi/trace-mcp/issues/242))
* **daemon:** retry transient transport errors in ProxyBackend.send ([#257](https://github.com/nikolai-vysotskyi/trace-mcp/issues/257))
* **init:** hide PowerShell console window in Windows launcher shim
* **quality:** get_changed_symbols base-branch auto-detection for non-main/master repos ([#258](https://github.com/nikolai-vysotskyi/trace-mcp/issues/258))
* **tools:** default preset to standard (~50 tools), not full (~170) ([#259](https://github.com/nikolai-vysotskyi/trace-mcp/issues/259))


### Chores

* **ci:** group github-actions dependabot updates ([#250](https://github.com/nikolai-vysotskyi/trace-mcp/issues/250))
* **deps:** bump postcss to close Dependabot alert [#65](https://github.com/nikolai-vysotskyi/trace-mcp/issues/65) ([#261](https://github.com/nikolai-vysotskyi/trace-mcp/issues/261))
* **deps:** patch 7 open Dependabot alerts via pnpm overrides ([#256](https://github.com/nikolai-vysotskyi/trace-mcp/issues/256))

## [1.46.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.45.3...v1.46.0) (2026-07-07)


### Features

* **init:** add KiloCode, Cline, Antigravity, Kimi MCP client auto-configuration, closes [#76](https://github.com/nikolai-vysotskyi/trace-mcp/issues/76)


### Bug Fixes

* **daemon:** kill the restart war — session parent-death + SIGTERM bounded exit, /health "starting" during any indexing, closes [#236](https://github.com/nikolai-vysotskyi/trace-mcp/issues/236) [#237](https://github.com/nikolai-vysotskyi/trace-mcp/issues/237)

## [1.45.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.45.2...v1.45.3) (2026-07-06)


### Bug Fixes

* **init:** run Windows hooks through hidden PowerShell wrappers (no console flashing), closes [#230](https://github.com/nikolai-vysotskyi/trace-mcp/issues/230)

## [1.45.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.45.1...v1.45.2) (2026-07-06)


### Bug Fixes

* **memory:** tighten mined-decision quality gate (code spans, dangling tails, table remnants), closes [#233](https://github.com/nikolai-vysotskyi/trace-mcp/issues/233)

## [1.45.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.45.0...v1.45.1) (2026-07-06)


### Bug Fixes

* **memory:** reject truncated fragments in session decision mining, closes [#231](https://github.com/nikolai-vysotskyi/trace-mcp/issues/231)

## [1.45.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.44.0...v1.45.0) (2026-07-04)


### Features

* **daemon:** idle project unload, per-connection SQLite memory caps, ancestor watcher restart


### Bug Fixes

* **ai:** auto-detect Ollama embedding dimension + surface embed_repo failures, closes [#223](https://github.com/nikolai-vysotskyi/trace-mcp/issues/223)
* **config:** preserve user-added keys when rewriting a project config section
* **daemon:** close topology.db handle in runSubprojectAutoSync (fd leak)
* **dashboard:** deep-merge PUT /api/settings and preserve JSONC comments, closes [#221](https://github.com/nikolai-vysotskyi/trace-mcp/issues/221)
* **indexer:** electron & filament edges were silently dropped — rewrite + tests (3/3)
* **indexer:** import TSNode locally in language helpers (keep re-export)
* **indexer:** import TSNode locally in language helpers instead of dead re-export
* **indexer:** stop following directory symlinks during file discovery, closes [#218](https://github.com/nikolai-vysotskyi/trace-mcp/issues/218)
* **init:** accept string content in withPs1Bom + align hooks test with BOM write path
* **init:** write .ps1 launcher/hook artifacts with a UTF-8 BOM + ASCII-only templates, closes [#224](https://github.com/nikolai-vysotskyi/trace-mcp/issues/224)
* **tests:** type the unknown config section before member access in jsonc-merge test
* **types:** restore tsc gate (1/3) — core plugin-api types match runtime
* **types:** restore tsc gate (2/3) — mechanical/drift/noise across 38 files


### Performance

* **daemon:** cache registry reads + dedup consultation markers on the hot path


### Refactoring

* **indexer:** extract extractAndPersist from IndexingPipeline (137 -&gt; 115 cyclomatic)
* **memory-scheduler:** extract shared types into a dependency-free leaf module to break the resource-ops cycle
* **memory:** extract MemorySchedulerResourceOps from MemoryScheduler


### Documentation

* **taint-analysis:** reword example comment to avoid self-triggering the SQL-injection scanner


### Chores

* **quality-gates:** calibrate thresholds from today's cleanup + scanner review


### CI/CD

* add tsc --noEmit typecheck gate to prevent type rot

## [1.44.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.43.3...v1.44.0) (2026-07-02)


### Features

* **analysis:** add get_file_health_timeline (complexity+coupling+churn merge)
* **analysis:** add get_graph_timeline (simplified commit-sampling tier)
* **analytics:** track semantic-degraded searches + near-duplicate rephrased queries
* **cfg:** model loop back-edges, loop-exit edges, and try/catch merge nodes
* **daemon:** serve registered subprojects read-mostly (no watcher, ephemeral)
* **daemon:** subproject-aware session binding ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))
* **eval:** health-metric calibration harness + honest triage language
* **iac:** K8s Resource nodes, multi-doc, Kustomize modules, compose build links
* **iac:** resolve Kustomize/compose path-string imports to real manifest nodes
* **memory:** decision staleness verification (Task 3)
* **memory:** hybrid retrieval for decisions + tracked benchmark (Task 9)
* **memory:** progressive disclosure of decisions (Task 12)
* **memory:** search-time heat decay + auto-supersession (Task 11)
* **quality:** SARIF 2.1.0 output for scan_security, detect_antipatterns, check_quality_gates
* **quality:** type-aware taint pruning to cut false positives
* **refactor:** re-enable extract_function with AST free-variable analysis
* **refactor:** rebuild apply_codemod on ast-grep AST engine
* **scip:** SCIP ingestion with scip_resolved edge tier
* **taint:** array-destructuring source + lock-in multi-hop/coercion regressions
* **tools:** register get_federation_impact, get_file_health_timeline, get_graph_timeline


### Bug Fixes

* **cache:** scope pagerank + search caches per-DB (WeakMap), not by db.name
* **cfg:** emit post-nested-block statement as its own node
* **cfg:** stop mis-classifying do-prefixed identifiers as do-while loops
* **codemod:** a pattern with zero matches is success, not an error
* **codemod:** lazy-load @ast-grep/napi so a missing native binding degrades instead of crashing the server
* **daemon:** FK-recovery hard-resets index tables instead of looping
* **extract-function:** stop misclassifying shadowed/multi-return slices, make confidence reflect it
* **hcl:** persist + resolve Terraform module source imports edge
* **indexer:** keep symbols_fts in sync on incremental reindex
* **indexer:** scope indexing to most-specific registered project ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))
* **memory:** break decision-store circular import via shared decision-types
* **memory:** decision retrieval bench script was broken and measuring stale data
* **memory:** fail open when decision verification throws internally
* **registry:** match extensionless language files by basename
* revert 6 dead-code false positives from get_dead_code confidence-1.0 batch
* **sarif:** emit the canonical OASIS $schema URL, not a dead 404
* **security:** eliminate 3x command injection in install-app.ts
* **security:** eliminate command injection in ask --repo git clone
* **security:** validate table identifier before DDL in Vec0Index (CWE-89)
* **session:** tighten unbatched-call hint, broaden tracked tool set
* **taint:** line-aware type pruning to prevent hidden string-injection
* **taint:** propagate taint through string concat and template literals
* **types:** narrow SearchResult | FlatSearchResult before _meta/_near_misses access
* **types:** null-guard decisionStore inside nested closures in memory.ts
* **types:** remove invalid type assertion in updateCallSites
* **types:** replace zod v3 ZodEffects with v4 ZodPipe/ZodTransform
* **types:** widen tsconfig rootDir to repo root to fix TS6059


### Performance

* **ai:** optional sqlite-vec ANN index for vector search
* **analysis:** batch per-period churn queries in getGraphTimeline into one git call
* **analysis:** cross-call cache for buildFileGraph + edge bottlenecks
* **analytics:** replace tool_calls JOIN sessions with IN-subquery filter
* **complexity:** strip strings/comments once per symbol, not twice
* **context:** hoist repeated graph/file loads in context assembly
* **daemon:** grace-TTL release of idle project stores + idle heartbeat backoff
* **db:** add hot-path indexes idx_symbols_parent/exported, idx_edges_resolved (schema v30)
* **indexer:** bulk-create symbol nodes per file batch (2N-&gt;1 statements)
* **indexer:** evict per-batch file content cache to bound in-process RSS
* **memory:** batch decision-verification blob reads via git cat-file --batch
* **memory:** dedupe getStats() on the wake-up hot path
* **memory:** memoize git subprocess spawns in decision verification
* **scoring:** avoid expensive filtered COUNT in PageRank cache-hit check
* **topology:** memoize endpoint-path normalization in linkClientCallsToEndpoints
* **topology:** O(N^2)-&gt;O(N) cross-service edges; fix FK-safe repo removal


### Refactoring

* **api:** split ask-sessions-routes dispatcher into per-route handlers
* **api:** split memory-routes dispatcher into per-route handlers
* **eval:** extract main() helpers in calibrate-health-metrics (F -&gt; D)
* **indexer:** extract FileCollector from IndexingPipeline.collectFiles
* **indexer:** extract RenameDetector from IndexingPipeline.detectRenames
* **lsp:** extract ensureFileOpen/enrichSymbol from enrichLanguage (cyclomatic 11 -&gt; 6)
* **lsp:** extract logging/drain helpers from flushInternal (cyclomatic 10 -&gt; 5)
* **lsp:** extract resolveServers helpers in config.ts (cyclomatic 19 -&gt; 1)
* **memory:** extract MemoOperations from DecisionStore god-class
* **memory:** extract MutationOperations (write-path) from DecisionStore
* **memory:** extract QueryOperations (read-path) from DecisionStore
* **memory:** extract ReviewOperations from DecisionStore
* **memory:** extract SchedulerState + Consolidation ops from DecisionStore
* **memory:** extract SessionOperations from DecisionStore
* **python:** decompose PythonLanguagePlugin.extractClass into helpers (class cyclomatic 153 to 66)
* **server:** decompose installToolGate into tool-gate-helpers (cyclomatic 154 to 26)
* **subproject:** extract contract resolution and source-service lookup in manager
* **subproject:** extract rename detection out of diffSchemas
* **subproject:** extract URL resolution and dedupe line-counting in scanner
* **subproject:** split per-repo search logic out of subprojectSearch
* **tools:** extract get_context_bundle + get_feature_context into navigation/context-tools.ts
* **tools:** extract get_task_context into navigation/task-context-tools.ts
* **tools:** extract point-lookup tools into navigation/lookup-tools.ts
* **tools:** extract search + suggest_queries into navigation/search-tools.ts
* **tools:** hoist memo helpers out of registerMemoryTools closure
* **tools:** reduce registerNavigationTools to thin orchestrator (cyclomatic 183 -&gt; 1)
* **topology:** decompose TopologyStore god-class into per-entity modules (125 -&gt; 49)


### Documentation

* fix CLAUDE.md/AGENTS.md drift (dead path, false-positive tool refs, oversized section)
* reflect shipped gap-closures + adversarial validation findings
* refresh competitor comparison (June 2026) + new entrants


### Tests

* **ai:** add AnthropicProvider unit tests
* **ai:** add ask-shared.ts unit tests (resolveProvider, gatherContext, factories)
* **ai:** add GeminiProvider unit tests
* **ai:** add OnnxProvider unit tests
* **ai:** add OpenAIProvider unit tests
* **api:** characterize ask-sessions-routes HTTP contract before split
* **cli:** add behavioral coverage for clients and check commands
* **cli:** add behavioral coverage for consent, bundles, status commands
* **cli:** add behavioral coverage for preflight, prune, remove commands
* **codemod:** add CI smoke test for @ast-grep/napi native binding resolution
* **eval:** widen MRR baseline tolerance to dataset granularity
* **iac:** adversarial hardening for K8s/Kustomize/compose edge cases
* **lsp:** add unit tests for LspBridge orchestrator
* **lsp:** add unit tests for LspClient JSON-RPC transport
* **lsp:** add unit tests for LspEnrichmentPass
* **lsp:** add unit tests for LspServerManager lifecycle
* **lsp:** add unit tests for symbol &lt;-&gt; LSP position mappers
* **memory:** adversarial supersession non-triggers (Task 11)
* **memory:** end-to-end heat-decay ranking with real timestamps (Task 11)
* **memory:** end-to-end staleness scenarios (file deletion, in-place edit)
* **memory:** progressive-disclosure error handling + content-leak hardening (Task 12)
* **memory:** query_decisions hybrid retrieval wiring at the tool-handler level (Task 9)
* **refactor:** fix extract_function preview fixture to a genuine single-return case
* **refactor:** fix legacy zero-match assertion missed by the targeted re-run
* **subproject:** add behavioral coverage for subproject-helpers.ts


### Chores

* **ai:** remove 5 unused retrieval-mode result interfaces
* **deps:** bump hono 4.12.27 + js-yaml 4.3.0 via pnpm.overrides (security)
* **deps:** declare vite &gt;=8.0.16 override (fs.deny bypass + launch-editor NTLMv2 advisories)
* **deps:** override esbuild &gt;=0.28.1 (fixes dev-server arbitrary file read on Windows)
* **deps:** override undici &gt;=7.28.0 (fixes SOCKS5 proxy pool cross-origin + TLS bypass advisories)
* **deps:** tighten protobufjs override to &gt;=8.6.0 (fixes unknown-field memory amplification + property-shadowing advisories)
* **lsp:** remove TextDocumentPositionParams — orphaned by prior removal
* **plugin:** sync manifest versions to 1.43.4
* **release:** 1.43.4
* remove 5 verified-dead leaf exports
* remove confirmed-dead exports from fresh dead-code sweep
* remove dead extractCashierConfig cascade + WorkspaceResolver
* remove verified dead code (4 symbols, confirmed via search_text)
* **ruby:** remove confirmed-dead filePathToModule and isAllCaps helpers


### CI/CD

* add informational-only quality-gates report job

## [1.43.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.43.2...v1.43.3) (2026-06-27)


### Bug Fixes

* **daemon:** seed initialize frame into swapped-in proxy backends ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))

## [1.43.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.43.1...v1.43.2) (2026-06-25)


### Bug Fixes

* **daemon:** guard POST /api/projects against bare-container roots ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))
* **daemon:** read-only local fallback — stop per-session full re-index ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))


### CI/CD

* **scorecard:** tolerate transient publish-results timeout ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))
* **windows:** drop node_modules cache on cross-platform job to fix realpath EPERM ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))

## [1.43.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.43.0...v1.43.1) (2026-06-16)


### Bug Fixes

* **daemon:** raise auto-spawn timeout 5s-&gt;20s to stop premature local fallback ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))
* **indexer:** skip postprocess on unchanged full reindex ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))

## [1.43.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.42.0...v1.43.0) (2026-06-15)


### Features

* **ai:** harden summarizer against prompt injection + configurable request body
* **hooks:** opt-in strict enforcement tier for the navigation guard
* **indexer:** first-class Astro (.astro) language support
* **indexer:** refine sensitive-file detection (basename + secret-store dirs)
* **lsp:** wire C# into LSP enrichment (csharp-ls auto-detect)
* **release:** publish provenance + get_symbol git-HEAD verification
* **tools:** add check_edit_safe edit-safety preflight


### Bug Fixes

* **daemon:** bounded reinit-retry covers 'Session expired' session loss ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))
* **daemon:** don't auto-register a bare parent dir that only contains projects ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))
* **daemon:** keep /health responsive during warm-up; log shutdown reason
* **daemon:** proxy transparently re-initializes after daemon restart ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))
* **daemon:** rotate daemon.log from inside the running daemon ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209))
* **deps:** regenerate pnpm-lock.yaml after dependabot group merges
* **server:** process-wide safety net so one stray error doesn't drop the session
* **types:** resolve 3 navigation type errors incl. a latent freshness bug
* **watcher:** stop indexing runtime churn; harden initial indexing; rotate daemon.log
* **windows:** green the nightly cross-platform job


### Performance

* **indexer:** defer full edge resolution to a coalesced reconcile; flag overlapping roots
* **local-backend:** seed session DBs from the shared index; sweep SIGKILL orphans

## [1.42.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.41.3...v1.42.0) (2026-06-08)


### Features

* **init:** preflight checks + verify/doctor hints for first-run ([#124](https://github.com/nikolai-vysotskyi/trace-mcp/issues/124))


### Bug Fixes

* **daemon:** respect explicit opt-out so removed daemon stays gone ([#202](https://github.com/nikolai-vysotskyi/trace-mcp/issues/202))
* **quality:** exclude .env* files from code-smell scanning
* **registry:** doctor reports registry/DB integrity, prune removes stale rows ([#168](https://github.com/nikolai-vysotskyi/trace-mcp/issues/168))
* **topology:** make subproject client-call scan async to unblock the event loop, closes [#198](https://github.com/nikolai-vysotskyi/trace-mcp/issues/198)


### Documentation

* **config:** add stdio vs HTTP setup guide for per-repo and team use
* **project-model:** document one-project-per-session model + serve-http log ([#199](https://github.com/nikolai-vysotskyi/trace-mcp/issues/199))

## [1.41.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.41.2...v1.41.3) (2026-06-01)


### Bug Fixes

* **fastapi:** compose cross-file include_router(prefix=...) mount prefixes

## [1.41.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.41.1...v1.41.2) (2026-06-01)


### Bug Fixes

* **config:** index Python source under app/ and flat layouts by default
* **fastapi:** compose APIRouter(prefix=...) into route URIs
* **fastapi:** resolve Depends(dep) to a symbol-level edge in pass 2
* **impact:** bound get_change_impact output for high-fan-in symbols
* **indexer:** discover nested subproject files per detected workspace
* **init:** comprehensive default config for non-framework / container roots
* **laravel:** compose group prefixes via a recursive route walk
* **laravel:** extract closure and inline-chained routes
* **model:** populate get_model_context for Python SQLModel/Pydantic models
* **monorepo:** detect implicit workspaces under a non-workspace root manifest
* **python:** resolve Celery task.delay()/.apply_async() to the task function
* **python:** resolve type annotations to symbol-level references edges
* **topology:** apply Laravel /api prefix for standalone-indexed services too
* **topology:** don't register Laravel nova-components as separate services
* **topology:** exclude intra-repo calls from the cross-project graph
* **topology:** exclude Vue Router page routes from cross-service endpoints
* **topology:** scan Nuxt $api plugin clients and dynamic API paths
* **topology:** serve Laravel routes/api.php endpoints under /api
* **topology:** skip backend declaration/view/admin files in client scan


### Tests

* **eval:** skip eval-cli smoke runs when the global index is transiently unavailable
* **isolation:** redirect global home to a temp dir so tests can't pollute ~/.trace-mcp
* **topology:** cover /api prefix for repo-relative routes/api.php

## [1.41.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.41.0...v1.41.1) (2026-05-29)


### ⚠ BREAKING CHANGES

* **app:** remove desktop app from core repo (phase E)

### Tests

* remove orphaned app tests from core (source moved to app repo)


### Chores

* **app:** remove desktop app from core repo (phase E)
* release as 1.41.1

## [1.41.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.40.0...v1.41.0) (2026-05-29)


### Features

* **app:** Activity P2 — keyboard nav, baseline deltas, sparkline zoom, file deep-links
* **install:** fetch desktop app from dedicated public dist repo (phase C)


### Bug Fixes

* **app:** add ErrorBoundary so one tab crash no longer blanks the whole window
* **app:** stop Activity feed crashing react-dom via nested &lt;button&gt;


### Refactoring

* **install:** make app distribution repo configurable (split prep, phase A)


### Tests

* exclude packages/app from core test runner (app moved to own repo)

## [1.40.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.39.4...v1.40.0) (2026-05-28)


### Features

* **app:** advanced Activity tab — Tool/AI sub-tabs, search, filters, sessions
* **lsp:** background enricher for incremental LSP edge upgrades


### Bug Fixes

* **app:** exclude test files from renderer typecheck
* **cli:** install menu bar app under --yes / --json / --dry-run
* **indexer,analysis:** suppress phantom SCCs from type-only imports & projected edges
* **intelligence:** 14 correctness/UX/storage fixes across the trace-mcp surface
* **updater:** locate installed .app by bundle id instead of guessing ~/Applications ([#179](https://github.com/nikolai-vysotskyi/trace-mcp/issues/179))


### Performance

* **indexer:** default incremental indexFiles to postprocess=minimal
* **indexer:** gate watcher reindexes through dedup + emit watcher telemetry


### Refactoring

* break 2 small import cycles via shared-module extraction
* break 7 small import cycles + fix latent DTS issues exposed


### Documentation

* **landing:** drop Benchmark section, fix install steps, fix copy button


### Chores

* **deps:** bump qs and protobufjs to patched versions


### Build

* ESM + DTS both clean

## [1.39.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.39.3...v1.39.4) (2026-05-25)


### Bug Fixes

* **app:** stop in-app updater from looping on npm-only outcomes ([#173](https://github.com/nikolai-vysotskyi/trace-mcp/issues/173))
* **db:** use ON CONFLICT DO UPDATE in insertSymbol to keep parent_id FKs valid
* **env:** unify .env secrecy model + provenance gate for tool-managed files ([#172](https://github.com/nikolai-vysotskyi/trace-mcp/issues/172))


### Documentation

* **toon:** standardize TOON description wording and document allowlist


### CI/CD

* add pr-comment workflow that posts impact-report from CI artifact

## [1.39.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.39.2...v1.39.3) (2026-05-24)


### Bug Fixes

* **app:** keep guard mode popover above sibling project rows
* **daemon:** self-heal stale registry + actionable MCP errors ([#168](https://github.com/nikolai-vysotskyi/trace-mcp/issues/168))


### Documentation

* align contributor setup with pnpm packageManager ([#156](https://github.com/nikolai-vysotskyi/trace-mcp/issues/156))

## [1.39.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.39.1...v1.39.2) (2026-05-18)


### Features

* **memory:** extend incremental cursor to provider (Hermes) mining
* **memory:** per-service wake-up scoping + scheduler_state table
* **memory:** persist scheduler state across daemon restarts + prune memo auto-trigger map


### Bug Fixes

* **daemon,app:** break post-update restart loop


### Chores

* release as 1.39.2

## [1.39.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.39.0...v1.39.1) (2026-05-18)


### Features

* **daemon:** background memory scheduler (P1.3) — auto mine + cluster + memo
* **memory:** auto-regenerate memo on write + auto-tune weights in scheduler
* **memory:** close P1.1/P1.2/P2.3/P2.4 close-out TODOs (decoration + retention + cursor knob)
* **memory:** confidence-weight learning from review feedback (P2.5)
* **memory:** export_decisions tool + CLI + optional audit log


### Bug Fixes

* **install:** plist v3 — both generators use launcher shim + post-kickstart health probe


### Chores

* **errors:** silence tsup "err/ok never used" warning via type-only import

## [1.39.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.38.0...v1.39.0) (2026-05-18)


### Features

* **ai:** auto-rebuild embedding index on provider/model mismatch
* **ai:** wire P0.1 auto-rebuild into embed_repo, pipeline, verify_index
* **memory:** add LLM-driven extraction strategy to mine_sessions
* **memory:** hard recall timeout for wake_up / query_decisions / feature_context
* **memory:** incremental cursor for session mining
* **memory:** LLM-driven semantic dedup via consolidate_decisions tool
* **memory:** project memo (L3 orientation digest) — synthesis + tools + wake-up integration
* **memory:** wire decision clusters MCP tools + wake-up topics
* **wake_up:** split response into stable+dynamic regions for prompt-cache friendliness


### Bug Fixes

* **app:** Electron auto-update also refreshes the npm CLI
* **ci:** apply-pending-update strips inherited NO_POSTINSTALL + README count
* **config:** allow "_warnings" in tools.meta_fields enum
* **hooks,evidence,gate:** P3 meta cleanup — coach allowlist, verdict split, visible clamps
* **install:** postinstall enables + bootstraps plist on first install
* **memory:** defensive access to memory.recall config in tool handlers
* **navigation,memory,analysis:** P2 UX/correctness pass on intel surface
* **quality,refactoring,analysis:** P1 false-positive + silent-empty pass
* **refactoring:** P0 safety + correctness pass on apply/plan tools
* **test:** embed-repo fake VectorStore must mirror to symbol_embeddings + re-enable in CI


### Chores

* **gitignore:** ignore .claw/, daemon*.log, run-benchmark.ts (developer-local debris)

## [1.38.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.37.0...v1.38.0) (2026-05-17)


### Features

* **daemon:** memory diagnostics endpoint + AI cancellation + multisink resilience + LocalBackend re-entry guard


### Bug Fixes

* **ai:** commit missing src/ai/abort.ts referenced by anthropic/gemini providers
* **app:** launcher-shim binary resolution instead of PATH-only `which`
* **ci:** postinstall test inherits workflow opt-out env + verbose reporter
* **daemon:** preserve error.message + .codeName when logging failures
* **indexer:** cap extract-worker crash loop with backoff + dedup
* **indexer:** release tree-sitter Tree WASM heap via tree.delete() in every parse path
* **install:** self-healing postinstall writes launcher.env + plist
* **logger:** atomic-rename rotation that survives multi-GB log files
* **test:** updater.test.ts must also clear TRACE_MCP_NO_AUTO_UPDATE in CI
* **test:** updater.test.ts must bypass isDevCheckout like rollback suite
* **updater:** atomic backup + rollback for ENOTEMPTY retry path


### Documentation

* **decision-memory:** document live-capture, review queue, and privacy filter


### Tests

* **tools:** behavioural coverage for dead-exports, untested-exports, and decision-graph tools
* **tools:** behavioural coverage for misc + framework-aware tools
* **tools:** behavioural coverage for planning, intent, and batch tools


### CI/CD

* **bisect:** also exclude src/telemetry/__tests__/** — suspect OtlpSink
* bump cache key to v2 to invalidate poisoned node_modules
* **diag:** add [FILE END] marker to surface the actually-hung file
* **diag:** file-start reporter to identify CI hang culprit
* drop --ignore-scripts from build install so native bindings compile
* drop sharding for 1.38.0 release — reliable single-job test run
* exclude embed-repo behavioural test (pinpointed hang via FILE END diag)
* exclude fixture + xml-plugin test files (1.38 release unblocker)
* exclude integration + daemon test dirs (bisect for CI hang)
* exclude tests/perf/** from per-commit shards
* exclude toon-drift + debounce-abort tests — bisection landed
* shard tests + share build artifact + safety-net timeouts (&lt;3 min target)

## [1.37.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.36.1...v1.37.0) (2026-05-15)


### Features

* **tools:** toon output format for tabular MCP responses (30-60% fewer tokens)


### Bug Fixes

* **analysis:** restore findDuplicateSymbols helper that check_duplication relied on
* **benchmark:** honest synthetic-estimator labelling + tokenizer calibration + multi-sample variance
* **daemon:** cap remaining unbounded long-lived caches and stores
* **daemon:** plug FileWatcher re-entry leak + pass_cache TTL + progress-throttle pruning
* **daemon:** restore /mcp routing for stdio clients + scope teardown to removed projects
* **db:** add v11 domain tables to fresh-DB DDL
* **db:** mirror remaining v11+ migration tables in fresh-DB DDL + parity guard
* **intent:** add missing domains JOINs in getCrossDomainDependencies
* **pipeline:** bound per-project resource accumulation across project lifecycle
* **scoring:** drop stale-prone in-process cache from ranking_pins lookups
* **telemetry:** bound OTLP/Langfuse sink memory under unreachable export endpoint
* **test:** bump bundles searchBundles limit-case timeout to 30s
* **tools:** invert source/target check in get_cross_workspace_impact
* **topology:** apply contractType filter to endpoints in get_api_contract
* **topology:** replace stale fr.* alias with sp.* in client-call queries


### Tests

* **tools:** behavioural coverage for api-contract and service tools
* **tools:** behavioural coverage for compare and suggest tools
* **tools:** behavioural coverage for context and complexity tools
* **tools:** behavioural coverage for corpus and packaging tools
* **tools:** behavioural coverage for cross-domain and edge tools
* **tools:** behavioural coverage for decision lifecycle tools
* **tools:** behavioural coverage for graph-traversal and analysis tools
* **tools:** behavioural coverage for graph/relationship tools
* **tools:** behavioural coverage for health and risk tools
* **tools:** behavioural coverage for history and coupling tools
* **tools:** behavioural coverage for index, embedding, and perf tools
* **tools:** behavioural coverage for ownership and tech-debt tools
* **tools:** behavioural coverage for quality and security tools
* **tools:** behavioural coverage for quality/coverage tools
* **tools:** behavioural coverage for refactoring tools
* **tools:** behavioural coverage for security and refactor tools
* **tools:** behavioural coverage for session and analytics tools
* **tools:** behavioural coverage for session and analytics tools
* **tools:** behavioural coverage for snapshot and maintenance tools
* **tools:** behavioural coverage for subproject and api-surface tools
* **tools:** behavioural coverage for trend and visualization tools
* **tools:** behavioural coverage for workspace and architecture tools
* **tools:** behavioural test coverage for search/get_outline/find_usages/get_change_impact/pin/query_decisions
* **tools:** skip discover_claude_sessions fixture on Windows

## [1.36.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.36.0...v1.36.1) (2026-05-14)


### Bug Fixes

* **daemon:** auto-recover from FK-violating stale data on initial index
* **daemon:** require explicit ?project= when multiple projects registered
* **indexer:** density-based binary detection in isBinaryBuffer
* **retrieval:** search_with_mode passes both `text` and `query` fields
* **test:** bump cli-smoke DB-schema test timeout to 30s for Windows runners
* **test:** skip eval-run smoke cases when project is not indexed
* **test:** widen XML perf guard threshold from 500ms to 1500ms


### Documentation

* release 1.36.0 consistency fixes
* **tools:** align check_claudemd_drift return shape with auditConfig


### Tests

* **db:** pin ranking_pins/pass_cache in fresh-DB schema guard
* **integration:** smoke-test eval CLI list/run/baseline
* **smoke:** MCP-tools end-to-end smoke script for new session tools

## [1.36.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.35.1...v1.36.0) (2026-05-13)


### Features

* **app:** insights tab surfacing drift, pagerank, and risk hotspots
* **app:** notebook scratchpad tab for ad-hoc tool queries
* **daemon:** pipeline-lifecycle SSE events + Electron consumer
* **eval:** code-intelligence benchmark harness with CLI subcommand
* **memory:** remember_decision MCP tool for live agent writes
* **pipeline:** composable Task DAG with idempotency keys
* **pipeline:** persisted task-cache via SQLite pass_cache table
* **presets:** decision-memory quartet on minimal + standard
* **quality:** CLAUDE.md drift detection + check_claudemd_drift tool
* **retrieval:** BaseRetriever protocol foundation with 2 adapters
* **retrieval:** emit routing telemetry from feeling_lucky retriever
* **retrieval:** graph_completion retriever — vector hit + 1-hop expansion
* **retrieval:** named search-mode taxonomy + search_with_mode MCP tool
* **scoring:** ranking pins — user-supplied importance weights for PageRank
* **telemetry:** observability bridge with OTLP and Langfuse sinks


### Bug Fixes

* **ci:** normalize CRLF in DaemonEvent union guardrail for Windows runners
* **ci:** unbreak notebook test under frozen-lockfile + register project before eval indexing
* **telemetry:** wire observability bridge into server bootstrap + ship local OTLP recipe


### Performance

* **indexer:** Phase 4+5+7 — incremental edges, cold-start, telemetry


### Refactoring

* **indexer:** migrate 3 pipeline passes onto Task DAG
* **retrieval:** migrate search MCP tool onto BaseRetriever
* **retrieval:** migrate search_text, search_bundles, search_sessions onto BaseRetriever


### Tests

* **daemon:** pipeline-lifecycle SSE integration test + drift firewall
* **quality:** cover dead_skill_ref and dead_command_ref drift categories


### CI/CD

* **eval:** baseline-regression check + GitHub workflow

## [1.35.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.35.0...v1.35.1) (2026-05-11)


### Bug Fixes

* **daemon:** normalize reindex paths to POSIX so Windows tests + cross-path dedup work


### Performance

* **indexer:** daemon-first reindex, AI-call coalescing, shared/warm worker pool, content-hash gate

## [1.35.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.34.2...v1.35.0) (2026-05-10)


### Features

* **app:** four new tabs — Activity, Memory, Ask v2, Dashboard
* **app:** four tabs v2 — stats, write actions, slash-commands, real metrics
* **memory:** lifecycle hooks, branch-aware decisions, stats modal, filter bar, recall harness
* **memory:** tiered retrieval modes + decision confidence/review queue


### Bug Fixes

* **server:** keep stdin in Buffer mode — setEncoding crashes MCP SDK

## [1.34.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.34.1...v1.34.2) (2026-05-10)


### Bug Fixes

* **ci:** pin npm publish back to npx npm@11 — pnpm provenance flow broken

## [1.34.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.34.0...v1.34.1) (2026-05-10)


### Bug Fixes

* **release:** sync Claude Code plugin manifests with package.json on bump

## [1.34.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.33.0...v1.34.0) (2026-05-10)


### Features

* **ai:** classified provider errors + retry helper with exp backoff
* **ai:** consent gate for outbound LLM provider traffic
* **ai:** detect local LLM endpoints (Ollama / LM Studio / llama.cpp)
* **ai:** one-shot stderr warning before cloud-bound embeddings
* **ai:** per-provider quota / auth circuit-breaker
* **ai:** stamp embedding provider on the index, refuse cross-provider mix
* **ai:** tier-router helper + tier-separated default models
* **analysis:** rank cross-community edges by surprise score
* **communities:** seed Leiden PRNG so community IDs are deterministic
* **communities:** split low-cohesion mega-clusters in a second Leiden pass
* **config:** add TRACE_MCP_DATA_DIR + TRACE_MCP_REPO_ROOT env overrides
* **daemon:** add stdio handshake watchdog
* **daemon:** proxy-backend routes worktree paths to canonical indexed repo
* **db:** verify_index + repair_index MCP tools
* **dead-code:** drop framework entry points from the candidate set
* **dead-code:** seed reachability with package.json#exports entries
* **find_usages:** drop text_matched edges into ambiguously-named targets
* **graph:** add float edge confidence on top of resolution_tier
* **hooks:** guard v0.9 — block bare directory walks + .md doc-tour hint
* **impact,refs:** surface resolution_tier on find_usages and get_change_impact
* **indexer:** add postprocess level knob (full / minimal / none)
* **indexer:** detect file renames by content hash and skip re-extraction
* **indexer:** force-include files declared as package.json entry points
* **indexer:** per-target PID-guard for reindex / embed_repo
* **indexer:** warn when a full reindex shrinks the graph by more than half
* **insights:** add generate_insights_report MCP tool
* **memory:** canonicalise decision file_path to repo-relative on store + query
* **memory:** CorpusBuilder — materialise corpora via packContext
* **memory:** CorpusStore — persistent code-context corpora on disk
* **memory:** privacy filter for mine_sessions strips internal payloads
* **memory:** worktree adoption — mine_sessions files decisions under parent
* **perf:** cooperative yield from heavy CPU loops to keep stdio responsive
* **plugin-api:** support async extractNodes in framework plugins
* **plugin:** add Claude Code plugin manifest for one-step install
* **plugins:** add class-validator, passport, react-table; expand NestJS WS
* **plugins:** add Kafka producer/consumer indexer (Spring, kafkajs, Python)
* **plugins:** index .luau (Roblox Lua) and .qmd (Quarto) files
* **plugins:** index extensionless scripts via #! shebang fallback
* **registry:** add git-worktree probe primitives
* **registry:** worktree-aware project resolution
* **security:** add SSRF guard utility for outbound fetches
* **security:** add wall-clock budget to searchText regex iteration
* **security:** extend git env hardening to predictive + impact paths
* **security:** harden git env in workspace-spawned commands
* **server:** expose project state through six MCP resources
* **server:** sanitize MCP tool output against prompt injection
* **server:** UTF-8 + stdout-guard hardening for the MCP stdio transport
* **session:** Codex CLI session provider for mine_sessions / discover
* **shared:** centralised path accessors + invariant test
* **spring:** enrich @Autowired/constructor metadata with call-site hints
* **ssrf-guard:** add allowPrivateNetworks opt-in for local LLM endpoints
* **subproject:** add a remote repo as a subproject in one shot via git_url
* **tools:** add detail_level=minimal knob on search/get_outline/find_usages
* **tools:** add get_minimal_context — single-call orientation entrypoint
* **tools:** add get_suggested_questions for ranked review checklists
* **tools:** add named graph snapshots + diff for tracking evolution
* **tools:** add traverse_graph BFS walker with token budget
* **tools:** coerce empty-string MCP args to undefined for filter fields
* **tools:** export the dependency graph as GraphML / Cypher / Obsidian
* **tools:** Knowledge Agent MCP surface — build/list/query/delete corpus
* **topology:** cross-project topic tunnels via entity registry
* **utils:** atomicWriteJson helper + apply at all state-file write sites
* **viz:** community-aggregation helper for large-graph visualisation
* **vscode-extension:** on-save reindex extension


### Bug Fixes

* **ai:** classify caller-driven aborts in withRetry as kind=aborted
* **app:** declare @types/node directly so tsc -p tsconfig.main.json works under pnpm
* **config:** atomic write for global JSONC config mutations
* **daemon:** atomic write for PID file + atomic stale-lock takeover
* **daemon:** identity-token PID-reuse guard for daemon lifecycle
* **db:** bound WAL growth and add periodic checkpoint to long-lived stores
* **db:** centralise symbols_fts DDL so repair-fts cannot drift from schema
* **dead-code:** never flag symbols that have any incoming call/ref edge
* **git-worktree:** use fs.realpathSync.native for Win32 8.3-shortname normalisation
* **indexer:** normalize relTarget separators when resolving import edges
* **indexer:** parse tsconfig.json as JSONC to recover path aliases
* **indexer:** serialize register_edit and reindex through the same lock
* **indexer:** suppress shrinkWarning + execFileSync for git rev-parse
* **navigation:** explicit degradation signal for semantic search without AI
* pin zod to 4.3.6 via pnpm.overrides (4.4.x breaks dist/cli.js)
* **refactoring:** normalize result paths to forward slashes for cross-platform consistency
* **resolver:** parse tsconfig.json as JSONC, not strict JSON
* **security:** chmod 0700 on ~/.trace-mcp and 0600 on local SQLite stores
* **security:** keep hook source lookup inside the trace-mcp install tree
* **security:** validate git refs and replace shell-mode execSync with execFileSync
* **security:** validate git_ref before passing to git --branch in subproject_add_repo
* **security:** wire SSRF guard into AI provider fetches and git-clone path
* **ssrf-guard:** import LookupAddress from node:dns instead of node:dns/promises


### Documentation

* bump headline figures to 99% and refresh hero copy
* **confidence:** clarify trigger contract + add SQL-level regression tests
* **readme:** add CI status badge
* update contributor instructions for pnpm


### Tests

* **ci:** align test-side realpath with production native binding
* **ci:** fix 7 baseline Windows-only failures (path separators + 8.3 names)
* cover remaining Windows-runner failures from cross-platform CI
* cover the long-tail Windows-runner failures from cross-platform CI
* **docs:** regression test for numeric README claims + sync stale numbers
* **impact,refs:** cover resolution_tier surfacing
* **markdown:** include .qmd in supportedExtensions assertion
* **perf:** de-flake batched-inserts benchmark across CI runners
* **perf:** re-deflake batched-inserts benchmark — loosen to regression guard
* **perf:** skip batched-inserts benchmark on Windows runner
* **security:** cover hook-source path-traversal validators
* **security:** make path expectations Windows-safe


### Chores

* **app:** migrate packages/app from npm to pnpm
* migrate root package manager from npm to pnpm
* **security:** drop unused restrictHomeDirPerms helper
* **wip:** version-stamp init helper + daemon session change


### CI/CD

* also run on push to master
* switch CI install path to pnpm + add cross-platform test matrix

## [1.33.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.7...v1.33.0) (2026-04-30)


### Features

* **app:** Sprint 1B — per-project guard mode toggle on the project list
* **app:** Sprint 2 — onboarding, coach default, version contract, uninstall
* **guard:** add manual bypass + auto-degradation for unresponsive MCP
* **guard:** Sprint 1A — rich status sentinel + hook v0.8 (modes + stall detection)
* **guard:** v0.9 — doc-tour hint for .md reads in source dirs + deny ls on source paths
* **plugins:** add Anthropic (Python + npm) and react-router coverage
* **retrieval:** output-token efficiency phases 1-5


### Bug Fixes

* **app:** open Request links in default browser via shell.openExternal
* **app:** show "Restart to install" after npm-install update
* **guard:** close retry-bypass loophole, add heartbeat fallback


### Documentation

* **landing:** tighten hero CTA, add trust line, reword metrics


### Chores

* **guard:** cross-platform hook resolution + Sprint 2 cleanups

## [1.32.7](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.6...v1.32.7) (2026-04-29)


### Features

* **app:** MCP Clients screen — show "Update" when on-disk entry drifted
* **init:** generic per-client config status + `trace-mcp clients status`


### Bug Fixes

* **daemon:** keep registered projects on graceful shutdown
* **landing:** tighten hero, lift red CTA above the fold, move metrics to proof strip
* **mcp:** keep trace-mcp tools eager in Claude Code via alwaysLoad


### Chores

* release 1.32.7

## [1.32.6](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.5...v1.32.6) (2026-04-29)


### Bug Fixes

* **app:** augment PATH + prefer existing node version for in-app updates

## [1.32.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.4...v1.32.5) (2026-04-28)


### Bug Fixes

* **daemon:** auto-register project on first MCP connect

## [1.32.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.3...v1.32.4) (2026-04-28)


### Bug Fixes

* **cli:** import detectGuardHook + detectProject + missing types in init

## [1.32.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.2...v1.32.3) (2026-04-28)


### Bug Fixes

* **cli:** import detectMcpClients in init command
* **install:** drop simple-git-hooks from postinstall

## [1.32.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.1...v1.32.2) (2026-04-28)


### Bug Fixes

* **app:** coalesce remaining res.statusCode → number ?? 0 ([#116](https://github.com/nikolai-vysotskyi/trace-mcp/issues/116))

## [1.32.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.0...v1.32.1) (2026-04-28)


### Bug Fixes

* **app:** drop duplicate resolveNpmBin/Root + tighten statusCode types ([#115](https://github.com/nikolai-vysotskyi/trace-mcp/issues/115))


### Chores

* **landing:** bump 'up to 97%' to 'up to 99%' in remaining copy

## [1.32.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.31.0...v1.32.0) (2026-04-28)


### Features

* **docs:** full SEO meta, favicon set from electron tray icon, PWA manifest
* **homepage:** mobile above-the-fold CTA, trust badges, red primary CTA
* **init:** add AMP, Warp, Factory Droid MCP clients ([#111](https://github.com/nikolai-vysotskyi/trace-mcp/issues/111))
* recomputation narrative + knowledge-graph markdown indexing ([#112](https://github.com/nikolai-vysotskyi/trace-mcp/issues/112))


### Bug Fixes

* **homepage:** eliminate horizontal scroll on mobile
* **landing:** collapse hero to single column on mobile
* **landing:** mobile hero — make 40–50% the lead metric with a value-prop label
* **landing:** mobile hero — promote 99% as the single hero metric
* **landing:** mobile overflow on use cases grid and install terminal
* **landing:** split 'up to' off the giant Doto numeral on mobile
* **merge:** drop duplicate imports + restore missing path import ([#113](https://github.com/nikolai-vysotskyi/trace-mcp/issues/113))


### Documentation

* **homepage:** restructure around "code intelligence layer for AI agents" positioning
* **landing:** drop pilot CTAs, send users straight to install/repo
* **positioning:** reframe as optimization layer for LLM apps, honest token numbers
* **readme:** add Star History chart


### Chores

* **ci:** hold off on electron major bumps
* **ci:** hold off on vite + plugin-react major bumps in app
* **ci:** hold off on web-tree-sitter minor/major bumps
* **ci:** ignore major bumps for @types/node
* **ci:** include chore/ci/build in release-please changelog
* **deps:** bump typescript to 6.0.3 (root + app) ([#103](https://github.com/nikolai-vysotskyi/trace-mcp/issues/103))
* **deps:** bump zod from 3.24 to 4.3.6 ([#105](https://github.com/nikolai-vysotskyi/trace-mcp/issues/105))
* **security:** bump electron to 41.3.0, drop stale pnpm-lock ([#109](https://github.com/nikolai-vysotskyi/trace-mcp/issues/109))
* **tooling:** introduce Biome as formatter (root) ([#110](https://github.com/nikolai-vysotskyi/trace-mcp/issues/110))


### CI/CD

* **release:** sign Electron release artifacts with SLSA provenance ([#108](https://github.com/nikolai-vysotskyi/trace-mcp/issues/108))
* **security:** add CodeQL, Semgrep, OSSF Scorecard, Dependabot
* **security:** pin all GitHub Actions by SHA, add top-level read perms

## [1.31.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.30.0...v1.31.0) (2026-04-24)


### Features

* **init:** Hermes Agent as a supported MCP client
* **session-providers:** Hermes Agent session provider + SessionProvider interface


### Bug Fixes

* **updater:** skip auto-update in dev checkouts


### Refactoring

* **init:** extract shared md-block helper from claude-md.ts


### Documentation

* **benchmark:** update with v1.30 results (92.8% reduction)

## [1.30.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.29.0...v1.30.0) (2026-04-23)


### Features

* **ai:** add Vertex AI and Voyage providers, retrieval task hint
* **analysis:** symbol-level bottlenecks + Stress Test hotspots UI
* **plugins:** add aws-s3 / supabase / sortable, Laravel sub-plugins, expanded coverage


### Bug Fixes

* **code-smells:** skip markdown and other non-code files
* **darwin:** prime amfid for prebuilt native modules


### Refactoring

* **plugin-api:** add PluginRegistry.createWithDefaults factory


### Documentation

* **plan:** session-providers implementation plan

## [1.29.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.28.0...v1.29.0) (2026-04-22)


### Features

* **analysis:** edge bottlenecks + app Quality tab + bottleneck graph overlay
* **plugins:** add ioredis, jose, nodemailer, redis-py, gunicorn, uvicorn plugins
* **plugins:** expand php-ecosystem coverage to 12 more packages
* **quality:** add debug-artifact smell, size/complexity antipatterns, AST clone detector
* **server:** add tools.agent_behavior config for discipline rules
* **subproject:** cross-service endpoint literal scan + Nuxt/httpx/aiohttp/urllib


### Bug Fixes

* **ai:** stamp embedding model+dim and reindex on mismatch
* **app:** harden pending-update lifecycle
* **env-indexer:** strip **/.env* patterns from fast-glob ignore list
* **hooks:** exempt .env.example/.env.sample templates from guard


### Documentation

* add Max-tier agent behavior, app gallery, and refreshed comparisons

## [1.28.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.27.0...v1.28.0) (2026-04-21)


### Features

* **plugins:** add Python ecosystem integration plugins


### Bug Fixes

* **indexer:** resolve asset imports and TS re-exports across the graph


### Performance

* **app:** custom FPS overlay + disable halo to lift graph FPS
* **app:** re-enable GPU compositing for graph explorer
* **app:** upgrade cosmos.gl to 3.0 beta and rework label placement

## [1.27.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.26.0...v1.27.0) (2026-04-20)


### Features

* **app:** open selected graph node in installed IDE


### Bug Fixes

* **app:** robust Update button with scratch cleanup, --force, and visible errors
* **build:** bundle deps via createRequire to survive spaced install paths
* **postinstall:** match new release asset naming (-arm64-mac.zip / -mac.zip)
* **updater:** pre-clean scratch dirs and back off on repeated failures

## [1.26.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.25.0...v1.26.0) (2026-04-20)


### Features

* **ai:** per-capability gates and empty-string config hygiene
* **app:** Ollama control panel in Settings
* **app:** tinted edge colors and camera-interaction lock in graph explorer
* **init:** stable launcher shim for MCP registration


### Bug Fixes

* **app:** capture streaming buffer before setState in AskTab
* **daemon:** launchd bootstrap/kickstart + startup health wait
* **db:** idempotent file upsert via ON CONFLICT
* **init:** drop stale {{tool_name}} template and clean up legacy hooks


### Documentation

* add dark-mode graph screenshot and refresh app images


### Tests

* **launcher:** accept either probe failure on CI

## [1.25.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.24.0...v1.25.0) (2026-04-18)


### Features

* **app:** graph explorer expansion and renderer UI polish
* **app:** hardened staged auto-update with SHA-256 + Gatekeeper
* **daemon:** unified lifecycle, idle auto-exit, and subdir→parent routing
* **indexer:** isolate workspaces in framework and file-projection edges
* **viz:** derive community labels from dominant path prefix


### Performance

* **indexer:** parallel file extraction via worker pool


### Documentation

* README refresh, desktop app section, comparisons page

## [1.24.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.23.1...v1.24.0) (2026-04-17)


### Features

* add landing page for trace-mcp.com
* **ai:** track AI request activity + rename ollama default model
* **app:** GPU-accelerated graph explorer (cosmos.gl)
* **blade:** extract script src asset references
* **daemon:** unified stdio session with proxy⇄full auto-switching
* **indexer:** phantom externals + file-level projection + TS call/type edges
* js-viz (Chart.js/vue-chartjs/marked) + php-ecosystem (symfony-dom-crawler/google-apiclient/laravel-ai) plugins
* **landing:** add ASK/GET examples, cross-language edge diagram, FAQ, use cases
* **laravel:** medialibrary + eloquent-sortable + composer Package Discovery
* **nextjs:** file-based entry point edges for App/Pages Router + metadata
* Nuxt 3/4 entry points, custom prefix parsing, improved detection
* **nuxt:** middleware/layout/plugin/route auto-registration edges
* PHP call graph resolver — symbol-level calls/heritage edges
* PHP property and constant access edge resolution
* PHP type-aware call resolution + class references
* scan Blade templates for PHP function calls + workspace-aware resolution
* structural member_of edges + class-fallback for unresolved methods
* Vue dynamic component references via TS/JS/Vue content scanning
* **vue:** Laravel Nova + Blade component entry points, SSR marker


### Bug Fixes

* **db:** schema v20 backfills seed edge types on existing DBs
* eliminate client call scanner false positives
* **init:** detect running Claude Desktop to avoid config overwrite
* **landing:** dynamic version from npm registry + terminal whitespace
* **landing:** improve readability — body text uses primary, headings beefed up
* make dir argument optional in index command, default to cwd
* self-first endpoint matching for client calls
* strict project_group isolation — ungrouped services no longer leak
* workspace assignment on fast path + broader default include patterns
* workspace naming, parent DB route fallback, and client_calls FK migration


### Refactoring

* community labels show dominant dir, pack-context models/feature-scope use FTS
* redesign landing page in Nothing design system

## [1.23.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.23.0...v1.23.1) (2026-04-15)


### Bug Fixes

* **app:** remove unused trace-mcp runtime dependency

## [1.23.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.22.0...v1.23.0) (2026-04-15)


### Features

* add Anthropic, Gemini, and OpenAI-compatible AI providers
* add PHP import edge resolver for use statement resolution
* add service group management UI and API
* **app:** add model-select and multiselect controls for AI settings


### Bug Fixes

* add workspace isolation to PHP import resolver
* isolate cross-service endpoint matching by project_group
* prevent topology contract duplication, false endpoints, and stale edges


### Tests

* add tests for topology fixes and PHP import resolver

## [1.22.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.21.2...v1.22.0) (2026-04-15)


### Features

* add MCP ToolAnnotations to all tools for Glama TDQS scoring
* add security context export for MCP server analysis
* add stdio proxy mode and lifecycle management
* redesign AskTab with provider setup CTA and settings deep-linking


### Bug Fixes

* add pre-flight check in GraphExplorer to prevent raw error display
* match LICENSE text to SPDX Elastic-2.0 canonical template
* move frameRequested declaration before first use in visualize
* remove extra text from LICENSE for exact SPDX template match
* split license into standard ELv2 + ethical addendum
* unset ELECTRON_RUN_AS_NODE in electron dev script
* use valid SPDX license identifier for Elastic-2.0


### Documentation

* add usage guidelines and output format to all tool descriptions

## [1.21.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.21.1...v1.21.2) (2026-04-14)


### Bug Fixes

* **ci:** pass --repo to gh commands in release notes step

## [1.21.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.21.0...v1.21.1) (2026-04-14)


### Bug Fixes

* sync lock file and make serve the default command

## [1.21.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.20.1...v1.21.0) (2026-04-14)


### Features

* **ai:** add streaming inference and ask command with code context
* **analytics:** expand known-packages catalog with deprecation tracking
* **app:** add Windows platform support with custom tab bar and installer
* **app:** extract daemon-lifecycle module and auto-start daemon from tray
* **lang:** add 10 new language plugins (Ada, Apex, D, Nim, Pascal, PL/SQL, PowerShell, Solidity, Tcl, VHDL)
* **lang:** enhance regex-base with scope tracking, doc comments, and multi-line signatures
* **lang:** improve regex-based plugins for Clojure, COBOL, Common Lisp, and 7 others
* rename "federation" to "subproject" across entire codebase
* **server:** add compact_schemas option to reduce tool schema token overhead

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

* resolve SQLite migration crashes and daemon PATH for launchd

## [1.20.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.19.0...v1.20.0) (2026-04-13)


### Features

* add Class Hierarchy Analysis (CHA) for polymorphic call resolution ([#55](https://github.com/nikolai-vysotskyi/trace-mcp/issues/55))


### Bug Fixes

* align get_tests_for with graph test_covers edges ([#56](https://github.com/nikolai-vysotskyi/trace-mcp/issues/56))
* exclude CLI entry points from get_dead_exports false positives ([#53](https://github.com/nikolai-vysotskyi/trace-mcp/issues/53))
* resolve method calls on parameter-annotated instances ([#54](https://github.com/nikolai-vysotskyi/trace-mcp/issues/54))

## [1.19.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.18.0...v1.19.0) (2026-04-12)


### Features

* add decision memory system for cross-session knowledge
* add Filament and Electron framework plugins
* add move, change-signature, and plan-refactoring tools
* add technology coverage, service management, and UI improvements
* scope federations to projects with auto-discovery


### Bug Fixes

* update tool registrations and fix visualize test assertions


### Documentation

* update documentation for refactoring tools and decision memory

## [1.18.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.17.0...v1.18.0) (2026-04-12)


### Features

* pin app to macOS Dock after install


### Bug Fixes

* include assets and icon in electron-builder package files

## [1.17.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.16.1...v1.17.0) (2026-04-12)


### Features

* default to max enforcement level, add install-app CLI command with retry


### Bug Fixes

* handle nullable topoStore in visualize tool

## [1.16.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.16.0...v1.16.1) (2026-04-12)


### Bug Fixes

* package.json
* resolve TypeScript errors in visualize modules

## [1.16.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.15.2...v1.16.0) (2026-04-12)


### Features

* add CORS headers to HTTP server for Electron renderer


### Bug Fixes

* exclude vendor dirs from graph visualization and clear state on error
* simplify artifact upload glob and remove redundant arch from yml

## [1.15.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.15.1...v1.15.2) (2026-04-12)


### Bug Fixes

* correct electron-builder artifact glob for macOS zip upload

## [1.15.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.15.0...v1.15.1) (2026-04-12)


### Bug Fixes

* consolidate electron-builder config to prevent asar packaging failure

## [1.15.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.14.1...v1.15.0) (2026-04-12)


### Features

* add --granularity, --symbol-kinds, --hide-isolated flags to CLI visualize
* async DB + pytest integration plugins
* clean topology data (federation, services) on project removal
* daemon mode — multi-project serve-http with REST API, SSE events, and stdio daemon awareness
* Electron app — auto-updater, GPU crash recovery, file browser, federation panel
* Electron app — redesigned icons, settings UI overhaul, clients tab, graph explorer improvements
* federated graph visualization, session landmarks, daemon client naming
* get_untested_symbols tool + per-symbol test reach in change impact
* graph visualization — light/dark theming, minimap, BFS highlight depth
* implicit workspace detection + per-workspace framework plugin activation
* LSP enrichment — 4-tier edge resolution confidence, schema v19, SQLite batch chunking
* menu bar app — Electron tray app, installer, init wizard integration, CI release workflow
* Next.js plugin — optional catch-all routes, 2-level intercepting routes, route segment config, use client/cache directives
* Next.js plugin — src/ prefix support, new file conventions (forbidden, unauthorized, metadata, instrumentation, proxy)
* ONNX local embeddings + Signal Fusion search — zero-config semantic search with multi-channel WRR ranking
* post-update migrations — auto-migrate hooks, config, CLAUDE.md, and reindex after version change
* Python language support — edge resolvers, CFG patterns, visibility, docstrings
* symbol-level graph, isolated-node filter, monorepo federation fix
* workspace-aware module resolution + config exclude normalization


### Bug Fixes

* replace dynamic await import() with static http import in postinstall-app.mjs
* set renders_component edge type category to 'nuxt' in NuxtPlugin
* visualize_graph file mode now seeds by symbol nodes, collapses to file edges


### Performance

* eliminate redundant queries in graph visualization


### Refactoring

* extract setupProject, add REST API endpoints, consolidate CI
* extract shared resolveSymbolInput utility, improve tool robustness


### Documentation

* update README, CLAUDE.md, configuration, and MCP instructions for LSP, ONNX, Signal Fusion, untested symbols

## [1.14.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.14.0...v1.14.1) (2026-04-09)


### Refactoring

* Improve project root detection logic

## [1.14.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.13.0...v1.14.0) (2026-04-09)


### Features

* add workspace/monorepo fallback with deep glob patterns when root has no direct source files


### Bug Fixes

* use result.isErr() instead of result.ok for neverthrow Result check

## [1.13.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.12.0...v1.13.0) (2026-04-09)


### Features

* add auto-updater with configurable check interval
* add budget defaults, improve analytics and tool-gate
* add confidence levels and methodology disclosure to analytical tools
* add discover_claude_sessions for multi-project federation
* add git worktree support, visualize CLI command, and auto-update serve flow
* add pack-context strategies (core_first, compact) and budget reporting
* add plan_turn opening-move router with insertion-point suggestions
* add semantic search modes, LRU result cache, and embed_repo tool
* add skills directory with trace-mcp usage guides
* enrich empty-result evidence with isolation verdict and relation tool suggestions
* refactor Dart plugin and improve CSS/JSON/YAML/Python/Kotlin language plugins
* refactor federation manager into focused modules
* upgrade hooks to v0.6.0 with per-session repeat-read dedup


### Bug Fixes

* remove DENY_MARKER cycle from guard hook, write initial state on first deny
* swap stat order in file_mtime to prevent multi-line output on Linux


### Refactoring

* remove file-watcher module


### Documentation

* update README with new tools and feature highlights

## [1.12.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.11.0...v1.12.0) (2026-04-07)


### Features

* add configurable file logging with rotation
* add decorator/annotation extraction and filtering
* add Laravel Horizon, Cashier, Scout, and Socialite plugins
* add Tailwind CSS integration plugin
* expand project root markers, add progress tables, improve evidence


### Documentation

* update README comparison table for accuracy

## [1.11.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.10.0...v1.11.0) (2026-04-07)


### Features

* add recursive multi-project technology coverage detection


### Refactoring

* Improve project root detection logic

## [1.10.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.9.0...v1.10.0) (2026-04-07)


### Features

* add CI project-aware reports with domain, ownership, and deployment analysis


### Refactoring

* extract federation manager helper methods
* extract indexer pipeline and file-persister helper methods


### Tests

* add topology DB and contract parser tests

## [1.9.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.8.0...v1.9.0) (2026-04-07)


### Features

* add advanced .traceignore
* add federation schema diffing, contract versioning, and federated search
* add Junie, JetBrains AI Assistant, and Codex MCP client support
* add server PID tracking, improved status output, and tweakcc integration
* migrate 16 language plugins from regex to tree-sitter


### Refactoring

* extract Laravel edge resolvers into sub-modules


### Documentation

* strengthen apply_codemod enforcement rule in CLAUDE.md
* update benchmarks to 11 categories and refresh tool counts to 120+


### Tests

* add server tool-gate, explored-tracker, and consultation-markers tests

## [1.8.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.7.0...v1.8.0) (2026-04-07)


### Features

* add JSONC-safe config read/write with migration support


### Performance

* optimize context bundle token efficiency

## [1.7.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.6.1...v1.7.0) (2026-04-07)


### Features

* add benchmark scenarios for find_usages, context_bundle, type_hierarchy, tests_for
* add indexing progress tracking with CLI status/remove commands
* block Agent(Explore) subagents in guard hook v0.5.0
* seed JSONC config template with all parameters on first run
* support async extractSymbols in LanguagePlugin interface


### Bug Fixes

* align benchmark SQL with normalized edge_types table
* correct TypeScript typing in hook entry filter callback
* update prompt templates to match current API response shapes


### Documentation

* add tweakcc system prompt routing guide
* expand CLAUDE.md with Agent anti-pattern table and Read-before-Edit optimization

## [1.6.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.6.0...v1.6.1) (2026-04-06)


### Bug Fixes

* deduplicate trigram batch by symbolId to prevent INSERT OR REPLACE conflicts
* skip missing child directories in multi-root workspace builds
* wrap CLI upgrade operations in try/catch for graceful error handling

## [1.6.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.4...v1.6.0) (2026-04-06)


### Features

* add apply_codemod tool for bulk regex find-and-replace
* add multi-root project support


### Refactoring

* migrate from native tree-sitter to web-tree-sitter WASM

## [1.5.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.3...v1.5.4) (2026-04-06)


### Refactoring

* Update hook finding logic

## [1.5.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.2...v1.5.3) (2026-04-06)


### Bug Fixes

* **ci:** use npx npm@11 for publish instead of global npm upgrade

## [1.5.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.1...v1.5.2) (2026-04-06)


### Bug Fixes

* **ci:** move TSUP_TARGET to job-level env and install latest npm for OIDC

## [1.5.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.0...v1.5.1) (2026-04-06)


### Bug Fixes

* **ci:** set node22 tsup target for npm OIDC publish compatibility

## [1.5.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.4.1...v1.5.0) (2026-04-06)


### Features

* add .traceignore support and shared ignore-pattern parser
* add AI concurrency config, expand known packages, simplify CI
* add consultation markers, explored tracker, and guard hook v0.4.0
* add duplication checking guidance to tools and instructions
* add memory leak detector and inter-procedural taint analysis
* add session dedup, resume, and adaptive token budget
* add session snapshot, precompact hook, and worktree hooks
* enhance init with competing tool cleanup and error handling


### Bug Fixes

* **ci:** improve risk scoring and split code/non-code file sections
* **ci:** use last release tag as base for impact report
* improve dead export detection accuracy
* store original export names in import specifiers across all languages


### Refactoring

* extract pipeline file persistence and edge resolution
* extract server tool registration into modular register files
* extract shared test utilities into tests/test-utils.ts
* extract Store into repository pattern
* narrow export visibility and minor cleanups across codebase
* remove dead code and narrow export visibility
* reorganize source tree into domain subdirectories


### Documentation

* add token reduction stat to README tagline
* update README with comparison tables, benchmarks, and .traceignore


### Tests

* add tests for init, runtime, tools, and AI pipeline
* expand conflict-detector coverage with fixture-based tests

## [1.4.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.4.0...v1.4.1) (2026-04-05)


### Bug Fixes

* **ci:** upgrade to Node 24 and conditionally upgrade npm

## [1.4.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.3.1...v1.4.0) (2026-04-05)


### Features

* add token optimization guidance to server instructions and hints

## [1.3.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.3.0...v1.3.1) (2026-04-05)


### Bug Fixes

* **ci:** restore npm upgrade for Trusted Publishing OIDC support

## [1.3.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.2.2...v1.3.0) (2026-04-05)


### Features

* add 10 integration plugins (mcp-sdk, raw-sql, commander, tree-sitter, etc.)
* enriched change impact with risk scoring, breaking changes, and diff-aware mode
* reduce tool calls and token waste across 7 optimizations
* safer conflict resolution — comment-out instead of delete, scope to selected clients
* scan .github/workflows in project context discovery
* token efficiency improvements + .env security guard
* Windows support for guard and reindex hooks


### Bug Fixes

* **ci:** bump Node from 20 to 22 to fix tsup DTS build

## [1.2.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.2.1...v1.2.2) (2026-04-05)


### Bug Fixes

* **ci:** auto-trigger CI on release-please PR branches

## [1.2.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.2.0...v1.2.1) (2026-04-05)


### Bug Fixes

* merge import specifiers on conflict instead of silently dropping
* restore parseError used by 20 language/integration plugins

## [1.2.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.1.0...v1.2.0) (2026-04-05)


### Features

* add analytics system with benchmarks and session tracking
* add bundle management, file watcher, and health check CLI
* add claw-code MCP client support
* add quality gates, taint analysis, and evidence tools
* integrate new features into server, CLI, and config


### Bug Fixes

* **ci:** support impact reports for release-please auto-PRs


### Performance Improvements

* optimize indexer with concurrent extraction and FTS5 batch mode

## [1.1.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.11...v1.1.0) (2026-04-05)


### Features

* add code smells scanner, consolidate imports, improve tool routing docs

## [1.0.11](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.10...v1.0.11) (2026-04-05)


### Bug Fixes

* **deps:** suppress tree-sitter peer dependency warnings
* **server:** remove duplicate plan_batch_change tool registration

## [1.0.10](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.9...v1.0.10) (2026-04-05)


### Bug Fixes

* **db:** add missing workspace/is_cross_ws columns in migration v9

## [1.0.9](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.8...v1.0.9) (2026-04-05)


### Bug Fixes

* **ci:** upgrade npm for Trusted Publishing OIDC support (requires &gt;=10.9.2)

## [1.0.8](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.7...v1.0.8) (2026-04-05)


### Bug Fixes

* **ci:** restore registry-url for npm OIDC auth

## [1.0.7](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.6...v1.0.7) (2026-04-05)


### Bug Fixes

* **ci:** remove registry-url to let npm use OIDC for Trusted Publishing

## [1.0.6](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.5...v1.0.6) (2026-04-05)


### Bug Fixes

* **ci:** use npm Trusted Publishing (OIDC) instead of NPM_TOKEN

## [1.0.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.4...v1.0.5) (2026-04-05)


### Bug Fixes

* **ci:** sync package-lock.json with fastest-levenshtein dependency

## [1.0.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.3...v1.0.4) (2026-04-05)


### Bug Fixes

* **ci:** add .npmrc with legacy-peer-deps for tree-sitter conflicts

## [1.0.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.2...v1.0.3) (2026-04-05)


### Bug Fixes

* **ci:** chain publish job to release-please via outputs

## [1.0.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.1...v1.0.2) (2026-04-05)


### Bug Fixes

* **ci:** trigger publish on GitHub Release instead of tag push

## [1.0.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.0...v1.0.1) (2026-04-05)


### Bug Fixes

* fix allowList key casing in .clabot for cla-assistant

## [1.0.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v0.1.1...v1.0.0) (2026-04-05)


### ⚠ BREAKING CHANGES

* get_task_context replaces manual chaining of search → get_symbol → get_context_bundle as the recommended workflow for AI agents starting work on a task. Server instructions updated to route agents to this tool first.

### Features

* add 23 new analysis tools — control flow, dataflow, SBOM, security, co-changes, history
* add 24 new language plugins and improve existing parsers
* add get_task_context — graph-aware context engine for AI agents
* CI/PR change impact reports — blast radius, risk scores, test gaps
* doctor command, conflict detection, init improvements
* enhance existing tools — call-graph, components, events, flow, introspect, model
* federation system — cross-repo graph linking and fuzzy search
* PostToolUse auto-reindex hook + index-file command
* runtime improvements, session tracking, savings telemetry, prompt system

## [0.1.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v0.1.0...v0.1.1) (2026-04-04)


### Features

* 11 self-development MCP tools + TypeScript heritage graph + ESM import resolution
* 15 new analysis tools — graph, git, complexity, dead code, rename safety
* 34 new language plugins + version feature detection
* 5 new MCP tools + search async upgrade
* add monorepo support, external plugins, E2E tests
* add NestJS, Next.js, Express framework plugins
* add optional AI semantic search (Ollama + vector store)
* **ai:** OpenAI embedding provider
* call graph tests, hybrid search tests, seed edge types fix, PageRank cache fix
* core infra — TS heritage extraction, store introspection, watcher debounce
* DB schema v12, BM25 tuning, pipeline batching, binary/gitignore filtering
* expand MCP server — 30+ new tool registrations, improved descriptions
* file watcher + hot-reload indexing in CLI
* Gin, Echo, Angular, Svelte integration plugins
* global config, project registry, CLI init/add/upgrade commands
* Laravel sub-plugins, new tools, Expo Router, integration tests
* **laravel:** Filament v3 plugin — resources, panels, widgets, relation managers
* **laravel:** Livewire v2/v3 plugin integration
* Mongoose, Sequelize, React Native plugins + 4 new tools
* Nova, Expo Router, find_references + integration tests
* organize integration plugins into category subdirectories
* perf optimizations, Java extends fix, new plugins (Go/Kotlin/Rails/Zod)
* predictive intelligence, intent classification, runtime tracing, topology
* Prisma, TypeORM, Drizzle, GraphQL plugins + ORM e2e tests
* Python ecosystem — Django, Flask, FastAPI, Celery, DRF, Pydantic, SQLAlchemy
* reorganize plugin system — versioned languages, categorized integrations
* security hardening, batch DB ops, dependency graph, dead export detection
* Spring/Rails plugins, platform-specific RN edges, expanded dynamic tool registration
* testing framework plugin + edge types for test coverage analysis
* tRPC, Fastify, Socket.io, Zustand, React plugins + Django registration + fixes
* wire EmbeddingPipeline into CLI serve command
* zustand/redux state tool, security utils, dead-exports/references/hierarchy tests


### Bug Fixes

* add missing handler/metadata fields to RouteRow and null-check file_id
* align n8n plugin tests with current implementation
* Inertia edge resolution + integration tests exposing real bugs
* Kotlin heritage regex + Go/n8n/tRPC improvements
* ORM-specific edge type resolution in pipeline

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
