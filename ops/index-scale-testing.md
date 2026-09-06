# Index-scale testing: the ceiling we test to, and why that number

A defect that only exists above a size threshold is invisible to a corpus below
it. This file records where our threshold sits, so the next run does not
re-derive it — and so that a fixture shrunk in a refactor is a visible change
rather than a silent loss of coverage.

## The threshold that matters

`Math.min(...xs)` and `arr.push(...xs)` pass every element as a separate
argument. V8 throws `RangeError: Maximum call stack size exceeded` past its
argument limit — **~65 000 to ~125 000, depending on remaining stack depth**.
Not a fixed number: the same array can pass on one machine and throw on
another, and can pass in a shallow call and throw in a deep one.

Practical consequence: a fixture at 70k proves nothing. A fixture has to clear
the *upper* end of that range to be evidence.

## Where we were (2026-09-06, before this change)

| Corpus | Symbols | What it exercised |
|--------|--------:|-------------------|
| `tests/perf/stress.test.ts` | **50 000** (10 000 files x 5) | `searchFts`, store batch methods |
| everything else | < 1 000 | tools, end to end |

So the largest thing CI ran was **50 000 symbols** — an order below the
threshold — and even that only reached the DB layer, never a tool handler. The
size the defect needs and the surface it lives on were both outside CI.

That is how GitHub [#957](https://github.com/nikolai-vysotskyi/trace-mcp/issues/957)
reached a user: `search` returned the bare string "Maximum call stack size
exceeded" for every query against a 152 734-symbol index, deterministically,
while `search_text` on the same index worked. Reported by `msalem89` with a
3/3 repro; cause and the first fix are Nikolai's, in the thread.

## Where we are now

| Corpus | Symbols | Nodes ranked | Cost |
|--------|--------:|-------------:|------|
| `tests/perf/scale-rangeerror.test.ts` | **150 000** | 165 000 | ~4 s |

150 000 is chosen to sit above the upper end of the V8 range and to match the
size actually reported from the field, not to be round.

The fixture is **generated, never vendored** — `tests/perf/large-index.ts`,
which is the seeder `stress.test.ts` has always used, extended with
symbol-level edges. That extension is not cosmetic: PageRank ranks only nodes
that appear in a resolved edge, so a file-only edge set caps `pagerankMap` at
the file count and cannot reproduce the failure at all.

## What the audit found

Reviewing "who expands or sorts the un-truncated set" turned up something the
original diagnosis had backwards, and it is worth writing down because the same
reasoning error will recur.

`searchFts` applies `LIMIT ?` **in SQL**. Every `ftsResults` array in the
codebase is therefore bounded by the caller's `limit` (~70-120 rows), not by
the index. Those spreads were never the crash — they cannot reach 65k.

The array that does scale with the index is `pagerankMap`, one entry per graph
node, spread as `Math.max(...pagerankMap.values(), 0.001)` in three places:

- `src/tools/navigation/navigation.ts` — `search()` and the fusion path
- `src/tools/navigation/context.ts` — `get_feature_context`

All three still crashed after the FTS fix landed, and the scale test above
reproduces each of them by name. `src/tools/navigation/task-context.ts` had
already been written as a manual loop and was the one correct precedent in the
tree.

Lesson for the next audit: **"bounded by the index" is a claim about where the
array comes from, and it has to be checked at the query, not inferred from the
variable name.** Two of us read `ftsResults` and assumed unbounded.

## The gate

`tests/ci/no-spread-into-call.test.ts` fails CI on any
`Math.min(...` / `Math.max(...` in `src/**`. The rule is **total, with no
allowlist**, because `minMax()` from `src/util/minmax.ts` is a drop-in for
every form and reducing a small array costs nothing — an allowlist would be
the only part of this that needs maintaining, and the entries would outlive
their reasons. All 26 call sites in `src/` were converted in the same change.

The behavioural test and the static gate are not redundant. The gate reaches
every line, including code no test calls — which is where both of #957's
instances lived. The behavioural test catches the forms the regex cannot see.

## Known and deliberately not gated

`arr.push(...xs)` throws the same `RangeError` on the same threshold and has
~40 call sites in `src/`, most of them bounded by a file or a query limit.
There is **no static gate on it**: unlike `Math.max`, the safe rewrite is not
a drop-in, and a rule with 35 exemptions is an allowlist wearing a rule's
clothes. The scale test covers the paths it exercises; the ones it does not
are the standing risk. Revisit if a field report names one — do not
pre-emptively rewrite 40 sites on a guess.

Also out of scope: sorting an un-truncated result set. That is a latency
problem, not a `RangeError`, and `stress.test.ts` already has time budgets.
