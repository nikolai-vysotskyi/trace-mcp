---
title: "PR Review Context Benchmark — Measured Input-Token Cost on Real Pull Requests"
description: "Reproducible measurement of the input tokens trace-mcp context saves over naive file loading when reviewing real merged pull requests in open-source repos."
updated: 2026-09-07
---

# PR Review Context Benchmark

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": {{ page.title | jsonify }},
  "description": {{ page.description | jsonify }},
  "url": "https://trace-mcp.com/pr-context-benchmark.html",
  "datePublished": "2026-08-30",
  "dateModified": {{ page.updated | jsonify }},
  "author": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "publisher": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://trace-mcp.com/pr-context-benchmark.html"
  }
}
</script>

Every claim about token reduction on this site used to rest on trace-mcp's own
internal estimators — the [session analytics](analytics.md) numbers, measured by
the tool on itself. That is not good enough for anyone outside the project.
This page is the measurement on somebody else's code: **{{ site.data.pr_context_bench.pr_count }}
real merged pull requests** across **{{ site.data.pr_context_bench.repo_count }}**
open-source repositories, with the PR numbers and commit SHAs pinned in the
repo so the run reproduces.

## TL;DR

Assembling review context for a pull request with trace-mcp costs a median
**{{ site.data.pr_context_bench.median_savings_pct }}% fewer input tokens** than
loading the diff plus every file it touches. It makes *more* of the code the
change can break visible — {{ site.data.pr_context_bench.trace_dependent_readable }}
of affected call sites readable against
{{ site.data.pr_context_bench.baseline_dependent_readable }}, and
{{ site.data.pr_context_bench.trace_dependent_pointed }} at least located — and
*less* of the changed code itself:
{{ site.data.pr_context_bench.trace_changed_symbol_readable }} of changed symbols
arrive with their bodies, against
{{ site.data.pr_context_bench.baseline_changed_symbol_readable }} for whole
files. That second number misses a
[preregistered bar]({{ '/perf/prereg-pr-context/' | relative_url }}).

The review written from it holds up. Sending both contexts to the same model on
the same PRs, the trace-mcp arm understood the change as often as the naive one
and asserted {{ site.data.pr_context_quality.trace_false_positives }} problems
that are not there per PR against
{{ site.data.pr_context_quality.baseline_false_positives }} — both inside a
[preregistered bar]({{ '/perf/prereg-pr-quality/' | relative_url }}) written
before the calls were made. An earlier run of that same arm published a 15 point
comprehension loss; it was measured on a context that
[contained no source code]({{ '/perf/pr-context-loss-classes/' | relative_url }})
and is struck. Both halves are below; neither number should be quoted without
the other.

| | naive file loading | trace-mcp |
|---|---:|---:|
| input tokens, median | {{ site.data.pr_context_bench.baseline_median_tokens }} | **{{ site.data.pr_context_bench.trace_median_tokens }}** |
| input tokens, p90 | {{ site.data.pr_context_bench.baseline_p90_tokens }} | **{{ site.data.pr_context_bench.trace_p90_tokens }}** |
| input tokens, worst case | {{ site.data.pr_context_bench.baseline_max_tokens }} | **{{ site.data.pr_context_bench.trace_max_tokens }}** |
| cost per PR, median | ${{ site.data.pr_context_bench.baseline_median_cost }} | **${{ site.data.pr_context_bench.trace_median_cost }}** |
| cost per PR, p90 | ${{ site.data.pr_context_bench.baseline_p90_cost }} | **${{ site.data.pr_context_bench.trace_p90_cost }}** |
| changed symbols readable | {{ site.data.pr_context_bench.baseline_changed_symbol_readable }} | {{ site.data.pr_context_bench.trace_changed_symbol_readable }} |
| affected call sites readable | {{ site.data.pr_context_bench.baseline_dependent_readable }} | **{{ site.data.pr_context_bench.trace_dependent_readable }}** |
| affected call sites at least located | {{ site.data.pr_context_bench.baseline_dependent_pointed }} | **{{ site.data.pr_context_bench.trace_dependent_pointed }}** |

Measured at trace-mcp **{{ site.data.pr_context_bench.measured_build.version }}
(`{{ site.data.pr_context_bench.measured_build.commit }}`)** on
{{ site.data.pr_context_bench.generated_at | date: "%-d %B %Y" }}{% if site.data.measurements.pr_context.historical %} — published as a result from that
build, not as a claim about the current one{% endif %}. What this run set out to
measure, the bar it had to clear and the verdict against that bar:
[preregistration]({{ '/perf/prereg-pr-context/' | relative_url }}).

Dollar figures are input tokens priced at `{{ site.data.pr_context_bench.model }}`,
${{ site.data.pr_context_bench.input_usd_per_mtok }} per million input tokens.
Indexing a repository costs a median {{ site.data.pr_context_bench.median_index_ms }} ms
per PR once the initial index exists, and is amortised across every query
against that repo.

## What was measured

The carrier task is **AI code review of a real pull request** — the most
token-hungry production pipeline in the code-agent market, and the one where
the entire cost is context assembly.

Two arms, same pull requests, same tokenizer (`gpt-tokenizer`, exact counts —
not a characters-over-four estimate), same prompt skeleton:

- **Naive file loading** — the review instructions, the unified diff, and the
  complete text of every source file the diff touches. This is what an agent
  without an index does.
- **trace-mcp** — the review instructions, the unified diff, then
  `get_changed_symbols` to resolve which indexed symbols the diff actually
  touched, `get_context_bundle` for those symbols with their dependencies and
  callers, and `get_change_impact` for the call sites the change can break.

Both contexts are assembled against the same commit — the PR head — because
that is the state a review agent has in front of it.

### Dataset

{{ site.data.pr_context_bench.pr_count }} merged, bug-fix-titled pull requests
from `honojs/hono`, `axios/axios`, `expressjs/express`, `psf/requests`,
`pallets/flask` and `sindresorhus/got` — TypeScript, JavaScript and Python.
Selection criteria, applied before any measurement:

- merged, with `fix` in the title (a review has something to look for);
- between 1 and 20 changed files (below that there is nothing to review; above
  it, no agent would attempt the naive arm and the pair stops being comparable);
- base and head SHAs resolvable, pinned in
  [`benchmarks/pr-context/dataset.json`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/main/benchmarks/pr-context/dataset.json).

A further {{ site.data.pr_context_bench.skipped_count }} PRs were mined but
excluded at run time because the diff touched no indexed symbol at all —
documentation, lockfiles, CI config. Including them would have inflated the
headline: the trace-mcp arm for such a PR is nothing but the diff, so the
"saving" would be an artifact of there being no code to load.

### Reproducing it

```bash
git clone https://github.com/nikolai-vysotskyi/trace-mcp && cd trace-mcp
pnpm install
npx tsx scripts/bench-pr-context.ts        # writes benchmarks/pr-context/results.json
```

The script clones each upstream repo into `node_modules/.cache/pr-context/`,
checks out the pinned SHA, indexes it, and writes every per-PR row alongside
the aggregates. Every number on this page is rendered from
`docs/_data/pr_context_bench.json`, which that script generates — none of them
is typed by hand.

## Where trace-mcp did not pay off

A benchmark without this section is marketing. On this dataset
**{{ site.data.pr_context_bench.loss_count }} of {{ site.data.pr_context_bench.pr_count }} PRs**
were cases where the index barely earned its keep:

| PR | files | changed symbols | naive | trace-mcp | saved |
|---|---:|---:|---:|---:|---:|
{% for l in site.data.pr_context_bench.losses -%}
| [{{ l.url | split: "/" | slice: -3, 3 | join: "/" }}]({{ l.url }}) | {{ l.changed_files }} | {{ l.changed_symbols }} | {{ l.baseline_tokens }} | {{ l.trace_tokens }} | {{ l.savings_pct }}% |
{% endfor %}

They share a shape: a small change to one or two small files. When the whole
file is 200 lines, loading it outright is already cheap, and the symbol bodies
plus the callers and the impact list come to more than the files themselves —
which is why 13 of these rows are negative, not merely small. `got#2379` is the
extreme at {{ site.data.pr_context_bench.losses[0].savings_pct }}%: the assembled
context costs more than twice what reading both files would.
**If your repository is small, or your PRs touch only small files, this index
does not solve a problem you have.** The saving scales with how much of a file
a reviewer does not need.

Two further limits worth stating plainly:

- **The truncation failure mode fires on most of this dataset.** The trace-mcp
  arm is capped at an 8,000-token context bundle, and changed-symbol
  readability is {{ site.data.pr_context_bench.trace_changed_symbol_readable }}
  against the naive arm's
  {{ site.data.pr_context_bench.baseline_changed_symbol_readable }} — a third of
  changed symbols arrive without their bodies, 117 of 338 across the corpus.
  This page said the opposite until 2026-09-07, because the metric counted
  whether the bundle *listed* a symbol rather than whether it carried the body;
  it now scores `detail === 'full'`. That miss is registered against the
  [preregistered quality floor]({{ '/perf/prereg-pr-context/' | relative_url }}),
  which the bar does not move for. The token figure is unaffected — it was
  always counted on the assembled text.
- **The coverage gap is what buys the saving.** Of those 117, **88 are budget
  truncation**. Re-running the same corpus at larger bundle budgets trades one
  for the other, monotonically: 8,000 → 221 of 338 bodies at
  {{ site.data.pr_context_bench.median_savings_pct }}% saved; 16,000 → 245 at
  29.7%; 32,000 → 281 at **−0.4%**; 64,000 → 309 at **−5.8%**. The saving
  crosses zero while 57 bodies are still missing, so on this dataset there is no
  budget that buys full changed-symbol coverage *and* a token win — the honest
  way to read the headline is "a third of the changed bodies is the price of the
  {{ site.data.pr_context_bench.median_savings_pct }}%". 29 bodies never arrive
  at any budget; those are a defect, not a tradeoff, and are open. Per-symbol
  counts:
  [`benchmarks/pr-context/symbol-detail.json`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/master/benchmarks/pr-context/symbol-detail.json).
- **Call-site coverage is structural, not semantic.** "Readable" means the
  symbol's body is in the context; "located" means it is named with its file
  and line. It does not mean a model used it correctly.
- **"Readable" counted pointers, not bodies — until 2026-09-07.** The metric
  recorded a span whenever the bundle listed a symbol and never checked that the
  body arrived, which is how it read 100% through a three-month stretch in which
  the benchmark's trace arm carried no source code at all. It now scores the
  bundle's own `detail` field, and every coverage figure on this page is the
  first measured under that definition. The
  [diagnosis]({{ '/perf/pr-context-loss-classes/' | relative_url }}) has the
  account of the original defect.

## Does the thinner context produce a worse review?

That question used to live in a "what this does not measure" section. It is
measured now, and the answer is **no, within the bar that was set for it**: on
the same pull requests, the review written from trace-mcp's context understood
the change as often as the review written from the full files
({{ site.data.pr_context_quality.trace_understood }} against
{{ site.data.pr_context_quality.baseline_understood }} — the sign is in our
favour, which {{ site.data.pr_context_bench.pr_count }} pull requests cannot
make significant, so read it as parity),
and asserted +0.22 more false positives per PR. The
[preregistered bar]({{ '/perf/prereg-pr-quality/' | relative_url }}) — no more
than a 10 point drop in comprehension and no more than +0.5 false positives per
PR — was written before the calls were made, and this run **meets both**.

**This is the second run under that preregistration.** The first published a 15
point loss and is struck: its trace arm carried no source code, because
`get_context_bundle` read symbol bodies through a bare `require('node:fs')` that
throws under ESM into a silent catch. The bars did not move, the corpus did not
move, and the [diagnosis]({{ '/perf/pr-context-loss-classes/' | relative_url }})
is published alongside. The naive arm scored the same 65% in both runs, which is
the control the correction rests on.

The method: the same {{ site.data.pr_context_quality.pr_count }} pull requests
and the same two assembled contexts — byte-for-byte the prompts counted above,
dumped to disk by the token run — each sent to
`{{ site.data.pr_context_quality.model }}` at identical settings, with the two
resulting reviews handed to a judge together with the PR's own diff as ground
truth, blind and in randomised order.

| | naive file loading | trace-mcp |
|---|---:|---:|
| understood the change | {{ site.data.pr_context_quality.baseline_understood }} | {{ site.data.pr_context_quality.trace_understood }} |
| false positives per PR | {{ site.data.pr_context_quality.baseline_false_positives }} | {{ site.data.pr_context_quality.trace_false_positives }} |
| findings claimed per PR | {{ site.data.pr_context_quality.baseline_findings }} | {{ site.data.pr_context_quality.trace_findings }} |
| review latency, median | {{ site.data.pr_context_quality.baseline_median_latency_s }} s | **{{ site.data.pr_context_quality.trace_median_latency_s }} s** |

Per-PR agreement: both arms understood the change on
{{ site.data.pr_context_quality.both_understood }} PRs, only the naive arm on
{{ site.data.pr_context_quality.baseline_only }}, only trace-mcp on
{{ site.data.pr_context_quality.trace_only }}, neither on
{{ site.data.pr_context_quality.neither }}.

Latency is level: {{ site.data.pr_context_quality.trace_median_latency_s }} s
against {{ site.data.pr_context_quality.baseline_median_latency_s }} s. The
saving is in input tokens, not in wall clock — the struck run's 17% latency win
was the speed of a context with the code taken out of it.

So the honest reading is: **trace-mcp's review context costs about 30% of the
tokens and the review written from it is not measurably worse on this corpus.**
What that does *not* say is that it is better, or that it holds on harder pull
requests — the corpus is merged bug-fix PRs where the defect is visible in the
diff, which flatters both arms (see below). Every review and every judgement is
committed in
[`benchmarks/pr-context/quality.json`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/main/benchmarks/pr-context/quality.json),
so the scoring is auditable rather than asserted.

```bash
npx tsx scripts/bench-pr-context.ts --dump-prompts benchmarks/pr-context/prompts
npx tsx scripts/bench-pr-quality.ts        # writes benchmarks/pr-context/quality.json
```

### What this still does not measure

- **The ground truth is weak, and that flatters both arms.** These are merged
  bug-fix PRs, so the defect is visible in the diff itself. "Understood the
  change" is a comprehension question, not a bug-discovery one — a careful
  reader can score it from the diff alone, which compresses the gap between the
  arms. Separating them properly needs a harder corpus: pull requests followed
  by a revert or an explicit regression fix, where a reviewer *should* have
  caught something and did not. That is a different dataset and a different
  run; this one keeps the pinned set so the quality rows sit on the same PRs as
  the token rows.
- **The judge is a model**, and `false_positives` in particular is a judgement
  call rather than a fact. It is reported because a cheap context that produces
  confident nonsense is not a win, and a number that can be audited beats an
  assurance that it does not happen.
- **Latency is model latency**, not end-to-end review time; it excludes the
  index build (a median
  {{ site.data.pr_context_bench.median_index_ms }} ms per PR, amortised) and
  any harness overhead.
- **Call-site coverage is still structural.** "Readable" means the symbol's
  body is in the context. The quality arm now says something about whether a
  model used that context well; it does not attribute that to any single row of
  the coverage table.

For the levers that produce the token difference — presets, compact schemas and
the TOON encoding — see
[cutting Claude Code token usage](reduce-claude-code-token-usage.md).

## See also

- [TOON output format — measured token savings](toon-savings.html)
- [Cut Claude Code token usage](reduce-claude-code-token-usage.html)
- [Tools reference](tools-reference.html)
