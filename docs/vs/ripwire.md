---
title: "ripwire Alternative: trace-mcp vs ripwire for agent code maps"
description: "ripwire is the zero-dependency CLI map for agents with published evals; trace-mcp is the persistent MCP graph. Map vs graph, honesty, memory compared."
updated: 2026-09-26
---

# ripwire alternative: trace-mcp vs ripwire

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vs/ripwire.html",
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
        "@id": "https://trace-mcp.com/vs/ripwire.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the core difference between ripwire and trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "ripwire is a zero-dependency C++ CLI that renders a ranked map of the repo per invocation — signatures over bodies, callers, blast radius, tests to run — with the MCP server as an explicitly optional, costlier second interface. trace-mcp is a persistent graph in SQLite served over MCP as the core product, queried turn after turn. Per-call map versus stored index."
          }
        },
        {
          "@type": "Question",
          "name": "Does ripwire have a call graph and impact analysis?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. Its README describes a ranked, deterministic call graph with per-edge uncertainty labels (dashed shafts where the resolver splits a call), plus blast radius, tests-to-run and quality deltas on the edit. That is the closest overlap with trace-mcp on this site — the difference is persistence and framework semantics, not the existence of edges."
          }
        },
        {
          "@type": "Question",
          "name": "What does ripwire do that trace-mcp does not?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Four things worth naming: a single zero-dependency binary with no daemon or index server; published evals that include the losses (a LocBench slice and a 48-question duel against a graph-database MCP server, with the seven defeats named); per-edge honesty labels on every uncertain call; and verdict-style outputs (quality delta, test gate, edit check) built for orchestrator loops."
          }
        },
        {
          "@type": "Question",
          "name": "What does trace-mcp do that ripwire does not?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Persistence and framework depth: an incremental SQLite index shared across sessions and agents, semantic edges across {{ site.data.counts.frameworks }} framework integrations (route to handler, controller to template, model to table), AST refactoring with import rewriting, and code-linked decision memory verified non-stale at recall. ripwire's README states no framework mapping on the reading date."
          }
        },
        {
          "@type": "Question",
          "name": "Can I use both?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. Reach for the ripwire CLI for cheap per-call orientation over a pipe, and query the trace-mcp graph for cross-session structure, framework edges and verified refactoring inside the agent loop. Map per call, graph across calls."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** ripwire (`redhat-et/ripwire`, {{ site.data.competitors.ripwire.stars }} stars, Apache-2.0, C++) calls itself the ripgrep of AI context and earns the name: one self-contained offline binary, no API key, no embeddings, no index server, no daemon — a ranked map (signatures at a claimed 74.7% fewer bytes than bodies, callers, blast radius, tests-to-run, quality deltas) rendered per invocation, with the MCP server deliberately demoted to an optional second interface because "its verb schemas sit in your agent's context every session". trace-mcp is the mirror image: a persistent graph in SQLite + FTS5 served over MCP as the core product, with {{ site.data.counts.frameworks }} framework integrations, AST refactoring and code-linked memory across sessions.

The honest summary is that ripwire is the best-argued page in this field — published evals with the losses included — and the gap between the two tools is narrower than on any other page here.

## Head-to-head

| Capability | trace-mcp | ripwire |
|---|:---:|:---:|
| **GitHub stars** | {{ site.data.competitors.trace_mcp.stars }} | {{ site.data.competitors.ripwire.stars }} |
| License | MIT | Apache-2.0 |
| Written in | TypeScript | C++ (C++23) |
| Model | persistent index (SQLite + FTS5) | per-invocation ranked map |
| Dependencies at runtime | Node.js | zero (single binary) |
| Daemon / index server | embedded daemon + watcher | ✗ none |
| Call graph | ✓ bidirectional, graph-based | ✓ ranked, deterministic, per-edge uncertainty labels |
| Impact / blast radius | ✓ reverse dependency traversal | ✓ blast radius + tests-to-run |
| Framework-aware edges | ✓ {{ site.data.counts.frameworks }} integrations | ✗ not stated in README on reading date |
| MCP tools advertised (default) | 29 (~11.6K tok); {{ site.data.counts.tools }} on `full` | optional second interface; CLI-first |
| Languages (parsed) | {{ site.data.counts.languages }} (tree-sitter) | 25 named in README |
| Published evals with losses | ✓ PR benchmark with blind judge | ✓ LocBench slice + 48-question duel, defeats named |
| Refactoring write tools | ✓ AST rename, move, extract, codemod | ✗ map + verdicts, no write path stated |
| Security / quality | ✓ OWASP Top-10 taint, SARIF 2.1.0 | ✓ quality deltas, test gates (McCabe/Halstead lineage) |
| Session memory | ✓ code-linked decisions, staleness-checked | `--recall` over notes; code-linking not stated |
| Works offline, no API keys | ✓ | ✓ |

Verified on September 26, 2026 against the ripwire README at `main` ({{ site.data.competitors.ripwire.stars }} stars, `redhat-et/ripwire`, v0.6.3) plus the GitHub API for stars, license and language. ripwire's benchmark figures (74.7% signature bytes, 0.25 s index, LocBench 58.3% vs 40.0%, 27–7–14 duel) are its own published claims, quoted as claims — not reproduced here.

## When to pick ripwire

Honest version, and it is the strongest "theirs" section on this site:

- **Zero-dependency single binary.** No Node, no daemon, no index server, no watcher — one process that maps a repo in a claimed quarter-second and exits. Our embedded daemon and SQLite files are strictly more machinery.
- **The CLI pipe is cheaper than any MCP surface.** No schemas in context, no 11.6K-token advertised surface — the agent pays per answer, never per session. ripwire says this explicitly in its own README, and it is right.
- **Published evals with the losses.** A LocBench slice (58.3% vs 40.0% best alternative), a 48-question duel against a graph-database MCP server (won 27, lost 7, tied 14 — defeats named one by one), counterexamples published against itself, and a drift-check script that fails if the README disagrees with its own tables. Nobody else in this field documents losing; that is a reason to trust the wins.
- **Per-edge honesty labels.** Uncertain calls drawn dashed, floors labelled floors, truncations disclosed, token budgets on the answer. Our resolution tiers are the same instinct; their per-edge rendering of it is better presentation than ours.
- **Verdict-style outputs for orchestrators.** Quality delta, test gate, edit check — answers a lane can hand back instead of transcripts to re-read.
- **The map visual.** A self-contained HTML graph coloured by complexity or churn, thresholds fixed so colours mean the same thing on every repo. We ship a desktop app; they ship a file.

## When to pick trace-mcp

- **Persistence across sessions and agents.** ripwire renders per invocation; our SQLite index is incremental, watched, and shared — with decisions linked to symbol IDs and verified non-stale at recall rather than notes recalled by relevance.
- **Framework semantics.** Route → handler, controller → template, model → table across {{ site.data.counts.frameworks }} integrations. ripwire's README states no framework mapping on the reading date — syntax and calls, not wiring.
- **The agent acts through the graph.** AST rename/move/extract/codemod with import rewriting and syntax verification, verified dead-code removal — ripwire states no write path.
- **Any MCP client.** The graph serves Claude Code, Cursor, Codex and whatever ships next quarter through one surface; ripwire's MCP server is the optional interface, the CLI pipe the primary one.
- **Full-text + embeddings + graph in one query path.** FTS5 with local ONNX embeddings composed with traversals, rather than a ranked map per call.

## The honest caveat

ripwire's duel section measures against "the leading graph-database code-context MCP server" without naming it in what we read — we do not know whether that server is us, and this page claims nothing about it either way. Their figures are quoted as their claims, with the methodology pointer (EVALS.md) attached so you can check rather than trust.

And our standing ceiling, stated on the [comparisons page](/comparisons.html): line-based CFG, lexical taint with type-aware pruning — not a dataflow engine, and out of scope to become one. Against a peer whose quality lens cites fifty years of replicated results, that ceiling deserves stating plainly.

## FAQ

**What is the core difference between ripwire and trace-mcp?**
Per-call ranked map versus persistent stored index. ripwire renders orientation per invocation over a pipe; trace-mcp keeps the graph in SQLite and serves it over MCP across turns.

**Does ripwire have a call graph and impact analysis?**
Yes — ranked deterministic call graph with per-edge uncertainty labels, blast radius, tests-to-run and quality deltas. Closest overlap with us on this site; the difference is persistence and framework depth.

**What does ripwire do that trace-mcp does not?**
Zero-dep binary, CLI pipe with no session surface cost, evals with published losses, per-edge honesty rendering, verdict outputs for orchestrators, HTML map export.

**What does trace-mcp do that ripwire does not?**
Cross-session persistent index, {{ site.data.counts.frameworks }} framework edges, AST write path with import rewriting, code-linked memory with staleness checks.

**Can I use both?**
Yes — ripwire CLI for cheap per-call orientation, trace-mcp graph for cross-session structure, framework edges and verified refactoring.

## Next steps

- Learn how a persistent code graph reduces token costs on every turn: [Code graph MCP server](/code-graph-mcp.html).
- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs Serena](/vs/serena.html) · [vs Repomix](/vs/repomix.html) · [vs Cody](/vs/cody.html) · [vs ast-grep](/vs/ast-grep.html) · [vs Aider](/vs/aider.html) · [vs IDE context](/vs/ide-context.html)
- [PR review context benchmark](/pr-context-benchmark.html) — measured input-token cost of code-review context on 60 merged pull requests.
- [Architecture](/architecture.html) — how the indexing pipeline, storage and LSP enrichment fit together.
- [Get started](/#install) — no configuration required.
