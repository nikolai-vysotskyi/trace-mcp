---
title: "CodeGraphContext Alternative: trace-mcp vs CodeGraphContext for AI agents"
description: "CodeGraphContext drives 11 SCIP indexers into a graph database you choose. trace-mcp ships one embedded store, framework edges and a write path."
updated: 2026-09-06
---

# CodeGraphContext alternative: trace-mcp vs CodeGraphContext

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vs/codegraphcontext.html",
      "datePublished": "2026-09-06",
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
        "@id": "https://trace-mcp.com/vs/codegraphcontext.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the core difference between CodeGraphContext and trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "CodeGraphContext goes further than anyone on compiler-grade references: an opt-in path shells out to eleven Sourcegraph SCIP indexer families and folds their symbol data into a property graph held in a graph database you choose from six backends. trace-mcp ships one embedded SQLite+FTS5 store with no backend decision, resolves framework edges across 87 integrations, and writes code as well as reading it."
          }
        },
        {
          "@type": "Question",
          "name": "Does CodeGraphContext need a graph database installed?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "It needs one of six backends: FalkorDB Lite (the default on Unix with Python 3.12+), FalkorDB Remote, KuzuDB, LadybugDB, Nornic DB or Neo4j. The embedded ones are a pip install rather than a server, but they are still a decision, and KuzuDB and LadybugDB default to a 4 GiB buffer pool. trace-mcp has no backend question: the index is an embedded SQLite file."
          }
        },
        {
          "@type": "Question",
          "name": "Which one has the larger MCP tool surface?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "CodeGraphContext defines 29 tools and advertises all 29, roughly 3.7K tokens of schema, trimmable only through a disabledTools denylist. trace-mcp advertises 28 on its default preset — about 11.6K tokens once the server-instructions block is counted — and keeps the rest one load_tools call away. Their default surface is cheaper than ours."
          }
        },
        {
          "@type": "Question",
          "name": "Can CodeGraphContext refactor code or scan for vulnerabilities?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. Reading its source at repository head on September 6, 2026 turned up no rename, move or codemod tooling, no taint analysis or security rules, no SARIF output and no cross-session decision memory. It detects dead code and computes cyclomatic complexity, but it reports rather than writes. trace-mcp ships all of those."
          }
        },
        {
          "@type": "Question",
          "name": "What are CodeGraphContext bundles?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Portable pre-indexed graph snapshots, published to a public registry hosted as a Hugging Face dataset and pulled with load_bundle or search_registry_bundles, so you can skip indexing a dependency by fetching someone else's graph of it. No other server in this field ships that, trace-mcp included."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** CodeGraphContext is the peer that drives the most compiler-grade indexers, and that is the thing to understand before comparing anything else. Turn on `SCIP_INDEXER=true` and it shells out to **eleven** Sourcegraph SCIP indexer families, folds their symbol data into its property graph, and falls back to tree-sitter for whatever SCIP did not cover. Nobody else here does that, us included: our bridge auto-runs three.

The price is set-up. Every SCIP language needs its indexer binary installed first, C/C++ additionally need a `compile_commands.json`, and the graph itself lives in one of six database backends you pick between. trace-mcp asks none of those questions — one embedded SQLite+FTS5 store, no binaries, no backend — and spends its complexity budget elsewhere: {{ site.data.counts.frameworks }} framework integrations resolving route → handler, controller → template and model → table, plus a write path.

Pick CodeGraphContext when reference precision on a mainstream language justifies installing a toolchain. Pick trace-mcp when the job continues past reading.

## Head-to-head

| Capability | trace-mcp | CodeGraphContext |
|---|:---:|:---:|
| **GitHub stars** | {{ site.data.competitors.trace_mcp.stars }} | {{ site.data.competitors.codegraphcontext.stars }} |
| License | MIT | MIT |
| Written in | TypeScript | Python |
| Maturity self-classified | stable releases | `Development Status :: 3 - Alpha` |
| Languages (tree-sitter) | {{ site.data.counts.languages }} | 23 |
| SCIP indexers driven for you | 3 (scip-typescript, scip-python, rust-analyzer) | **11 families**, opt-in via `SCIP_INDEXER=true` |
| Ingests a `.scip` index you built | ✓ | ✓ |
| Framework integrations | ✓ {{ site.data.counts.frameworks }} | 2 tools, Java Spring only |
| Framework edges beyond routing | ✓ controller → template, model → table, component → component | ✗ |
| Storage | embedded SQLite + FTS5, no choice to make | 6 backends: FalkorDB Lite / Remote, KuzuDB, LadybugDB, Nornic DB, Neo4j |
| Runs fully local, no API key | ✓ | ✓ (embedded backends) |
| MCP tools defined | {{ site.data.counts.tools }} | 29 |
| MCP tools advertised by default | 28 (~11.6K tok) | **29** (~3.7K tok) |
| Trimming the surface | ✓ presets + `load_tools` allowlist | `disabledTools` denylist |
| Raw graph query escape hatch | ✗ fixed tool set | ✓ `execute_cypher_query` |
| Portable pre-indexed bundles | ✗ | ✓ `.cgc` snapshots, Hugging Face registry |
| Database structure as graph nodes | ✗ | ✓ MySQL, Redis, Cassandra ingesters |
| Impact analysis | ✓ reverse traversal + decorator filter | ✓ `simulate_architectural_change` (reports only) |
| Dead code / complexity | ✓ detect **and** remove | ✓ detect only |
| Refactoring tools | ✓ rename, move, signature, AST codemod, extract | ✗ |
| Security scanning | ✓ OWASP Top-10, type-aware taint | ✗ |
| SARIF / CI output | ✓ 2.1.0, schema-validated | ✗ |
| Session memory | ✓ code-linked decision graph | ✗ |
| Published token benchmark | ✓ [PR review context](/pr-context-benchmark.html), {{ site.data.pr_context_bench.pr_count }} merged PRs | ✗ |

Verified on September 6, 2026 against CodeGraphContext's source at repository head (`pyproject.toml` 0.6.13, latest tagged release v0.5.7, pushed that day). Tool count and names come from `src/codegraphcontext/tool_definitions.py`, the denylist from `server.py`, the indexer families from `tools/scip_indexer.py`, backends and language count from the README's own tables.

## When to pick CodeGraphContext

- **You want references a heuristic parser cannot give you, across a lot of languages.** Eleven SCIP families — python, typescript, go, rust, java, clang, dotnet, php, ruby, swift, ctags — is more driven indexers than any other project in this comparison, and the fallback to tree-sitter for uncovered files means turning it on does not cost you coverage.
- **Someone else has already indexed the dependency you care about.** `.cgc` bundles are downloadable graph snapshots from a public registry. Skipping an index entirely is a capability nobody else here offers.
- **Your graph question is not one of the shipped tools.** `execute_cypher_query` hands you the database. Our tool set is fixed by design; theirs has a back door, if you write Cypher.
- **Your data layer is part of the architecture question.** Their MySQL, Redis and Cassandra ingesters put schema structure in the same graph as the code. We model code only.
- **You want the whole surface listed without opting in.** All 29 tools are advertised, for about 3.7K tokens of schema — a third of what our default preset costs.

## When to pick trace-mcp

- **You want it working in one command with nothing else installed.** No indexer binaries, no `compile_commands.json`, no graph database and no backend decision. That difference is the whole first-run experience.
- **The edges you care about are framework edges.** {{ site.data.counts.frameworks }} integrations resolving route → handler, controller → template, model → table. CodeGraphContext's framework awareness is two hardcoded Java Spring tools.
- **The job goes past reading.** Rename across a repository, move a symbol with its imports, an AST codemod, dead-code removal, a taint scan, SARIF for CI. They detect and report; they do not write.
- **Your stack is polyglot beyond the mainstream.** {{ site.data.counts.languages }} grammars against 23.
- **You want memory that outlives the session and is tied to code.** trace-mcp's decisions link to symbol IDs, are checked for staleness before recall, and surface inside `get_change_impact`. CodeGraphContext has no cross-session memory.
- **You want a published, re-runnable number.** The [PR review context benchmark](/pr-context-benchmark.html): a median {{ site.data.pr_context_bench.median_savings_pct }}% input-token reduction across {{ site.data.pr_context_bench.pr_count }} merged pull requests in {{ site.data.pr_context_bench.repo_count }} repositories nobody here maintains, shipping base and head SHAs, the cases where it lost, and one command to re-run it.

## Where we are not being smug

**Their reference resolution beats ours where SCIP is installed.** Eleven driven indexer families against our three is not a rounding difference, and compiler-grade symbol data is more accurate than any tree-sitter heuristic, ours included. We publish our own limits per language as a `resolution_tier` rather than claiming parity.

**Their default tool surface is cheaper than ours.** 29 tools for ~3.7K tokens against our 28 for ~11.6K including the server-instructions block. Our surface is trimmable per role and theirs only per denylist, which is the argument in our favour — but on the number itself they win.

**Bundles are a genuinely good idea we do not have.** Downloading a pre-built graph of a dependency instead of indexing it is the kind of thing that only looks obvious afterwards.

**They document their own dependency pain in public.** Their comments record that Kùzu was archived upstream and that redis-py is pinned to 5.x to keep FalkorDB Lite's Unix-socket path working. Projects that write that down are easier to trust than projects that do not.

**Our security scanning has a ceiling.** The control-flow graph is line-based, not AST-based, and taint analysis is lexical rather than a real dataflow engine. Type-aware pruning cuts false positives; it does not make this a dataflow analyser.

If you maintain CodeGraphContext and something here is wrong, [open an issue](https://github.com/nikolai-vysotskyi/trace-mcp/issues) and we will fix it.

## FAQ

**What is the core difference between CodeGraphContext and trace-mcp?**
They buy reference precision with setup — eleven SCIP indexer families and a graph database of your choosing. We buy zero setup and framework-level edges, and we write code as well as reading it.

**Does CodeGraphContext need a graph database installed?**
One of six backends. FalkorDB Lite is the default on Unix with Python 3.12+, and the embedded options are a pip install rather than a server — but KuzuDB and LadybugDB default to a 4 GiB buffer pool, so it is a decision with consequences. trace-mcp's index is an embedded SQLite file.

**Which one has the larger MCP tool surface?**
They define 29 and advertise 29 (~3.7K tokens), trimmable through a `disabledTools` denylist. We advertise 28 (~11.6K including server instructions) and keep the other {{ site.data.counts.tools }}-minus-28 one `load_tools` call away. Cheaper default: theirs.

**Can CodeGraphContext refactor code or scan for vulnerabilities?**
No. Source read at head on September 6, 2026: no rename/move/codemod, no taint analysis, no SARIF, no cross-session memory. It finds dead code and computes complexity, and reports both.

**What are CodeGraphContext bundles?**
Portable `.cgc` graph snapshots, published to a Hugging Face-hosted registry and pulled with `load_bundle` / `search_registry_bundles`, so a dependency's graph can be fetched instead of built. Nobody else in this field ships that.

## Next steps

- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs Repomix](/vs/repomix.html) · [vs Serena](/vs/serena.html) · [vs codebase-memory-mcp](/vs/codebase-memory-mcp.html) · [vs codegraph](/vs/codegraph.html) · [vs Context Mode](/vs/context-mode.html)
- [Language matrix](/language-matrix.html) — what resolution tier each language actually reaches.
- [Get started](/#install) — no configuration required.
