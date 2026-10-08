# Phase 2 complete — parser spike (v3.34.6)

## Decision

**Proceed with tree-sitter-sql** (via `tree-sitter-wasm`). No `libpg_query` spike required for this corpus.

## Implementation (spike only — not wired into indexer yet)

| Module | Role |
|--------|------|
| `preprocess.ts` | `{{TEMPLATE}}`, `{format}`, `:bind`, `DISTINCT`+`ON` line-join, `AS MATERIALIZED` strip, `ILIKE`→`LIKE`, `AT TIME ZONE` fold (parse-only; keeps `::cast` in pipeline) |
| `sql-parser.ts` | Lazy WASM load for `sql` grammar |
| `ast-extract.ts` | CTEs + `object_reference` relation text |
| `spike-parse.ts` | `ok` / `partial` / `failed` + structured result |

## Corpus results (private benchmark tree — ~250 `.sql` files at spike time)

| Metric | Regex (v3.34.6 index) | Tree-sitter spike |
|--------|----------------------|-------------------|
| CTE symbols | **171** (first `WITH` only) | **1021** (unique CTE names per file) |
| Parse `ok` | n/a | **196** |
| Parse `partial` (`hasError`) | n/a | **53** |
| Parse `failed` | n/a | **0** |

**Former hard failures (not planned):** chained `(expr AT TIME ZONE 'a') AT TIME ZONE 'b'` (see fixture `standalone/timezone_chain_sample.sql`). Fixed with `normalizePgAtTimeZone()` in preprocess (parse-only).

`partial` is acceptable for Phase 3: tree has errors but CTE/relation extraction still runs; spike no longer marks root `ERROR` as failed when CTEs are recoverable.

### Pre-Phase-3 lift experiments (2025-10-03)

| Shim | In default pipeline? | Corpus `ok` / `partial` |
|------|---------------------|-------------------------|
| `AS MATERIALIZED` → `AS (` | yes | 196 / 53 (current corpus; was 54 on 250-file baseline) |
| `ILIKE` → `LIKE` | yes | same |
| `::type` → `CAST(... AS type)` | **no** (helper only) | **185 / 65** when enabled — net regression |

`scripts/shim-lift-experiment.ts` on remaining optional shims (`FILTER`, jsonb ops, `::text` coercion, interval simplify): **0** partial→ok flips on top of current preprocess.

## Five-fixture success bar

All expected CTE names match ground truth (`tests/sql-corpus/ast-spike.test.ts`).

## Commands

```bash
npm run test:sql-corpus
npm run sql-corpus:spike
```

Full JSON: `docs/sql-enhancement/phase-2-spike-report.json`.

## Next (Phase 3)

Integrate `spike-parse` into `SqlLanguagePlugin` (keep regex fallback), persist CTE symbols with stable `::name#variable` ids, store graph payload in symbol `metadata`, then edges in Phase 4.
