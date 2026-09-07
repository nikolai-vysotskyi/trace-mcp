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

## Verdict — the prediction was wrong, and the pass is about the frame (TRA-993, 2026-09-06)

**The prediction above is wrong and stays on the page.** It said the aggregate
would land between 30.7% and 56.0%. Measured on the registered frame:
**67.4% net reduction** (68.3% credited, 65.8% all-in) over 18,319 calls, 97.2%
of recorded call volume, 5 of 22 tools still costing more than their baseline.
That is outside the interval, above it. (Frozen literals — this is a verdict on
one run. The live figures moved with TRA-1049 below.)

Against the declared bar — net ≥ 25% over ≥ 90% of call volume — this is the
first **PASS** this measurement has recorded.

**It should not be read as the product getting better.** The build is one commit
past TRA-952's, which published 21.0% on the same call weights and the same
tokenizer. Nothing shipped in between that moves a headline 46 points. What
moved is the frame: the three volume-heavy tools stopped being priced from one
sample each. The four frames now on record for this metric price the same class
of build at 21.0%, 30.7%, 56.0% and 67.4% — and the registered one is not
"correct", it is *fixed in advance and checkable*, which is a different and
smaller claim.

So the useful result of this run is not the number. It is that **the number is
frame-dominated**, and here is the mechanism, visible for the first time because
per-item costs are now retained:

- `search_text` costs **86 to 2 244 tokens** across the twenty frame queries —
  a 26x spread around a 608-token mean. Any single sample from that population
  was always going to be noise.
- **Three of twenty `search_text` queries return zero matches** (`hits: 0` in
  the artifact) and cost 86 tokens each. Six of twenty `search` queries find no
  symbol. A corpus-derived frame naturally asks for rare things; real users ask
  for things they expect to exist. This frame therefore prices misses, and a
  miss is cheap — which pushes the aggregate up.
- The opposite pull is there too: the two `word`-stratum queries (`advanced`,
  `nestjs`) are the two most expensive items in both baskets, 2 128 and 2 244
  tokens on `search_text`, an order of magnitude above the phrase stratum.

Both effects were in the frame before it was run, both are stated in the strata
rules, and neither was tuned after seeing the result. That is what the
preregistration buys — not accuracy.

**Known contamination, found during the run and not fixed here.** The bench
indexes this repository, and this repository now contains the frame:
`benchmarks/response-tokens/frame.json` and `docs/perf/response-tokens.json`
both hold every query string as literal text, so a frame query can match the
artifact that records it. `search { query: "extract subscript" }` returns
`total: 0` symbols and falls back to text matches whose first two hits are those
two files. The bias is **conservative for the headline** — it adds tokens to the
measured side, which lowers the reduction — but it grows every time the artifact
grows, and it needs excluding from the bench's corpus before the next run.

**What this does not fix.** The control arm is still absent: `baseline_per_call`
remains the hand-written `RAW_COST_ESTIMATES` table, not a measured `Read`/`Grep`
alternative. A 67.4% against an estimated baseline is still an estimate on one
side. With the frame now registered, that is again the outstanding work on this
measurement, and it is the last structural one.

Measured at trace-mcp **3.19.0 (`bf277620`)** on 6 September 2026.

## `find_usages` was the fourth one-sample tool, and it was not registered in advance (TRA-1049, 2026-09-07)

**Stated first, because it is the part this discipline exists to catch: this
change was not preregistered.** The basket that prices `find_usages` was added
to the harness and the run executed inside one session, which is exactly the
sequence TRA-993 introduced this document to prevent.

What limits the damage is that **no new basket was written.** `find_usages` now
runs over the `identifier` stratum of
`benchmarks/response-tokens/frame.json` — generated by
`scripts/gen-response-token-frame.mjs`, committed on 2026-09-06, and re-checked
against the repository by `tests/docs/response-token-frame.test.ts`. The only
choice available in this run was *which committed stratum*, against the status
quo of one symbol picked by hand in the harness. Read the result with that
caveat and not without it.

**Why it needed doing.** TRA-993 fixed the one-sample defect on the three tools
carrying 76% of the weight and left it in place on the fourth. `find_usages`
returns one row per incoming edge, so the target's in-degree *is* the response
size: across the twelve frame symbols it runs 265 to 21,671 tokens, an 82x
spread. The single symbol the harness had been using (`estimateTokens`) sat near
the top of that range, and its 1.12x is what put `find_usages` on the
over-baseline list and made it the named target of TRA-1026.

**A second, independent reading was available and had never been used.**
`~/.trace/analytics.db` records `output_size_chars` for 175 real non-error
`find_usages` calls over five months. Converted at the tool's own measured
chars-to-token ratio: median 300 tokens, p90 973, max 4,773
(`node scripts/field-response-distribution.mjs find_usages`). Against a
1,000-token baseline the median real call is **0.30x**. That agrees with the
frame basket's median of 337 and disagrees with the 1.12x that was published.
This is field data, one machine, and it is not a control arm — but it is the
first time any figure on this page has been checked against calls the product
actually served.

**The conclusion reversed; the defect did not.** `find_usages` is not an
over-baseline tool. It did, however, have no response ceiling of any kind, and
one call on this repo returned 21,671 tokens. It now takes a `limit` (default
50, chosen off the recorded distribution above, `total` and `resolution_tiers`
unchanged, a `truncated` marker when the page is short). That is a product
change, not a re-framing: `Error` drops 21,671 → 4,032, the basket mean 2,129 →
659, the basket median does not move at all, and the headline moves 67.4% →
{{ site.data.response_tokens.reduction_pct }}% — **0.3 points, the only step in
that whole row that came from shipping something.**

**What this does not fix.** The control arm is still absent, and it is now the
only structural gap left: `baseline_per_call` remains the hand-written
`RAW_COST_ESTIMATES` table. Every ratio on this page — including the 0.30x above
and every "costs more than it replaces" verdict — is measured on one side and
guessed on the other.

Measured at trace-mcp **{{ site.data.response_tokens.measured_build.version }}
(`{{ site.data.response_tokens.measured_build.commit }}`)** on
{{ site.data.response_tokens.measured_at | date: "%-d %B %Y" }}.

## `register_edit` is the fifth one-sample tool, and this time it is registered (TRA-1107, registered 2026-09-07, before the run)

**Registered before the run, unlike TRA-1049.** Nothing below was written after
seeing a frame number. The field figures quoted as the cross-check were already
published in TRA-1098 and in TRA-1107's own text; the frame basket has not been
run at the time of writing.

### The defect

`register_edit` is priced at **345 tokens** from one harness call,
`register_edit { file_path: 'src/savings.ts' }`. Its response is bookkeeping
(21-47 tokens) plus one `_duplication_warnings` entry per similarity the file
happens to carry, and `src/savings.ts` carries four. `src/tools/register/core.ts`
carries none and answers in 47. The spread is a property of the file passed in,
not of the tool — the same argument-driven, one-sample defect TRA-993 fixed for
`search_text` / `get_outline` / `search` and TRA-1049 fixed for `find_usages`.

It matters more here than on those four. `register_edit` is credited zero and
counted as pure overhead (TRA-945), so every token it returns is spend, and its
1 289 recorded calls make it the largest single block of response spend in the
product. That figure feeds `reduction_pct_incl_overhead` — the all-in number
this page tells a reader to budget against.

### Decision: frame, not field

Priced from the **committed frame**, cross-checked against the field
distribution. That is TRA-1049's arrangement and it applies unchanged.

TRA-1107 raised the objection that there is no stratum for "a file with a
representative number of near-duplicate symbols", so a frame entry would have to
be built and frozen first. **That objection is wrong, and dropping it is the
point of this entry.** `benchmarks/response-tokens/frame.json` has carried a
`file` stratum since TRA-993 — fifteen indexed non-test `.ts` files under `src/`,
path-sorted, every Nth, generated on 2026-09-06 and re-checked against the
repository by `tests/docs/response-token-frame.test.ts`. `get_outline` already
prices against it. `register_edit`'s argument is a file path. The stratum is the
right shape and it is already frozen.

Building a duplication-stratified frame entry instead would mean inventing a
selection rule for "representative number of similarities" — a judgement call
made after seeing which files are expensive, which is the exact move TRA-985
showed decides the headline. **The only choice available in this run is which
committed stratum**, and there is only one whose items are file paths.

The field distribution is the independent check, not the price: it is one
machine, it carries no build stamp, and it is weighted by which files this
maintainer happens to edit. It cannot be the published figure for the same
reason `list_projects`' 4.03x cannot — it prices the laptop.

### Metric

`register_edit` run once per frame `file` item, fifteen calls, collapsed to the
group mean by the harness's existing `collapseGroups` — mean, because the
aggregate multiplies it by a call count. Per-item costs retained in
`docs/perf/response-tokens.json` under `items`, as for every other grouped tool.

### Prediction

Registered before running:

1. The frame mean lands **below 345** — the harness sample sits high by
   construction and every reading available says so.
2. The frame mean lands **between 80 and 250** tokens. Most files carry no
   similarity at all; a minority carry several.
3. The frame **median** lands **above the field median of 67** and below the
   frame mean. The frame is uniform over source files; the field is weighted by
   how often each file is edited, and repeat edits within a session are
   suppressed by TRA-1098's memo, so the field is pulled toward the bookkeeping
   floor in a way a one-call-per-file basket is not.
4. `reduction_pct_incl_overhead` **rises**, because `register_edit` is the
   largest overhead block and it is being repriced downward.

Prediction 4 is why this is a separate commit from anything that benefits from
it: the change moves the published all-in figure **in our favour**, which is
exactly when a frame edit needs to have been registered first.

### Pass bar

There is none, and that is deliberate. This is a re-framing, not a product
change — nothing ships in it that could make the product faster or cheaper. The
run passes if the frame basket is the committed one, the per-item spread is
published rather than summarised to a mean, and the direction of the headline
move is reported before the number.

### Field cross-check, fixed in advance

`node scripts/field-response-distribution.mjs register_edit`, read before the
frame run, 710 non-error calls between 2026-04-06 and 2026-09-06:

| min | p25 | median | p75 | p90 | max | mean | n |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 38 | 57 | **67** | 112 | 408 | 712 | 141 | 710 |

Registered at trace-mcp `ea994220`, 7 September 2026.

## Verdict — four for four, and the headline moved in our favour anyway (TRA-1107, 2026-09-07)

Registered above at `ea994220`, run at `9f499d67`, two commits later. The
harness change is one basket swap: `register_edit` now runs over the frame's
committed `file` stratum instead of one hand-picked path.

| prediction | result | |
|---|---|---|
| 1. frame mean below 345 | **219** | ✅ |
| 2. frame mean between 80 and 250 | 219 | ✅ |
| 3. frame median above the field median (67) and below the frame mean | median **183**, mean 219 | ✅ |
| 4. `reduction_pct_incl_overhead` rises | 66.1% → **67.1%** | ✅ |

**Four correct predictions is a weaker result than it looks, and the reason is
the one worth recording.** Every one of them was inferable from data that
already existed — TRA-1098 had published the composition table and the field
mean before this entry was written. Predicting a number you have already half
measured is not a test of a model; it is a test of arithmetic. The
preregistration's value here is not that it was right, it is prediction 4:
**registering, before the run, that the change would improve our published
figure without improving the product.** That is the claim a reader can hold us
to, and it is the only one that could have been embarrassing.

The spread across the fifteen committed files is 48 to 453 tokens, 9.4x, with
six files at the bookkeeping floor because they carry no similarity at all. The
old 345 sat above the 80th percentile of that.

**The 1.0-point move on the all-in figure is not all reprice.** 0.6 points is
`register_edit` (162 414 tokens over a 27 729 800-token baseline). The remainder
is the bench re-measuring all 24 tools eleven commits later — `get_call_graph`
802 → 904, `get_index_health` 299 → 338, `get_changed_symbols` 258 → 62 — which
also carries `reduction_pct` 67.7% → 68.2%. Neither half is a product change.
The bench regenerates the whole artifact on every run, so a reframing commit
cannot avoid dragging a re-measurement along with it; the two are separated here
by hand, and separating them mechanically is not solved.

**What this does not fix**, unchanged from TRA-1049 and now the only structural
gap left on this metric: `baseline_per_call` is still the hand-written
`RAW_COST_ESTIMATES` table. `register_edit` is exempt from it — it is a
no-baseline tool by TRA-945 — so this reprice is one of the few figures on the
page that is measured on both sides, for the trivial reason that one side is
zero. Every ratio that is not is still measured on one side and guessed on the
other.

`reindex` (59 tokens, still one sample) and the four remaining over-baseline
tools are untouched. `reindex` is a genuine one-sample tool with no argument to
vary, so a frame cannot help it; its variance is index state, and that is a
different measurement.

Measured at trace-mcp **{{ site.data.response_tokens.measured_build.version }}
(`{{ site.data.response_tokens.measured_build.commit }}`)** on
{{ site.data.response_tokens.measured_at | date: "%-d %B %Y" }}.

## The 2.2% nobody priced, and the one tool it found (TRA-1159, 2026-09-07)

**Two halves, two honesty labels, and they are different.** The tail
measurement below was run before this entry was written — it is
**retrospective**, like TRA-880's and TRA-945's entries, and nothing in it was
predicted in advance. The bench half — adding `get_plugin_registry` to the
harness and re-running the whole artifact — is **registered**: at the time of
writing the harness has not been run with that row in it, and the four
predictions under "Prediction" below are the claim a reader can hold us to.

### The gap

The harness prices 24 tools because each one needs arguments a human wrote.
This machine has called **98**. The 74 it never priced are 598 calls — 3.2% of
the recorded volume, 0% of the measurement — and the page has been quoting
"97.2% of recorded call volume" as if the remainder were small enough to ignore.
It is small enough to ignore *by count*. Nobody had checked whether it is small
by tokens, which is the only sense in which it could matter, and a tool nobody
prices can return anything.

### Instrument, and why it is the weaker one

Those tools cannot be re-called: no arguments are recorded anywhere.
`~/.trace/analytics.db` does keep `output_size_chars` per call, which is the
response itself, so the tail is priced from recorded responses converted at the
**median chars-to-token ratio of the 24 tools the harness measured on the wire**
(`scripts/field-tail-cost.ts`, writing `docs/perf/response-tokens-tail.json`).

Three limits, stated before the result rather than after:

- The 24 measured ratios span **0.2203 to 0.3677**. The median (0.2639) is the
  estimator; a single tail tool can be off by ~30% in either direction. The
  block is the claim, not any row in it.
- One machine, this maintainer's, with no build stamp — the same objection that
  keeps `list_projects` off the published figure.
- **112 of the 598 calls (35 tools) have no recorded response at all** and are
  imputed with nothing. They stay uncovered, and the coverage figure says so.

This instrument does not replace a harness row for any tool. It prices a block
that was previously priced at zero by omission.

### Prediction — the bench half, registered before the run

`get_plugin_registry` is the worst row the tail turned up: 10 433 tokens per
call against a 500-token baseline, **20.9x**, the most expensive single response
in the product. Shaped in this run the way TRA-952 shaped `list_projects` — the
193-entry edge-type catalog is a static list, identical on every project and
every call, and is now one `include_edge_types: true` away, with
`edge_types_total` and per-category counts kept in the default answer. A scratch
call over stdio measured **8 427 → 4 983 tokens** before the harness row existed.

Then it is added to `scripts/bench-response-tokens.ts`, so it is guarded from
here on, and the artifact is regenerated. Registered predictions:

1. The harness median lands **within 5% of the 4 983** the scratch call measured.
2. It is **still over baseline** — 500 tokens is not a credible price for
   "what a `Read`/`Grep` of the plugin registry would have cost", so
   `tools_costing_more` goes 4 → 5. Shaping does not get it under 1.00 and is
   not aimed at doing so.
3. `reduction_pct` **falls, and by less than 0.5 points** — 10 recorded calls
   against 18 319 is not enough weight to move a weighted mean, which is the
   same lesson TRA-952 recorded and the reason this is not a headline fix.
4. At least one untouched tool moves by more than 10% between artifacts, from
   corpus drift alone. Every bench run so far has produced one, and a run that
   did not would mean the corpus stopped moving, not that the product did.

### Pass bar

**The tail half has no bar** — it is a first measurement, and any number it
returns is publishable. What it must not do is stay unpublished if it makes the
headline worse.

The bench half passes if predictions 1-3 hold. Prediction 4 is a control on the
instrument, not on the product: if it fails, the run is still valid and the
observation is recorded.

**Whatever the tail does to `reduction_pct`, the new figure is the published
one.** Registered here so that it cannot be argued afterwards that a
lower-coverage number was the fairer comparison.
