# Recall harness

Regression metric for the quality of trace-mcp's retrieval surfaces:
`search`, `gatherContext` (via `packContext` file selection), and
`query_decisions`. Each fixture pins a query to an expected result set
and asserts that today's measured `recall@k` stays at or above a captured
baseline.

The point is not absolute retrieval correctness — it is to catch the moment
a prompt tweak or ranker change quietly degrades top-k recall.

## How to run it

```bash
pnpm run test:recall            # vitest mode — asserts each fixture meets baseline
pnpm run test:recall:report     # CLI mode — runs harness, writes JSON + markdown reports
RECALL_UPDATE=1 pnpm run test:recall   # rewrite baselines after an intentional improvement
```

Outputs (CLI mode and `beforeAll` of vitest mode):

- `tests/recall-harness/report.json` — full per-fixture detail (retrieved IDs, matched IDs, metrics)
- `tests/recall-harness/report.md` — human-readable summary table + failure breakdown

The harness needs the project's index DB to exist; the vitest test
auto-skips when it doesn't, so a fresh checkout with no `trace-mcp add`
will not break CI.

## How to add a fixture

Drop a JSON file in `tests/recall-harness/fixtures/`. Filename order
controls run order; prefix with a number for grouping. Schema:

```jsonc
{
  "id": "09-search-foo-bar",            // stable id; defaults to filename
  "query": "fooBar",                    // free-text query
  "kind": "symbol",                     // symbol | file | decision
  "expected_ids": ["fooBar", "foo.ts"], // substring matches against retrieved
  "k": 10,                              // top-k cutoff (default 10)
  "min_recall_at_k": 1.0,               // failing threshold
  "notes": "why this fixture exists"
}
```

`kind` semantics:

| kind       | what runs                                                                                  | id matches against                                |
|------------|--------------------------------------------------------------------------------------------|---------------------------------------------------|
| `symbol`   | `search(store, query)` from `src/tools/navigation/navigation.ts`                           | `symbol_id` / `fqn` / `name` (case-insensitive substring) |
| `file`     | `packContext({ scope: "feature", query })` from `src/tools/refactoring/pack-context.ts`    | included file paths (extracted from markdown headers) |
| `decision` | `DecisionStore.queryDecisions` against an in-memory store seeded with `decisions_seed`     | decision titles                                   |

For a `decision` fixture, supply the corpus inline so the test is
self-contained and never depends on the live `decisions.db`:

```jsonc
{
  "id": "09-decisions-cache-policy",
  "query": "cache eviction",
  "kind": "decision",
  "expected_ids": ["LRU cache eviction policy"],
  "min_recall_at_k": 1.0,
  "decision_filters": { "search": "cache eviction" },
  "decisions_seed": [
    { "title": "LRU cache eviction policy", "content": "...", "type": "architecture_decision", "tags": ["cache"] },
    { "title": "Some unrelated decision",   "content": "...", "type": "convention",            "tags": ["misc"]  }
  ]
}
```

### Workflow for a new fixture

1. Pick a query that exercises a real retrieval path you care about
   (something an agent or prompt actually issues).
2. Run `pnpm run test:recall:report` once; check the per-fixture report
   to see which ids are returned today.
3. Encode those ids as `expected_ids` and set `min_recall_at_k` to the
   measured recall (often `1.0` for symbol/file fixtures driven by a
   distinctive identifier).
4. Re-run `pnpm run test:recall`; the fixture should pass.

## How to update baselines after a ranker improvement

```bash
RECALL_UPDATE=1 pnpm run test:recall:report
```

This overwrites `min_recall_at_k` in every fixture with today's measured
value. Review the diff before committing — if a number went *down* the
update may be hiding a regression you actually want to see.

The CLI form is preferred over `RECALL_UPDATE=1 pnpm run test:recall`
because vitest mode treats every fixture as a passing assertion in
update mode (no test signal to act on).

## What a failing assertion means

`recall@k=X.YZ fell below baseline 1.000` means: the retrieval surface
returned fewer of the expected ids in the top-k results than it did when
the baseline was captured. Common causes:

- A scoring weight was changed and a popular id got displaced.
- A prompt was rewritten and now elicits different FTS tokens.
- The fixture's expected ids are stale (a symbol was renamed/moved).
- The index is stale — re-run `trace-mcp index` and try again.

The failure message includes the top-k retrieved ids and the matched
subset, so you can see *what* changed without re-running the harness.
