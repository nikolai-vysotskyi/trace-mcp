---
title: "Repomix vs codegraph: packing a repo vs indexing it for AI agents"
description: "Repomix packs a repo into one file an agent reads; codegraph indexes it into a graph an agent queries. Head-to-head on cost, freshness and benchmarks."
updated: 2026-09-02
---

# Repomix vs codegraph

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vs/repomix-vs-codegraph.html",
      "datePublished": "2026-09-02",
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
        "@id": "https://trace-mcp.com/vs/repomix-vs-codegraph.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the difference between Repomix and codegraph?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Repomix packs a repository into one consolidated file that a model reads. codegraph parses a repository into a symbol and call graph in SQLite that an agent queries. Repomix hands over content; codegraph answers questions about structure. That single difference explains almost every other row in a comparison between them."
          }
        },
        {
          "@type": "Question",
          "name": "Is Repomix or codegraph cheaper in tokens?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "It depends on how many turns the agent spends in the repository. A Repomix pack is a fixed up-front cost paid on every prompt that carries it, and re-paid on every repack; --compress cuts roughly 70% of it by keeping signatures and dropping bodies. codegraph advertises one tool for about 1.9K tokens and then charges per query, and its own August 2026 benchmark across seven repositories reports 62% fewer tokens and 44% lower cost than a file-reading agent. For a single question about a small repository, Repomix usually wins. Across a long session on a repository too large for the context window, the graph wins."
          }
        },
        {
          "@type": "Question",
          "name": "Do Repomix and codegraph both stay up to date as I edit code?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Both have a watcher, but they refresh different things. Repomix's --watch re-packs the whole output after a 300 ms debounce, and it only works on local directories. codegraph auto-syncs the graph per changed file and, during its debounce window, prepends a staleness banner naming any pending file so the agent reads that file directly instead of trusting the index."
          }
        },
        {
          "@type": "Question",
          "name": "Can Repomix answer who calls this function?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Not as a computed answer. Its MCP server exposes grep_repomix_output, which runs a JavaScript regular expression over the packed text, so it finds the string. A regex over a pack cannot distinguish a call from a comment, follow an import to a re-export, or resolve dynamic dispatch. codegraph resolves those as graph edges, which is what codegraph_explore returns as call paths and a blast-radius summary."
          }
        },
        {
          "@type": "Question",
          "name": "Can I use Repomix and codegraph together?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, and the split is natural. Repomix packs a remote third-party repository you do not own into a single prompt in seconds; codegraph indexes the repository you work in every day. They do not overlap in either direction and neither requires an API key or sends code anywhere."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** Repomix and codegraph are both answers to "my agent does not know my codebase", and they are opposite answers. Repomix **packs**: it concatenates the repository into one consolidated file the model reads. codegraph **indexes**: it parses the repository into a symbol and call graph in SQLite the agent queries. Repomix hands over content. codegraph answers questions about structure.

Pick Repomix when the repository is small enough to hand over whole, or when it is somebody else's and you want to look at it once. Pick codegraph when the agent will spend many turns in a repository too large to hand over at all.

Everything below was verified against both projects' public README and docs on **September 2, 2026**. We build [trace-mcp](/), which is in the same lane as codegraph; the last section says plainly where we differ and where each of these beats us.

## Head-to-head

| | Repomix | codegraph |
|---|:---:|:---:|
| **GitHub stars** | {{ site.data.competitors.repomix.stars }} | {{ site.data.competitors.codegraph.stars }} |
| License | MIT | MIT |
| Model | one-shot pack | live index (SQLite) |
| What the agent receives | file content | resolved symbols, call paths, blast radius |
| Parses code | ✓ tree-sitter, `--compress` only (experimental) | ✓ tree-sitter, always |
| Languages | not enumerated for `--compress`; 19 for comment stripping | 34 |
| Cross-file dependency edges | ✗ | ✓ |
| Call graph | ✗ | ✓ including dynamic-dispatch hops |
| Impact analysis | ✗ | ✓ blast radius inline in `explore` |
| Framework-aware route edges | ✗ | ✓ 15 route-shape families |
| Navigation (`navigates`) edges | ✗ | ✓ 7 routers (Next.js, Expo, React Router, TanStack, Vue/Nuxt, SvelteKit) |
| Cross-language bridging | ✗ | ✓ Swift ↔ Obj-C, React Native bridge, Expo, Fabric |
| Search | ✓ regex over the pack (`grep_repomix_output`) | ✓ graph query |
| Remote repositories | ✓ `--remote owner/name` | ✗ index a local checkout |
| Freshness | `--watch`, 300 ms debounce, full re-pack, local dirs only | auto-sync per file + staleness banner on pending files |
| MCP server | ✓ `--mcp`, 5 tools (+2 in `--sandbox`) | ✓ **1** advertised tool, 7 more behind an env allowlist |
| Refactoring / write path | ✗ | ✗ |
| Security scanning | ✓ Secretlint (secrets only) | ✗ |
| Published A/B benchmark | ✗ token counting, no A/B | ✓ 7 repos, model/queries/run count disclosed |
| Runs local, no API key | ✓ | ✓ |

Sources: Repomix's README and CLI reference; codegraph's README at the `main` head, and its source at commit `b9ca4b79` for the tool-surface row. Star counts read from the GitHub API the same day — they move fast in this space, so treat them as a snapshot rather than a ranking.

## When to pick Repomix

- **The repository is not yours.** `repomix --remote owner/name` gives you a third-party codebase in a prompt in seconds, with `--remote-branch` for a tag or a commit. codegraph indexes a local checkout; there is no remote mode.
- **The whole thing fits in context.** If the model can hold every file, a graph buys you nothing — it already has the answer to every structural question, in full.
- **You want no MCP client in the loop.** A pack is a file. Paste it into a web chat, attach it to a ticket, hand it to a colleague. codegraph is only useful through a tool call.
- **You need the pack itself as an artifact.** `--token-count-tree` shows where the tokens are, and `--token-budget` fails a CI job when the packed output exceeds a threshold. That is a build-pipeline primitive; a graph is not.
- **Secrets scanning on the way out.** Repomix runs Secretlint over what it packs, so a key in a `.env` does not silently land in a prompt.

## When to pick codegraph

- **The repository does not fit, and re-packing is the cost you are trying to avoid.** codegraph's own benchmark is exactly this shape: on questions where a file-reading agent needed 28–43 tool calls and up to 19 file reads, the agent with the graph answered from one to four `codegraph_explore` calls and read zero files.
- **The question is structural.** "What breaks if I change this", "who calls this", "how does the request reach this handler". A pack contains the bytes that would answer it, but nothing that computes the answer — and `grep_repomix_output` finds the string, not the edge.
- **Your stack has boundaries a parser normally stops at.** Route to handler across 15 framework families, `navigates` edges across 7 routers, and Swift ↔ Objective-C and React Native bridge hops.
- **You care about the advertised tool surface.** codegraph defines eight MCP tools and lists **one**. Its stated reasoning is that the other seven are narrower slices of `explore` and that presence itself steers agents into mis-picking. The whole surface costs roughly 1.9K tokens. Repomix's MCP server lists five.
- **Staleness has to be visible, not assumed.** During the debounce window, codegraph prepends a banner naming pending files and tells the agent to read them directly. A pack has no equivalent: it is silently stale from the first edit after it was written.

## Where each of them is honestly weak

**Repomix cannot compute anything.** Its `--compress` mode is tree-sitter, and it is genuinely good at what it does — signatures kept, bodies dropped, roughly 70% of the bytes gone — but it is lossy summarisation *per file*. There is no cross-file edge in a pack, at any compression level, and no amount of grep over one recovers a call graph.

**codegraph leaves more context resident, and says so.** Its README reports that across the same seven repositories, its responses leave about **80% more retrieval context** in the window at the end of a multi-turn session than a file-reading agent's do — 67K tokens against 18K on VS Code. Fewer tokens *processed* and a larger persistent *footprint* are both true at once. Publishing that is a point in its favour, and it is a real cost in a small context window.

**Neither one writes code.** No rename across files, no move, no signature change, no codemod. Both are read paths.

**Neither benchmark is third-party.** codegraph's is self-run — well documented, with the model, the queries, four runs per arm and a disclosed correction to its own earlier harness, but self-run. Repomix publishes token counts, not an A/B at all.

## Where trace-mcp fits

We are in codegraph's lane, not Repomix's, and it would be dishonest to pretend the comparison flatters us on every axis.

[trace-mcp](/) is a precomputed graph like codegraph's, with two differences that matter and one that costs us. It ships {{ site.data.counts.frameworks }} framework integrations that model edges beyond routing — controller → template, model → table, component → component — across {{ site.data.counts.languages }} languages. And it has a write path: rename, move, signature change, AST codemod, dead-code removal, plus OWASP taint scanning and SARIF for CI, none of which either tool above has.

What it costs: our default preset advertises 28 tools at roughly 11.6K tokens, against codegraph's one tool at ~1.9K. That gap is the honest reason to pick codegraph if orientation is the whole job. It is real money paid every session, and what it buys is the write path above plus everything outside the preset one `load_tools` call away.

On measurement we can offer one thing neither of them does: the [PR review context benchmark](/pr-context-benchmark.html) is a median {{ site.data.pr_context_bench.median_savings_pct }}% input-token reduction over {{ site.data.pr_context_bench.pr_count }} merged pull requests in {{ site.data.pr_context_bench.repo_count }} open-source repositories nobody here maintains, with the base and head SHAs, the losing cases, and the command that re-runs it all shipped in the repository.

Head-to-head, one at a time: [trace-mcp vs Repomix](/vs/repomix.html) · [trace-mcp vs codegraph](/vs/codegraph.html).

## FAQ

**What is the difference between Repomix and codegraph?**
Repomix packs a repository into one file a model reads. codegraph parses it into a symbol and call graph an agent queries. Content versus computed structure — that one difference explains almost every other row above.

**Is Repomix or codegraph cheaper in tokens?**
It depends on session length. A pack is a fixed up-front cost, re-paid on every repack; `--compress` cuts roughly 70% of it. codegraph advertises one tool at ~1.9K tokens and charges per query, and reports 62% fewer tokens and 44% lower cost than a file-reading agent across seven repositories. One question, small repo: Repomix. Long session, large repo: codegraph.

**Do they both stay up to date as I edit?**
Both watch, but refresh different things. Repomix's `--watch` re-packs the whole output after a 300 ms debounce and works on local directories only. codegraph syncs the graph per changed file and flags pending files in the response so the agent reads them directly.

**Can Repomix answer "who calls this function"?**
Not as a computed answer. `grep_repomix_output` runs a JavaScript regex over the packed text, so it finds the string — not the call. It cannot tell a call from a comment, follow a re-export, or resolve dynamic dispatch.

**Can I use both?**
Yes. Repomix for a remote repository you want to look at once; codegraph for the one you work in daily. No overlap, no API key on either side.

## Next steps

- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers, with the same sourcing discipline.
- The head-to-heads: [vs Repomix](/vs/repomix.html) · [vs codegraph](/vs/codegraph.html) · [vs Serena](/vs/serena.html) · [vs codebase-memory-mcp](/vs/codebase-memory-mcp.html) · [vs Context Mode](/vs/context-mode.html)
- [Cut Claude Code token usage](/reduce-claude-code-token-usage.html) — the measured tactics, including the ones that have nothing to do with any of these tools.
