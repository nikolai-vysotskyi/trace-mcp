---
layout: default
title: Preregistration — PR review context benchmark
permalink: /perf/prereg-pr-context/
description: What the PR review context benchmark set out to measure, the bar it had to clear, and the verdict against that bar.
noindex: true
measurement: pr_context
data_file: docs/_data/pr_context_bench.json
preregistration: retrospective
written_on: 2026-09-05
verdict: MISSED
---

# Preregistration — PR review context benchmark

**This file is retrospective.** The run it describes happened on 2026-08-30; this
was written on 2026-09-05, after the numbers were known. Nothing below was
declared in advance, and a bar written after the result is not evidence about
that result — it binds the *next* run of this benchmark, not the one already
published. Saying so is the point: the alternative is a backdated file that
claims a discipline we did not have.

## Question

Does assembling pull-request review context out of the trace-mcp index cost
fewer input tokens than loading the diff plus every file it touches, on code we
do not own — and without hiding more of what the change can break?

## Metric

`savings_pct = (baseline_tokens − trace_tokens) / baseline_tokens`, per pull
request, reported as the **median across pull requests** (not the ratio of
sums — one enormous PR must not carry the figure). Both arms are counted with
`gpt-tokenizer` over the assembled prompt text, never estimated from character
counts.

Emitted by `scripts/bench-pr-context.ts` into `benchmarks/pr-context/results.json`
(`aggregates.median_savings_pct`) and, preformatted for the site, into
`docs/_data/pr_context_bench.json`.

The secondary metrics are quality, and they exist so a token win bought by
dropping information is visible: `changed_symbol_readable`,
`dependent_readable`, `dependent_pointed` — the share of changed symbols and of
affected call sites a reviewer can read or at least locate in the assembled
context.

## Corpus

60 merged pull requests across six open-source repositories we do not own
(`hono`, `axios`, `express`, `requests`, `flask`, `got`), frozen with base and
head SHAs in `benchmarks/pr-context/dataset.json`. Frozen means the run is
reproducible: the dataset file is committed, and re-running against a moved
branch is a different measurement.

## Pass bar

- **Primary:** median `savings_pct` ≥ **50%**.
- **Quality floor:** `trace_changed_symbol_readable` ≥ `baseline_changed_symbol_readable`.
  A token win that makes the changed code less readable is a failure, not a win.

Unadjustable after seeing data. If a future run lands at 48%, it publishes as
MISSED at 48% — the bar does not move to 45%.

## Prediction

Large savings on PRs that touch a handful of files inside a big repository,
shrinking towards zero on small self-contained PRs where the diff *is* the
context. We expected a minority of pull requests where trace-mcp barely pays off
and some where it loses outright; the run publishes those cases rather than
trimming them.

## Control

The baseline arm is a real control, not an estimate: the same 60 pull requests,
the same tokenizer, context assembled by loading the diff plus every file it
touches. That is what makes a miss on this benchmark interpretable — a bad
result would be a result about trace-mcp, not about a guessed baseline. It is
also the reason this figure, and not the aggregate in
[prereg-response-tokens](./prereg-response-tokens.md), leads the storefront.

## Verdict — MISSED: primary bar met at 72.8%, quality floor failed at 71%

A run that misses any registered bar publishes as MISSED, so that is the verdict
even though the headline saving cleared its bar comfortably. Which bar failed,
and why it failed only now, is below.

**Corrected 2026-09-07 (TRA-1090).** The 2026-08-30 run measured a trace-mcp arm
that contained no source code: `get_context_bundle` read symbol bodies through a
bare `require('node:fs')`, which throws under ESM and was swallowed by a catch,
so the benchmark — which imports `src/` as real ESM under `tsx` — assembled
signatures only. The shipped build was never affected (its `createRequire`
banner defines `require`), but the published number was measured on a context
the product does not serve. The [diagnosis]({{ '/perf/pr-context-loss-classes/'
| relative_url }}) has the full account.

The same 60 pull requests, same pinned SHAs, re-run with bodies restored:
**median {{ site.data.pr_context_bench.median_savings_pct }}%**
(13,595 → {{ site.data.pr_context_bench.trace_median_tokens }} input tokens),
against the 90.6% first published. The primary bar was ≥50% and is still met; the previous figure is
struck, not defended.

**The quality floor is a different story, and it now fails.** It reads
`trace_changed_symbol_readable` ≥ `baseline_changed_symbol_readable`. That
metric counted whether the bundle *listed* a symbol, never whether it carried
the body, so it read 100% in both arms — including through the period when the
trace arm had no source code in it at all. TRA-1100 rewrote it to score
`detail === 'full'`, and this is the first run measured under the corrected
definition:

| | naive | trace-mcp |
|---|---:|---:|
| changed symbols readable (median per PR) | {{ site.data.pr_context_bench.baseline_changed_symbol_readable }} | **{{ site.data.pr_context_bench.trace_changed_symbol_readable }}** |
| affected call sites readable | {{ site.data.pr_context_bench.baseline_dependent_readable }} | {{ site.data.pr_context_bench.trace_dependent_readable }} |
| affected call sites at least located | {{ site.data.pr_context_bench.baseline_dependent_pointed }} | {{ site.data.pr_context_bench.trace_dependent_pointed }} |

Some of the changed symbols arrive without their bodies — **98 of 338**
across the corpus, counted per symbol in
[`benchmarks/pr-context/symbol-detail.json`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/benchmarks/pr-context/symbol-detail.json).
The previously-published 58% call-site readability was the same pointer count;
it is {{ site.data.pr_context_bench.trace_dependent_readable }} when bodies are
required. **The bar was registered as unadjustable and
it is not being adjusted: this publishes as MISSED.** The token saving is
unaffected by the metric's definition — whatever it reads, it was counted on the
assembled text, not on what the metric called readable.

### What the 98 are, and what they cost to recover

This was published as unmeasured on 2026-09-07 and is measured now, because the
guess in that sentence turned out to be wrong. Re-running the identical corpus
at four bundle budgets (`--bundle-budget N`; a non-default budget is a
diagnostic and writes no artifacts):

| of 338 changed symbols | 8,000 (shipped) | 16,000 | 32,000 | 64,000 |
|---|---:|---:|---:|---:|
| body present | 240 | 263 | 299 | 333 |
| bodyless — whole-file node | 65 | 48 | 21 | 3 |
| bodyless — ordinary symbol | 33 | 27 | 18 | 2 |
| **median token saving** | **72.8%** | **32.3%** | **−0.1%** | **−0.3%** |

A *whole-file node* is one whose body is the entire file — a `__module__` /
`<module>` node, or a document node on a non-code file — so the bundle declining
to carry it is the index working as intended. **93 of the 98 are budget
truncation**: raise the budget far enough and all but five bodies arrive.

The curve is monotone in both columns, and that is the finding: every body
recovered costs saving, and **the saving crosses zero between 16,000 and 32,000
— while 39 bodies are still missing.** There is no budget at which this corpus
gets full changed-symbol coverage *and* a token win. The 72.8% is not a saving
that happens to come with a coverage gap; the coverage gap is what pays for it.

That reframes what the missed floor asks for. It cannot be met by turning the
budget up. It is a packing question — which symbols get the budget — not a size
question.

**5 bodies never arrive at any budget** (2 ordinary symbols, 3 whole-file
nodes). That residual was 29 before [TRA-1141]({{ '/perf/pr-context-loss-classes/' | relative_url }})
stopped the bundle shipping a container and its members as separate copies of
the same bytes: the budget those duplicates were consuming is most of what the
higher budgets above were buying back. Five is small enough to inspect one by
one, which is the next thing to do rather than a class to reason about.

What it does *not* say is that the review suffers: the
[quality arm]({{ '/perf/prereg-pr-quality/' | relative_url }}), which asks a
model rather than a metric, came back at parity on the same corpus. Both are
true, and the gap between them — 98 of 338 changed-symbol bodies missing without
a measurable comprehension cost — is the open question, not a resolved one, and
measuring the decomposition named above is the way into it.

Pull requests where the index did not pay off went from 5 to 56 under the
corrected metric — 42 of them classified `truncated`, which is that same
finding counted per PR rather than per symbol, and 13 costing more than reading
the files outright; they are published in
[`docs/_data/pr_context_bench.json`](../_data/pr_context_bench.json) and on the
[benchmark page]({{ '/pr-context-benchmark.html' | relative_url }}).

**Re-measured 2026-09-07 (TRA-1141), and both bars moved.** The 70.5% run was
correct about what the bundle contained; it was also paying for the same bytes
twice, because a symbol and the container it lives inside were both emitted in
full. With that duplication removed, and with a member restored whenever the
container that replaced it turns out not to fit the budget, the same 60 pull
requests measure **median 72.8%** (13,595 → 3,286 input tokens) and
**71%** changed-symbol readability against the 67% above.

The floor is still missed — 71% against the baseline's 100% — and the verdict
above stands. What moved is the direction: the same change that raised the
saving raised the readability it is measured against, which is the only way this
bar is worth clearing. Its cost is on the other coverage column: call-site
readability goes 28% → 22%, because markdown documents, file-level wrappers and
symbols already inside something else are now listed rather than inlined.
`dependent_pointed` stays 100%, so every one of them is still named with a
location. Raising the floor the rest of the way is TRA-1144's job. The
[loss-class page]({{ '/perf/pr-context-loss-classes/' | relative_url }}) has the
per-section diagnosis and the head-to-head comprehension check on the 13 pull
requests the change touched most.

Measured at trace-mcp **{{ site.data.pr_context_bench.measured_build.version }}
(`{{ site.data.pr_context_bench.measured_build.commit }}`)** on
{{ site.data.pr_context_bench.generated_at | date: "%-d %B %Y" }}. The 2026-08-30
build was reconstructed from the run's timestamp — the run did not record it, which is the
second thing TRA-920 fixed. Every run from now on stamps its own build.
