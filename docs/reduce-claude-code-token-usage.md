---
title: "How to Reduce Claude Code Token Usage — 7 measured tactics"
description: "Seven ways to cut token usage in Claude Code, ordered by measured impact: stop full-file reads, trim your MCP tool surface, pick the output format."
updated: 2026-09-04
---

# How to reduce Claude Code token usage

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/reduce-claude-code-token-usage.html",
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
        "@id": "https://trace-mcp.com/reduce-claude-code-token-usage.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What actually uses the most tokens in Claude Code?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Three things, in this order: repeated full-file reads during exploration, the MCP tool schemas advertised at session start, and long transcripts that carry every earlier tool result forward. Exploration dominates on large repositories, because finding the right file costs many reads before any useful one happens."
          }
        },
        {
          "@type": "Question",
          "name": "Do MCP servers increase or decrease token usage?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Both. Every MCP server pays a fixed up-front cost — its tool schemas are injected into the context at session start — and then saves tokens per query if its answers are narrower than the file reads they replace. A server with a large advertised surface and few calls per session is a net loss. Check the cost: run tools/list and count the tokens before deciding."
          }
        },
        {
          "@type": "Question",
          "name": "Does asking for an outline instead of reading the file really help?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Substantially, when you only need structure. An outline returns signatures and line ranges without bodies, so a 500-line file becomes a short list. The pattern that pays is outline first, then read only the specific symbol or line range you need — rather than reading the whole file to edit five lines of it."
          }
        },
        {
          "@type": "Question",
          "name": "Does output format affect token cost?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Measurably, but only for the right payload shape. On trace-mcp's own measurements with the cl100k_base tokenizer, TOON encoding beat JSON by 31.4% on query_decisions and 28.8% on get_outline, where every row has the same scalar fields. On payloads with nested objects or inner arrays it lost — minus 17.5% on find_usages and minus 25.5% on search_text. Format is a per-tool decision, not a global switch."
          }
        },
        {
          "@type": "Question",
          "name": "Is clearing context the same as saving tokens?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No, and it is often worse. Clearing throws away work the agent has to redo, and re-derivation usually costs more than the transcript did. Compacting or handing off a short written summary keeps the conclusions while dropping the raw tool output that made them."
          }
        }
      ]
    }
  ]
}
</script>

Token cost in Claude Code is not mostly the code you show it. It is the code it reads **looking for** the code it needs, plus everything it re-reads on later turns because the earlier result scrolled out of reach.

Below are seven tactics ordered by how much they moved the number in our own measurements, with the numbers we actually have and honest gaps where we do not have any. Several of them have nothing to do with trace-mcp; those come first, because they are free.

## 1. Stop paying for exploration twice

The dominant cost on a repository too large to fit in context is *search*, not reading. An agent asked "where is rate limiting handled" will open a dozen candidate files before it finds the one that matters, and every one of those reads stays in the transcript for the rest of the session.

Two cheap habits fix most of it:

- **Name the file when you know it.** "Fix the retry backoff in `src/http/client.ts`" costs one read. "Fix the retry backoff" costs an exploration.
- **Ask for structure before content.** Signatures and line ranges are a fraction of a file's tokens, and they are usually enough to pick the one symbol worth reading in full.

## 2. Read symbols, not files

Reading a 500-line file to change five lines pays for 495 lines you did not need — and pays again on the next turn if the result gets re-read. The pattern that works is outline → one symbol → edit.

This is what trace-mcp's `get_outline` and `get_symbol` exist for: the first returns signatures with line numbers, the second returns exactly one function or class. Claude Code's native `Read` supports `offset`/`limit` and will do the same job once you know the range, which is precisely what the outline gives you.

## 3. Audit your MCP tool surface — including ours

This is the tactic most people never check, and it can dominate everything else.

Every MCP server you connect injects its tool schemas into the context **at session start, before you ask anything**. Three servers with large surfaces can cost tens of thousands of tokens on every single session, whether or not you call any of them.

Measured on our own server, August 29, 2026: trace-mcp's shipped default is the `minimal` (28 tools) preset — ~9.8K tokens of `tools/list` plus ~1.75K tokens of server instructions, **~11.6K in total**, which is the number to budget against because a client pays both. (`full` ({{ site.data.counts.tools }} tools) is ~49.9K + ~2.1K if you opt into it.) That is still not cheap, and we say so on our own [comparisons page](/comparisons.html) — the leanest peers in this category advertise ~1.9K and ~7K tokens by shipping a small default surface with the rest opt-in.

What to do about it:

- Run `tools/list` against each server you have connected and count the tokens. Most people have never looked.
- Disconnect servers you are not using in this project. A server connected "just in case" is a fixed tax.
- Use a preset or allowlist where the server offers one. trace-mcp ships `minimal` (28 tools), `standard` (60 tools) and `full` ({{ site.data.counts.tools }} tools), plus `tools.include` / `tools.exclude` in config.
- **Previously noted here as broken, now fixed:** presets used to take effect only when the daemon was bypassed (`TRACE_MCP_NO_DAEMON=1`) and were silently ignored on the default daemon-backed path. That bug is shipped and closed — the preset is honoured on both paths, and `TRACE_MCP_NO_DAEMON=1` is no longer needed as a workaround. Measured on the default path: `standard` serves ~18.8K tokens of `tools/list` plus ~1.75K of server instructions (~20.5K), against ~49.9K + ~2.1K for `full`.
- **One caveat that is still live:** set these in the global `~/.trace/.config.json`. `tools.preset` is honoured from a project-local `.trace/.config.json` too, but `tools.description_verbosity` / `tools.instructions_verbosity` are not — set those globally until that is fixed.

## 4. Pick the output format per tool, not globally

Encoding matters, but not uniformly. Our measurements (`scripts/bench-toon.ts`, `gpt-tokenizer` with the cl100k_base encoding, against a snapshot of this repo's own index — 1,501 files, 9,467 symbols):

| Payload shape | Format change | Measured |
|---|---|---:|
| Flat, same scalar fields per row (`query_decisions`) | JSON → TOON | **+31.4%** |
| Flat symbol records (`get_outline`) | JSON → TOON | **+28.8%** |
| Flat item records (`search`) | JSON → TOON | **+16.4%** |
| Nested object per row (`find_usages`) | JSON → TOON | **−17.5%** |
| Inner array per row (`search_text`) | JSON → TOON | **−25.5%** |
| Repeated long paths (`search_text`) | flat → grouped by file | **+20.8%** |

The rule underneath: compact tabular encodings win when every row has the same scalar columns, and lose the moment a row contains a nested object or an inner array. Full method and the breakeven curve are on the [TOON savings page](/toon-savings.html).

Every number in this section is measured by trace-mcp on trace-mcp. The one measurement taken on code we do not own is the [PR review context benchmark](/pr-context-benchmark.html) — {{ site.data.pr_context_bench.pr_count }} merged pull requests across {{ site.data.pr_context_bench.repo_count }} open-source repositories — and to see what any of this is worth on your own sessions rather than on ours, [session analytics](/analytics.html) reports the same figures from your local agent logs.

## 5. Prefer one structural query over many reads

"What breaks if I change this function" answered by reading files is an open-ended crawl: find the definition, grep for the name, open each hit, follow each of those. Answered from a dependency graph it is one call that returns the affected symbols and the tests covering them.

The same applies to "who calls this", "which tests cover this", and "what does this module import". These are graph traversals. If your tooling can compute them, the token cost is the answer's size rather than the search's size — and the search is the expensive part.

## 6. Compact, don't clear

Clearing the context feels like saving tokens and usually is not: the agent re-derives what it lost, and re-derivation costs more than the transcript did. Compaction — or simply writing a short summary of conclusions and starting fresh from it — keeps the findings while dropping the raw tool output that produced them.

## 7. Index once, query many times

The reason a code index pays off is amortisation. Building it costs something once; every query afterwards is cheap and scoped. A packing tool that concatenates your repository into a prompt pays its full cost on **every** refresh, which is fine for a one-shot question and expensive across a long session.

That is the trade in one line: if your session is a single question about a small repository, pack it. If it is many turns against a repository too large to fit in context, index it. We wrote up the specifics against the main packing tool in [trace-mcp vs Repomix](/vs/repomix.html).

## What we claim, and what we have measured

### The number moved on 5 September 2026, and here is why

Until that date this site and the README claimed **~40–50% fewer tokens on average**. That figure was not a measurement. It descended from a counter in `src/savings.ts` that scored every tool call *before the tool ran*: `RAW_COST_ESTIMATES[tool] × 0.15`, a constant. Thousands of calls, zero variance — 5,123 `search_text` calls each booked exactly 2,550 tokens saved. We found it ourselves, in [TRA-880](https://github.com/nikolai-vysotskyi/trace-mcp/pull/915), and the counter now measures the real response instead.

The figure we publish in its place is **{{ site.data.response_tokens.reduction_pct }}%**, over {{ site.data.response_tokens.calls_weighted }} recorded calls of twelve tools, with each tool's response counted in `o200k_base` tokens on the wire. Read the caveats before quoting it:

- **The measured half is the response. The baseline half is still an estimate.** "What a `Read`/`Grep` would have cost instead" is hand-written in `RAW_COST_ESTIMATES` and has never been validated. Until it is, this is a measured numerator over an estimated denominator.
- **One machine's usage mix**, not the field — the call weighting comes from a single maintainer store (`benchmarks/response-tokens/call-volume.json`, with provenance).
- **{{ site.data.response_tokens.tools_costing_more }} of the {{ site.data.response_tokens.tools_measured }} tools measured return *more* tokens than the baseline they replace** — `search`, `find_usages`, `get_complexity_report` and `get_call_graph`. The old counter booked a positive number for them anyway. The per-tool table is published in full: [tool response token cost](/perf/response-tokens/).
- It still varies enormously with repository size and session shape; on a small repo that fits in context it is roughly zero.

The one figure here that is neither ours nor an estimate is the [PR review context benchmark](/pr-context-benchmark.html) — {{ site.data.pr_context_bench.median_savings_pct }}% median over {{ site.data.pr_context_bench.pr_count }} merged pull requests in {{ site.data.pr_context_bench.repo_count }} repositories we do not maintain, SHAs pinned and losing cases published. The numbers on this page that come with a script and a tokenizer are the ones in section 4; those you can reproduce.

We still do not have a published, independently reproducible *end-to-end session* benchmark, and at least one competitor does. We would rather write that here than quietly imply otherwise.

## FAQ

**What actually uses the most tokens in Claude Code?**
Repeated full-file reads during exploration, the MCP tool schemas advertised at session start, and long transcripts carrying every earlier tool result forward — in that order on large repositories.

**Do MCP servers increase or decrease token usage?**
Both. Each pays a fixed up-front schema cost and then saves per query if its answers are narrower than the reads they replace. A large surface with few calls per session is a net loss. Measure it with `tools/list`.

**Does asking for an outline instead of reading the file really help?**
Yes, when you only need structure. Outline first, then read the specific symbol or line range — instead of reading 500 lines to edit five.

**Does output format affect token cost?**
Measurably, per payload shape. TOON beat JSON by 31.4% on `query_decisions` and 28.8% on `get_outline`, and lost by 17.5% and 25.5% on `find_usages` and `search_text`. It is a per-tool decision.

**Is clearing context the same as saving tokens?**
No — clearing forces re-derivation, which usually costs more. Compact, or hand off a short written summary.

## Next steps

- [Tools reference](/tools-reference.html) — every trace-mcp tool, including the outline/symbol/impact ones above.
- [TOON savings](/toon-savings.html) — the full measurement method behind section 4.
- [Configuration](/configuration.html) — presets and `tools.include` / `tools.exclude`.
- [Get started](/#install) — no configuration required.
