---
title: "Code Graph MCP Server for AI Coding Agents"
description: "How a code graph MCP server gives AI coding agents persistent symbol, call, and framework relationships without re-reading whole repositories."
updated: 2026-09-07
---

# Code graph MCP server for AI coding agents

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/code-graph-mcp.html",
      "datePublished": "2026-09-07",
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
        "@id": "https://trace-mcp.com/code-graph-mcp.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is a code graph MCP server?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "A code graph MCP server parses a repository into a persistent graph of symbols, imports, call hierarchies, and framework routes, then exposes that graph to AI coding agents over the Model Context Protocol. Instead of scanning raw files with grep or find, the agent queries specific symbol definitions, caller chains, or blast radius in a single request."
          }
        },
        {
          "@type": "Question",
          "name": "How does a code graph MCP server reduce agent token costs?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Agents spend tokens every turn re-reading files they opened previously. A code graph server computes relationships once and returns targeted subgraphs. On trace-mcp, this assembles pull-request review context with a median {{ site.data.pr_context_bench.median_savings_pct }}% fewer input tokens across {{ site.data.pr_context_bench.pr_count }} open-source pull requests, while maintaining review comprehension at parity ({{ site.data.pr_context_quality.trace_understood }} vs {{ site.data.pr_context_quality.baseline_understood }} blind-scored comprehension, {{ site.data.pr_context_quality.trace_false_positives }} vs {{ site.data.pr_context_quality.baseline_false_positives }} false positives per PR)."
          }
        },
        {
          "@type": "Question",
          "name": "How does trace-mcp differ from other code graph MCP servers?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Many code graph servers stop at language-agnostic AST parsing or single-file packing. trace-mcp models framework semantics across {{ site.data.counts.frameworks }} frameworks (linking routes to controllers, templates, and database models), includes AST refactoring and code-linked decision memory, and runs locally on embedded SQLite with zero external dependencies."
          }
        }
      ]
    }
  ]
}
</script>

A **code graph MCP server** indexes a codebase into a structured knowledge graph — symbols, definitions, call hierarchies, imports, and framework routes — and serves targeted slices to AI coding agents over the [Model Context Protocol](https://modelcontextprotocol.io/).

Without a code graph, an AI agent running in Claude Code, Cursor, Codex, or Windsurf relies on `grep`, `find`, and repeated file reads. Every turn pulls thousands of lines of source code into the prompt window. A code graph server changes that relationship: the repository is indexed once locally, and the agent queries precise relationships instead of re-reading raw files.

```
Without code graph:  Prompt -> grep / read_file -> 10,000+ raw tokens loaded per turn
With code graph:     Prompt -> graph query     -> exact subgraphs (definitions, callers, routes)
```

## Why AI agents need persistent graph context

Every turn in an agentic coding session pays for the entire preceding conversation history. When an agent opens files to locate a function or trace an import, those lines remain in the prompt context until the session ends.

A persistent code graph replaces file scans with graph queries:

1. **Cost scales with the answer, not the repository.** Reading files scales with the size of the repository. Graph queries (`find_symbol`, `find_usages`, `get_change_impact`) scale with the size of the returned subgraph.
2. **Measured context reduction.** In real benchmarks, graph-assembled context reduces input token usage by a median **{{ site.data.pr_context_bench.median_savings_pct }}%** to assemble pull-request review context across {{ site.data.pr_context_bench.pr_count }} open-source pull requests in {{ site.data.pr_context_bench.repo_count }} repositories ([read the PR context benchmark](/pr-context-benchmark.html)). Blind evaluation confirms comprehension at parity: {{ site.data.pr_context_quality.trace_understood }} understood rate against naive file loading's {{ site.data.pr_context_quality.baseline_understood }} (at {{ site.data.pr_context_quality.trace_false_positives }} vs {{ site.data.pr_context_quality.baseline_false_positives }} false positives per PR; see [quality preregistration](/perf/prereg-pr-quality/)).
3. **Freshness without rebuilds.** File watchers detect edits with a 300 ms debounce, re-parsing only changed files and updating edge tables in an embedded SQLite database.

## How trace-mcp implements the code graph

trace-mcp is a local-first code graph MCP server built around four architectural choices:

* **Polyglot tree-sitter parsing:** Parsers for {{ site.data.counts.languages }} programming languages compile into the binary, resolving symbols, classes, functions, and import chains without requiring language servers or build toolchains ([view language matrix](/language-matrix.html)).
* **Framework-aware semantic edges:** Web applications do not live in isolated ASTs. trace-mcp resolves route-to-controller, controller-to-template, and model-to-table relationships across {{ site.data.counts.frameworks }} frameworks, including Laravel, Next.js, Django, Rails, Spring, and FastAPI ([supported frameworks](/supported-frameworks.html)).
* **Zero-overhead local storage:** All graph nodes, edges, and FTS5 search indices live in an embedded SQLite database on your machine. No hosted services, no background daemons requiring cloud accounts, and no API keys.
* **Controlled schema footprint:** An MCP server that advertises dozens of tools consumes thousands of tokens before the agent asks its first question. trace-mcp uses role presets to expose roughly 2K tokens of tool schemas on session start, while keeping extended tools accessible dynamically via `load_tools` ([tools reference](/tools-reference.html)).

## The code graph MCP ecosystem

Different tools approach codebase context from distinct angles:

| Approach | Representative project | Mechanism | Trade-off |
|---|---|---|---|
| **Prompt packing** | [Repomix](https://github.com/yamadashy/repomix) | Concatenates repository source into a single compressed prompt artifact. | Fast setup, but computes no edges and repays full file costs on every turn. [trace-mcp vs Repomix](/vs/repomix.html) |
| **LSP proxy** | [Serena](https://github.com/oraios/serena) | Bridges IDE language servers directly into MCP tool calls. | Compiler-grade type precision, but requires active language toolchains and maintains no persistent graph. [trace-mcp vs Serena](/vs/serena.html) |
| **Single-tool graph** | [codegraph](https://github.com/colbymchenry/codegraph) | Exposes a single `explore` tool by default to minimize advertised schema tokens. | Low schema token cost, but navigation only — no write path or framework edges. [trace-mcp vs codegraph](/vs/codegraph.html) |
| **Broad grammar graph** | [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | Compiles 162 vendored grammars into an incremental graph. | Broad syntax support, but no framework routing or refactoring operations. [trace-mcp vs codebase-memory-mcp](/vs/codebase-memory-mcp.html) |
| **SCIP-driven graph** | [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) | Orchestrates eleven external Sourcegraph SCIP indexers into graph snapshots. | External indexer pipelines, but requires external binaries and complex backend choices. [trace-mcp vs CodeGraphContext](/vs/codegraphcontext.html) |
| **Review graph** | [code-review-graph](https://github.com/code-review-graph/code-review-graph) | Tracks incremental changes with empty-result uncertainty explanations. | Specialised for review navigation, but advertises 29 tools without preset filtering. [trace-mcp vs code-review-graph](/vs/code-review-graph.html) |
| **Hybrid vector-AST graph** | [SocratiCode](https://github.com/giancarloerra/SocratiCode) | Combines Qdrant vector embeddings with ast-grep in Docker. | Semantic vector search, but requires Docker runtime and lacks framework routing. [trace-mcp vs SocratiCode](/vs/socraticode.html) |

For a comprehensive feature-by-feature breakdown across 20+ tools, see the [code graph comparisons hub](/comparisons.html).

## Getting started

Install trace-mcp in your project root:

```bash
npx trace-mcp init
```

The init command inspects your repository, detects your frameworks and languages, sets up client configurations for Claude Code, Cursor, or Windsurf, and indexes your codebase into a local `.trace/` database.

* Explore all available tools: [Tools Reference](/tools-reference.html)
* Review configuration and preset options: [Configuration Guide](/configuration.html)
* Inspect architecture and storage contracts: [Architecture Documentation](/architecture.html)
