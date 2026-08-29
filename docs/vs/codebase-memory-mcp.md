---
title: "codebase-memory-mcp Alternative: trace-mcp vs codebase-memory-mcp"
description: "Both build a persistent code knowledge graph for AI agents. Head-to-head on language coverage, advertised tool cost, framework awareness, refactoring and security — including the two places codebase-memory-mcp is clearly ahead."
updated: 2026-08-29
---

# codebase-memory-mcp alternative: trace-mcp vs codebase-memory-mcp

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "codebase-memory-mcp alternative: trace-mcp vs codebase-memory-mcp",
      "description": "Head-to-head comparison of trace-mcp and DeusData's codebase-memory-mcp as persistent code knowledge graphs for AI agents.",
      "url": "https://trace-mcp.com/vs/codebase-memory-mcp.html",
      "datePublished": "2026-08-29",
      "dateModified": "2026-08-29",
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
        "@id": "https://trace-mcp.com/vs/codebase-memory-mcp.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "How similar are trace-mcp and codebase-memory-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "They are the closest pair in this space. Both parse a repository with tree-sitter into a persistent knowledge graph, both do impact analysis and call-path tracing, both model infrastructure-as-code as graph nodes, and both expose it over MCP. The divergence is what sits on top: trace-mcp adds framework-aware edges, a refactoring engine, security scanning and code-linked decision memory; codebase-memory-mcp goes wider on raw language count and much leaner on advertised tool surface."
          }
        },
        {
          "@type": "Question",
          "name": "codebase-memory-mcp supports 161 languages and trace-mcp supports {{ site.data.counts.languages }}. Does that matter?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Only if your repository contains a language in the gap, which for most teams it does not. trace-mcp's coverage is chosen to span the real-world long tail rather than to win a count. Where trace-mcp goes deeper is per-language and per-framework semantics: route-to-handler, controller-to-template, model-to-table edges that a broader-but-shallower parser does not produce."
          }
        },
        {
          "@type": "Question",
          "name": "Is codebase-memory-mcp cheaper in tokens?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "On advertised surface, yes, and by a wide margin. Its 15 tools cost roughly 7K tokens of schema, and its scout and analysis profiles trim that to 7 and 11 tools. trace-mcp advertises 28 tools at roughly 11.6K tokens on the shipped default path — the `minimal` preset, re-measured August 29, 2026; the preset-bypass bug behind the ~50K figure this page used to quote is fixed and closed. A ~1.7× gap remains, and it is still the clearest place this peer leads."
          }
        },
        {
          "@type": "Question",
          "name": "Does codebase-memory-mcp have a published benchmark?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Its authors published a preprint (arXiv 2603.27277) reporting 83% answer quality, roughly 10 times fewer tokens and 2.1 times fewer tool calls versus file-by-file exploration across 31 repositories. We have not independently reproduced it, and it is a self-published preprint rather than peer-reviewed third-party work — but it is still more evidence than most peers, trace-mcp included, have put on the table."
          }
        },
        {
          "@type": "Question",
          "name": "Can either one refactor code, not just read it?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Only trace-mcp. It ships graph-aware rename across files, symbol and file moves with import rewriting, signature changes with call-site updates, AST-based codemods and verified dead-code removal. codebase-memory-mcp is read-only analysis: it will tell an agent what would break, but the agent still edits by hand."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** codebase-memory-mcp (DeusData) is the peer closest to trace-mcp's premise: parse a repository into a persistent knowledge graph and serve it to agents over MCP, instead of letting them re-read files. Both do impact analysis, call-path tracing, cross-service linking and infrastructure-as-code as graph nodes.

The split is depth versus breadth, in both directions. codebase-memory-mcp is broader on languages (161 vs {{ site.data.counts.languages }}) and dramatically leaner on advertised tool cost. trace-mcp is deeper per repository: {{ site.data.counts.frameworks }} framework integrations produce edges a language-agnostic parser cannot, and it can act on the graph — rename, move, codemod, remove dead code, scan for vulnerabilities — rather than only describe it.

## Head-to-head

| Capability | trace-mcp | codebase-memory-mcp |
|---|:---:|:---:|
| **GitHub stars** | 100 | 41.0K |
| Languages | {{ site.data.counts.languages }} | 161 |
| Framework integrations | ✓ {{ site.data.counts.frameworks }} | ✗ (partial REST routes) |
| Persistent knowledge graph | ✓ SQLite + FTS5 | ✓ |
| Knowledge-graph queries | ✓ `graph_query` | ✓ Cypher-like |
| Impact analysis | ✓ reverse dependency traversal + decorator filter | ✓ `detect_changes` |
| Call graph | ✓ bidirectional | ✓ `trace_call_path` |
| Cross-service / multi-repo | ✓ cross-repo API linking | ✓ cross-service HTTP linking |
| IaC as graph nodes | ✓ K8s/Kustomize/HCL/Docker, cross-file resolved | ✓ K8s/Kustomize/HCL/Docker |
| Clone / community detection | ✓ AST Type-2 subtree hashing, 11 antipatterns | ✓ MinHash near-clone, Louvain communities |
| Refactoring tools | ✓ rename, move, signature, AST codemod, extract | ✗ |
| Security scanning | ✓ OWASP Top-10, type-aware taint, SARIF 2.1.0 | ✗ |
| Control-flow graph | ✓ basic blocks, loop back-edges, try/catch merges | ✗ |
| Quality gates in CI | ✓ complexity / security / coverage thresholds | ✗ |
| Code-linked decision memory | ✓ decisions bound to symbol IDs, staleness-verified | partial (`manage_adr` markdown documents) |
| Runtime trace ingestion | ✗ | ✓ `ingest_traces` |
| Graph visualization | ✓ desktop app | ✓ 3D web UI |
| MCP tools advertised (default) | 28 (~11.6K tok); {{ site.data.counts.tools }} on `full` | 15 (~7K tok); profiles: 11 / 7 |
| Supply-chain posture | OpenSSF Scorecard, CodeQL, Semgrep | SLSA L3, VirusTotal, OpenSSF Scorecard |
| Published benchmark | ✗ | ✓ preprint, not independently reproduced |
| Written in | TypeScript | C |

## When to pick codebase-memory-mcp

This is the peer where the honest list is longest, so here it is in full:

- **Your advertised tool budget is tight.** 15 tools at roughly 7K tokens — or 7 with `--tool-profile=scout` — against trace-mcp's ~11.6K on the shipped default path (down from ~50K; the preset-bypass bug is fixed and the default is now `minimal`). If you run several MCP servers in one client and every one of them is competing for the same context window, a ~1.7× difference still matters. This is the clearest place any competitor beats us, and we are not going to pretend otherwise on our own comparison page.
- **You need a language we do not parse.** 161 grammars against {{ site.data.counts.languages }}. If your repo has one in the gap, none of trace-mcp's depth helps you.
- **You want evidence before adopting.** Its authors published a benchmark preprint (arXiv 2603.27277: 83% answer quality, ~10× fewer tokens, 2.1× fewer tool calls across 31 repositories). We have not reproduced it and it is not peer-reviewed — but trace-mcp has no comparable published number at all.
- **Supply-chain requirements are strict.** SLSA Level 3 provenance plus VirusTotal-scanned reproducible release candidates is a stronger posture than ours, and in a regulated environment that can be the whole decision.
- **You have runtime traces to fold in.** `ingest_traces` enriches the graph with observed caller/callee counts — dynamic edges static analysis cannot see. trace-mcp has no equivalent.

## When to pick trace-mcp

- **Framework semantics.** A graph that knows `UserController` exists but not that it renders `Users/Show.vue` via Inertia is missing the edges developers actually reason about. {{ site.data.counts.frameworks }} integrations produce route → handler, controller → template, model → table and component edges; a language-agnostic parser produces none of them.
- **You want the agent to change code.** Rename across files with import rewriting, symbol and file moves, signature changes that update call sites, AST-based codemods with metavariable substitution, dead-code removal with orphan-import detection. codebase-memory-mcp is read-only.
- **Security is part of the job.** OWASP Top-10 rules, taint analysis with type-aware pruning, and OASIS-schema-validated SARIF 2.1.0 for CI ingestion.
- **Memory should be code-linked and verified.** `manage_adr` writes flat markdown documents. trace-mcp binds decisions to symbol IDs, checks at recall time that the linked code still resolves and is unchanged, and surfaces them inside `get_change_impact` — so a decision about code that was deleted stops being served.
- **Gates, not just reports.** Quality gates with configurable complexity, security and coverage thresholds, plus SARIF output, make the graph a CI participant rather than a chat aid.

## FAQ

**How similar are trace-mcp and codebase-memory-mcp?**
The closest pair in this space. Both parse with tree-sitter into a persistent knowledge graph, both do impact analysis and call-path tracing, both model IaC as nodes. The divergence is what sits on top: framework-aware edges, refactoring, security and code-linked memory for trace-mcp; raw language breadth and a much leaner advertised surface for codebase-memory-mcp.

**It supports 161 languages and trace-mcp supports {{ site.data.counts.languages }}. Does that matter?**
Only if your repository contains a language in the gap. trace-mcp's coverage targets the real-world long tail rather than a count; the depth goes into per-framework semantics instead.

**Is codebase-memory-mcp cheaper in tokens?**
On advertised surface, yes — ~7K against our ~11.6K on the shipped default path as of August 29, 2026. The preset-bypass bug that put us at ~50K is fixed and the default preset is now `minimal`; the remaining ~1.7× gap is real and is the clearest place a competitor leads.

**Does it have a published benchmark?**
A self-published preprint (arXiv 2603.27277), not independently reproduced and not peer-reviewed — but still more evidence than most peers, us included, have put on the table.

**Can either one refactor code, not just read it?**
Only trace-mcp. codebase-memory-mcp is read-only analysis.

## Next steps

- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs Repomix](/vs/repomix.html) · [vs Serena](/vs/serena.html) · [vs codegraph](/vs/codegraph.html)
- [Decision memory](/decision-memory.html) — how code-linked decisions differ from a notes file.
- [Get started](/#install) — no configuration required.
