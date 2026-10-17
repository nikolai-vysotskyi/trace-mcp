# Phase 4 — SQL graph edges

**Status:** Phase 4 SQL graph edges implemented (`sql_cte_ref`, `sql_reads`, `loads_sql`).

Design: `phase-3-prep.md` §5–6.

## Edge types

| Edge | Status |
|------|--------|
| `sql_cte_ref` | CTE → CTE via `referencesCtes` + `sql-cte-refs.ts` resolver |
| `sql_reads` | CTE / file → relation phantom via `relationRefs` + `sql-reads.ts` |
| `loads_sql` | Python → `.sql` via `loads-sql.ts` + static path extract (`python-sql-loader-paths.ts`) |

## Verify `sql_cte_ref` (private index)

```bash
npm run build
node dist/cli.js index "$TRACE_SQL_INDEX_PROJECT" --force
sqlite3 "$TRACE_INDEX_DB" \
  "SELECT COUNT(*) FROM edges e JOIN edge_types t ON t.id=e.edge_type_id WHERE t.name='sql_cte_ref';"
```
