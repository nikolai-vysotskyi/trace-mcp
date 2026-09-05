---
layout: default
title: Preregistration — tool response token cost
permalink: /perf/prereg-response-tokens/
description: What the aggregate token-reduction figure set out to measure, the bar it had to clear, and the verdict against that bar.
noindex: true
measurement: response_tokens
data_file: docs/_data/response_tokens.json
preregistration: retrospective
written_on: 2026-09-05
verdict: MISSED
---

# Preregistration — tool response token cost

**This file is retrospective.** The measurement ran on 2026-09-05 and this was
written the same day, after the numbers were known. It was not preregistered.
The bar below binds the next run; it is not evidence about this one.

The reason this measurement exists at all is a failure of exactly the kind
preregistration catches. For months the published figure was `~40–50% on
average`, which descended from a counter that scored every call *before the tool
ran* — `RAW_COST_ESTIMATES[tool] × 0.15`, a constant with zero variance across
thousands of calls (TRA-880, [#915](https://github.com/nikolai-vysotskyi/trace-mcp/pull/915)).
Arithmetic presented as measurement, caught by a person reading the code rather
than by any process.

## Question

Across the call mix a real session actually produces, do trace-mcp tool
responses cost fewer tokens than the file reads they replace — and which tools
cost more?

## Metric

`reduction_pct = (Σ calls × baseline_per_call − Σ calls × measured_per_call) / Σ calls × baseline_per_call`

Net: tools that cost more than their baseline subtract from the total. The
second ratio, `credited_reduction_pct`, floors each tool's loss at zero — that
is what the corrected in-product counter books, it is higher, and it is never
the headline.

`measured_per_call` is a real `o200k_base` count of a real `tools/call` response
over stdio, emitted by `scripts/bench-response-tokens.ts` into
[`response-tokens.json`](./response-tokens.json). `baseline_per_call` is
`RAW_COST_ESTIMATES` imported from `src/savings.ts`. The join is
`scripts/gen-response-tokens-data.ts` → `docs/_data/response_tokens.json`, and
that file regenerates byte-identically from its inputs or CI fails.

## Corpus

Two frozen inputs, both committed:

- `docs/perf/response-tokens.json` — responses measured against trace-mcp's own
  repository (2,144 files, 11,134 symbols).
- `benchmarks/response-tokens/call-volume.json` — the weights: a snapshot of one
  machine's `~/.trace/savings.json`, 20,359 recorded calls, provenance in the
  file.

One machine's mix, and the surfaces that quote the figure have to say so.

## Pass bar

- **Primary:** net `reduction_pct` ≥ **25%** over calls covering ≥ **90%** of
  recorded call volume.
- **Disclosure floor, not a threshold:** the count of tools whose responses cost
  more than their baseline is published whatever it is. There is no number of
  them that constitutes a pass, and none that licenses dropping the count.

Unadjustable after seeing data. A future run at 22% publishes as MISSED at 22%.

## Prediction

We expected the corrected figure to land well below the `40–50%` it replaced,
and we expected a minority of tools to cost more than the reads they stand in
for — the old counter credited those a saving too, so the correction had to move
in this direction. We did not predict the size of either.

## Control — absent, and that is the finding

There is no measured control arm. The baseline half — what a `Read`/`Grep` would
have cost instead — is a hand-written table in `src/savings.ts`, not a measured
alternative run. So a miss on this metric cannot be told apart from a
mis-calibrated baseline, and neither can a beat.

That limit is why this figure does not lead the storefront: the
[PR review context benchmark](./prereg-pr-context.md) has a real control arm and
runs on code we do not own. Every surface quoting the aggregate has to say the
baseline is still an estimate, and `tests/docs/savings-claims.test.ts` fails when
one stops.

Building a measured control is the outstanding work on this measurement.

## Verdict — MISSED again, and on the other half (TRA-945, 2026-09-05)

The first run of this measurement (TRA-880) missed on **coverage**: twelve tools
carrying 88.4% of recorded calls against a declared 90%. The stated fix was
"measuring the tail, not lowering the line". The tail is measured — twenty-four
tools, **97.2%** of recorded call volume — and the bar is missed again, on the
other half:

{{ site.data.response_tokens.reduction_pct }}% net reduction
({{ site.data.response_tokens.credited_reduction_pct }}% credited) against a
declared **25%**. The coverage half now passes; the primary half does not.

**That is the result, and it is the opposite of what closing a coverage gap was
expected to do.** The prediction was that the unmeasured 11.6% would move the
figure a little in an unknown direction. It moved it 8.2 points down, because the
tail held the two most expensive things in the product:

- **The worst per-call ratios.** `list_projects` returns 10.5x the baseline it is
  credited against, `get_dead_code` 4.0x, `check_claudemd_drift` 2.2x. The count
  of tools costing more than they replace went from 4 of 12 to
  {{ site.data.response_tokens.tools_costing_more }} of
  {{ site.data.response_tokens.tools_with_baseline }}.
- **Calls that had no baseline at all.** `register_edit` and `reindex` replace no
  file read, so `DEFAULT_RAW_COST` was inventing a counterfactual for them —
  1 731 calls and ~736k tokens across the whole store. They are now credited
  zero and counted as overhead, which is the honest treatment and also the one
  that lowers the number.

The bar is not moved. It said "unadjustable after seeing data. A future run at
22% publishes as MISSED at 22%", and this run publishes as MISSED at
{{ site.data.response_tokens.reduction_pct }}%. The figure stays on the
storefront with the miss stated next to it, because it is not wrong — it is
smaller than we hoped and better supported than what it replaces.

A third number is published alongside for the first time:
**{{ site.data.response_tokens.reduction_pct_incl_overhead }}%**, all-in, with
the {{ site.data.response_tokens.overhead_calls }} no-baseline calls counted on
the spend side and nothing on the baseline side. It answers "what does a session
cost" where `reduction_pct` answers "what does a lookup cost". It is the lowest
of the three and the right one to plan a budget against.

The fix this time is not more coverage. It is response shaping on the ten tools
that cost more than they replace — one issue each, with the
[per-tool table](./response-tokens.md) as the before number.

{{ site.data.response_tokens.tools_costing_more }} of the
{{ site.data.response_tokens.tools_with_baseline }} tools with a baseline return
more tokens than it credits them.

Measured at trace-mcp **{{ site.data.response_tokens.measured_build.version }}
(`{{ site.data.response_tokens.measured_build.commit }}`)** on
{{ site.data.response_tokens.measured_at | date: "%-d %B %Y" }}.
