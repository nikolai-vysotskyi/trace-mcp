---
title: "code-review-graph Alternative: trace-mcp vs code-review-graph"
description: "code-review-graph builds an incremental SQLite graph; trace-mcp adds framework awareness, refactoring, security and memory. Head-to-head comparison."
updated: 2026-09-06
---

# code-review-graph alternative: trace-mcp vs code-review-graph

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vs/code-review-graph.html",
      "datePublished": "2026-09-06",
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
        "@id": "https://trace-mcp.com/vs/code-review-graph.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the core difference between code-review-graph and trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Both projects parse code with tree-sitter into an incremental SQLite knowledge graph so agents can query dependencies instead of re-reading raw files. code-review-graph focuses on code review navigation and blast-radius reporting in CI, pairing it with an uncertainty contract that explains why empty results occur. trace-mcp builds a deeper graph with framework semantics across {{ site.data.counts.frameworks }} integrations, active refactoring, security scanning, and code-linked session memory."
          }
        },
        {
          "@type": "Question",
          "name": "What is code-review-graph's empty-result uncertainty mechanism?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Its uncertainty module treats an empty result as an answer that owes the caller a reason. Under a hard 140-character cap, it explains whether a zero result is genuine or the result of a known parser gap or unindexed dependency. This prevents agents from drawing false conclusions or falling back to costly whole-repository file scans."
          }
        },
        {
          "@type": "Question",
          "name": "How do their advertised tool surfaces compare in token cost?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "code-review-graph registers 29 MCP tools and advertises all 29 by default, costing roughly 8K tokens of descriptions alone every turn, trimmable only via manual allowlists. trace-mcp advertises 28 tools on its minimal preset costing roughly 11.6K tokens including instructions, and keeps ~140 additional tools reachable dynamically via load_tools without requiring an allowlist restart."
          }
        },
        {
          "@type": "Question",
          "name": "Can code-review-graph refactor code or run security scans?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. Reading code-review-graph's source at commit b58668751ab0 confirmed it is read-only navigation and blast-radius analysis. It provides no rename, move, signature update, or AST codemods, and no OWASP taint analysis or SARIF reporting. trace-mcp ships full refactoring tools and OASIS SARIF 2.1.0 security scanning."
          }
        },
        {
          "@type": "Question",
          "name": "Which languages and frameworks do they support?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "code-review-graph supports 23 languages plus Jupyter notebooks via tree-sitter-language-pack, but has no framework awareness beyond Python entry points. trace-mcp parses {{ site.data.counts.languages }} languages and understands {{ site.data.counts.frameworks }} framework integrations, resolving route-to-handler, controller-to-template, and model-to-table edges."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** [code-review-graph](https://github.com/tirth8205/code-review-graph) (tirth8205/code-review-graph, {{ site.data.competitors.code_review_graph.stars }} stars, Python, MIT) and trace-mcp share the same core architectural premise: parse code with tree-sitter into an incremental, persistent SQLite knowledge graph and serve it to AI coding agents over MCP, instead of letting agents burn context on raw file reads. Both provide cross-file symbol lookup, bidirectional call graphs, reverse-dependency impact analysis, and multi-repo support.

The split is between code review triage and comprehensive codebase intelligence. code-review-graph is designed for review exploration and CI blast-radius checks, with an elegant uncertainty contract that explains why empty results occur. trace-mcp goes deeper into repository semantics with {{ site.data.counts.frameworks }} framework integrations, active refactoring, OWASP security scanning, and session memory that binds architectural decisions to code.

## Head-to-head

| Capability | trace-mcp | code-review-graph |
|---|:---:|:---:|
| **GitHub stars** | {{ site.data.competitors.trace_mcp.stars }} | {{ site.data.competitors.code_review_graph.stars }} |
| License | MIT | MIT |
| Written in | TypeScript | Python |
| Current release | v3.22.0 | v2.3.8 |
| Languages | {{ site.data.counts.languages }} | 23 + Jupyter notebooks |
| Framework integrations | ✓ {{ site.data.counts.frameworks }} integrations | ✗ (Python entry points only) |
| Persistent graph storage | ✓ SQLite + FTS5 | ✓ SQLite (`nodes` / `edges` / `metadata`) |
| Edge confidence model | ✓ 5 resolution tiers (`scip_resolved` > `lsp_resolved` > `ast_resolved` > `ast_inferred` > `text_matched`) | 2 tiers (`EXTRACTED` / `INFERRED`) |
| Empty-result reasoning | ✗ derived from edge tier (cap in progress) | ✓ `uncertainty.py` (≤140 chars per empty result) |
| Impact analysis / blast radius | ✓ reverse dependency traversal + decorator filter | ✓ blast-radius + Leiden communities (`igraph`/`networkx`) |
| Call graph | ✓ bidirectional | ✓ graph-based |
| Refactoring tools | ✓ rename, move, signature, AST codemod, dead code | ✗ |
| Security scanning | ✓ OWASP Top-10, type-aware taint, SARIF 2.1.0 | ✗ |
| Control-flow / data-flow | ✓ CFG with basic blocks, loop back-edges | ✗ |
| Session memory | ✓ code-linked decision graph, staleness-verified | ✗ |
| Compiler-grade precision path | ✓ opt-in LSP + offline SCIP ingestion | ✗ |
| Multi-repo support | ✓ cross-repo API linking | ✓ multi-repo daemon |
| CI / PR blast-radius Action | ✓ quality gates + SARIF | ✓ turnkey blast-radius GitHub Action |
| Graph visualization | ✓ desktop app (cosmos.gl) | ✗ |
| MCP tools advertised (default) | 28 (`minimal`, ~11.6K tok); {{ site.data.counts.tools }} on `full` | 29 advertised (~8K description tokens) |
| Tool surface trimming | ✓ dynamic `load_tools` in session; 3 presets | manual allowlist (`serve --tools`, `CRG_TOOLS=`) |

Verified on September 2, 2026 against code-review-graph's source at commit `b58668751ab0` (v2.3.8). Tool registrations, parser dependencies, and graph architecture claims come directly from the source; star count from the GitHub API.

## What code-review-graph actually is, from its source

Cloning the repository at commit `b58668751ab0` and reading `pyproject.toml`, `code_review_graph/graph.py`, `main.py`, `uncertainty.py`, `scoped_resolver.py`, and `parser.py` surfaced four details worth understanding beyond the README.

**Empty results as first-class answers.** The clearest idea in code-review-graph is `uncertainty.py`. When a graph query returns `result_count: 0`, the agent does not know whether the symbol truly has no callers or whether the target was never indexed, the language has a static-analysis blind spot, or the graph is behind the working tree. A confused agent either assumes the relationship does not exist or abandons the tool and runs expensive brute-force scans. `uncertainty.py` attaches an explanation under a strict `MAX_CONFIDENCE_CHARS = 140` budget when the result set is empty, while keeping normal non-empty results byte-identical. Blind spots are maintained in a `LanguageGap` table pairing language sets with query patterns, so call-resolution caveats land on call graphs and never on file summaries.

**Conventional SQLite storage with string keys.** The storage model is a single SQLite file containing `nodes`, `edges`, and `metadata` tables. Edge endpoints are stored as qualified-name strings rather than integer IDs. AST parsing uses `tree-sitter-language-pack`, traversal runs through `networkx`, and `igraph` is an optional extra for calculating Leiden communities.

**Advertised tool cost.** `code_review_graph/main.py` registers 29 `@mcp.tool()` handlers and advertises all 29 to the client by default. Its own docstrings estimate this at "~8k description tokens per LLM turn". Trimming the surface requires setting the `CRG_TOOLS=` environment variable or launching with `serve --tools ...`. There is no preset hierarchy and no mechanism for an agent to load deferred tools mid-session.

**Headline claims.** Its README claims a ~65× median per-question reduction across six repositories (36×–376×), measured against a whole-corpus baseline that the README itself concedes "no real agent pays".

## When to pick code-review-graph

- **You value empty-result explanations.** When a query returns zero results, code-review-graph explicitly tells the model *why* under a 140-character cap rather than returning an ambiguous empty list, preventing the model from hallucinating or falling back to grep.
- **Turnkey GitHub Action for pull request reviews.** It ships a ready-made blast-radius GitHub Action designed to comment impact summaries directly on PRs in CI.
- **You work with Jupyter notebooks.** It parses `.ipynb` notebooks alongside 23 traditional programming languages.
- **Leiden community detection.** It uses `igraph` to partition codebases into functional clusters, which helps with architectural understanding.
- **Multi-repo background daemon.** It includes a dedicated daemon architecture designed to serve multi-repo environments.
- **Established adoption.** At {{ site.data.competitors.code_review_graph.stars }} stars, it has an active user base and broad community awareness.

## When to pick trace-mcp

- **Framework semantics.** A graph that knows functions and files but not that a route links to a handler or an ORM model backs a table misses what developers actually care about. trace-mcp models those connections across {{ site.data.counts.frameworks }} framework integrations.
- **Active refactoring.** Code modification goes beyond reading. trace-mcp provides cross-file rename with import updates, symbol and file moves, signature modifications, AST-based codemods (`@ast-grep/napi`), and dead-code removal. code-review-graph is strictly read-only.
- **Security scanning and quality gates.** trace-mcp includes OWASP Top-10 rules, type-aware taint analysis, control-flow graphs with loop back-edges, and OASIS SARIF 2.1.0 output for CI quality gates.
- **Code-linked session memory.** Architectural decisions and rationale persist across agent sessions bound to symbol IDs, verified against code staleness before recall, and surfaced in impact analysis. code-review-graph has no session memory.
- **Language breadth and compiler-grade precision.** trace-mcp parses {{ site.data.counts.languages }} languages via tree-sitter, and offers an opt-in path for live LSP and offline SCIP index ingestion to raise edge resolution to compiler-grade tiers.
- **Dynamic tool surface.** trace-mcp's default `minimal` preset advertises 28 tools (~11.6K tokens total), keeping ~140 additional tools one `load_tools` call away in-session without server restarts.

## Where we are not being smug

Four honest points where code-review-graph leads or sets a standard.

**Empty-result honesty is a genuine design win we did not think of first.** Treating zero-results with respect by spending ~30 tokens of explanation prevents thousands of tokens of wasted manual file searching. We acknowledged this in our profiling pass and plan to adopt empty-result confidence markers derived from edge resolution tiers.

**Their CI GitHub Action is more turnkey than our quality gates.** They provide an out-of-the-box GitHub Action for blast-radius reporting on pull requests; our CI integration requires running trace-mcp quality gates or ingesting SARIF payloads.

**Our security scanning has a ceiling, and it is stated on the [comparisons page](/comparisons.html) rather than only here.** The control-flow graph is line-based, not AST-based, and taint analysis is lexical/regex, not a full dataflow engine. Type-aware pruning cuts false positives; it does not turn this into a full static application security testing platform.

**Their popularity is roughly 300 times ours.** At {{ site.data.competitors.code_review_graph.stars }} stars, code-review-graph is a proven tool in many workflows, and we do not dismiss that difference.

If you maintain code-review-graph and something here is inaccurate, [open an issue](https://github.com/nikolai-vysotskyi/trace-mcp/issues) and we will correct it.

## FAQ

**What is the core difference between code-review-graph and trace-mcp?**
Both projects parse code with tree-sitter into an incremental SQLite knowledge graph so agents can query dependencies instead of re-reading raw files. code-review-graph focuses on code review navigation and blast-radius reporting in CI, pairing it with an uncertainty contract that explains why empty results occur. trace-mcp builds a deeper graph with framework semantics across {{ site.data.counts.frameworks }} integrations, active refactoring, security scanning, and code-linked session memory.

**What is code-review-graph's empty-result uncertainty mechanism?**
Its uncertainty module treats an empty result as an answer that owes the caller a reason. Under a hard 140-character cap, it explains whether a zero result is genuine or the result of a known parser gap or unindexed dependency. This prevents agents from drawing false conclusions or falling back to costly whole-repository file scans.

**How do their advertised tool surfaces compare in token cost?**
code-review-graph registers 29 MCP tools and advertises all 29 by default, costing roughly 8K tokens of descriptions alone every turn, trimmable only via manual allowlists. trace-mcp advertises 28 tools on its minimal preset costing roughly 11.6K tokens including instructions, and keeps ~140 additional tools reachable dynamically via `load_tools` without requiring an allowlist restart.

**Can code-review-graph refactor code or run security scans?**
No. Reading code-review-graph's source at commit `b58668751ab0` confirmed it is read-only navigation and blast-radius analysis. It provides no rename, move, signature update, or AST codemods, and no OWASP taint analysis or SARIF reporting. trace-mcp ships full refactoring tools and OASIS SARIF 2.1.0 security scanning.

**Which languages and frameworks do they support?**
code-review-graph supports 23 languages plus Jupyter notebooks via tree-sitter-language-pack, but has no framework awareness beyond Python entry points. trace-mcp parses {{ site.data.counts.languages }} languages and understands {{ site.data.counts.frameworks }} framework integrations, resolving route-to-handler, controller-to-template, and model-to-table edges.

## Next steps

- Learn how a persistent code graph reduces token costs on every turn: [Code graph MCP server](/code-graph-mcp.html).
- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs Repomix](/vs/repomix.html) · [vs Serena](/vs/serena.html) · [vs codebase-memory-mcp](/vs/codebase-memory-mcp.html) · [vs codegraph](/vs/codegraph.html) · [vs CodeGraphContext](/vs/codegraphcontext.html) · [vs SocratiCode](/vs/socraticode.html) · [vs jCodeMunch](/vs/jcodemunch.html) · [vs TokenSave](/vs/tokensave.html) · [vs Context Mode](/vs/context-mode.html)
- [PR review context benchmark](/pr-context-benchmark.html) — measured input-token cost of code-review context on 60 merged pull requests.
- [Architecture](/architecture.html) — how the indexing pipeline, storage and LSP enrichment fit together.
- [Get started](/#install) — no configuration required.
