---
title: "PR Review Context Benchmark — Measured Input-Token Cost on Real Pull Requests"
description: "Reproducible measurement of the input tokens trace-mcp context saves over naive file loading when reviewing real merged pull requests in open-source repos."
updated: 2026-09-02
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
loading the diff plus every file it touches — while making *more* of the code
the change can break visible, not less.

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
plus the impact list come to nearly the same size. `got#2379` is the extreme —
{{ site.data.pr_context_bench.losses[0].savings_pct }}% saved, which is noise.
**If your repository is small, or your PRs touch only small files, this index
does not solve a problem you have.** The saving scales with how much of a file
a reviewer does not need.

Two further limits worth stating plainly:

- **The truncation failure mode did not fire here.** The trace-mcp arm is
  capped at an 8,000-token context bundle; on this dataset no PR was large
  enough for that cap to drop a changed symbol, so changed-symbol readability
  is {{ site.data.pr_context_bench.trace_changed_symbol_readable }} in both
  arms. On a substantially larger PR it would bite, and the benchmark reports
  it as a `truncated` loss when it does. We have not measured that regime.
- **Call-site coverage is structural, not semantic.** "Readable" means the
  symbol's body is in the context; "located" means it is named with its file
  and line. It does not mean a model used it correctly.

## What this does not measure

**Review quality is not measured here.** The metrics on this page are
structural coverage of the code a reviewer needs, not an LLM's judgement about
whether it found the bug. Measuring that requires running a model over both
arms on all {{ site.data.pr_context_bench.pr_count }} PRs and scoring the
findings, which is a separate, paid experiment.

So the honest reading of this page is narrow and it is deliberately narrow:
**for the same review task on the same PRs, trace-mcp's context costs about a
tenth of the tokens and puts strictly more of the affected call graph in front
of the reviewer.** Whether that translates into catching more bugs is an open
question, and this benchmark is the harness a future run would extend to answer
it. For the levers that produce that difference — presets, compact schemas and
the TOON encoding — see [cutting Claude Code token usage](reduce-claude-code-token-usage.md).

## See also

- [TOON output format — measured token savings](toon-savings.html)
- [Cut Claude Code token usage](reduce-claude-code-token-usage.html)
- [Tools reference](tools-reference.html)
