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

## Not audited yet

Nothing below has been read against the code. Pick one, audit it, move it up.

- `README.md` — install instructions, quick start, the client config snippets
- `docs/configuration.md` — every key against `TraceMcpConfigSchema`
- `docs/architecture.md`, `DESIGN.md`
- `docs/quality-gates.md`, `docs/telemetry.md`, `docs/analytics.md`
- `docs/decision-memory.md`, `docs/daemon-memory.md`
- `docs/development.md`, `CONTRIBUTING.md`
- CLI commands and flags quoted anywhere, against `src/cli.ts`
- `docs/images/` freshness against `scripts/screenshots.manifest.json`
- `CLAUDE.md` / `AGENTS.md` tool-routing tables (`audit_config` covers part of this)

Out of scope here by mandate: `docs/comparisons.md`, `docs/ROADMAP.md`, and the
marketing surface of trace-mcp.com.
