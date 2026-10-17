# SQL indexing — coverage roadmap (living)

Goal: **include everything we can justify with evidence**, keep **fallback** for the rest, and **never pretend** full understanding when `parse_status` is `partial` or `fallback`.

## Layered model (not “parser OR regex”)

| Layer | Purpose |
|-------|---------|
| **L0 — Original source** | Always stored on disk; `search_text` always works. |
| **L1 — Preprocessor** | Parse-only rewrites for constructs the grammar lacks (templates, binds, `AT TIME ZONE`, future PG shims). |
| **L2 — tree-sitter-sql AST** | CTEs, relations, structure; primary extractor in Phase 3+. |
| **L3 — Regex / heuristics** | Fallback symbols when L2 fails; never removed. |
| **L4 — Metadata honesty** | `parse_status`, `preprocessor_applied[]`, `confidence` on every edge. |

Preprocessor changes **must not** be written back to repo files — indexing only.

## Current corpus signal (private benchmark ~250 files, post–AT TIME ZONE fix)

| Status | Count | Meaning |
|--------|------:|---------|
| `ok` | 196 | Clean AST (`hasError === false`). |
| `partial` | 53 | AST usable but `hasError` (local ERROR nodes). |
| `failed` | 0 | No recoverable structure (regex fallback). |

Run: `npm run sql-corpus:spike` and `npm run sql-partial:diagnostics`.

### Features over-represented in `partial` (candidates for L1 shims or grammar upgrades)

| Feature | In partial | Notes |
|---------|------------|--------|
| `::` casts | 76% of partial files | Often paired with DISTINCT ON / expressions. |
| `DISTINCT ON` | 70% | PG-specific; grammar gaps common. |
| `interval '…'` | 70% | Usually still parses; often co-occurs with other issues. |
| `{python_format}` braces | 50% | **Not SQL** — need `{name}` → placeholder like `{{}}`. |
| `OVER (` windows | 46% | |
| `ILIKE` | 33% | |
| `ANY (` | 26% | |
| JSONB `->` / `->>` | 20% | |
| `LATERAL` | 19% | High lift vs ok (1%). |
| `FILTER (` | 19% | |
| `AS MATERIALIZED` CTE | 15% | |
| Chained `AT TIME ZONE` | fixed | Was 2 hard failures; now `ok`. |

One partial file had **no flag** until `trivial_invalid_sql` (intentional typo `selec *` in a private sample). See `phase-3-prep.md`.

## Inclusion backlog (prioritized)

### P0 — Already in preprocessor

- `{{TEMPLATE}}` → `__tpl_*__`
- `:bind` → `__bind_*__` (preserve `::cast`)
- Chained / single `AT TIME ZONE 'literal'`

### P1 — Next shims (high corpus impact, low semantic risk)

- **Done:** Python-style `{name}` in SQL → `/* __fmt_name__ */` (`normalizePythonFormatBraces`). Fixture: `standalone/format_brace_slot.sql` (`pool_date_filter`). Does not touch `{{TEMPLATE}}`.
- **Done:** join `DISTINCT` + newline + `ON (` → `DISTINCT ON (` (`normalizePgDistinctOn`). Fixture: `etl/distinct_on_sample.sql`.
- **Done:** `AS MATERIALIZED (` → `AS (` (`normalizePgMaterializedCte`). Fixture: `etl/materialized_union_sample.sql`.
- **Done:** `ILIKE` → `LIKE` (`normalizePgIlike`). Parse-only; metadata can still record original operator later.
- **Rejected (global):** `normalizePgDoubleColonCast` — enabling in L1 dropped `ok` ~196→~185; `DISTINCT ON` + `CAST(...)` still confuses tree-sitter-sql. Keep helper for targeted retries in Phase 3 fallback ladder.

### P2 — PostgreSQL surface (repo + future ETL)

Track in tests even if corpus count is low today:

- `WITH RECURSIVE`
- `RETURNING`, `ON CONFLICT`
- Dollar-quoting `$$…$$`
- `GENERATE_SERIES`, `UNNEST`, array literals
- Procedural blocks (`DO $$`, functions) — likely **file-level `fallback`**, not full AST

### P3 — Grammar / parser escalation

Stay on tree-sitter-sql until spike metrics stall. Escalate to **libpg_query** (or similar) only if:

- P0+P1 shims still leave >N% `failed`, or
- Critical files stay `partial` with **missing CTEs** (not just `hasError`).

### P4 — Outside static SQL (explicit non-goals for v1)

- Dynamic SQL built only at runtime (f-strings with no literal path)
- DB catalog introspection (unless opt-in)
- Cross-DB dialects (MySQL, T-SQL) unless new corpora appear

## How coverage evolves over time

1. **Corpus spike** on every SQL-related PR (`sql-corpus:spike` in CI when wired).
2. **Partial diagnostics** when `partial` count rises (`sql-partial:diagnostics`).
3. **New construct** → add flag to diagnostics → measure lift → add shim or test → document in this file.
4. **Ground-truth fixtures** grow with each bug (communication ETL, booking incremental, etc.).

## Internet / “all of SQL”

We do **not** aim to model every SQL keyword as a graph node. We aim to:

- Parse **Postgres query shapes** this org uses (CTEs, joins, PG builtins, templates, parameters).
- Preserve **source** for everything else.
- Add **targeted** preprocessor rules backed by **corpus + tests**, not by grammar completeness on paper.

When in doubt: **partial + metadata** beats **silent wrong edges**.
