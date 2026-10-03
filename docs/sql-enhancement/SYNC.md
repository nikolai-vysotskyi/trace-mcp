# SQL enhancement — repo sync

Keep these aligned when working on SQL indexing:

| What | Pin |
|------|-----|
| **Released CLI / app** | **3.34.6** (`trace -v`) — regex-only SQL unless built from feature branch |
| **AST development** | Branch `feat/sql-brightchamps-corpus` (fork: `IshanSarkar/trace-mcp`); local `dist/cli.js` after `npm run build` |
| **Cursor MCP (AST)** | Point `mcp.json` at `../trace-mcp/dist/cli.js serve` (see benchmark `trace-sql-sync.json`) |
| **Benchmark corpus** | `data-analytics-python/scripts/queries` (**249** `.sql` files; **276** repo-wide) |

## Environment

- `TRACE_SQL_CORPUS_ROOT` — optional override; default resolves sibling `../data-analytics-python/scripts/queries` from this repo root.
- `TRACE_SQL_AST=0` — force regex-only SQL plugin (default on this branch: AST enabled).
- `TRACE_SQL_INDEX_PROJECT` / `TRACE_INDEX_DB` — override paths for `npm run sql-index:smoke` and `sql-index:cte-diff`.

## Gates (Phase 3 complete)

```bash
npm run test:sql-corpus      # 42 tests (skips if corpus missing)
npm run sql-corpus:spike     # 196 ok / 53 partial / 0 failed; 1021 AST CTEs (249 files)
npm run build && node dist/cli.js index "<data-analytics-python>" --force
npm run sql-index:smoke      # index DB counts + emp_age metadata
npm run sql-index:cte-diff   # per-file spike vs index CTE parity (exit 0)
```

## Benchmark repo pointer

`data-analytics-python/.cursor/trace-sql-sync.json` mirrors this file’s pins (`phase`: `3-complete-ready-phase-4`).

## Phases

1. **Phase 0** — evidence (`phase-0-evidence.md`), index baseline, regex root-cause.
2. **Phase 1** — `tests/sql-corpus/brightchamps-ground-truth.json` + baseline vitest.
3. **Phase 2** — tree-sitter-sql spike (`phase-2-summary.md`, `npm run sql-corpus:spike`).
4. **Phase 3** — AST wired in `SqlLanguagePlugin`, metadata contract, smoke + `sql-index:cte-diff`.
5. **Phase 4** — `sql_cte_ref`, `sql_reads`, `loads_sql`, MCP graph retrieval (`phase-3-prep.md` §5–6).
6. **Coverage** — `coverage-roadmap.md`; `npm run sql-partial:diagnostics` when adding preprocessors.
