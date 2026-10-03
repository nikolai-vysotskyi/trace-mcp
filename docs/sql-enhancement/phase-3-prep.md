# Phase 3 prep — handle known work before indexer wiring

Phase 2 proved tree-sitter-sql on the corpus. This document locks **contracts and inventories** so Phase 3 integration does not rediscover the same gaps.

## Corpus scope

| Scope | `.sql` count | Role |
|-------|-------------:|------|
| `data-analytics-python/scripts/queries` | **249** | Indexed SQL corpus + spike metrics |
| Whole `data-analytics-python` repo | **276** | Extra SQL outside `scripts/queries` (migrations, ad-hoc); out of v1 spike unless path added |

Run inventories:

```bash
npm run sql-corpus:p2-inventory
npm run sql-python:loader-inventory
```

Artifacts: `p2-inventory.json`, `python-loader-inventory.json`, `shim-ledger.json`.

## 1. Preprocessor / L1 shims

**Ledger:** `shim-ledger.json` — accepted steps, rejected global `::` cast, zero-lift experiments.

Phase 3 must persist `preprocessorApplied` on every `.sql` file symbol using `SQL_PREPROCESSOR_PIPELINE` in `sql-index-metadata.ts`.

Do **not** enable `normalizePgDoubleColonCast` in the default pipeline; optional retry only.

## 2. libpg_query escalation

**Decision (pre-Phase 3):** Stay on **tree-sitter-sql** for v1 indexer.

Escalate only if:

- `failed` parse rate becomes unacceptable after wiring, or
- Critical files are `partial` with **missing CTEs** (not merely `hasError`), or
- `p2-inventory` shows growth in constructs tree-sitter cannot recover (e.g. dollar-quoted functions).

`libpg_query_candidate` in P2 inventory flags files with `DISTINCT ON` + `::` in the same clause — correlate before investing.

## 3. P2 PostgreSQL surface

Not required for **parse** success today (0 `failed`). Track counts via `sql-corpus-p2-inventory.ts` and add **fixture tests** when a construct appears in production SQL paths.

Policy:

| Construct | Phase 3 behavior |
|-----------|------------------|
| `WITH RECURSIVE`, `RETURNING`, `ON CONFLICT` | AST when parse ok/partial; else regex file symbol only |
| `$$…$$`, `DO $$`, `CREATE FUNCTION` | Prefer **file-level** `parse_status: fallback` if root unrecoverable |
| Procedural SQL | Same as DDL — regex `CREATE *` patterns where present |

## 4. Joins, aliases, columns

**Decision unchanged:** not top-level symbol kinds.

| Data | Where in Phase 3 |
|------|------------------|
| CTE names | Symbols `path::cteName#variable` + `SqlCteSymbolMetadata` |
| Table refs | `SqlFileSymbolMetadata.relationRefs[]` from `object_reference` nodes (`confidence` heuristic) |
| Aliases / per-CTE reads | Empty `aliases[]` in v1; ground truth in `brightchamps-ground-truth.json` drives Phase 4 tests |
| Column lineage | Explicit non-goal v1 |

Module: `sql-index-metadata.ts` — `buildSqlFileSymbolMetadata()`, `buildCteSymbolMetadata()`.

## 5. Edges (Phase 4 — designed now)

| Edge type | From | To | When |
|-----------|------|-----|------|
| `sql_cte_ref` | CTE symbol | CTE symbol | AST / heuristics within file |
| `sql_reads` | CTE or file | Relation string or resolved table symbol | `relationRefs` + template metadata |
| `loads_sql` | Python function / module | `.sql` file | Static path from loader inventory |

Standalone `.sql` files today: **0** SQL edges in index (Phase 0). `RawSqlPlugin` does not link `read_sql_file` → file path.

## 6. Python → `.sql` loaders

Inventory: `python-loader-inventory.json`.

Resolve in Phase 4 integration plugin (or extend Python framework plugin):

- `read_sql_file(...)` — `database.session`
- `render_sql_file`, `load_query_sql`, `load_sql_with_*` — `services/sql_loader.py`
- String literals `scripts/queries/...sql` and `Path(...sql)`

No dynamic f-string SQL paths in v1.

## 7. Partial corpus hygiene

- **53** `partial` files — acceptable; index CTEs with `parse_status: partial`.
- Diagnostics: `partial_unflagged_files` in `sql-partial:diagnostics` output.

## 7b. UNNEST regression fixtures

All six corpus files tagged with `UNNEST` in P2 inventory are in `brightchamps-ground-truth.json` (`*_unnest` ids). `ast-spike.test.ts` asserts `parse_status: partial` and the full AST CTE name set so Phase 3 plugin wiring cannot drop CTEs on these paths.

## 8. Phase 3 implementation checklist

1. `SqlLanguagePlugin.extractSymbols` → call `spikeParseSqlSource`; on `failed`, regex fallback (current patterns).
2. Emit CTE symbols for **all** `spike.ctes` (not first-CTE regex).
3. Attach `buildSqlFileSymbolMetadata(spike)` to file-level symbol or first symbol in file result.
4. Re-index benchmark repo; assert **1021** CTE symbols vs 171 regex baseline (249 files).
5. Gate: `npm run test:sql-corpus` + `sql-corpus:spike` thresholds **196/53/0**, **1021** CTEs (`tests/sql-corpus/corpus-metrics.json`).
6. After `node dist/cli.js index <project> --force`: `npm run sql-index:smoke` (counts + `sample_symbol_metadata` for `emp_age` on `base_ownership.sql`).
7. Tests: `sql-plugin-metadata.test.ts` locks `parseStatus`, `preprocessorApplied`, line spans on plugin output.
