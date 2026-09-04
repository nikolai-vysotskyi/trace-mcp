---
title: "Serena MCP Alternative: trace-mcp vs Serena for agent code navigation"
description: "Serena drives a live language server; trace-mcp precomputes a framework-aware code graph. Head-to-head on precision, startup cost, refactoring, memory."
updated: 2026-09-03
---

# Serena MCP alternative: trace-mcp vs Serena

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vs/serena.html",
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
        "@id": "https://trace-mcp.com/vs/serena.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the core difference between Serena and trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Serena proxies a live language server (LSP) per request, so its answers are compiler-grade but only as broad as the language server exposes. trace-mcp precomputes a persistent graph from tree-sitter parsing, then optionally upgrades edges with LSP or offline SCIP indexes. Serena is precision-first and stateless; trace-mcp is breadth-first and persistent."
          }
        },
        {
          "@type": "Question",
          "name": "Is Serena more accurate than trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "For plain symbol references and renames in a language with a good language server, yes by default — LSP resolution is compiler-grade and trace-mcp's AST resolution is not. trace-mcp closes that gap only when you enable its opt-in LSP enrichment or ingest a SCIP index, which raises those edges to the lsp_resolved or scip_resolved tier. For cross-language and framework edges, no language server has the answer at all, and trace-mcp is ahead."
          }
        },
        {
          "@type": "Question",
          "name": "Does trace-mcp need a language server installed?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. trace-mcp works with tree-sitter alone across {{ site.data.counts.languages }} languages and needs no toolchain, no compile step and no language server. LSP enrichment is opt-in via lsp.enabled in config, and SCIP ingestion is fully offline. Serena's core premise is the opposite: no language server for your stack means no answers."
          }
        },
        {
          "@type": "Question",
          "name": "Can Serena do impact analysis or framework-aware navigation?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Not as a graph. A language server answers 'references to this symbol'; it has no notion that a controller renders a specific template via Inertia, that a route maps to a handler, or that an ORM model backs a table. trace-mcp models those as first-class edges across {{ site.data.counts.frameworks }} framework integrations and traverses them for reverse-dependency impact analysis."
          }
        },
        {
          "@type": "Question",
          "name": "Which has a lower startup cost?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Serena, on a cold repository: there is no index to build, though the language server itself still has to warm up, which on a large TypeScript or Java project is not free. Serena does persist per-file document-symbol caches, so a second start is cheaper than the first. trace-mcp pays a one-time index build and then serves queries from SQLite, so it is faster once warm; both survive restarts, but only trace-mcp's stored state contains edges."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** Serena and trace-mcp both give an agent structured code navigation instead of raw file reads, and they get there from opposite directions. Serena is a **live LSP proxy**: it asks a real language server your question, so its references and renames are compiler-grade, but its world is exactly what the language server knows. trace-mcp is a **precomputed graph**: tree-sitter parsing across {{ site.data.counts.languages }} languages into SQLite, with framework-aware edges, refactoring, security scanning and code-linked memory on top — and LSP or offline SCIP as an *optional* precision upgrade rather than a hard dependency.

Pick Serena if precision on one well-supported language is the whole job. Pick trace-mcp if breadth, framework semantics, or anything beyond navigation is.

## Head-to-head

| Capability | trace-mcp | Serena |
|---|:---:|:---:|
| **GitHub stars** | {{ site.data.competitors.trace_mcp.stars }} | {{ site.data.competitors.serena.stars }} |
| Languages | {{ site.data.counts.languages }} (tree-sitter) | 40+ (73 LSP backends) |
| Requires a language server | ✗ optional enrichment | ✓ core premise |
| Reference precision by default | AST-resolved (tiered) | compiler-grade (LSP) |
| Compiler-grade path | ✓ opt-in LSP + offline SCIP ingestion | ✓ live LSP |
| Framework integrations | ✓ {{ site.data.counts.frameworks }} | ✗ |
| Cross-language edges | ✓ | ✗ |
| Persistent state across restarts | ✓ SQLite + FTS5 graph | partial — on-disk symbol cache, no graph |
| Impact analysis | ✓ reverse dependency traversal + decorator filter | ✗ |
| Call graph | ✓ bidirectional, graph-based | ✗ not exposed as a tool |
| Refactoring tools | ✓ rename, move, signature, AST codemod, extract | ✓ rename, safe-delete; move and inline only via the JetBrains bridge |
| Live debugger | ✗ deliberately out of lane | ✓ via a JetBrains IDE bridge (optional, beta) |
| Session memory | ✓ code-linked decision graph, staleness-checked at recall | ✓ markdown notes, cross-referenced but not code-linked |
| Security scanning | ✓ OWASP Top-10, type-aware taint | ✗ |
| Control-flow / data-flow | ✓ CFG with basic blocks and loop back-edges | ✗ |
| SARIF / CI output | ✓ 2.1.0, schema-validated | ✗ |
| Multi-repo subprojects | ✓ cross-repo API linking | partial — query another project, no cross-repo edges |
| Graph visualization | ✓ desktop app | ✗ |
| MCP tools advertised (default) | 28 (~11.6K tok); {{ site.data.counts.tools }} on `full` | 29; 52 defined |
| Written in | TypeScript | Python |

## When to pick Serena

- **You work in one language with a first-class language server.** For Python or TypeScript, "find all references" and "rename symbol" from a real language server are correct in cases AST heuristics get wrong: overloads, re-exports, generics, dynamic dispatch through interfaces. That is a genuine precision lead, and it is on by default for Serena while it is opt-in for us.
- **You want no index build step.** There is no graph to construct and nothing to re-index after a pull. Serena is not fully stateless, though — `SolidLanguageServer` keeps two pickled per-file symbol caches under `.serena/cache/<language>/` (`raw_document_symbols.pkl`, `document_symbols.pkl`), loaded on start and keyed by file content hash, so warm queries survive a restart. What it does not keep is edges: no import graph, no call graph, no impact traversal.
- **You already work inside a JetBrains IDE.** Serena can bridge into it for debugging — breakpoints, stepping and variable inspection driven by the agent (an optional beta tool, and it needs the IDE plus their plugin running). trace-mcp deliberately does not do this; a static graph is not the right tool for a running process, and we are not planning to chase it.
- **Popularity.** Serena is roughly 280× larger by stars, with correspondingly more community answers and integrations.

## When to pick trace-mcp

- **Your stack is polyglot or unusual.** {{ site.data.counts.languages }} tree-sitter grammars beat 40+ language servers when part of your repo is Terraform, Kotlin, SQL, Dockerfiles, or a language whose LSP is a maintenance liability.
- **The edges you care about are framework edges.** Route → handler, controller → template, model → table, component → component. No language server models these. trace-mcp ships {{ site.data.counts.frameworks }} integrations that do.
- **You want impact analysis, not just references.** "Everything transitively affected by changing this function, filtered to route handlers" is a graph traversal; it is not an LSP request.
- **The job goes past navigation.** Security scanning with type-aware taint pruning, quality gates, dead-code removal, AST codemods, SARIF output for CI, complexity and churn hotspots — Serena's scope stops well before these.
- **Memory should survive the session and be tied to code.** Serena's memories are notes the agent writes. trace-mcp's decisions are linked to symbol IDs, verified as non-stale at recall time, and surface inside `get_change_impact`.

## Where we are not being smug

Two honest points.

First, **the table above used to be built from Serena's README, and reading the source moved four rows in Serena's favour.** We cloned it at commit `43ae021` (version 1.7.1.dev0, MIT) and read its tool package, its memory package, its project server and its `solidlsp` language-server layer. What changed:

- **It is not stateless.** We claimed "no persistent state, per-session". It persists two pickled document-symbol caches per language and loads them at startup (see the bullet above). Warm symbol lookups do survive a restart; only the edges do not exist.
- **It can reach other repositories.** We claimed a flat ✗. `query_project` and `list_queryable_projects` run any read-only Serena tool against another registered project, through a small Flask project server. Both are optional tools, off unless enabled, and there are still no edges between repositories — but "cannot" was wrong.
- **Its memories are more than notes.** We called them manual notes. They are markdown files under `.serena/memories` with topic namespacing, a global scope beside the project scope, and `mem:` cross-references with referential-integrity checking and autofix. What they are not is code-linked: nothing ties a memory to a symbol, and nothing rechecks it against the code when it is recalled. That narrower difference is the real one.
- **Its default surface is 29 tools, not ~55.** The registry marks 52 tool classes, 23 of them optional (13 are the JetBrains bridge), leaving 29 enabled by default — so the honest comparison against our 28 is "the same size", not "half".

Two rows moved the other way, and we state the evidence rather than the verdict. **Call graph**: `callHierarchy/incomingCalls` and `outgoingCalls` are implemented in the LSP client layer, but no tool class calls them, so an agent cannot ask Serena for a call graph. **Move and inline refactoring**: `JetBrainsMoveTool` and `JetBrainsInlineSymbol` proxy to a running JetBrains IDE; both are optional and beta. Native and always-on are `rename_symbol` and `safe_delete_symbol`.

If you maintain Serena and something here is wrong, [open an issue](https://github.com/nikolai-vysotskyi/trace-mcp/issues) and we will fix it.

Second, **our default tool surface is expensive.** trace-mcp advertises 28 tools, roughly 11.6K tokens, on the shipped default path as of August 29, 2026 — down from ~50K, once the preset bypass on the daemon-backed path was fixed and the default preset moved to `minimal`. That is level with Serena's 29 default tools rather than an order of magnitude above it, and anything outside the default is one `load_tools` call away.

**Our security scanning has a ceiling, and it is stated on the [comparisons page](/comparisons.html) rather than only here.** The control-flow graph is line-based, not AST-based, and taint analysis is lexical/regex, not a real dataflow engine. Type-aware pruning cuts false positives; it does not turn this into a dataflow analyser. A full AST/dataflow rewrite is out of scope for now.

## FAQ

**What is the core difference between Serena and trace-mcp?**
Serena proxies a live language server per request: compiler-grade, but only as broad as the language server. trace-mcp precomputes a persistent graph from tree-sitter, then optionally upgrades edges with LSP or offline SCIP. Precision-first and stateless versus breadth-first and persistent.

**Is Serena more accurate than trace-mcp?**
For plain references and renames in a well-served language, yes by default. trace-mcp closes that gap only with opt-in LSP enrichment or a SCIP index, which raise edges to the `lsp_resolved` / `scip_resolved` tier. For cross-language and framework edges, no language server has the answer at all.

**Does trace-mcp need a language server installed?**
No. tree-sitter alone covers {{ site.data.counts.languages }} languages with no toolchain and no compile step. LSP is opt-in; SCIP ingestion is offline. Serena's premise is the opposite — no language server for your stack means no answers.

**Can Serena do impact analysis or framework-aware navigation?**
Not as a graph. "References to this symbol" is an LSP request; "this controller renders that template via Inertia" is not something a language server models.

**Which has a lower startup cost?**
Serena on a cold repo — no index build, though the language server still has to warm up, which on a large TypeScript or Java project is not free. Its pickled symbol caches make the second start cheaper than the first. trace-mcp pays a one-time index build, then serves from SQLite; both survive restarts, but only trace-mcp's stored state includes edges.

## Next steps

- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs Repomix](/vs/repomix.html) · [vs codebase-memory-mcp](/vs/codebase-memory-mcp.html) · [vs codegraph](/vs/codegraph.html) · [vs Context Mode](/vs/context-mode.html)
- [Architecture](/architecture.html) — how the indexing pipeline, storage and LSP enrichment fit together.
- [Get started](/#install) — no configuration required.
