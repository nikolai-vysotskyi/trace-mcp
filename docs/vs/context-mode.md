---
title: "Context Mode alternative? trace-mcp vs Context Mode for AI coding agents"
description: "Context Mode keeps raw tool output out of the context window; trace-mcp makes the questions about your code cheap to ask. Head-to-head on tool surface, code parsing, benchmarks, licence — and why running both is the honest answer."
updated: 2026-08-30
---

# trace-mcp vs Context Mode

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": "trace-mcp vs Context Mode",
      "description": "Head-to-head comparison of trace-mcp and Context Mode as context-efficiency MCP servers for AI coding agents.",
      "url": "https://trace-mcp.com/vs/context-mode.html",
      "datePublished": "2026-08-30",
      "dateModified": "2026-08-30",
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
        "@id": "https://trace-mcp.com/vs/context-mode.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Is Context Mode a competitor to trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Mostly no. Context Mode keeps the output of tool calls out of the context window: it runs agent-written scripts in a subprocess and returns only what the script printed, and it indexes long output into SQLite FTS5 for BM25 retrieval. It does not parse source code. trace-mcp parses source code into a symbol graph so that structural questions are cheap to ask in the first place. The two reduce different halves of the same bill and compose in one client."
          }
        },
        {
          "@type": "Question",
          "name": "Does Context Mode build a code graph or symbol index?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. Reading its source on August 30, 2026 at commit 8a35367 (v1.0.169), its runtime dependency list is eight packages — the MCP SDK, better-sqlite3, zod, two HTML-to-Markdown converters, a prompt library and a colour library — with no tree-sitter and no other parser. Its eleven MCP tools are execution, indexing, search, fetch, stats, doctor, upgrade, purge and insight. None of them resolves a symbol, an import edge or a call edge."
          }
        },
        {
          "@type": "Question",
          "name": "What does Context Mode's 98% reduction number actually measure?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "The byte size of a tool's raw output against the byte size of the summary its ctx_execute_file path returns, over 14 fixtures captured from real tools — Playwright snapshots, GitHub API responses, an nginx access log, an analytics CSV. Its own BENCHMARK.md subtotal is 315 KB raw to 5.5 KB, and the fixtures and harness are committed to the repository. It is not an end-to-end measurement of an agent completing tasks, and the project says so itself: its FTS5 retrieval path, measured in the same file, saves 44-93% rather than 98%."
          }
        },
        {
          "@type": "Question",
          "name": "Is Context Mode open source?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "It is source-available, not OSI open source. Its LICENSE file is the Elastic License 2.0 and package.json declares Elastic-2.0; GitHub reports the licence as NOASSERTION. ELv2 forbids providing the software to third parties as a managed service and forbids circumventing licence-key functionality. trace-mcp is MIT. If your employer's policy filters dependencies by licence class, that difference is decided before any feature comparison."
          }
        },
        {
          "@type": "Question",
          "name": "Is Context Mode's sandbox an OS-level sandbox?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No, and the project states this plainly in its own README: the execution tools run arbitrary code and inherit the process's filesystem access, so the boundary guard is defence in depth rather than a full OS sandbox, and approving an execution tool should be read as approving arbitrary code. Its own MCP annotations mark ctx_execute destructiveHint true and openWorldHint true. What it does provide is a scratch working directory, a timeout, and a roughly seventy-entry denylist of environment variables that enable code injection."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** These two tools are not really rivals, and a page that pretended otherwise would be wrong in a way you would catch in ten minutes.

Context Mode attacks the cost of what tool calls *return*. A Playwright snapshot, twenty GitHub issues, an nginx access log — its answer is that the agent should write a script, run it in a subprocess, and put only the printed result into the conversation. Everything long gets indexed into SQLite FTS5 and retrieved by BM25 instead of pasted.

trace-mcp attacks the cost of *asking about code*. It parses your repository into a symbol graph so "what calls this", "what breaks if I change this", "where is this route handled" are single cheap lookups rather than a sequence of reads that need compressing afterwards.

If your agent is drowning in tool output, Context Mode is aimed at your problem and trace-mcp is not. If your agent is drowning in `Read` calls trying to understand a codebase, it is the other way round. Both connect to the same client at the same time.

## Head-to-head

| Capability | trace-mcp | Context Mode |
|---|:---:|:---:|
| **GitHub stars** | 102 | ~20.2K |
| Licence | MIT | Elastic License 2.0 (source-available, not OSI) |
| Written in | TypeScript | TypeScript |
| MCP tools defined | {{ site.data.counts.tools }} | 11 |
| MCP tools advertised (default) | 28 (~11.6K tok) | 11 — all of them |
| Parses source code (AST) | ✓ tree-sitter, {{ site.data.counts.languages }} languages | ✗ no parser in its dependency tree |
| Symbol index | ✓ | ✗ |
| Cross-file dependency graph | ✓ directed edge graph | ✗ |
| Call graph | ✓ bidirectional | ✗ |
| Impact analysis | ✓ reverse traversal + decorator filter | ✗ |
| Framework-aware edges | ✓ {{ site.data.counts.frameworks }} integrations | ✗ |
| Refactoring tools | ✓ rename, move, signature, codemod, dead code | ✗ |
| Security scanning | ✓ OWASP Top-10, type-aware taint | ✗ |
| Runs agent-written code | ✗ by design | ✓ 12 runtimes, subprocess |
| Compresses other tools' output | ✗ | ✓ core premise |
| Full-text search over arbitrary content | ✓ FTS5 over the indexed repo | ✓ FTS5 + BM25 over docs, logs, fetched pages |
| Fetches and indexes web pages | ✗ | ✓ `ctx_fetch_and_index` |
| Survives context compaction | ✓ decision memory, code-linked | ✓ session snapshot replayed after compaction |
| Cross-session memory | ✓ decisions bound to symbol IDs | ✓ session events, deleted unless `--continue` |
| Client coverage | any MCP client | 17 hosts, but session continuity varies by host |
| Runs fully local, no API key | ✓ | ✓ |
| Published measurement | per-repo `get_real_savings` | ✓ 21 fixtures, harness in repo |

Verified on August 30, 2026 against Context Mode's source at commit `8a35367`, matching `package.json` version `1.0.169`. Tool, parser and storage claims come from the source; host-coverage and self-stated limits come from its README, quoted below.

## What Context Mode actually is, from its source

Four things are worth stating precisely, because the marketing word "context" covers both products and hides how differently they work.

**Eleven tools, all advertised.** `ctx_execute`, `ctx_execute_file`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`, `ctx_batch_execute`, `ctx_stats`, `ctx_doctor`, `ctx_upgrade`, `ctx_purge`, `ctx_insight`. There is no preset system and no deferred loading; the one mode that hides them is the embedded-plugin path, where the host registers the same eleven natively instead.

**"12 languages" is not the same axis as our language count.** Context Mode's list — JavaScript, TypeScript, Python, shell, Ruby, Go, Rust, PHP, Perl, R, Elixir, C# — is the set of runtimes it can *shell out to* in order to run a script you wrote. trace-mcp's {{ site.data.counts.languages }} is the set of grammars it can *parse* to build a graph. Reading the two numbers as comparable is the single easiest mistake to make about these tools, and it is worth not making it in either direction.

**The "sandbox" is hardening, not isolation.** A scratch temp directory, a timeout, and a large denylist of environment variables that enable injection (`LD_PRELOAD`, `NODE_OPTIONS`, `PYTHONSTARTUP`, `RUBYOPT`, `BASH_ENV` and roughly seventy in all, each annotated with its rationale). No container, no seccomp, no VM. The project says this itself rather than leaving you to find it: its README states that the execution tools "run arbitrary code and still inherit the process's filesystem access, so the boundary guard is a defense-in-depth layer for the *file-read* tool, not a full OS sandbox — treat approving any execution tool as approving arbitrary code, and keep host-level sandboxing enabled." Its MCP annotations agree: `ctx_execute` is marked `destructiveHint: true` and `openWorldHint: true`.

**The benchmark is real, narrow, and honestly bounded.** `BENCHMARK.md` reports 21 scenarios over fixtures captured from actual tool output — Context7 docs, Playwright page snapshots, GitHub issue lists, vitest and tsc output, an nginx log, a 500-row analytics CSV — with the fixtures and the harness committed. The headline "315 KB becomes 5.4 KB, 98% reduction" is the subtotal of the 14 `ctx_execute_file` scenarios (its own table says 5.5 KB). The same file reports the FTS5 retrieval path at 44-93%, and labels the overall figure 96%. It measures output bytes, not task success — but it names its fixtures and ships them, which is more than most claims in this field do.

## When to pick Context Mode

- **Your context is being eaten by tool output, not by code reading.** Browser automation, log analysis, big API responses, CI output. That is exactly the problem it was built for, and trace-mcp does nothing about it.
- **You want the agent to compute rather than read.** "Write a script that counts, print the count" is a genuinely good instinct, and Context Mode makes it a first-class routed path instead of a habit you have to nag the model into.
- **You need continuity across compaction on a supported host.** Its session snapshot is rebuilt and re-injected after the conversation compacts. Check its host table first, because coverage is uneven: it calls session support *full* on Claude Code, OpenCode and KiloCode; *high* on Gemini CLI, VS Code and JetBrains Copilot, GitHub Copilot CLI, OpenClaw, Pi and OMP (tool events captured, user decisions mostly not); *partial* on Cursor, Codex CLI, Antigravity CLI and Kiro; and Antigravity IDE and Zed have no hook support and get no session tracking at all.
- **You are not shipping it as a service.** For ordinary internal use, ELv2 is unlikely to bother you.

## When to pick trace-mcp

- **The expensive question is structural.** "What breaks if I change this signature", "who calls this", "which template does this controller render". Those are graph queries. Context Mode has no graph to query — it would help your agent write a script that greps, and a grep is not a resolved edge.
- **You want the work that comes after understanding.** Rename across a repo, move a symbol with its imports, an AST codemod, taint analysis, SARIF for CI, verified dead-code removal. None of that exists in Context Mode's eleven tools.
- **Your memory needs to be about code, not about the session.** trace-mcp's decisions bind to symbol IDs and are checked for staleness before recall, so a decision about a function that has since changed does not get replayed as if it still held. Context Mode's session store is an event journal about the conversation, and it is wiped on a fresh start unless you pass `--continue`.
- **Licence class matters where you work.** MIT against ELv2 is a policy question at many companies, and it gets decided before anyone reads a feature table.

## Where we are not being smug

**Their advertised surface is smaller than ours and always fully loaded.** Eleven tools against our 28 at roughly 11.6K tokens at session start. If you run both servers, you pay both — that is a real cost of the "run them together" recommendation on this page, and you should weigh it rather than take the recommendation on faith.

**Their measurement is published and ours is not, again.** This is the third head-to-head page where we have to write that sentence. We publish a conservative 40-50% and ship `get_real_savings` so you can measure your own repository, which is a defensible choice and not a substitute for a benchmark with named fixtures you can re-run.

**They are 200 times our size, and it is not only marketing.** A tool that reaches 20K stars in six months has found something people wanted. The "think in code" framing is a genuinely good idea that we do not have an equivalent of.

If you maintain Context Mode and something here is wrong, [open an issue](https://github.com/nikolai-vysotskyi/trace-mcp/issues) and we will fix it.

## FAQ

**Is Context Mode a competitor to trace-mcp?**
Mostly no. It compresses what tools return; we make questions about code cheap to ask. Different halves of the same bill, and they compose in one client.

**Does Context Mode build a code graph or symbol index?**
No. At commit `8a35367` its eight runtime dependencies contain no tree-sitter and no other parser, and none of its eleven tools resolves a symbol, an import edge or a call edge.

**What does the 98% reduction number actually measure?**
Raw output bytes against summary bytes, over 14 committed fixtures, on the `ctx_execute_file` path only. Its own file reports 44-93% for FTS5 retrieval and 96% overall. It is not a task-success benchmark, and it does not claim to be.

**Is Context Mode open source?**
Source-available under the Elastic License 2.0, which GitHub reports as NOASSERTION. ELv2 forbids offering the software as a managed service. trace-mcp is MIT.

**Is its sandbox an OS-level sandbox?**
No — a scratch directory, a timeout and an environment denylist. Its README says outright that approving an execution tool means approving arbitrary code and that host-level sandboxing should stay on.

**Can I run both?**
Yes, and for a codebase-heavy agent that also drives browsers or CI, that is probably the right setup. Budget for both tool surfaces at session start.

## Next steps

- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs Repomix](/vs/repomix.html) · [vs Serena](/vs/serena.html) · [vs codebase-memory-mcp](/vs/codebase-memory-mcp.html) · [vs codegraph](/vs/codegraph.html)
- [Cut Claude Code token usage](/reduce-claude-code-token-usage.html) — seven tactics, ordered by measured impact.
- [Get started](/#install) — no configuration required.
