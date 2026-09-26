---
title: "IDE Context Alternative: trace-mcp vs Cursor rules, Copilot setup"
description: "Cursor rules and Copilot instructions steer one IDE session; trace-mcp is the persistent graph every agent queries. Session context vs stored edges."
updated: 2026-09-26
---

# IDE context alternative: trace-mcp vs Cursor rules and Copilot instructions

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vs/ide-context.html",
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
        "@id": "https://trace-mcp.com/vs/ide-context.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the difference between IDE rules and a code graph?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Rules are guidance you write: conventions, style, architecture notes the agent should follow, scoped by file globs. A code graph is structure the tool computes: symbols, call edges, framework relations resolved from the code itself. Rules tell the agent how to behave; the graph answers what the code does. One is authored, the other is derived."
          }
        },
        {
          "@type": "Question",
          "name": "Do Cursor rules or Copilot instructions answer who-calls-this?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. An instruction file can tell the agent to check callers before editing, but the file itself contains no caller information — the agent still has to go find it. The graph stores the edges, so the same question is one tool call with no search."
          }
        },
        {
          "@type": "Question",
          "name": "Can trace-mcp replace my Cursor rules?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No, and it should not try. Rules carry judgement the code cannot contain — team conventions, migration intent, what good looks like here. The graph carries facts the rules cannot contain — resolved edges, transitive impact, framework wiring. Keep the rules; add the graph underneath them."
          }
        },
        {
          "@type": "Question",
          "name": "Where does each one live?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Rules live with the repo and the IDE: .cursor/rules versioned in git, team rules on Cursor servers, copilot-instructions.md and .github/instructions in the repository, AGENTS.md at any level. The graph lives beside the repo as a SQLite index, served over MCP to whatever agent is running — IDE, CLI, or CI."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** Cursor rules (`.cursor/rules` with `description`/`globs`/`alwaysApply`, plus team rules and `AGENTS.md`) and Copilot instructions (the repo-wide copilot-instructions.md file in .github, plus path-specific .instructions.md files under .github/instructions) are the same idea in two IDEs: markdown guidance, versioned with the repo, telling the agent how to work here. trace-mcp is a different layer underneath: a persistent graph of what the code *is* — symbols, imports, call edges, {{ site.data.counts.frameworks }} framework integrations — served over MCP to any agent. Rules steer the session; the graph answers the structural questions inside it.

This is a conceptual comparison — there is no single repository on the other side, so there is no star count and no version. Facts below are from Cursor docs and GitHub docs as read on September 26, 2026.

## Head-to-head

| Capability | trace-mcp | IDE rules (Cursor / Copilot) |
|---|:---:|:---:|
| What it is | computed code graph over MCP | authored markdown guidance for one agent |
| Who writes it | the indexer (from your code) | you (conventions, intent, taste) |
| Answers who-calls-this | ✓ one tool call, stored edges | ✗ can instruct the agent to check; holds no edges |
| Impact analysis | ✓ reverse dependency traversal | ✗ |
| Framework-aware edges | ✓ {{ site.data.counts.frameworks }} integrations | ✗ |
| Per-file scoping | n/a (queries scope themselves) | ✓ globs (`**/*.py`), path-specific instruction files |
| Team enforcement | n/a | ✓ team rules, enforced or optional |
| MCP tools advertised (default) | 29 (~11.6K tok); {{ site.data.counts.tools }} on `full` | n/a — rules are prompt text; MCP servers attach per host |
| Persists across sessions | ✓ SQLite index + code-linked memory | ✓ files persist; agent re-reads them per session |
| Works across agents | ✓ any MCP client | partial — AGENTS.md travels; `.mdc` and team rules do not |
| Refactoring write path | ✓ AST rename, move, extract, codemod | ✗ (the agent edits; rules only constrain it) |
| Security scanning | ✓ OWASP Top-10 taint, SARIF 2.1.0 | ✗ |
| Setup cost | index build, then instant queries | ~zero — a markdown file |

Verified on September 26, 2026 against Cursor rules docs (`cursor.com/docs/rules`, `cursor.com/docs/context/rules`) and GitHub Copilot custom-instructions docs plus the VS Code agent-customization page. Cursor rule mechanics (`.mdc` frontmatter, four rule types, Always/Intelligent/Files/Manual application) and Copilot mechanics (repo-wide file, path-specific `.instructions.md`, organisation level) are as those pages state; anything beyond them is marked as guidance, not quoted fact.

## When to pick IDE rules

Honest version — and most teams should do all of this regardless of the graph:

- **Conventions live in versioned markdown.** "Use named exports", "migrations need up *and* down", "never alter a column in place" — the Cursor docs' own examples. No index will ever contain your team's judgement; write it down where the agent reads it.
- **Scoping is free and precise.** Globs attach guidance to exactly the files it governs; path-specific instruction files do the same for Copilot. Scoped text beats a global preamble on every session budget.
- **Team-wide enforcement.** Team rules with enforced-vs-optional, organisation-level Copilot instructions — governance without a new tool to operate.
- **Zero new machinery.** A markdown file needs no daemon, no index build, no MCP client. The cheapest context is the kind you already have.
- **Portability where it exists.** `AGENTS.md` (and `CLAUDE.md`) travel across agents — Cursor reads them, and so does everything Claude-shaped. Rules written there outlive any single IDE.

## When to pick trace-mcp

- **Guidance cannot hold edges.** "Check callers before editing this" is good guidance; the resolved caller list is a graph answer. Rules point at the work, the graph does it.
- **The question is transitive.** "Everything affected by changing this signature, filtered to route handlers" is not expressible as an instruction file — it is a traversal over stored edges.
- **Framework wiring.** Route → handler, controller → template, model → table across {{ site.data.counts.frameworks }} integrations. No rule file models these; the graph stores them.
- **Across agents and sessions.** The index and its code-linked decisions survive IDE switches, CLI sessions and CI runs; rules are re-read per session and `.mdc` files do not travel outside Cursor.
- **Verified action.** AST refactoring with import rewriting, dead-code removal, OWASP taint with SARIF — the agent edits either way, but through the graph it verifies against resolved structure.

## The honest caveat

Rules win on cost and on content no tool can derive: a 200-line markdown file versioned in git beats any index for "how we work here", and at ~zero tokens of machinery it is the first thing every team should write — before us, not instead of us. The graph is the second layer, not the first.

And our standing ceiling, stated on the [comparisons page](/comparisons.html): line-based CFG, lexical taint with type-aware pruning — not a dataflow engine, and out of scope to become one.

## FAQ

**What is the difference between IDE rules and a code graph?**
Authored guidance versus derived structure. Rules tell the agent how to behave here; the graph answers what the code does. One you write, the other the indexer computes.

**Do Cursor rules or Copilot instructions answer who-calls-this?**
No. They can demand the agent check, but they hold no edges — the agent still searches. The graph stores the edges, so the question is one call.

**Can trace-mcp replace my Cursor rules?**
No. Rules carry team judgement the code cannot contain; the graph carries facts the rules cannot contain. Keep the rules; add the graph underneath.

**Where does each one live?**
Rules live with the repo and IDE (`.cursor/rules`, team dashboard, the Copilot instructions files, `AGENTS.md`); the graph lives beside the repo as SQLite, served over MCP to any agent.

## Next steps

- Learn how a persistent code graph reduces token costs on every turn: [Code graph MCP server](/code-graph-mcp.html).
- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs Serena](/vs/serena.html) · [vs Repomix](/vs/repomix.html) · [vs Cody](/vs/cody.html) · [vs ripwire](/vs/ripwire.html) · [vs ast-grep](/vs/ast-grep.html) · [vs Aider](/vs/aider.html)
- [Cut Claude Code token usage](/reduce-claude-code-token-usage.html) — rules-style tactics plus measured graph tactics.
- [Architecture](/architecture.html) — how the indexing pipeline, storage and LSP enrichment fit together.
- [Get started](/#install) — no configuration required.
