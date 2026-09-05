---
layout: default
title: Tool response token cost
permalink: /perf/response-tokens/
description: What trace-mcp tool responses cost in tokens, per tool, weighted by real call volume — including the ten tools that cost more than the reads they replace.
updated: 2026-09-05
---

# Tool response token cost

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": {{ page.title | jsonify }},
  "description": {{ page.description | jsonify }},
  "url": "https://trace-mcp.com/perf/response-tokens/",
  "datePublished": "2026-09-05",
  "dateModified": "2026-09-05",
  "author": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi"
  }
}
</script>

Measured 2026-09-05 on darwin 25.5.0 / arm64, trace-mcp
{{ site.data.response_tokens.measured_build.version }}
(`{{ site.data.response_tokens.measured_build.commit }}`) — the build stamp
travels with the figure to every surface that quotes it, and the
[preregistration](./prereg-response-tokens.md) states the bar and the verdict
(this run publishes as a **miss**, on the reduction half of the bar). Against
trace-mcp's own repo (2 159 files, 11 134 symbols) over a real stdio
`tools/call` round-trip. TRA-880, extended to the tail by TRA-945. Reproduce
with:

```
pnpm run build && npx tsx scripts/bench-response-tokens.ts [repoPath]
```

Token column is the median of three runs, a real `o200k_base` count of the
response text, not an estimate. Call volume is this machine's
`~/.trace/savings.json` ({{ site.data.response_tokens.calls_store_total }} calls
since the store was created) — real usage, one machine, never an average user.

## What was wrong

The *advertised surface* side of the token story has been measured and guarded
for weeks (`preset-surface-budget.test.ts`). The *response* side never was.

`src/savings.ts` scored a call before the tool ran: `recordCall(name)` took a
hand-written `RAW_COST_ESTIMATES[name]`, multiplied it by a flat
`COMPRESSION_RATIO = 0.15`, and booked the difference as saved. The gate
(`src/server/tool-gate-helpers.ts`) was the only caller and never passed a real
count. So `tokens_saved` was **`calls x constant`** — arithmetically confirmable
in the store: 5 123 `search_text` calls, 13 063 650 saved, exactly 2 550 each.

That number is not internal. It is the counter on the homepage and in the README
(`docs/_data/savings.yml`), and `calls`/`tokens_saved` ride the usage ping.

## The measurement

{{ site.data.response_tokens.tools_measured }} tools, covering **97.2%** of
recorded call volume. Ratio is measured response ÷ the raw `Read`/`Grep` the
tool is credited with replacing; **above 1.00 means the tool costs more than
what it stands in for.**

| tool | calls (real) | raw baseline | measured response | measured/baseline |
|---|---|---|---|---|
| `search_text` | 5,125 | 3,000 | **1,659** | 0.55 |
| `get_outline` | 4,461 | 1,200 | **1,427** | 1.19 |
| `search` | 4,441 | 600 | **926** | 1.54 |
| `get_symbol` | 2,687 | 800 | **294** | 0.37 |
| `find_usages` | 440 | 1,000 | **1,122** | 1.12 |
| `get_project_map` | 351 | 1,500 | **568** | 0.38 |
| `get_index_health` | 211 | 500 | **337** | 0.67 |
| `get_tests_for` | 96 | 800 | **90** | 0.11 |
| `get_complexity_report` | 80 | 800 | **1,820** | 2.27 |
| `get_feature_context` | 73 | 4,000 | **7,441** | 1.86 |
| `get_env_vars` | 66 | 500 | **13** | 0.03 |
| `get_dead_code` | 53 | 1,200 | **4,819** | 4.02 |
| `get_context_bundle` | 39 | 6,000 | **127** | 0.02 |
| `get_changed_symbols` | 38 | 500 | **521** | 1.04 |
| `get_task_context` | 32 | 8,000 | **5,384** | 0.67 |
| `check_quality_gates` | 24 | 500 | **121** | 0.24 |
| `get_circular_imports` | 21 | 500 | **76** | 0.15 |
| `check_duplication` | 19 | 500 | **272** | 0.54 |
| `check_claudemd_drift` | 17 | 500 | **1,099** | 2.20 |
| `scan_security` | 16 | 500 | **38** | 0.08 |
| `list_projects` | 15 | 500 | **5,240** | 10.48 |
| `get_call_graph` | 14 | 1,500 | **5,263** | 3.51 |

Those {{ site.data.response_tokens.calls_weighted }} calls cost
{{ site.data.response_tokens.measured_tokens }} measured tokens against a
{{ site.data.response_tokens.baseline_tokens }}-token baseline —
**{{ site.data.response_tokens.reduction_pct }}% fewer**, or
{{ site.data.response_tokens.credited_reduction_pct }}% if you floor the losing
tools at zero the way the corrected counter does. That is the figure the
homepage and the README quote in place of the old "~40–50% on average"
(TRA-904). It is generated into `docs/_data/response_tokens.json` by
`npx tsx scripts/gen-response-tokens-data.ts` from this table's two inputs, so
no surface can retype it. The baseline half is still an estimate — see the last
section.

Three things the table says:

1. **0.15 is wrong on every tool that matters.** The four busiest (88% of all
   calls) measure 0.37–1.54. The assumption is off by 2.5x on the best of them.
2. **{{ site.data.response_tokens.tools_costing_more }} of the
   {{ site.data.response_tokens.tools_with_baseline }} cost more than the
   baseline they replace** — and were still booking a positive number on every
   call. `list_projects` at 10.5x and `get_dead_code` at 4.0x are the worst
   ratios; `get_call_graph` at 5 263 tokens for one symbol is the worst per
   call. Each of these is a response-shaping defect: a default `depth`/`limit`
   too generous for what the caller asked.
3. **A few are far better than claimed** — `get_context_bundle` at 0.02 and
   `get_env_vars` at 0.03 were being under-credited by an order of magnitude.

## The tail, and the tools with nothing to compare against

TRA-880 measured twelve tools (88.4% of calls) and published as a miss on
coverage. Measuring the remaining twelve found something the head could not
show: **some tools have no baseline at all.**

A savings figure is "what a `Read`/`Grep` would have cost, minus what we
returned". `register_edit` is a notification that a file changed; `reindex`
rebuilds an index. There is no file read an agent could have run instead, so
that subtraction has no left-hand side. `DEFAULT_RAW_COST = 500` was supplying
one anyway — and `register_edit` is the **fourth busiest tool on this machine**,
1 289 calls. Across the whole store, 1 731 calls to mutating tools had booked
**~736 000 tokens of savings that never existed**, 3.0% of everything the
counter had ever claimed.

Fixed in `src/savings.ts`: `NO_BASELINE_TOOLS` credits zero. The response is
still counted on the spend side, because the agent still paid for it:

| tool | calls | baseline | measured response | tokens spent, credited zero |
|---|---|---|---|---|
| `register_edit` | 1,289 | — | **345** | 444,705 |
| `reindex` | 184 | — | **59** | 10,856 |

That is {{ site.data.response_tokens.overhead_calls }} calls and
{{ site.data.response_tokens.overhead_tokens }} tokens of pure overhead — real
cost with no counterfactual. Counting it on the spend side and nothing on the
baseline side gives the all-in number:
**{{ site.data.response_tokens.reduction_pct_incl_overhead }}%**. That is what a
session costs; the {{ site.data.response_tokens.reduction_pct }}% above is what
a lookup costs. Neither is wrong; they answer different questions, and the lower
one is the one to plan a budget against.

`src/tools/register/__tests__/no-baseline-tools.test.ts` fails CI if a tool that
describes itself as mutating is left out of the set, so the next one cannot
quietly start booking savings again.

### What closing the tail did to the headline

| | TRA-880 (12 tools) | TRA-945 (24 tools) |
|---|---|---|
| coverage of recorded calls | 88.4% | **97.2%** |
| net `reduction_pct` | 29.3% | **{{ site.data.response_tokens.reduction_pct }}%** |
| credited | 35.2% | {{ site.data.response_tokens.credited_reduction_pct }}% |
| all-in, incl. no-baseline overhead | not computed | {{ site.data.response_tokens.reduction_pct_incl_overhead }}% |
| tools costing more than their baseline | 4 of 12 | **{{ site.data.response_tokens.tools_costing_more }} of {{ site.data.response_tokens.tools_with_baseline }}** |

The tail was more expensive than the head, in both directions: it contained the
worst per-call ratios in the product and the calls that should never have been
scored. Fixing the coverage miss produced a reduction miss.

## The fix

`SavingsTracker.recordActualTokens(tool, tokens)` corrects the pre-call guess
once the response exists. `recordCall` stays where it is, before the tool runs,
because budget clamping and dedup both read the session totals first — this is a
two-phase estimate-then-reconcile, not a move.

Four things the correction has to get right, all found in review and guarded in
`tests/tools/savings.test.ts`:

- **A response bigger than its baseline credits zero**, not a fat positive.
- **A failed call credits zero** (`recordFailedCall`). Scored as payload, a
  4-token error from `get_task_context` would have booked 7 996 saved — more
  than any real answer to the same call. Applies to error responses and to
  throws alike.
- **`batch` is corrected too.** It dispatches handlers directly and never goes
  through the gate, so every batched call would otherwise have kept the guess.
- **Measured last, on the wire bytes.** `enrichResponse` adds fields and
  `applyWireFormat` can re-encode into a denser format; measuring before either
  books a number the client never receives. An empty response is a measured
  zero, not a missing one.

## How the numbers are collected

Three runs per tool, median published, min and max printed. That is not
ceremony: a single sample recorded `get_task_context` at 5 383 tokens and then
at 8 357 minutes later on the same commit. The spread turned out not to be
variance but a **degraded surface** — when a daemon is already running, the
stdio session proxies to it and the session's own `--preset` is ignored, so
twelve of the twenty-four tools answer `Tool X disabled` and the bench was
about to publish those error strings as measurements. The harness now aborts on
any errored call rather than writing it to the artifact.

Within one healthy session the responses are near-deterministic: every tool
above has a min–max spread of 0–3 tokens.

## What is still an estimate, and what to do next

`RAW_COST_ESTIMATES` — "what a `Read`/`Grep` would have cost instead" — is still
hand-written and unvalidated, so the savings *baseline* remains a guess even
though the response side is now measured. That is the next measurement, not this
one: it needs a real counterfactual (the same question answered with
`Read`/`Grep`, tokens counted), which is what `benchmarks/pr-context-benchmark`
does for PR context and nothing does for tool calls.

Second follow-up: ten tools are now known to return more than they save. That is
a response-shaping problem — a default `depth`/`limit` that is too generous — and
it is worth a separate issue per tool with this table as the before number.
`list_projects` (10.5x), `get_dead_code` (4.0x) and `get_call_graph` (3.5x)
first.

One caveat on `get_outline`: it reads 1 427 tokens here against 1 056 in
TRA-880, on the same target file, because the change that added
`NO_BASELINE_TOOLS` grew `src/savings.ts` by ~70 lines. The bench measures a
live repository, so its own commits move its numbers. That is a property of the
corpus, not noise, and it is why the corpus size is stated at the top.
