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
  machine's `~/.trace/savings.json`, 20,187 recorded calls, provenance in the
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

## Verdict — MISSED (retrospective)

{{ site.data.response_tokens.reduction_pct }}% net reduction
({{ site.data.response_tokens.credited_reduction_pct }}% credited) clears the 25%
half of the bar. The coverage half does not: the
{{ site.data.response_tokens.tools_measured }} tools measured carry
{{ site.data.response_tokens.calls_weighted }} of the
{{ site.data.response_tokens.calls_store_total }} recorded calls — **88.4%,
against a declared 90%**. 2,340 calls are unmeasured, and nothing rules out
their being the expensive ones.

So the figure publishes as a miss. It is not rewritten into a bar it clears, and
the 29.3% stays on the storefront with the coverage stated next to it, because
the number is not wrong — it is incomplete in a direction we cannot sign. The
fix is measuring the tail, not lowering the line.

{{ site.data.response_tokens.tools_costing_more }} of the
{{ site.data.response_tokens.tools_measured }} tools measured return more tokens
than the baseline credits them (`search`, `find_usages`,
`get_complexity_report`, `get_call_graph`); the per-tool table is on the
[response cost page](./response-tokens.md).

Measured at trace-mcp **{{ site.data.response_tokens.measured_build.version }}
(`{{ site.data.response_tokens.measured_build.commit }}`)** on
{{ site.data.response_tokens.measured_at | date: "%-d %B %Y" }}.
