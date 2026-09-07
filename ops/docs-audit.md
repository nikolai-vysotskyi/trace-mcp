# Documentation audit ledger

What has been checked line-by-line against the code, when, and what was found.
Same purpose as `ops/distribution.md`: the work is invisible from the diff, so
without a written record each run re-reads the same pages and re-discovers the
same things — or, worse, stops at "nothing new" because it happened to open a
page a previous run had already fixed.

**Update this in the same change that audits something.** A row here means
someone compared the prose to the code, not that the page looks plausible.

Claims that a test already guards need no re-audit; the guard is the record:

| Claim | Guard |
| --- | --- |
| tool / language / framework counts in README, docs, CLAUDE.md, AGENTS.md, skills | `tests/docs/readme-claims.test.ts` against `docs/_data/counts.yml` |
| preset sizes | `tests/docs/preset-claims.test.ts` against the real tool filter |
| per-language capability matrix | `tests/docs/language-matrix.test.ts` |
| every registered tool has a documented one-liner | `tests/docs/tools-index.test.ts` |
| every config key the schema accepts is listed with its type and real default | `tests/docs/config-index.test.ts` |
| every docs page is indexed or `noindex`, and linked from the footer nav | `tests/docs/internal-links.test.ts` |
| reader-visible `updated:` dates match `sitemap.xml` | `tests/docs/page-dates.test.ts` |
| breaking changes appear in the changelog | `tests/docs/changelog-breaking-changes.test.ts` |
| every backticked repository path in `README.md` and `docs/**` exists | `tests/docs/doc-path-refs.test.ts` |

## Audited

| Date | Scope | Verified against | Outcome |
| --- | --- | --- | --- |
| 2026-09-07 | every claim about *where the product runs*, and every surface quoting the PR-benchmark saving | `src/telemetry/usage-ping.ts`, `docs/privacy.md`, `docs/_data/pr_context_bench.json`, `docs/_data/pr_context_quality.json` | Two defects, both on the first screen. (1) The banner chip and its `alt` text read **100% local** while the usage ping POSTs to `google-analytics.com` on by default — `grep google-analytics` over our own repo disproves it in one command, on the string auto-indexes copy verbatim. Now "your code stays local"; the generator, the `alt` and the four banner PNGs move together. (2) `README.md` published **70.5% fewer input tokens** with no quality figure anywhere on the page, though the same 60 PRs were scored blind and the data has sat in `docs/_data/pr_context_quality.json` since 2026-09-07 (67% vs 65% understood, 0.80 vs 0.58 false positives). Both are now gated in `tests/docs/readme-claims.test.ts`. **Not fixed here, filed instead:** `docs/index.html` (hero) and `docs/comparisons.md` quote the saving without the quality half — those pages belong to the site and competitor mandates. |
| 2026-09-06 | every backticked repository path in `README.md` and `docs/**` | the filesystem, via `extractDocRefs` (`verify_docs`) | 59 paths did not exist. Ten were real drift and are fixed here: `src/indexer/extract-worker.js` (it is `.ts`), `benchmarks/pr-context-benchmark` (it is `benchmarks/pr-context`), `src/indexer/plugins/integration/framework/index.ts` (no such file — plugins register in `src/indexer/plugins/integration/all.ts`), and seven `packages/app/` paths written as if repo-root in `docs/perf/README.md` and `docs/development.md`. The rest are other projects' trees quoted in `docs/comparisons.md`, generated or gitignored files, files correctly named as deleted, and add-a-plugin placeholders — all enumerated with a reason in `tests/docs/doc-path-refs.test.ts`, which now gates this. |
| 2026-08-30 | `docs/tools-reference.md` — completeness of the tool listing | every `server.tool(...)` registration under `src/tools/register`, captured live via `_capture-tools.ts` | 101 of the 151 tools a default install registers were listed nowhere. Fixed by generating `docs/tools-index.md` (#642) and dropping the page's "full reference" claim. |
| 2026-08-30 | tool names quoted anywhere in `docs/tools-reference.md` | the same registration scan, plus `src/tools/ai/ai-tools.ts` | No ghosts. The five AI-backed tools live outside `src/tools/register`, which is why they are absent from `counts.yml` — that is correct, not drift. |
| 2026-09-02 | every CLI command and long flag quoted in a code span or fenced block across `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `DESIGN.md`, `SECURITY.md`, `docs/**`, `skills/**` | `--help` output of the real binary — every top-level command and every subcommand of `clients`, `bundles`, `subproject`, `memory`, `analytics`, `daemon`, `eval`, `consent` | One ghost: `README.md` documented `trace-mcp savings`, which does not exist (it is `trace-mcp analytics savings`; an unknown verb falls through to the default `serve` command and errors with `too many arguments for 'serve'`). **Every documented long flag exists** — no drift in the flag surface. |
| 2026-09-02 | every `~/.trace-mcp` / `.trace-mcp.json` path quoted in the docs, in the files PR #717 does not touch | `src/global.ts` (`TRACE_MCP_HOME`, `INDEX_DIR`, `REGISTRY_PATH`, `TOPOLOGY_DB_PATH`, `DAEMON_LOG_PATH`), `src/config.ts` `searchPlaces`, `src/runtime/tuning.ts`, `src/shared/paths.ts` | The state directory became `~/.trace` in TRA-611 and the docs never followed: `registry.json`, `topology.db`, `daemon.log`, `tuning.jsonc`, `telemetry-state.json`, the per-project index DBs and the project-local config file were all documented under the old name. Fixed here. `docs/development.md:268,287` deliberately keep the old path — the app/scripts really do still write those two markers there, which is a code bug, not a doc bug (TRA-667). |
| 2026-09-04 | `docs/configuration.md` — every key, type and default it states, in both tables and jsonc examples | every path in `TraceMcpConfigSchema`, walked programmatically for type, enum members, bounds and default | **Documented defaults are accurate** — one automated pass over every table row and every `// default:` comment found no drift, and no ghost keys: everything the page names exists. Two real defects: the page claimed to cover "every key" while describing 190 of 263 (73 keys were documented nowhere in the repo, including all of `predictive`, `runtime`, `indexer`, `pipeline`, `vault`, `logging`, `git` and six daemon knobs), and the Multica-agents section stated the default preset is `standard` — it is `minimal`, as the same page's own `tools.preset` row says. Fixed by generating `docs/config-index.md` from the schema and correcting the preset claim. |
| 2026-09-04 | `config.db.path` | `src/global.ts` `getDbPath()`, and every reader of `config.db` | The default `.trace-mcp/index.db` is vestigial: indexes are resolved into `~/.trace/index/` and the only runtime reader is the `config.dbPath` field of `get_project_status`, which therefore reports a path no database is at. A code bug, not a doc bug — noted on the generated page, filed separately. |
| 2026-09-02 | `SECURITY.md` default-exclude list | `src/config.ts:879` | Claimed `.trace-mcp` and `.turbo` are excluded by default. Neither is in the schema default. Also claimed the index DB defaults to a project-relative `.trace-mcp/index.db`; real DBs are resolved by `getDbPath()` into `~/.trace/index/`. Both fixed. |
| 2026-09-05 | `docs/images/` freshness and content, and the screenshot claims in `docs/DESIGN-WEB.md` | `node scripts/capture-screenshots.mjs --check`, then a re-capture and a look at all six frames; the pairing check the checklist itself prescribes, run against `docs/index.html` | The committed set was two markers stale — app UI `150a59fd → d88864d4` (9 commits under `packages/app/src/{renderer,main}`) and app version 3.17.0 → 3.18.0. Re-captured; all six frames publishable (no error banners, skeletons, personal paths). The checklist's own un-paired-shot measurement stated "It is 2 today" — it is 0: all six shots have been paired since TRA-851, so the line taught the reader to expect a failure that no longer exists. Fixed. Remaining defect, not fixed here: in `app-dark-projects` the three headline tiles read "No change vs 2 seconds ago" because the light shot seeds the delta baseline moments earlier, while the same tiles in the light shot read "tracking from today". Capture-script fix, filed separately (script is owned by Design/UX). |
| 2026-09-04 | `db.path` / `TRACE_MCP_DB_PATH` as a configurable index location (`SECURITY.md:150`) | `src/global.ts` `getDbPath()`, every `new Store(...)` call site | Neither the key nor the env var reached the code that opens the database — the only reader was `get_index_health`, which reported the schema default `.trace-mcp/index.db` as `dbPath`. Removed the key, the env override and the `SECURITY.md` claim; `get_index_health` now reports `store.db.name` (TRA-802). |

## The symbol half of doc-to-code verification — measured, and not gating (2026-09-06, TRA-1023)

`verify_docs` resolves both backticked *paths* and backticked *identifiers*
against the index. Only the path half gates CI. This is why.

Measured on `README.md` plus every page under `docs/`, against a full index of
this repo at `7f53f325`:

| Corpus | Identifier code spans | Unresolved | Rate |
| --- | --- | --- | --- |
| `README.md` + `docs/**` | 2 661 | 2 406 | **90.4%** |
| `docs/comparisons.md` alone | 223 | 210 | **94.2%** |
| camelCase/PascalCase spans only, whole corpus | 321 | 222 | **69.2%** |

Almost none of that is drift. The unresolved set is led by MCP tool names
(`search_text` ×28, `load_tools` ×25, `get_change_impact` ×23 — real product
concepts, registered as string literals rather than as symbols), preset and
enum values (`minimal` ×32, `full` ×24, `scip_resolved`, `EXTRACTED`), JSON
field and metric names (`symbol_id`, `ui_p95_ms`, `renderer_fcp_ms`), config
keys (`tools.preset`), and bare `true` / `false` / `null`.

Narrowing to camelCase/PascalCase — which drops tool names, prose words, dotted
config keys and SCREAMING_CASE env vars in one rule — still leaves 69.2%, now
led by the host's own tools (`Read` ×21, `Grep` ×17, `Glob`, `Bash`), platform
globals (`MutationObserver`, `setTimeout`, `EventSource`), competitors' symbols
quoted from their source (`SolidLanguageServer`, `buildGatewayWireSchema`,
`CodeCompressor`), and hook event names (`SessionStart`, `PostToolUse`).

**Conclusion: the symbol half stays a tool, not a gate.** No filter cheap enough
to state in one rule gets the false-positive rate near the ~0% the path half
reaches, because most of what our prose backticks is a name in a namespace the
index does not hold. Re-measure before revisiting; the numbers above are the
baseline.

## Not audited yet

Nothing below has been read against the code. Pick one, audit it, move it up.

- `README.md` — install instructions, quick start, the client config snippets
  (the CLI commands and flags in it are audited; the rest is not)
- `docs/configuration.md` — the *prose*: the keys it explains are real and its
  defaults are right (audited above), but nothing has checked that what it says a
  key **does** matches what the code does with it
- a CI guard for legacy `~/.trace-mcp` paths — deliberately **not** added here: it
  cannot go green until PR #717 finishes the same rename in `README.md`,
  `CLAUDE.md`, `AGENTS.md`, `docs/configuration.md`, `docs/analytics.md`,
  `docs/decision-memory.md` and `docs/index.html`. The rule it should encode:
  a doc may name the legacy path only on a line that also names the current one.
- `docs/architecture.md`, `DESIGN.md`
- `docs/quality-gates.md`, `docs/telemetry.md`, `docs/analytics.md`
- `docs/decision-memory.md`, `docs/daemon-memory.md`
- `docs/development.md`, `CONTRIBUTING.md`
- `docs/images/` freshness against `scripts/screenshots.manifest.json`
- `CLAUDE.md` / `AGENTS.md` tool-routing tables (`audit_config` covers part of this)

Out of scope here by mandate: `docs/comparisons.md`, `docs/ROADMAP.md`, and the
marketing surface of trace-mcp.com.
