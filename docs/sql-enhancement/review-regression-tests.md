# PR #1482 — regression tests (review feedback)

Maps maintainer review items to **automated** coverage in `npm run test:sql-corpus` (CI when workflows are approved on fork PRs).

| Review item | Regression covered | Where |
|-------------|-------------------|--------|
| **1. Spans point at original SQL** | Template before `WITH`; preprocess + remap to source lines | `src/indexer/plugins/language/sql/__tests__/preprocess.test.ts` (`maps CTE lines back…`), `sql-source-map.ts`, `remap-extract.ts` |
| **2. Plain `SELECT` loses `sql_reads`** | CTE-less file gets `sql_reads` edge | `tests/sql-corpus/fixtures/standalone/plain_select.sql`, `tests/sql-corpus/sql-reads.test.ts` (`plain_select`) |
| **3. False `sql_cte_ref` (column vs CTE)** | `SELECT a` in SELECT list must not create `b → a` | `src/indexer/plugins/language/sql/__tests__/ast-extract.test.ts` (`does not treat selected column names…`) |
| **3b. Duplicate CTE names** | Nested/repeated `x` emits multiple definitions | `ast-extract.test.ts` (`emits separate entries for repeated CTE names`) |
| **4. `loads_sql` in comments/strings** | Commented loader + docstring path → no refs | `src/indexer/edge-resolvers/__tests__/python-sql-loader-paths.test.ts` |
| **5. pnpm split** | Not a test — lockfile on pnpm 10 in PR | `package.json` `packageManager`, no `pnpm-workspace.yaml` |

**Positive-path fixtures** (unchanged role): `tests/sql-corpus/fixture-ground-truth.json`, `sql-plugin.test.ts`, `sql-plugin-metadata.test.ts`, `ast-spike.test.ts`, `loads-sql.test.ts`, `sql-regex-baseline.test.ts`.

**Gate:** `npm run test:sql-corpus` — **35** tests (was 32 before review fixtures).
