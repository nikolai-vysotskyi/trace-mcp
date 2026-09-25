---
title: "ast-grep Alternative: trace-mcp vs ast-grep for AI code context"
description: "ast-grep finds code by AST pattern; trace-mcp indexes it into a queryable graph. Search, rewriting, impact analysis, MCP use compared."
updated: 2026-09-26
---

# ast-grep alternative: trace-mcp vs ast-grep

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vs/ast-grep.html",
      "datePublished": "2026-09-26",
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
        "@id": "https://trace-mcp.com/vs/ast-grep.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the core difference between ast-grep and trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "ast-grep is a CLI for structural search, lint and rewriting: you write a code pattern with $METAVAR wildcards and it finds or rewrites every AST node with that shape. trace-mcp is a persistent code graph served over MCP: it precomputes symbols, imports, call edges and framework edges into SQLite, and an agent queries them turn after turn. Pattern matching versus a queryable index."
          }
        },
        {
          "@type": "Question",
          "name": "Can ast-grep do impact analysis or find callers?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Not as a graph traversal. ast-grep matches structural patterns per file, so 'every place shaped like this call' is a search. 'Everything transitively affected by changing this function' needs resolved call edges across files, which is what trace-mcp stores. You can approximate callers with a pattern for the callee name, but overloads, re-exports and dynamic dispatch defeat a pattern."
          }
        },
        {
          "@type": "Question",
          "name": "Does ast-grep have an MCP server?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Not in its README as read on September 26, 2026. ast-grep ships as a CLI (npm, pip, cargo, brew, scoop, MacPorts) with YAML rule configuration and an online playground. An agent uses it by shelling out, not by calling MCP tools."
          }
        },
        {
          "@type": "Question",
          "name": "Which is better for large-scale codemods?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "ast-grep, for pattern-shaped rewrites: its pattern syntax is isomorphic to the code it matches, its YAML rules double as lint, and the Rust core uses multiple cores. trace-mcp's codemod path is graph-driven (rename, move, signature change with import rewriting and syntax verification) — stronger when the rewrite follows edges rather than shapes."
          }
        },
        {
          "@type": "Question",
          "name": "Can I use both?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. Use ast-grep for structural search and pattern rewrites in CI and scripts, and trace-mcp as the agent's live index for navigation, impact analysis and framework-aware questions. They share tree-sitter as a foundation and solve different halves of the workflow."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** ast-grep (`ast-grep/ast-grep`, {{ site.data.competitors.ast_grep.stars }} stars, MIT, Rust) is the best structural `grep` most teams have never tried: write a pattern that looks like ordinary code with `$LIKE_THIS` wildcards, and it finds or rewrites every AST node with that shape — fast, multi-core, configured in YAML, runnable in CI. trace-mcp is a different kind of tool: it parses the repo into a persistent dependency graph (symbols, imports, call edges, framework edges across {{ site.data.counts.frameworks }} integrations) and serves it over MCP, so an agent asks "who calls this" and "what breaks if I change it" instead of re-searching files every turn.

If the job is "find every `if (x && x())` and rewrite it", ast-grep wins outright. If the job is "an agent working in this repo for forty turns", the graph wins.

## Head-to-head

| Capability | trace-mcp | ast-grep |
|---|:---:|:---:|
| **GitHub stars** | {{ site.data.competitors.trace_mcp.stars }} | {{ site.data.competitors.ast_grep.stars }} |
| License | MIT | MIT |
| Written in | TypeScript | Rust |
| Model | persistent index (SQLite + FTS5) | one-shot structural search |
| Pattern search | ✓ symbol/FTS search (text + graph) | ✓ AST patterns with metavariables |
| Rewriting | ✓ AST codemod, rename, move, extract | ✓ `--rewrite` + YAML rules |
| Cross-file call graph | ✓ bidirectional, graph-based | ✗ per-file pattern matches |
| Impact analysis | ✓ reverse dependency traversal | ✗ |
| Framework-aware edges | ✓ {{ site.data.counts.frameworks }} integrations | ✗ |
| MCP tools advertised (default) | 29 (~11.6K tok); {{ site.data.counts.tools }} on `full` | 0 — CLI, no MCP server in README |
| Works offline, no API keys | ✓ | ✓ |
| CI / lint integration | ✓ SARIF 2.1.0, quality gates | ✓ YAML rules as lint |
| Session memory | ✓ code-linked decisions, staleness-checked | ✗ |
| Security scanning | ✓ OWASP Top-10 taint | ✗ (custom rules possible, not shipped) |

Verified on September 26, 2026 against the ast-grep README at `main` ({{ site.data.competitors.ast_grep.stars }} stars, `ast-grep/ast-grep`) plus the GitHub API for stars, license and language. Language count for ast-grep not stated as a single figure in the README on that date, so the table carries no number rather than a guessed one.

## When to pick ast-grep

Honest version, and it is a real list:

- **Pattern-shaped search and rewrites.** `ast-grep -p '$A && $A()' -l ts -r '$A?.()'` is the canonical example from its own README: isomorphic patterns, metavariable wildcards, rewrite in one pass. Nothing in trace-mcp is that direct for shape-based edits.
- **Lint as YAML.** Custom rules (`rule:` + `pattern:` + `fix:`) turn team conventions into CI checks without writing an ESLint plugin or an AST visitor. trace-mcp's quality gates check its own graph; they are not a lint-rule authoring story.
- **Codemods for breaking library migrations.** The README's pitch to library authors is exactly right: ship a scan/rewrite rule and your users adopt the breaking change mechanically. Our codemod path follows graph edges; theirs follows shapes — and most migrations are shapes.
- **Zero daemon, zero index, multi-core Rust.** No build step, no SQLite file, no watcher. It scans, uses every core, exits. For scripts and pre-commit hooks that shape is strictly better than ours.
- **Ecosystem.** Roughly two orders of magnitude more stars, an online playground, and packages on every installer (npm, pip, cargo, brew, scoop, mise, MacPorts, nix). That matters at 2am.

## When to pick trace-mcp

- **The question is structural, not shaped.** "Who calls this", "what breaks if I change this signature", "which route renders this component" — a pattern can approximate the first and cannot answer the rest. The graph resolves them as one tool call.
- **Multi-turn agent sessions.** ast-grep re-scans per invocation; trace-mcp indexes once and serves scoped answers per query. Across forty turns in a repo that does not fit in context, the index amortises and the scans do not.
- **Framework semantics.** Route → handler, controller → template, model → table across {{ site.data.counts.frameworks }} integrations. No pattern language models these; the graph stores them as edges.
- **The agent acts, then remembers.** AST rename/move/extract with import rewriting, OWASP taint with SARIF output, and decisions linked to symbol IDs with staleness checks at recall — none of which a search tool ships.

## The honest caveat

Two of them. First, **ast-grep's pattern engine is the tool ours is not**: for "every call shaped like X", a pattern is more precise than our symbol search plus graph filter, and cheaper than any graph query. We would rather say that here than have you benchmark it yourself.

Second, **our default tool surface is expensive next to a CLI.** trace-mcp advertises 29 tools at roughly 11.6K tokens on the shipped default path; ast-grep advertises nothing because there is no session to advertise into. A short scripted job genuinely costs less through ast-grep.

**Our security scanning has a ceiling, stated on the [comparisons page](/comparisons.html) rather than only here.** The control-flow graph is line-based, not AST-based, and taint analysis is lexical/regex, not a real dataflow engine. Type-aware pruning cuts false positives; it does not turn this into a dataflow analyser.

## FAQ

**What is the core difference between ast-grep and trace-mcp?**
ast-grep matches structural patterns per invocation; trace-mcp precomputes a persistent graph and serves it over MCP. Pattern matching versus a queryable index.

**Can ast-grep do impact analysis or find callers?**
Not as a traversal. A pattern for the callee name approximates callers until overloads, re-exports or dynamic dispatch defeat the pattern. Transitive impact needs resolved edges, which is the graph's job.

**Does ast-grep have an MCP server?**
Not in its README as read on September 26, 2026. It ships as a CLI with YAML rules; an agent uses it by shelling out.

**Which is better for large-scale codemods?**
ast-grep for shape-based rewrites (isomorphic patterns, YAML lint rules, multi-core). trace-mcp when the rewrite follows edges — rename with import rewriting, moves, signature changes verified against the graph.

**Can I use both?**
Yes — ast-grep for structural search and rewrites in CI and scripts, trace-mcp as the agent's live index for navigation, impact analysis and framework-aware questions.

## Next steps

- Learn how a persistent code graph reduces token costs on every turn: [Code graph MCP server](/code-graph-mcp.html).
- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs Serena](/vs/serena.html) · [vs Repomix](/vs/repomix.html) · [vs Continue](/vs/continue.html) · [vs Aider](/vs/aider.html) · [vs codebase-memory-mcp](/vs/codebase-memory-mcp.html) · [vs codegraph](/vs/codegraph.html)
- [PR review context benchmark](/pr-context-benchmark.html) — measured input-token cost of code-review context on 60 merged pull requests.
- [Architecture](/architecture.html) — how the indexing pipeline, storage and LSP enrichment fit together.
- [Get started](/#install) — no configuration required.
