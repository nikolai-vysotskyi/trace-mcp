---
title: "CodeGraph MCP Alternative: trace-mcp vs codegraph for AI coding agents"
description: "codegraph ships one orientation tool; trace-mcp ships a broad graph with refactoring, security and memory. Head-to-head on tools, coverage, benchmarks."
updated: 2026-09-04
---

# CodeGraph MCP alternative: trace-mcp vs codegraph

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vs/codegraph.html",
      "datePublished": "2026-08-29",
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
        "@id": "https://trace-mcp.com/vs/codegraph.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the core difference between codegraph and trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "codegraph defines eight MCP tools and advertises exactly one of them by default — codegraph_explore — on the stated reasoning that every other tool is a narrower slice of it and that offering more tools makes agents mis-pick. trace-mcp advertises 28 tools on its default preset and keeps the rest one load_tools call away. codegraph optimises for one job done in one call; trace-mcp optimises for breadth, with refactoring, security scanning and code-linked memory alongside navigation."
          }
        },
        {
          "@type": "Question",
          "name": "Does codegraph have a smaller tool surface than trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, substantially. codegraph lists a single tool to the agent by default; trace-mcp lists 28 on its shipped default preset, roughly 11.6K tokens of tools/list plus server instructions. That is a real cost we pay every session and codegraph does not. What you get for it is a much wider set of operations that are addressable without an env-var opt-in."
          }
        },
        {
          "@type": "Question",
          "name": "Can codegraph do refactoring or security scanning?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. Reading codegraph's source on August 29, 2026 turned up no rename, move or codemod tooling, no taint analysis or security rules, no control-flow graph, no SARIF output and no cross-session memory. It is a navigation and discovery tool by design, and its README scopes it that way. trace-mcp ships all of those."
          }
        },
        {
          "@type": "Question",
          "name": "Whose token-savings numbers are better supported?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Both projects publish one. codegraph's is an A/B across seven repositories with the model, the queries and the run count named, plus a documented correction of an earlier flaw in its own harness: 62% fewer tokens and 44% lower cost on average. trace-mcp's is the PR review context benchmark, a median {{ site.data.pr_context_bench.median_savings_pct }}% input-token reduction across {{ site.data.pr_context_bench.pr_count }} merged pull requests in {{ site.data.pr_context_bench.repo_count }} open-source repositories nobody on the project maintains, shipping the base and head SHAs, the cases where it lost, and the single command that re-runs it. Both are run on open-source code the benchmarking project does not maintain, and both are self-run rather than third-party reproduced. codegraph's covers a broader slice of session work; trace-mcp's ships the exact revisions and the cases where it lost."
          }
        },
        {
          "@type": "Question",
          "name": "Do either of them send code to a cloud service?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. Both index locally into SQLite, need no API key and no external service, and persist the graph across restarts. On this axis they are the same, and both differ from RAG-over-your-repo products that upload embeddings."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** codegraph is the largest project in this field by stars, and it made one design decision that is worth understanding before you compare anything else: it defines eight MCP tools and **advertises exactly one of them**. Everything an agent can ask it goes through `codegraph_explore`. The reasoning, stated in its own source, is that the other seven are narrower slices of `explore` and that the mere presence of a tool steers agents into mis-picking it.

trace-mcp bets the other way. It advertises 28 tools on its default preset — navigation, impact analysis, refactoring, security scanning, code-linked memory — because those are genuinely different operations, not slices of one.

Pick codegraph if the job is *orient an agent in a repository it has never seen*, and you want that to cost almost nothing in advertised schema. Pick trace-mcp if the job continues after orientation.

## Head-to-head

| Capability | trace-mcp | codegraph |
|---|:---:|:---:|
| **GitHub stars** | {{ site.data.competitors.trace_mcp.stars }} | {{ site.data.competitors.codegraph.stars }} |
| License | MIT | MIT |
| Languages | {{ site.data.counts.languages }} (tree-sitter) | 34 (tree-sitter, Rust kernel + WASM fallback) |
| Framework integrations | ✓ {{ site.data.counts.frameworks }} | ✓ 17 (route → handler) |
| Framework edges beyond routing | ✓ controller → template, model → table, component → component | partial — route → handler, plus React Native `component`/`property` nodes |
| Cross-language edges | ✓ | ✓ Swift ↔ ObjC, RN bridge / TurboModules / Expo / Fabric |
| MCP tools defined | {{ site.data.counts.tools }} | 8 |
| MCP tools advertised by default | 28 (~11.6K tok) | **1** (`codegraph_explore`) |
| Rest of the surface reachable | ✓ `load_tools`, one call | ✓ `CODEGRAPH_MCP_TOOLS` env allowlist, restart |
| Persistent graph across restarts | ✓ SQLite + FTS5 | ✓ SQLite |
| Runs fully local, no API key | ✓ | ✓ |
| Incremental re-index on save | ✓ | ✓ debounced file watcher |
| Impact analysis | ✓ reverse traversal + decorator filter | ✓ `codegraph_impact` (behind the allowlist) |
| Refactoring tools | ✓ rename, move, signature, AST codemod, extract | ✗ |
| Security scanning | ✓ OWASP Top-10, type-aware taint | ✗ |
| Control-flow / data-flow | ✓ CFG with basic blocks and loop back-edges | ✗ |
| SARIF / CI output | ✓ 2.1.0, schema-validated | ✗ |
| Session memory | ✓ code-linked decision graph | ✗ |
| Multi-repo | ✓ cross-repo API linking into one graph | partial — queries other separately-indexed projects by path |
| Graph visualization | ✓ desktop app | ✗ |
| Published A/B token benchmark | ✗ per-repo `get_real_savings` instead | ✓ 7 repos, methodology disclosed |
| Written in | TypeScript | TypeScript + Rust kernel |

Verified on August 29, 2026 against codegraph's source and README at commit `6a056ec` — the `main` head, shipped after the `v1.6.0` tag. Tool-surface claims come from the source; language, framework and bridging counts come from the README's own tables, which the source directory layout corroborates.

## When to pick codegraph

- **Your agent's expensive problem is orientation, not editing.** codegraph's own benchmark shows its largest wins exactly where an agent would otherwise burn a big slice of budget on find/grep/read before touching the right file — 2 tool calls against 28 on VS Code, 2 against 43 on Excalidraw, zero file reads in both. If most of your sessions are "understand this unfamiliar codebase", that is the shape of win you are buying.
- **You want the cheapest possible advertised surface.** One tool. Nothing else is listed to the model at all. Our 28-tool default is real money next to that, paid on every session by every client that does not defer tool loading.
- **You want a published benchmark you can argue with.** codegraph reports 88% fewer tool calls, 62% fewer tokens, 44% lower cost and 53% faster across seven repositories, and it discloses the model, the queries, four runs per arm, and a correction to an earlier version of its own harness that had let the control arm reach CodeGraph through the shell. It is self-run, not independently reproduced — but it is the most transparent self-benchmark in this field, and it is more than we publish.
- **Indexing speed on very large trees matters.** A native Rust extraction kernel with per-language tree-sitter grammars, a WASM fallback for unbuilt platforms, and cgroup-aware resource scaling for small VPS boxes is a different engineering investment than a TypeScript-only parser, and their reported numbers on the Swift compiler and the Linux kernel reflect it.
- **Popularity.** codegraph is roughly 670× larger by stars, with the community answers and integrations that follow from that.

## When to pick trace-mcp

- **The job goes past navigation.** Rename across a repo, move a symbol with its imports, an AST codemod, a taint scan with type-aware pruning, quality gates, SARIF for CI, dead-code removal. codegraph has none of these, by design and by its own README's scope.
- **The edges you care about are framework edges beyond routing.** codegraph links URL patterns to their handlers across 17 frameworks, and does it well; its React Native work also emits `component` and `property` nodes. It does not model controller → template or model → table. trace-mcp's {{ site.data.counts.frameworks }} integrations do, and traverses them.
- **Your stack is polyglot.** {{ site.data.counts.languages }} grammars against 34.
- **You want memory that outlives the session and is tied to code.** trace-mcp's decisions link to symbol IDs, are verified as non-stale before recall, and surface inside `get_change_impact`. codegraph has no session memory at all.
- **You want the other tools without an env var and a restart.** codegraph's seven unlisted tools are fully implemented and re-enablable through `CODEGRAPH_MCP_TOOLS`; that is a config change, not something the agent can decide mid-task. trace-mcp's deferred surface is one `load_tools` call away inside the session.

## Where we are not being smug

Four honest points.

**Their default surface is cheaper than ours and it is not close.** One advertised tool against our 28 and ~11.6K tokens. Our number is down from ~50K after the preset bypass on the daemon path was fixed and the default preset moved to `minimal`, and everything outside it is one call away — but "much better than we were" is not "as cheap as theirs."

**Their benchmark covers more of the job than ours does.** Both projects now publish an A/B across named repositories with a disclosed harness — theirs across seven repos and a broad slice of session work, ours the [PR review context benchmark](/pr-context-benchmark.html): a median {{ site.data.pr_context_bench.median_savings_pct }}% input-token reduction over {{ site.data.pr_context_bench.pr_count }} merged pull requests in {{ site.data.pr_context_bench.repo_count }} repositories nobody here maintains, with the losing cases and the re-run command shipped in the repo. Theirs covers the wider workload; ours publishes the revisions it ran on and the five cases where it lost. Both run on repositories their authors do not maintain — that is not a point of difference, and this page said otherwise until September 5, 2026. One task type measured well is not the same as a general claim, and our headline 40-50% for everything else is still an aggregate from our own usage rather than a benchmark.

**They publish their own downside, so we will repeat it rather than quietly use it.** codegraph's README states that its responses leave roughly 80% more retrieval context resident at the end of a multi-turn session than a file-reading agent's do — 67K tokens against 18K on VS Code. That is a genuine cost of returning rich graph answers, it is a cost trace-mcp pays in its own form, and the fact that they printed it is a point in their favour.

**Our security scanning has a ceiling, and it is stated on the [comparisons page](/comparisons.html) rather than only here.** The control-flow graph is line-based, not AST-based, and taint analysis is lexical/regex, not a real dataflow engine. Type-aware pruning cuts false positives; it does not turn this into a dataflow analyser. A full AST/dataflow rewrite is out of scope for now.

If you maintain codegraph and something here is wrong, [open an issue](https://github.com/nikolai-vysotskyi/trace-mcp/issues) and we will fix it.

## FAQ

**What is the core difference between codegraph and trace-mcp?**
codegraph defines eight tools and advertises one, on the reasoning that the rest are narrower slices of `explore` and that presence itself steers mis-picks. trace-mcp advertises 28 and keeps ~140 more one `load_tools` call away, because refactoring, security scanning and memory are not slices of navigation.

**Does codegraph have a smaller tool surface than trace-mcp?**
Yes, substantially — one advertised tool against 28 and ~11.6K tokens. That is a cost we pay every session and they do not. What it buys is a much wider set of operations addressable without an env-var opt-in and a restart.

**Can codegraph do refactoring or security scanning?**
No. Reading its source on August 29, 2026 found no rename/move/codemod, no taint analysis, no control-flow graph, no SARIF and no cross-session memory. It is a navigation and discovery tool, and scopes itself that way.

**Whose token-savings numbers are better supported?**
Both publish one. Theirs: seven repositories, model and queries named, four runs per arm, a documented fix to a flaw in their own earlier harness — 62% fewer tokens, 44% lower cost. Ours: the [PR review context benchmark](/pr-context-benchmark.html), a median {{ site.data.pr_context_bench.median_savings_pct }}% input-token reduction across {{ site.data.pr_context_bench.pr_count }} merged pull requests in {{ site.data.pr_context_bench.repo_count }} repositories we do not maintain, with base and head SHAs, the five cases where it lost, and one command to re-run it. Theirs covers more of a session; ours is the more auditable. Both run on code their authors do not maintain, and neither is third-party reproduced.

**Do either of them send code to a cloud service?**
No. Both index locally into SQLite, need no API key, and survive restarts.

## Next steps

- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs Repomix](/vs/repomix.html) · [vs Serena](/vs/serena.html) · [vs codebase-memory-mcp](/vs/codebase-memory-mcp.html) · [vs Context Mode](/vs/context-mode.html)
- Comparing codegraph against something other than us: [Repomix vs codegraph](/vs/repomix-vs-codegraph.html) — indexing against packing, on their own terms.
- [Architecture](/architecture.html) — how the indexing pipeline, storage and LSP enrichment fit together.
- [Get started](/#install) — no configuration required.
