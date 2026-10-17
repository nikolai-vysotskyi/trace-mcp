# Indexing cost — Phase 4 SQL resolvers (PR #1482)

Methodology for maintainer review: one **full** `index --force` on a representative **Python + warehouse SQL** monorepo (not committed to OSS; numbers below are from a private benchmark run on **2026-10-08**). Compare against **v3.34.6** regex-only SQL on the same machine/repo shape.

## Environment

| | |
|--|--|
| trace-mcp | Branch `feat/sql-postgresql-cte-indexing` @ `3f670a94` (rebased on upstream `master`; benchmark metrics unchanged since review-fix `e48807e0`) |
| Node | 22+ |
| Command | `node dist/cli.js index <project_root> --force` |
| Measurement | macOS `/usr/bin/time -l` + SQLite counts on project index DB |

## Wall time & memory

| Metric | v3.34.6 regex SQL (baseline) | AST + Phase 4 resolvers (this PR) |
|--------|------------------------------|-----------------------------------|
| Files indexed | ~768 | **774** |
| Pipeline `durationMs` (log) | ~2.6–2.7s | **~2.2–2.8s** |
| `/usr/bin/time` real | ~3.0s | **~2.6s** |
| Peak RSS (`time -l`) | not re-run here | **~1.15 GiB** |

Full index cost is dominated by **Python + tree-sitter** extraction and existing edge passes; three SQL resolvers add postprocess work but did not change order-of-magnitude wall time on this repo.

## Graph / DB growth (same benchmark DB after `--force`)

| | v3.34.6-style (regex) | AST + Phase 4 (after review fix) |
|--|----------------------|----------------------------------|
| SQL file rows in `files` | ~250 in benchmark SQL tree | **~250** `.sql` paths |
| SQL CTE / file symbols | ~**171** (first CTE per file) | **~1095** (all CTEs + file-unit symbols) |
| `sql_cte_ref` edges | **0** | **953** |
| `sql_reads` edges | **0** | **~1998–2444** (depends on relation filter pass) |
| `loads_sql` edges | **0** | **63** (stricter comment/string filter vs ~143 before) |
| Total `edges` (all types) | lower | **~10.8k** |
| Total `symbols` | lower | **~9.7k** |
| Index SQLite file size | smaller | **~73 MiB** |

New edge types are **additive**; DB size grows with symbol richness and SQL graph edges, not duplicate full-file storage.

## Retrieval token impact (illustrative)

Not a formal benchmark harness in CI; illustrative MCP-style savings on the **public** synthetic fixture `tests/sql-corpus/fixtures/etl/two_cte_join_sample.sql` (generic `app` / `hr` tables — not a production path):

| Approach | `two_cte_join_sample.sql` (33 lines) |
|----------|--------------------------------------|
| Read full file | ~33 lines of source in context |
| `get_outline` (AST index) | **2** CTE rows (`scoped` 2–19, `emp_age` 20–28) — outline only, no bodies |

Exact token counts depend on client and `detail_level`; the product goal is **outline + `get_symbol` on demand** instead of whole-file reads. For repo-wide search, `search` / graph edges replace grepping large SQL trees.

## CI

Upstream gate for this PR:

```bash
npm run test:sql-corpus   # 35 tests, public fixtures only
npm run build
```

Fork PRs require maintainer **workflow approval** before GitHub Actions runs; CLA alone does not execute tests.

## Reproduce (private)

```bash
npm run build
/usr/bin/time -l node dist/cli.js index "$TRACE_SQL_INDEX_PROJECT" --force
sqlite3 ~/.trace/index/<project-hash>.db "SELECT t.name, COUNT(*) FROM edges e JOIN edge_types t ON t.id=e.edge_type_id WHERE t.name LIKE 'sql_%' OR t.name='loads_sql' GROUP BY 1;"
```

Do not commit proprietary paths or DB dumps to OSS.
