---
layout: default
title: Tool response token cost
permalink: /perf/response-tokens/
description: What trace-mcp tool responses cost in tokens, per tool, weighted by real call volume — including the ones that cost more than the reads they replace.
updated: 2026-09-08
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
{% for r in site.data.response_tokens.rows -%}
| `{{ r.tool }}` | {{ r.calls }} | {{ r.baseline_per_call }} | **{{ r.measured_per_call }}** | {% if r.measured_over_baseline > 1 %}**{{ r.measured_over_baseline }}**{% else %}{{ r.measured_over_baseline }}{% endif %} |
{% endfor %}

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

1. **0.15 is wrong on every tool that matters.** The busiest four are 88% of all
   calls, and not one of them lands on it: the closest, `search_text`, is 1.3x
   off, and the other three are 2.2x to 4.7x off.
2. **{{ site.data.response_tokens.tools_costing_more }} of the
   {{ site.data.response_tokens.tools_with_baseline }} cost more than the
   baseline they replace** — and, before the counter was corrected, were still
   booking a positive number on every call. It was ten of twenty-two until
   TRA-952 reshaped the three worst (below). Each survivor is a response-shaping
   defect: a default `depth`/`limit` too generous for what the caller asked. Read
   the current list off the table rather than from here — which tools are on it
   changes with every reshaping, and a name typed into prose is how this page
   went stale once already (TRA-1020, below).
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
{% for r in site.data.response_tokens.overhead_rows -%}
| `{{ r.tool }}` | {{ r.calls }} | — | **{{ r.measured_per_call }}** | {{ r.measured_tokens }} |
{% endfor %}

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

**TRA-1098 then shaped the larger of the two, and the harness could not see
it.** That result is written up in full below, because the number came back
against the change and the reason is more useful than the change was.

### What closing the tail did to the headline

Every column but the last is a frozen literal: it records what that run
measured, so a later re-measurement cannot rewrite it. Only the last column is
live.

| | TRA-880 (12 tools) | TRA-945 (24 tools) | TRA-952 (shaped) | TRA-993 (registered frame) | TRA-1049 (find_usages framed) |
|---|---|---|---|---|---|
| coverage of recorded calls | 88.4% | 97.2% | 97.2% | 97.2% | **97.2%** |
| net `reduction_pct` | 29.3% | 21.1% | 21.0% | 67.4% | **{{ site.data.response_tokens.reduction_pct }}%** |
| credited | 35.2% | 32.6% | 31.5% | 68.3% | {{ site.data.response_tokens.credited_reduction_pct }}% |
| all-in, incl. no-baseline overhead | not computed | 19.5% | 19.4% | 65.8% | {{ site.data.response_tokens.reduction_pct_incl_overhead }}% |
| tools costing more than their baseline | 4 of 12 | 10 of 22 | 8 of 22 | 5 of 22 | **{{ site.data.response_tokens.tools_costing_more }} of {{ site.data.response_tokens.tools_with_baseline }}** |

**The TRA-993 column is not an improvement on the one before it.** Nothing in
the product changed between them that would move a headline 46 points. What
changed is that `search_text`, `get_outline` and `search` — 76% of the weight —
stopped being priced from one sample each and started being priced from a
[registered sampling frame](./prereg-response-tokens.md#registered-sampling-frame-tra-993-registered-2026-09-06-before-the-run).
Read across that row as *frames*, not builds — with one exception: the TRA-1049
column is the only step that moved because the product changed, and it is worth
0.3 points.

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
`Read`/`Grep`, tokens counted), which is what `benchmarks/pr-context`
does for PR context and nothing does for tool calls.

One caveat on `get_outline`: it read 1 427 tokens against 1 056 in
TRA-880, on the same target file, because the change that added
`NO_BASELINE_TOOLS` grew `src/savings.ts` by ~70 lines. The bench measures a
live repository, so its own commits move its numbers. That is a property of the
corpus, not noise, and it is why the corpus size is stated at the top.

## Two things TRA-985 found, one shipped and one suspended (2026-09-06)

**Shipped: `search` was returning three quarters noise on filename-shaped
queries.** The language plugins emit a synthetic `__module__` pseudo-symbol per
file so the call graph can attribute module-body call sites
(`metadata.synthetic = true`, signature `(module body) <path>`). Its name embeds
the file's basename and FTS weights the name column 10x, so on any
filename-shaped query these outrank every real symbol. Across fifteen such
queries, **145 of 192 top-20 rows (75.5%) were pseudo-symbols**: `search`
for `indexer` returned twenty of them and nothing else, `daemon` four of its top
five. They are excluded now on every retrieval path — lexical, hybrid, fusion,
pure-semantic and the six named `retriever` modes — bypassed when the query
names `__module__` itself. That list took three rounds of review to get right:
the first fix covered only the lexical SQL, the second added the hybrid and
fusion merge points, and the third covered `search { retriever }`, which
early-returns before either. Each round the claim "every retrieval path" was
made before it was true.

That is a retrieval-quality fix. `daemon` used to answer with four module bodies
and one real constant; it answers with five real symbols now.

**What that is worth in tokens depends entirely on which queries you ask.** On
the filename-shaped basket it reads −39.3%. On a basket of symbol names — which
cannot be aimed at a pseudo-symbol named after a *file* — the same fix reads
**−4.9%**. Three defensible frames for the three volume-heavy tools (76% of the
weight) produced 21.0%, 30.7% and 56.0% on one build, so TRA-985 published no
aggregate at all.

That is fixed by construction rather than by argument (TRA-993): the frame is
generated by `scripts/gen-response-token-frame.mjs`, frozen in
`benchmarks/response-tokens/frame.json`, committed before the run that uses it,
and every stratum claim is re-checked against the repository by
`tests/docs/response-token-frame.test.ts`. Per-item costs are retained in
`response-tokens.json`, so the spread inside each basket is readable instead of
hidden behind its mean — and it is wide: `search_text` runs 86 to 2 244 tokens
across twenty queries on one build. The
[preregistration](./prereg-response-tokens.md) carries the frame, the limits
declared before the run, and the verdict.

## What shaping the three worst tools did (TRA-952)

The first three tools on that follow-up list have been reshaped, and the table
above is the after. What each one was returning that nobody asked for:

| tool | before | after | what came out |
|---|---|---|---|
| `list_projects` | 5,240 (10.48x) | **901 (1.80x)** | 98 subprojects, three absolute paths each. `call_project_tool` only accepts registered roots, so a subproject was never a valid next call. Now `include_subprojects`, default off. |
| `get_call_graph` | 5,263 (3.51x) | **1,421 (0.95x)** | Both directions expanded at every level, so depth 2 answered "what else does my caller call" — 64 of 75 nodes. Each branch now keeps its own direction. |
| `get_dead_code` | 4,819 (4.02x) | **2,725 (2.27x)** | 50 of 341 candidates in one page, for a list the caller verifies entry by entry. Default is 25; `total_dead` is unchanged, so nothing is hidden. |

No response field was dropped and no schema changed: the subprojects list is
still available on request, the call graph still reaches the same depth, and a
deeper dead-code page is still one `limit` away.

**And it moved the headline by 0.1 points.** Those three tools are 82 of 18,319
recorded calls. The weighted figure is decided by `search_text`, `get_outline`
and `search`, which are 78% of call volume between them. Worst-ratio-first was
the right order for finding defects and the wrong one for moving the number.

The sentence that used to close this paragraph named `search` (1.54x) and
`get_outline` (1.19x) as "the whole of the negative block that matters" and
pointed the next issue at `search`. **Both figures were stale and both tools are
under 1.00** — see TRA-1020 below.

`get_dead_code` is left at 2.27x on purpose. Its baseline is 1,200 tokens —
"what a `Read`/`Grep` would have cost instead" for a whole-repo dead-code sweep
over 3,412 exports, which is not a credible 1,200 tokens. Cutting the tool
further would buy the ratio by answering less; the honest correction there is on
the baseline half, which is still an estimate.

### Three rows moved for reasons that are not this change

`get_changed_symbols` (521 → 1,224), `find_usages` (1,122 → 975) and
`search_text` (1,659 → 1,722) were not touched. `get_changed_symbols` reports the
diff of whatever working tree it runs on, so the two runs asked it different
questions and its row is not comparable between them at all. The other two track the corpus: the repo gained files and symbols between
the two measurements. Same caveat as `get_outline` above, and the reason the
per-tool ratios are the durable part of this page and the aggregate is not.

## `find_usages` was on the over-baseline list because of one symbol (TRA-1049)

TRA-1026 named `find_usages` "the only over-baseline tool with real call
volume" — 440 calls, 1,122 tokens against a 1,000-token baseline, 1.12x — and
pointed the next shaping pass at it. **That 1.12x was one call.** The harness
priced `find_usages` by resolving a single symbol (`estimateTokens`) and
measuring the answer, which is the same one-sample defect TRA-993 fixed for
`search_text`, `get_outline` and `search`, left in place on the fourth tool
because nobody had looked at it.

`find_usages` is the tool in this product whose cost is least decided by the
tool. It returns one row per incoming edge, so the target's in-degree *is* the
response size, and in-degree spans two orders of magnitude inside one
repository. Priced over the frame's committed `identifier` stratum — twelve
real symbol names, picked positionally, no new selection rule — the twelve
per-item costs in `docs/perf/response-tokens.json` run **265 to 21,671 tokens,
an 82x spread**, and eleven of the twelve are under 600. The symbol the harness
happened to pick sat near the top of that range.

Two independent readings agree on where the middle is:

| | median | p90 | max | n |
|---|---|---|---|---|
| harness basket, this repo | 337 | — | 21,671 | 12 |
| recorded field calls, five months | 300 | 973 | 4,773 | 175 |

The field row is every non-error `find_usages` call this machine has made since
2026-04-05, from `~/.trace/analytics.db`, with recorded chars converted at the
tool's own measured chars-to-token ratio. Reproduce it with
`node scripts/field-response-distribution.mjs find_usages`. Against a
1,000-token baseline the median real call reads **0.30x**. `find_usages` was
never an over-baseline tool; it was a tool measured once, at its p90.

**So the conclusion reverses, and the defect does not.** What the frame exposed
is that `find_usages` had **no response ceiling of any kind** — not a `limit`,
not a page size, only the compute guard's two-million-iteration ceiling, which
is a wall-clock protection and not a token one. On this repo a call for `Error`
returned 262 references and 21,671 tokens in one response. In a repository with
a real god-node there is no number that answer stops at.

Fixed the way TRA-952 fixed `get_dead_code`: a `limit`, defaulting to 50, with
`total` and `resolution_tiers` still counting every reference and a `truncated`
marker when the page is short of the answer. No field was dropped and the rest
is one `limit` away. Fifty comes off the distribution above, not off taste — it
is past the 97th percentile of recorded calls, four of the 175 are large enough
to be clipped, and none by much.

| | before | after |
|---|---|---|
| `Error` (262 references) | 21,671 | **4,032** |
| basket mean, the published figure | 2,129 | **659** |
| basket median | 337 | 337 |
| ratio against the 1,000-token baseline | 2.13x | **0.66x** |

The median does not move, which is the point: the change is invisible to every
call the shape of real use produces, and cuts the worst one by 81%. On the
weighted headline it is worth 0.3 points — 67.4% to
{{ site.data.response_tokens.reduction_pct }}% — and it takes the over-baseline
list from five tools to
{{ site.data.response_tokens.tools_costing_more }}.

One thing this does **not** fix: the published per-tool figure is the basket
*mean*, and on a distribution this skewed a mean is a statement about the
basket. 659 is the mean of eleven calls near 340 and one near 4,032. The mean is
the right estimator for the weighted aggregate — it multiplies by a call count —
but a reader wanting to know what a `find_usages` call costs should read the
per-item rows in the artifact, or the field median above, and not this page's
table cell. Every other multi-item tool on this page has the same property; this
is the first one where the spread is large enough to say so out loud.

## `register_edit` repeated itself, and the harness prices the one call that does not (TRA-1098)

Since TRA-945 `register_edit` is credited zero and counted as pure overhead, so
every token it returns is spend. This page priced that at 345 tokens over 1 289
calls — 444 705 tokens, the largest single block of response spend in the
product. Making it visible did not make it cheaper, so TRA-1098 went looking at
what was in it.

**The composition, five files of this repo:**

| file | total | `_duplication_warnings` | share |
|---|---:|---:|---:|
| `src/global.ts` | 380 | 330 | 87% |
| `src/savings.ts` | 351 | 294 | 84% |
| `src/indexer/pipeline.ts` | 312 | 253 | 81% |
| `src/progress.ts` | 290 | 239 | 82% |
| `src/tools/register/core.ts` | 47 | 0 | — |

The bookkeeping half — `status`, `file`, `totalFiles`, `indexed`, `skipped`,
`errors`, `durationMs` — is 21-47 tokens. Everything else was duplication
warnings, and the check recomputed them over the whole file on every edit, so
editing one file forty times reported the same similarities forty times.

**The obvious fix is wrong, and the reason is worth keeping.** Snapshot the
file's symbols before reindexing, report only what is new. Review caught the
race: a single edit fires three independent reindex paths — parcel-watcher
inside the daemon, the PostToolUse HTTP hook, and the agent's own
`register_edit` call — and `recent-reindex-cache.ts` documents skew between
them regularly exceeding 500 ms, which is why its dedup TTL is 2 000 ms. If
another path indexes first and the agent's call arrives later than that, the
"pre-edit" snapshot is read from a store that already reflects the edit, and the
genuinely new symbol is filtered out as pre-existing. That is a silent false
negative in the one case the warning exists for, and it is worse than the noise
it replaces. `tests/tools/register-edit-duplication-memo.test.ts` fails on
exactly that scenario.

What shipped instead does not read the store: each warning is reported once per
file per process. A warning the agent has not been shown is new *to the agent*
whoever indexed the file, which is the only sense in which "new" was ever
actionable.

### The result went the other way

Re-running `scripts/bench-response-tokens.ts` after the change measures
`register_edit` at **345 tokens — unchanged**. The harness calls each tool once
against a fresh server, so it prices the first call on a file, which is the one
call that still legitimately pays for the warning. Nothing here moves the
headline, and the columns above are unchanged on purpose.

The effect is real, and it is smaller than the composition table suggests.
Replayed against every `register_edit` call recorded in `~/.trace/analytics.db`
— 740 calls, 369 distinct files, mean 470 chars — with the memo applied in call
order:

| grouping | suppressed | response tokens | per call |
|---|---:|---:|---:|
| per session + file (memo lives one session) | 169 of 740, 22.8% | 101 003 → 83 236, **−17.6%** | 136 → 112 |
| per file (memo lives the daemon's life) | 364 of 740, 49.2% | 101 003 → 70 423, **−30.3%** | 136 → 95 |

Reality is between the two rows: the memo is process-local, and a daemon
outlives a session while a stdio server does not.

**And the field distribution says this page has been over-pricing the tool.**
The harness's single sample is `src/savings.ts`, which fires four warnings at
351 tokens. Across 740 recorded calls the mean is **136 tokens**, 2.5x lower —
`register_edit`'s cost is decided by how many similarities its file happens to
carry, which is the same argument-driven spread that put `find_usages` on the
over-baseline list from one sample (TRA-1049). At 136 tokens the recorded
overhead block is nearer 101 000 tokens than 445 000.

That is a frame question, not a product one, and this page's rule is that
editing the frame is a visible act in its own commit. It was filed separately as
TRA-1107 and repriced there — see the next section; nothing on this page was
repriced in TRA-1098's own commit.

## `register_edit` repriced: 345 tokens was one file, and the frame already had the right stratum (TRA-1107)

TRA-1098 left `register_edit` priced at **345 tokens** from a single harness
call on `src/savings.ts`, and said in the same breath that the field mean was
2.5x lower. This is the reprice. It is a **re-framing, not a product change** —
nothing shipped in it, no response got smaller, and the headline moves anyway.
That is the whole reason it is its own commit and its own
[preregistration](https://trace-mcp.com/perf/prereg-response-tokens/) entry,
written before the run.

**The objection that delayed it was wrong.** TRA-1107 argued there was no
stratum for "a file with a representative number of near-duplicate symbols", so
a frame entry would have to be built and frozen first.
`benchmarks/response-tokens/frame.json` has carried a `file` stratum since
TRA-993 — fifteen indexed non-test `.ts` files under `src/`, path-sorted, every
Nth, committed on 2026-09-06, re-checked against the repository by
`tests/docs/response-token-frame.test.ts`. `get_outline` already prices against
it and `register_edit`'s argument is a file path. The basket was already there.
Building a duplication-stratified one instead would have meant inventing a
selection rule for "representative number of similarities" after seeing which
files are expensive, which is the move TRA-985 showed decides the headline.

**The spread, fifteen committed files, median of three runs:**

| | tokens |
|---|---:|
| `src/ai/abort.ts`, `src/retrieval/index.ts` (no similarities) | 48 |
| median of the basket | **183** |
| mean of the basket — the published figure | **219** |
| `src/indexer/edge-resolvers/imports.ts` | 453 |
| previous published figure (`src/savings.ts`, one call) | 345 |

A 9.4x spread, and the file the harness happened to pick sat above the 80th
percentile of it. Six of the fifteen carry no similarity at all and answer in
under 52 tokens — the bookkeeping floor.

**Three readings, and they agree about the shape:**

| | median | p90 | max | n |
|---|---:|---:|---:|---:|
| frame basket, this repo | 183 | — | 453 | 15 |
| recorded field calls, five months | 67 | 408 | 712 | 710 |
| old published figure | — | — | — | **1** |

The field row is every non-error `register_edit` call this machine has made
since 2026-04-06, converted at the tool's own measured chars-to-token ratio
(`node scripts/field-response-distribution.mjs register_edit`). It sits *below*
the frame, as preregistered: the frame asks each file once, while the field is
weighted by which files a maintainer edits repeatedly, and TRA-1098's memo
suppresses the repeats. The field is the cross-check, not the price — it is one
machine, and it prices this laptop's editing habits the way `list_projects`
prices its project count.

**What it moves.** `register_edit` is credited zero and counted as pure
overhead, so the whole change lands on the all-in figure:

| | before | after |
|---|---:|---:|
| `register_edit` per call | 345 | **219** |
| recorded overhead block (1 289 calls + `reindex`) | 455 561 | **293 147** |
| `reduction_pct_incl_overhead` | 66.1% | **{{ site.data.response_tokens.reduction_pct_incl_overhead }}%** |

**Read that 1.0-point move as two things, not one.** 0.6 points of it is this
reprice (162 414 tokens over a 27 729 800-token baseline). The rest is that the
bench re-measures every tool on every run, and this run sits eleven commits past
the previous artifact: `get_call_graph` 802 → 904, `get_index_health` 299 → 338,
`get_tests_for` 90 → 115, `search_text` 641 → 608, and `get_changed_symbols`
258 → 62, which reports the diff of whatever working tree it runs on and is not
comparable between runs at all. Those also take `reduction_pct` from 67.7% to
{{ site.data.response_tokens.reduction_pct }}%, and none of them is a product
change either.

**The direction is the uncomfortable part.** This reprice makes our published
number better by 0.6 points without making the product one token cheaper, and
we knew it would before we ran it — which is why the prediction saying so is
registered, dated and one commit earlier than the result.

## The five tools still over baseline, and why none of them is next (TRA-1098, updated TRA-1159)

With `find_usages` reversed, `register_edit` repriced, and `get_plugin_registry`
shaped, the over-baseline list stands at five tools carrying **175 recorded calls
between them** — against 1 289 for `register_edit` alone. Each has a recorded
decision now, so the next run does not re-derive them:

| tool | calls | ratio | decision |
|---|---:|---:|---|
| `list_projects` | 15 | 4.03x | **Not portable.** TRA-1026 established the figure moves with how many projects the measuring machine has registered (901 tokens on one, 2 017 here). It prices this laptop, not the tool. |
| `get_complexity_report` | 80 | 2.27x | **Baseline, not response.** 30 rows of `{ symbol_id, name, kind, file, line, cyclomatic, max_nesting, param_count }` is the question the caller asked. 800 tokens is not what deriving those metrics from `Read`/`Grep` would cost, and the tabular redundancy already has an answer in `output_format: "toon"`. |
| `get_dead_code` | 53 | 2.27x | **Decided in TRA-1026:** a 1 200-token baseline for a whole-repo sweep is not credible, so cutting the tool would buy the ratio by answering less. |
| `check_claudemd_drift` | 17 | 2.20x | Volume too low to price; same baseline objection. |
| `get_plugin_registry` | 10 | 10.09x | Catalog shaped in TRA-1159 (edge types opt-in, 8 427 → 5 045 tokens). 500-token default baseline is not a credible cost for indexing plugin metadata. |

Four of the five are baseline problems, and the baseline half is the estimate
this whole page says is still an estimate. **None of the five is in `minimal`,
the shipped default surface** — they live in `standard`, `review`, `perf` and
`architecture`, where a caller has explicitly asked for that analysis. Shaping
them further would be optimising a number nobody's default session pays.

The honest next move on this metric is not another shaping pass; it is
measuring the baseline half. Until then, a ratio near 2x on a low-volume
analysis tool is a statement about `RAW_COST_ESTIMATES`, not about the tool.

## The 2.9% nobody priced, and the one tool it found (TRA-1159)

The harness previously priced 24 tools because each needed human-written arguments.
The other 74 tools called on this machine were 2.7% of call volume in that store (and grew to 73 tools / 591 calls in the 2026-09-08 field tail snapshot). TRA-1159 prices this tail from field response sizes
converted at the median chars-to-token ratio (0.2635) of the 25 wire-measured tools
(`scripts/field-tail-cost.ts` writing `docs/_data/response_tokens_tail.json`).

The worst row the tail turned up was `get_plugin_registry` (10 433 tokens per call,
20.9x baseline). The 193-entry static edge types catalog was 44% of its response.
It is now opt-in via `include_edge_types: true` while counts by category stay in
the default answer (8 427 scratch → 5 045 tokens).

The tool is now guarded in `scripts/bench-response-tokens.ts` and added to
`call-volume.json` at 10 calls (making 25 harness tools, 19 802 calls including overhead, 97.3% of the 20 359 calls in the 2026-09-05 store).
Pricing the remaining 73 tail tools (591 calls, 479 priced from recorded sizes) gives an
all-in reduction of **65.5%** with tail included, expanding measurement coverage from 97.3% to 99.5% across the combined cohorts.

## The table on this page was hand-typed, and it had gone stale (TRA-1020)

Everything on this page that reads `{{ site.data.response_tokens.* }}` is
generated. The **per-tool table** was not: it was Markdown someone typed, and
between TRA-952 and TRA-993 the measurements moved underneath it while the rows
stayed put. The gap on the three tools that carry 76% of the weight, committed
artifact against what the page was showing:

| tool | page said | `docs/perf/response-tokens.json` said |
|---|---|---|
| `search_text` | 1,722 (0.57x) | 608 (0.20x) |
| `get_outline` | 1,427 (1.19x) | 419 (0.35x) |
| `search` | 924 (1.54x) | 421 (0.70x) |

Re-measured independently on 3.20.0 (`bc67ad28`) before touching anything:
`search_text` 608, `get_outline` 419, `search` 423. The artifact reproduces; the
table did not.

It is not only a wrong number. The page's own conclusion — "`search` at 1.54x
and `get_outline` at 1.19x are now the whole of the negative block that
matters", and the recommendation to shape `search` next — rested on rows that
said those tools cost more than they replace when the committed measurement said
they cost 0.70x and 0.35x. The aggregates beside the table were right the whole
time, because they are generated: **{{ site.data.response_tokens.tools_costing_more }}
of {{ site.data.response_tokens.tools_with_baseline }}** cost more than their
baseline, not the eight the prose implied, and `search` is not among them.

The table is now a Liquid loop over `site.data.response_tokens.rows`, so it
cannot disagree with the artifact it summarises, and
`tests/docs/response-tokens-table.test.ts` fails CI if a per-tool token count is
typed back into the page. This is the same defect class as TRA-762 (README
quoting synthetic benchmark numbers as measured) and TRA-880 (the counter
publishing arithmetic as measurement), in the one place that documents both.

## Your own install: `trace savings` (TRA-1091)

This page is one benchmark run on one repository. The same corrected counter
also keeps a per-install tally, and `trace savings` (also printed by
`trace doctor`, served at `GET /api/savings`, and shown on the desktop app's
Savings screen) is where you read it. Everything those surfaces print comes from
`src/savings-report.ts` — one implementation, so no surface can drift back into
the arithmetic TRA-880 disproved.

Three properties it carries, and why:

- **Measured calls only.** `savings.json` gained a `measured` block that is
  incremented only when a response was actually counted. The old
  `total_tokens_saved` — which on any store written before this includes the
  `calls x constant` guess — is never read. An install upgrading from an older
  build therefore starts from "not enough data", not from an inflated total.
- **A floor.** Dollars are priced at the cheapest current Claude input rate, so
  the figure understates for everyone on a larger model. The baseline half is
  still `RAW_COST_ESTIMATES`, i.e. an estimate, which is why the wording is
  "at least" and why this page is linked from every surface that prints it.
- **It says "not enough data" rather than showing a zero.** Below 25 measured
  calls there is no figure at all.

**It is not expressed as a share of a weekly limit**, which is the obvious thing
to want. Anthropic does not publish the Claude Code weekly limit in tokens, so
any percentage would need a denominator we invented — the exact move that
produced the number TRA-880 had to retract. Tokens and a floor price are what we
can source.
