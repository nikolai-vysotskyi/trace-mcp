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
verdict: NOT-RUN
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

21.1% net reduction (32.6% credited) against a declared **25%**. The coverage
half now passes; the primary half does not.

**That is the result, and it is the opposite of what closing a coverage gap was
expected to do.** The prediction was that the unmeasured 11.6% would move the
figure a little in an unknown direction. It moved it 8.2 points down, because the
tail held the two most expensive things in the product:

- **The worst per-call ratios.** `list_projects` returned 10.5x the baseline it
  is credited against, `get_dead_code` 4.0x, `check_claudemd_drift` 2.2x. The
  count of tools costing more than they replace went from 4 of 12 to 10 of 22.
- **Calls that had no baseline at all.** `register_edit` and `reindex` replace no
  file read, so `DEFAULT_RAW_COST` was inventing a counterfactual for them —
  1 731 calls and ~736k tokens across the whole store. They are now credited
  zero and counted as overhead, which is the honest treatment and also the one
  that lowers the number.

The bar is not moved. It said "unadjustable after seeing data. A future run at
22% publishes as MISSED at 22%", and this run publishes as MISSED at 21.1%. The
figure stays on the storefront with the miss stated next to it, because it is not
wrong — it is smaller than we hoped and better supported than what it replaces.

A third number is published alongside for the first time: **19.5%**, all-in,
with the {{ site.data.response_tokens.overhead_calls }} no-baseline calls counted
on the spend side and nothing on the baseline side. It answers "what does a session
cost" where `reduction_pct` answers "what does a lookup cost". It is the lowest
of the three and the right one to plan a budget against.

The fix this time is not more coverage. It is response shaping on the ten tools
that cost more than they replace — one issue each, with the
[per-tool table](./response-tokens.md) as the before number.

## Re-measured after the first three were shaped (TRA-952, 2026-09-05)

The three worst ratios — `list_projects` 10.5x, `get_dead_code` 4.0x,
`get_call_graph` 3.5x — were shaped, and the whole table was re-measured on the
same protocol at the same declared bar. The current data on this page is that
run:

{{ site.data.response_tokens.reduction_pct }}% net reduction
({{ site.data.response_tokens.credited_reduction_pct }}% credited,
{{ site.data.response_tokens.reduction_pct_incl_overhead }}% all-in), still
**MISSED** against the declared 25%.

The three tools dropped 65–83% each and
{{ site.data.response_tokens.tools_costing_more }} of the
{{ site.data.response_tokens.tools_with_baseline }} tools with a baseline still
return more tokens than the figure credits them. The headline moved 0.1 points,
because those three carry 82 of
{{ site.data.response_tokens.calls_weighted }} recorded calls: worst-ratio-first
finds defects, volume-first moves the number, and only the second was ever going
to clear a bar. `search` (4,441 calls, 1.54x) is where that starts.

## The aggregate is suspended: three defensible frames, three answers, same build (TRA-985, 2026-09-06)

**No verdict is claimed for this run, and the figures on this page are the
TRA-952 ones, unchanged.** What follows is why they were not replaced.

`search_text`, `get_outline` and `search` are **76% of the weight** in this
metric, and each of their published rows came from **one sample** — one query,
one file, one query. That is not a defensible way to price a tool whose cost
depends mostly on its input, so TRA-985 set out to replace each with a basket.
Every basket that got built moved the aggregate somewhere else:

| frame for the three volume-heavy tools | aggregate, same build |
|---|---|
| one sample each (what this page publishes) | **21.0%** |
| 15 filename-shaped words + stratified files | 30.7% |
| shape-representative queries (25/75) | 56.0% |

Same commit, same tools, same call weights, same tokenizer. The spread is the
frame.

### How each frame turned out to be wrong

The first basket was fifteen single lowercase subsystem words. Code review
caught what that is: **exactly the query shape where a `__module__:<filename>`
pseudo-symbol wins the 10x FTS name weight** — the defect the same change fixed.
The basket was enriched for its own treatment. Measured on it, the fix was worth
−39.3%; measured on a basket of symbol names, which cannot be aimed at a
file-named pseudo-symbol, the same fix was worth **−4.9%**.

Its stated provenance was also false. The harness claimed the terms were "the
fifteen most common subsystem nouns in this repo's own directory names". Eleven
of the fifteen are not directory names. Nobody checked the sentence before it was
written, and a mechanical check found it in one command.

The third frame was built from real data — 1,133 recorded `search` calls, 24.9%
single lowercase words against 75.1% identifiers and phrases — and it moved the
aggregate to 56%, because the same terms handed to `search_text` are rare strings
that match almost nothing. Correcting one selection effect introduced another in
the opposite direction.

### Why there is no fourth attempt in this run

`search` is the only one of the three with recorded arguments to build a frame
from, and even those cannot be replayed: they are symbol names from private
repositories, targeting codebases this bench does not index. For `search_text`
and `get_outline` the store holds **zero** recorded queries, so any basket for
them is somebody's intuition about usage, and this run demonstrated three times
over what intuition is worth here.

Picking the frame after seeing what each one does to the number is how a
preregistration gets defeated from the inside. So:

- The **retrieval fix ships** — synthetic module-body pseudo-symbols were 75% of
  a top-20 page on filename-shaped queries and are excluded on every retrieval
  path. That is a correctness result and it does not depend on any frame.
- The **aggregate does not move**, and the figures above stay at TRA-952's until
  a sampling frame is registered *before* the measurement that uses it.
- The 21.0% on this page is now known to rest on one sample per volume-heavy
  tool. It is not defended; it is left in place because replacing it with a
  number chosen after the fact would be worse.

**Outstanding work, in order:** register a sampling frame for the three
volume-heavy tools, with its construction committed and its provenance checkable,
and only then re-measure. That is now a harder blocker than the missing control
arm, and it sits in front of it.

## Registered sampling frame (TRA-993, registered 2026-09-06, before the run)

**This section was written and committed before the measurement that uses it
ran.** That ordering is the whole point of it, and it is checkable: the frame and
this section land in one commit, the numbers in the next.

The frame is `benchmarks/response-tokens/frame.json`, generated by
`scripts/gen-response-token-frame.mjs`, frozen once and read by
`scripts/bench-response-tokens.ts` at run time. It prices the three tools that
carry 76% of the weight — `search_text`, `get_outline`, `search` — with 20
queries and 15 files.

**Where the strata weights come from.** The only recorded arguments that exist
for any of the three tools are 1,133 `search` queries in `~/.trace/analytics.db`
(one machine, other repositories). Their shape, measured for this run over the
same 1,133 rows: **10.3% single all-lowercase word, 60.7% single
mixed-case/underscore identifier, 28.9% multi-word phrase, mean 1.69 words.**
The frame carries that shape: 2 / 12 / 6 out of 20.

TRA-985 reported 24.9% single lowercase words from the same 1,133 rows and used
it to justify a 25/75 split. That figure does not reproduce here under any
classifier tried: 10.3% for `^[a-z]+$`, 15.2% allowing `_` and digits, 71.1% for
any single token. The shape statistic that justified the previous basket was
itself unreproducible, which is the second false provenance claim found on this
measurement.

**Where the items come from.** Each stratum is filled by a positional rule over
a sorted population — sort, take every Nth, no seed, no rejection:

| stratum | population | rule |
|---|---|---|
| word (2) | directory names under `src/` | matching `^[a-z][a-z0-9]{3,}$`, deduped, sorted, every Nth |
| identifier (12) | indexed symbol names | no pseudo-symbols, >3 chars, not all-lowercase, ordered by `symbol_id`, every Nth |
| phrase (6) | indexed symbol names | split on camelCase/snake_case into ≥2 lowercase words, every Nth |
| file (15) | indexed non-test `.ts` under `src/` | path-sorted, every Nth |

`tests/docs/response-token-frame.test.ts` re-checks every one of those claims
against the repository — every `word` item really is a directory name, every
identifier and phrase word really occurs in the corpus, every file really exists.
That test is the answer to TRA-985's basket, whose stated provenance ("the
fifteen most common subsystem nouns in this repo's own directory names") was
false for eleven of fifteen items and would have been caught by one `ls`.

**Declared limits, before the numbers.**

- `search` and `search_text` share one basket. `search_text` has **zero**
  recorded arguments, so a basket of its own would be invented usage. Sharing is
  an assumption, stated here, and the per-item rows will show what it does.
- Symbol-derived phrases are not natural-language phrases. Real recorded ones
  look like "profile dropdown menu"; generated ones look like "extract signal
  names". This frame's phrases match the corpus better than a user's would.
- One repository, one machine's call mix. Unchanged from earlier runs.

**What is committed in advance about the verdict.** The bar stays where it was —
net `reduction_pct` ≥ 25% over ≥ 90% of recorded call volume — and it is not
adjustable now. Three further commitments, made before the number is known:

1. Whatever the aggregate comes out at, it is published, with the verdict stated
   against the 25% bar.
2. The new figure is **not comparable** to the 21.0% on this page. That number
   priced three tools from one sample each; this one prices them from a frame.
   A frame change is a re-framing, not a re-measurement, and the page will say so
   rather than drawing an improvement arrow between them.
3. Per-item raw measurements are retained in `response-tokens.json`, so a reader
   can see the spread inside each basket instead of only its mean.

**Prediction.** Twelve of twenty queries are rare identifiers, which `search_text`
mostly fails to match, so the aggregate is expected to land above the 30.7%
frame and below the 56.0% one. If it lands outside that interval the prediction
was wrong and this line stays on the page saying so.

Measured at trace-mcp **{{ site.data.response_tokens.measured_build.version }}
(`{{ site.data.response_tokens.measured_build.commit }}`)** on
{{ site.data.response_tokens.measured_at | date: "%-d %B %Y" }}.
