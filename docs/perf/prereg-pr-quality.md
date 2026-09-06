---
layout: default
title: Preregistration — PR review quality benchmark
permalink: /perf/prereg-pr-quality/
description: What the LLM arm of the PR review context benchmark set out to measure, the bar it had to clear, and the verdict against that bar.
noindex: true
measurement: pr_context_quality
data_file: docs/_data/pr_context_quality.json
preregistration: prospective
written_on: 2026-09-06
verdict: MISSED
---

# Preregistration — PR review quality benchmark

**This file was written before the run.** It was committed on 2026-09-06 with
`verdict: PENDING`, ahead of the 180 model calls it describes; the verdict line
was filled in from `docs/_data/pr_context_quality.json` afterwards and nothing
else in this file changed. The [token arm's
preregistration](./prereg-pr-context.md) was retrospective and said so — this
one is the correction of that.

## Verdict: MISSED, on both bars

The registered prediction was wrong, and in the direction that costs us. On 60
pull requests the trace-mcp arm understood the change **50%** of the time
against the naive arm's **65%** — a **15 point** loss where the bar allowed 10
— and produced **1.20** false positives per PR against **0.65**, a **+0.55**
where the bar allowed +0.50. The prediction registered below was a 0–8 point
loss with the primary bar met. It was not met.

Latency went the other way, as a tenth of the input predicts: 74.5 s median
against 90.0 s.

The bar does not move. The finding is that at the current `get_context_bundle`
budget the 90% token saving [measured in the token
arm](../pr-context-benchmark.md) is bought with a measurable amount of review
quality, and the next issue is closing that gap on this same harness — not
rewriting the question.

## Question

[The token benchmark](../pr-context-benchmark.md) showed that trace-mcp's
review context costs about a tenth of the input tokens of loading the diff plus
every file it touches. It did not show that a review written from that thinner
context is worth reading. This run asks exactly that: **on the same 60 pull
requests, does a model reviewing the trace-mcp context understand the change as
well as one reviewing the full files, and does it invent fewer or more
problems?**

## Metrics

Per pull request, both arms, judged by a model given the PR's own diff as
ground truth:

- **`understood`** — did the review name the defect the diff fixes, or
  correctly describe what the change does and why? Binary. Reported as
  `understood_rate` across PRs. This is deliberately *not* "found a latent
  bug": the corpus is merged bug-fix PRs, so the defect is visible in the diff
  and the honest question is comprehension, not discovery. See *Limits*.
- **`false_positives`** — claims the review makes about the code that are wrong
  about the code shown: a bug that is not there, a call site that does not
  exist, an already-handled edge case. Stylistic nitpicks and speculative
  "consider…" suggestions do not count. Reported as a per-PR mean. This is the
  number that decides whether a review bot is usable at all; a cheap context
  that produces confident nonsense is not a win.
- **`api_ms`** — model latency per review, median. Secondary, but it gets asked.

Emitted by `scripts/bench-pr-quality.ts` into
`benchmarks/pr-context/quality.json` and, preformatted for the site, into
`docs/_data/pr_context_quality.json`.

## Corpus

The same 60 pull requests as the token arm, and — this is the point — the same
prompts. `scripts/bench-pr-context.ts --dump-prompts` writes each arm's
assembled context to disk during the token run, and this script reads those
files. The texts scored here are byte-for-byte the texts that were
token-counted there; neither arm is re-assembled or re-worded for the quality
run.

## Method

Every call is made through the same function at the same settings — one named
model (`claude-sonnet-4-5`), default temperature, no tools, no MCP servers, no
project or user settings, no dynamic system-prompt sections. Only the system
prompt and the user text differ between reviewer and judge.

The judge sees the PR title, the diff, and the two reviews **blind and in
randomised order** — it is never told which arm is which, and a fixed A/B order
would let position bias ride along with the result.

## Pass bar

- **Primary (non-inferiority):** `trace.understood_rate` ≥
  `baseline.understood_rate` − **10 percentage points**. The claim this
  benchmark supports is "a tenth of the tokens for the same review", so the
  quality arm has to show *no meaningful loss*, not a gain.
- **Secondary:** `trace.false_positives_per_pr` ≤
  `baseline.false_positives_per_pr` + **0.5**. A thinner context that makes the
  model guess more is a real cost even if comprehension holds.

Unadjustable after seeing data. If the trace arm lands 15 points down, it
publishes as MISSED at 15 points, and the next issue is fixing `pack_context`
or the bundle budget — not moving the bar to 20.

## Prediction

Registered before the run: the trace arm loses a small amount of comprehension
— **0 to 8 points** — because the baseline arm can read surrounding code the
bundle omits, and it produces **slightly more** false positives for the same
reason, on the order of +0.2 to +0.5 per PR. We expect the primary bar to be
met and the secondary to be the close one.

## Control

The baseline arm is a real control: same PRs, same model, same settings, same
judge, context assembled by loading the diff plus every file it touches. A miss
is therefore a result about trace-mcp's context, not about a guessed baseline.

## Limits

Stated in advance so they are not read as excuses afterwards:

- **The ground truth is weak.** These are merged bug-fix PRs; the defect is in
  the diff. A reviewer that reads the diff carefully can score `understood`
  without any surrounding context at all, which compresses the gap between the
  arms in the trace arm's favour. A harder corpus — PRs followed by a revert or
  an explicit regression fix, where the reviewer *should* have caught something
  and did not — would separate the arms better and is a separate issue. This
  run keeps the pinned set so the quality numbers sit on the same rows as the
  token numbers.
- **The judge is a model.** `false_positives` in particular is a judgement
  call. Per-PR reviews and judgements are committed alongside the aggregates so
  the scoring is auditable rather than asserted.
- **The transport is the `claude` CLI in headless mode**, because this runtime
  has no API key. That adds a constant ~16k tokens of tool definitions to every
  call's system prompt, identical in both arms and in the judge, and no tool is
  callable. It does not affect the comparison; it does mean the token and cost
  figures on this page are the CLI's and not the benchmark's. Read
  `results.json` for those.
