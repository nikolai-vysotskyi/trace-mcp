# Phase 0 evidence (v3.34.6)

Evidence class: **CONFIRMED** unless marked **OBSERVED**.

## Runtime pin

- CLI / daemon: **3.34.6** (`~/.trace/launcher.env` → desktop app `cli.js`).
- Implementation source: `src/indexer/plugins/language/sql/index.ts` on tag **v3.34.6**.

## Answers (Section 54 checklist)

### 1. What parser is actually active?

**CONFIRMED:** None for `.sql` files. `SqlLanguagePlugin` uses `createRegexLanguagePlugin` only (`src/indexer/plugins/language/sql/index.ts`). `tree-sitter-sql.wasm` is vendored but **not** wired into this plugin.

### 2. Why are some CTEs detected and others not?

**CONFIRMED:** CTE pattern is `\bWITH\s+(?:RECURSIVE\s+)?([a-zA-Z_]\w*)\s+AS\s*\(` — it matches only the **first** name after `WITH`, not `, name AS (`.

Example: `two_cte_join_sample.sql` indexes `scoped` only; `emp_age` is missed. `incremental_keys_sample.sql` indexes `base` only; `touched_parents`, `keys` missed. `ranked_window_sample.sql` indexes `touched` only; `ranked` missed.

### 3. What SQL symbols are persisted?

**OBSERVED** (regex baseline, Phase 0): first-CTE-only regex on a large external corpus — see `baseline-inventory.json` / `corpus-metrics.json` for the **public fixture pack** shipped in-repo.

### 4. What SQL edges are persisted?

**CONFIRMED:** **Zero** edges from `.sql` file symbols. `RawSqlPlugin` (`integration/orm/raw-sql`) scans inline SQL in `.py`/`.ts`/`.js` only and returns **no edges** in `extractNodes`. No `sql_reads` / `sql_cte_ref` types registered for standalone SQL.

### 5. Can the graph schema represent CTE/table dependencies?

**CONFIRMED:** Yes. `edges` table has `metadata`, `resolution_tier`, `confidence`. New edge types can be registered in `edge_types`. `nodes` link symbols/files. No separate SQL DB required.

### 6. Where should AST parsing be introduced?

**INFERRED:** Replace or wrap `SqlLanguagePlugin.extractSymbols` in `src/indexer/plugins/language/sql/` — keep regex as fallback path inside same plugin. Persist rich metadata on symbols + new edge types from a reference extractor.

### 7. Template-aware parsing?

**INFERRED:** Pre-pass: detect `{{NAME}}`, replace with parser-safe identifiers, parse, map ranges back; mark relations as `template-dependent` in edge metadata. Corpus templates: `SCHEMA_NAME`, `BUSINESS_REGION_FILTER`, `BUSINESS_LEADER_EMAIL_FILTER`, `MANAGER_EMAIL_FILTER`, `INCREMENTAL_DATE`.

### 8. SQL → SQL relationships?

**Design:** Only on explicit include/`read_sql_file` static path — not shared table names.

### 9. Python → SQL?

**CONFIRMED gap:** No resolver for `read_sql_file`, `load_query_sql`, `render_sql_file`, path constants. **INFERRED:** New Python integration plugin or extend existing loaders with string-literal path resolution + `loads_sql` edges.

### 10. Search and MCP retrieval changes?

**CONFIRMED today:** Symbol search = FTS on symbols; `search_text` scans file bodies. **INFERRED:** `get_feature_context` / graph neighborhood must include SQL edge types once `get_call_graph` / `get_change_impact` traverse them.

### 11. Regression tests?

**Phase 1:** `fixture-ground-truth.json` + `sql-regex-baseline.test.ts` (regex behavior) + AST success suite (`TRACE_SQL_AST=1` default on feature branch).

### 12. Performance impact?

**UNKNOWN** until Phase 2 corpus spike on 277 files. Budget gate before enabling AST in production index.

## Five-file index baseline (regex)

| Fixture | Indexed CTE symbols (regex) | Expected CTEs (ground truth) |
|---------|----------------------------|------------------------------|
| `two_cte_join_sample.sql` | `scoped` | `scoped`, `emp_age` |
| `incremental_keys_sample.sql` | `base` | `base`, `touched_parents`, `keys` |
| `payment_ledger.sql` | (none) | (none — no WITH) |
| `ranked_window_sample.sql` | `touched` | `touched`, `ranked` |
| `distinct_on_sample.sql` | `pay` | `pay` |
