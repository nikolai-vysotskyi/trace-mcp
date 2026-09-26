---
title: "Cody Alternative: trace-mcp vs Sourcegraph Cody for code context"
description: "Cody is enterprise-only cloud search plus assistant. trace-mcp is the local-first graph alternative — no key, no cloud, framework edges compared."
updated: 2026-09-26
---

# Cody alternative: trace-mcp vs Sourcegraph Cody

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vs/cody.html",
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
        "@id": "https://trace-mcp.com/vs/cody.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Is Sourcegraph Cody still available?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Only as Cody Enterprise for existing enterprise customers. Cody Free, Pro and Enterprise Starter were discontinued on July 23, 2025, the sourcegraph/cody repository returns 404, and only an archived public snapshot remains. Sourcegraph's individual-developer effort moved to Amp, spun off as a separate company in December 2025. Verify against Sourcegraph's current pricing before adopting."
          }
        },
        {
          "@type": "Question",
          "name": "What is the core difference between Cody and trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Cody is a cloud assistant on top of Sourcegraph's code search: chat, completions and edits with context pulled from local and remote codebases through their Search API. trace-mcp is a local-first code graph in SQLite on your own machine: no account, no key, no code leaving the workstation, with framework edges and a refactoring write path. Hosted search-plus-assistant versus a persistent local index."
          }
        },
        {
          "@type": "Question",
          "name": "When is Cody the better pick?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "When the codebase lives across an organisation and you want one vendor to index all of it: remote search over every repo, enterprise access controls, IDE extensions, and batch changes for large migrations — with someone else operating the infrastructure. That is a genuine zero-setup story at enterprise scale, and a local tool cannot offer it."
          }
        },
        {
          "@type": "Question",
          "name": "Does Cody work offline?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. Cody's context comes from Sourcegraph's search infrastructure, cloud or self-hosted, which is the point of the product — and the cost of it. trace-mcp parses with tree-sitter across {{ site.data.counts.languages }} languages entirely offline; the index never leaves the machine."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** Cody was Sourcegraph's AI coding assistant — chat, completions and edits with context pulled from your whole codebase through their Search API, local and remote. Read the status notice first: Cody Free, Pro and Enterprise Starter were discontinued on July 23, 2025, the `sourcegraph/cody` repository itself returns 404, and what remains is Cody Enterprise for existing enterprise customers (plus an archived public snapshot at {{ site.data.competitors.cody.stars }} stars) while Sourcegraph's individual-developer energy moved to Amp. trace-mcp is the opposite bet: a persistent code graph (tree-sitter across {{ site.data.counts.languages }} languages, {{ site.data.counts.frameworks }} framework integrations, SQLite + FTS5) on your own machine — no account, no key, no per-seat bill, no code leaving the workstation.

If your organisation already pays for Sourcegraph and wants one vendor indexing every repo, Cody Enterprise is the zero-setup answer. If you want the index to live with the code, read on.

## Head-to-head

| Capability | trace-mcp | Cody |
|---|:---:|:---:|
| **GitHub stars** | {{ site.data.competitors.trace_mcp.stars }} | {{ site.data.competitors.cody.stars }} (archived snapshot) |
| License | MIT | Apache-2.0 (snapshot); commercial Enterprise |
| Written in | TypeScript | TypeScript (snapshot) |
| What it is | persistent local graph over MCP | cloud assistant on hosted code search |
| Where the index lives | your machine (SQLite) | Sourcegraph Cloud or self-hosted |
| Needs account / key | ✗ | ✓ Enterprise plan |
| Remote multi-repo search | ✓ cross-repo subprojects (local) | ✓ local + remote via Search API |
| Framework-aware edges | ✓ {{ site.data.counts.frameworks }} integrations | not verified on reading date |
| Impact analysis | ✓ reverse dependency traversal | not verified on reading date |
| MCP tools advertised (default) | 29 (~11.6K tok); {{ site.data.counts.tools }} on `full` | not verified on reading date |
| Refactoring write path | ✓ AST rename, move, extract, codemod | ✓ agent edits; batch changes for migrations |
| Security scanning | ✓ OWASP Top-10 taint, SARIF 2.1.0 | ✗ (not its lane) |
| Session memory | ✓ code-linked decisions, staleness-checked | conversation-scoped, not verified as code-linked |
| Works offline | ✓ | ✗ by design |
| Availability | actively maintained | Enterprise-only; repo 404 as of 2026-09-26 |

Verified on September 26, 2026: `sourcegraph/cody` returns 404 on both web and API; stars and language from the archived `sourcegraph/cody-public-snapshot` via the GitHub API; plan status from Sourcegraph docs, changelog and Wikipedia (Free/Pro/Starter discontinued July 23, 2025; Amp spin-off December 2025). Cody's MCP surface and framework depth were not verifiable from the sources read on that date, so those cells read "not verified" rather than a guess.

## When to pick Cody

- **One vendor indexing every repo in the org.** Local and remote codebases through a single Search API, with enterprise access controls deciding what the assistant may see. A local-first tool indexes what is on your disk; Cody answers over what the company owns.
- **Zero infrastructure of your own.** No index to build, no daemon to run, no SQLite files to keep fresh — Sourcegraph operates it. The per-seat price is the trade, and at enterprise scale it is often the cheaper trade.
- **Migrations at org scale.** Agentic batch changes across hundreds of repositories is Sourcegraph's home turf — code search was built for exactly that before the assistant existed.
- **IDE presence.** VS Code, JetBrains, Visual Studio and web, with completions in the editor rather than a tool call away from it.

## When to pick trace-mcp

- **The code cannot leave the machine.** No account, no key, no cloud round-trip, no per-seat meter. Regulated codebases and NDAs decide this one before any feature table.
- **Framework semantics.** Route → handler, controller → template, model → table across {{ site.data.counts.frameworks }} integrations — stored edges, not search results the model must re-derive.
- **Persistence across sessions and agents.** The graph and its code-linked decisions survive restarts and outlive any single assistant host; Cody's context is conversation-scoped.
- **Past reading.** AST refactoring with import rewriting, verified dead-code removal, OWASP taint with SARIF, CI quality gates.
- **Offline.** Planes, data centres without egress, laptops on hotel wifi — the index is already there.

## The honest caveat

Cody Enterprise at org scale is the single thing on this site a local tool cannot do: search and assist across every repository a company owns, with access controls, operated by someone else. If that is the job, this page is not going to talk you out of it.

And the standing caveat on our side: **our default tool surface costs ~11.6K tokens before the agent asks anything**, and our security scanning ceiling (line-based CFG, lexical taint, type-aware pruning — not a dataflow engine) is stated on the [comparisons page](/comparisons.html), not hidden here.

## FAQ

**Is Sourcegraph Cody still available?**
Only as Cody Enterprise for existing enterprise customers. Free, Pro and Starter ended July 23, 2025; the repo is a 404 with an archived snapshot; Amp carries the individual-developer effort. Check current pricing before adopting.

**What is the core difference between Cody and trace-mcp?**
Hosted search-plus-assistant versus a persistent local index. Cody pulls context from Sourcegraph infrastructure; trace-mcp stores the graph on your machine and serves it over MCP.

**When is Cody the better pick?**
Org-wide remote search, enterprise controls, zero own infrastructure, batch migrations — with someone else operating it.

**Does Cody work offline?**
No, by design. Ours does, entirely — {{ site.data.counts.languages }} tree-sitter languages with no toolchain and no network.

## Next steps

- Learn how a persistent code graph reduces token costs on every turn: [Code graph MCP server](/code-graph-mcp.html).
- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs Serena](/vs/serena.html) · [vs Repomix](/vs/repomix.html) · [vs ast-grep](/vs/ast-grep.html) · [vs Aider](/vs/aider.html) · [vs ripwire](/vs/ripwire.html) · [vs IDE context](/vs/ide-context.html)
- [PR review context benchmark](/pr-context-benchmark.html) — measured input-token cost of code-review context on 60 merged pull requests.
- [Architecture](/architecture.html) — how the indexing pipeline, storage and LSP enrichment fit together.
- [Get started](/#install) — no configuration required.
