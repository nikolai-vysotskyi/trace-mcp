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
| every docs page is indexed or `noindex`, and linked from the footer nav | `tests/docs/internal-links.test.ts` |
| reader-visible `updated:` dates match `sitemap.xml` | `tests/docs/page-dates.test.ts` |
| breaking changes appear in the changelog | `tests/docs/changelog-breaking-changes.test.ts` |

## Audited

| Date | Scope | Verified against | Outcome |
| --- | --- | --- | --- |
| 2026-08-30 | `docs/tools-reference.md` — completeness of the tool listing | every `server.tool(...)` registration under `src/tools/register`, captured live via `_capture-tools.ts` | 101 of the 151 tools a default install registers were listed nowhere. Fixed by generating `docs/tools-index.md` (#642) and dropping the page's "full reference" claim. |
| 2026-08-30 | tool names quoted anywhere in `docs/tools-reference.md` | the same registration scan, plus `src/tools/ai/ai-tools.ts` | No ghosts. The five AI-backed tools live outside `src/tools/register`, which is why they are absent from `counts.yml` — that is correct, not drift. |
| 2026-09-02 | every CLI command and long flag quoted in a code span or fenced block across `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `DESIGN.md`, `SECURITY.md`, `docs/**`, `skills/**` | `--help` output of the real binary — every top-level command and every subcommand of `clients`, `bundles`, `subproject`, `memory`, `analytics`, `daemon`, `eval`, `consent` | One ghost: `README.md` documented `trace-mcp savings`, which does not exist (it is `trace-mcp analytics savings`; an unknown verb falls through to the default `serve` command and errors with `too many arguments for 'serve'`). **Every documented long flag exists** — no drift in the flag surface. |
| 2026-09-02 | every `~/.trace-mcp` / `.trace-mcp.json` path quoted in the docs, in the files PR #717 does not touch | `src/global.ts` (`TRACE_MCP_HOME`, `INDEX_DIR`, `REGISTRY_PATH`, `TOPOLOGY_DB_PATH`, `DAEMON_LOG_PATH`), `src/config.ts` `searchPlaces`, `src/runtime/tuning.ts`, `src/shared/paths.ts` | The state directory became `~/.trace` in TRA-611 and the docs never followed: `registry.json`, `topology.db`, `daemon.log`, `tuning.jsonc`, `telemetry-state.json`, the per-project index DBs and the project-local config file were all documented under the old name. Fixed here. `docs/development.md:268,287` deliberately keep the old path — the app/scripts really do still write those two markers there, which is a code bug, not a doc bug (TRA-667). |
| 2026-09-02 | `SECURITY.md` default-exclude list | `src/config.ts:879` | Claimed `.trace-mcp` and `.turbo` are excluded by default. Neither is in the schema default. Also claimed the index DB defaults to a project-relative `.trace-mcp/index.db`; real DBs are resolved by `getDbPath()` into `~/.trace/index/`. Both fixed. |

## Not audited yet

Nothing below has been read against the code. Pick one, audit it, move it up.

- `README.md` — install instructions, quick start, the client config snippets
  (the CLI commands and flags in it are audited; the rest is not)
- `docs/configuration.md` — every key against `TraceMcpConfigSchema`
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
