---
layout: default
title: Tool response token cost
permalink: /perf/response-tokens/
description: Internal working document. What trace-mcp tool responses actually cost in tokens.
noindex: true
---

# Tool response token cost

Measured 2026-09-05 on darwin 25.5.0 / arm64, trace-mcp 3.17.1 (`f9645147`), against
trace-mcp's own repo (2 144 files, 11 134 symbols) over a real stdio `tools/call`
round-trip. TRA-880. Reproduce with:

```
pnpm run build && npx tsx scripts/bench-response-tokens.ts [repoPath]
```

Token column is a real `o200k_base` count of the response text, not an estimate.
Call volume is this machine's `~/.trace/savings.json` (20 187 calls since the store
was created) — real usage, one machine.

## What was wrong

The *advertised surface* side of the token story has been measured and guarded for
weeks (`preset-surface-budget.test.ts`). The *response* side never was.

`src/savings.ts` scored a call before the tool ran: `recordCall(name)` took a
hand-written `RAW_COST_ESTIMATES[name]`, multiplied it by a flat
`COMPRESSION_RATIO = 0.15`, and booked the difference as saved. The gate
(`src/server/tool-gate-helpers.ts`) was the only caller and never passed a real
count. So `tokens_saved` was **`calls x constant`** — arithmetically confirmable in
the store: 5 123 `search_text` calls, 13 063 650 saved, exactly 2 550 each.

That number is not internal. It is the counter on the homepage and in the README
(`docs/_data/savings.yml`), and `calls`/`tokens_saved` ride the usage ping.

## The measurement

| tool | calls (real) | raw baseline | assumed response | measured response | measured/baseline | claimed saved | saved vs measurement |
|---|---|---|---|---|---|---|---|
| `search_text` | 5,123 | 3,000 | 450 | **1,659** | 0.55 | 13,063,650 | 6,869,943 |
| `get_outline` | 4,428 | 1,200 | 180 | **1,056** | 0.88 | 4,516,560 | 637,632 |
| `search` | 4,413 | 600 | 90 | **921** | 1.53 | 2,250,630 | 0 |
| `get_symbol` | 2,646 | 800 | 120 | **294** | 0.37 | 1,799,280 | 1,338,876 |
| `find_usages` | 436 | 1,000 | 150 | **1,122** | 1.12 | 370,600 | 0 |
| `get_project_map` | 345 | 1,500 | 225 | **568** | 0.38 | 439,875 | 321,540 |
| `get_index_health` | 206 | 500 | 75 | **298** | 0.60 | 87,550 | 41,612 |
| `get_tests_for` | 94 | 800 | 120 | **66** | 0.08 | 63,920 | 68,996 |
| `get_complexity_report` | 78 | 800 | 120 | **1,820** | 2.27 | 53,040 | 0 |
| `get_context_bundle` | 36 | 6,000 | 900 | **127** | 0.02 | 183,600 | 211,428 |
| `get_task_context` | 30 | 8,000 | 1,200 | **6,086** | 0.76 | 204,000 | 57,420 |
| `get_call_graph` | 12 | 1,500 | 225 | **5,165** | 3.44 | 15,300 | 0 |

**Totals over these twelve tools: 23,048,005 claimed vs 9,547,447 measured — 41%.**
They cover 17 947 of the 20 187 recorded calls.

Three things the table says:

1. **0.15 is wrong on every tool that matters.** The four busiest (94% of all calls)
   measure 0.37–1.53. The assumption is off by 2.5x on the best of them.
2. **Four of the twelve cost more than the baseline they replace.** `search`,
   `find_usages`, `get_complexity_report` and `get_call_graph` return more tokens
   than the raw Read/Grep they are credited with saving — and were still booking a
   positive number on every call. `get_call_graph` at 5 165 tokens for one symbol is
   the worst offender per call.
3. **A few are far better than claimed** — `get_context_bundle` at 0.02 and
   `get_tests_for` at 0.08 were being under-credited by an order of magnitude.

## The fix

`SavingsTracker.recordActualTokens(tool, tokens)` corrects the pre-call guess once
the response exists. `recordCall` stays where it is, before the tool runs, because
budget clamping and dedup both read the session totals first — this is a two-phase
estimate-then-reconcile, not a move.

Four things the correction has to get right, all found in review and guarded in
`tests/tools/savings.test.ts`:

- **A response bigger than its baseline credits zero**, not a fat positive.
- **A failed call credits zero** (`recordFailedCall`). Scored as payload, a 4-token
  error from `get_task_context` would have booked 7 996 saved — more than any real
  answer to the same call. Applies to error responses and to throws alike.
- **`batch` is corrected too.** It dispatches handlers directly and never goes
  through the gate, so every batched call would otherwise have kept the guess.
- **Measured last, on the wire bytes.** `enrichResponse` adds fields and
  `applyWireFormat` can re-encode into a denser format; measuring before either
  books a number the client never receives. An empty response is a measured zero,
  not a missing one.

## What is still an estimate, and what to do next

`RAW_COST_ESTIMATES` — "what a Read/Grep would have cost instead" — is still
hand-written and unvalidated, so the savings *baseline* remains a guess even though
the response side is now measured. That is the next measurement, not this one: it
needs a real counterfactual (the same question answered with Read/Grep, tokens
counted), which is what `benchmarks/pr-context-benchmark` does for PR context and
nothing does for tool calls.

Second follow-up: `get_call_graph`, `get_complexity_report`, `search` and
`find_usages` are now known to return more than they save. That is a response-shaping
problem — a default `depth`/`limit` that is too generous — and it is worth a separate
issue per tool with this table as the before number.
