---
title: "Graft Alternative: trace-mcp vs Graft for AI agents"
description: "Graft builds a markdown cache with paid LLM APIs. trace-mcp indexes code locally with zero token bills, typed tools, 88 frameworks, and AST refactoring."
updated: 2026-09-11
---

# Graft alternative: trace-mcp vs Graft

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vs/graft.html",
      "datePublished": "2026-09-11",
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
        "@id": "https://trace-mcp.com/vs/graft.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the core difference between Graft and trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Graft generates a plain-language knowledge graph by calling external LLMs (Anthropic Claude or OpenAI) and saving summaries as loose markdown files on disk. trace-mcp is a 100% local, deterministic code intelligence engine that indexes code in seconds using embedded Tree-sitter WASM and relational SQLite, with zero external API calls, zero token costs, 88 framework integrations, and AST refactoring write tools."
          }
        },
        {
          "@type": "Question",
          "name": "Does Graft require paid LLM API keys to index code?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. Graft depends on external LLM APIs (@anthropic-ai/sdk, openai) to read and summarize codebase concepts and subsystems before its graph can be created. trace-mcp requires zero API keys, sends zero code off your machine, and performs deterministic parsing completely offline using local WASM parsers."
          }
        },
        {
          "@type": "Question",
          "name": "How do their storage models and graph querying compare?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Graft stores its knowledge graph as loose markdown files with YAML front matter in a graft/ directory, which requires file system scans and markdown parsing for queries. trace-mcp stores symbols, calls, and relationships in an embedded relational SQLite database with WAL mode and FTS5 full-text search, delivering sub-millisecond query execution on codebases with hundreds of thousands of symbols."
          }
        },
        {
          "@type": "Question",
          "name": "Does Graft support code refactoring or modifications?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "No. Graft is strictly a read-only context retrieval tool with 6 MCP tools. trace-mcp provides verified AST refactoring write tools (refactor_rename, refactor_extract, refactor_move, refactor_codemod) that update multi-file call sites, resolve import graphs, and verify syntax before writing."
          }
        },
        {
          "@type": "Question",
          "name": "How do their framework integrations and build portability compare?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Graft extracts generic language syntax and relies on native C++ Tree-sitter node-gyp compilation. trace-mcp models semantic relationships across 88 web frameworks (HTTP routes to handlers, ORM models to database tables, controllers to templates) and runs entirely in sandboxed WASM with zero native compiler dependencies."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** Graft (`trailhq/Graft` / `@nanonets/graft`, {{ site.data.competitors.graft.stars }} stars, MIT) is a context layer for AI coding agents (Claude Code, Cursor, Codex) that generates a repository knowledge graph as a folder of linked markdown files. It uses an external LLM (Anthropic Claude or OpenAI) to summarize subsystems, architectural boundaries, and concepts in plain English.

The fundamental differences between the two projects lie in indexing cost, privacy, graph storage, framework depth, and write capabilities. Graft relies on external LLM API calls to generate and update its markdown files, meaning indexing costs tokens, requires external API keys, and uploads proprietary source code to cloud models. trace-mcp is 100% local, deterministic, and private: it parses code in seconds using local Tree-sitter WASM and stores edges in an embedded SQLite database with zero external network requests and zero token bills. Graft stores concept nodes as loose markdown files on disk; trace-mcp stores relational symbol graphs that enable sub-millisecond multi-hop graph queries (`get_callers`, `get_callees`, `get_change_impact`). Furthermore, trace-mcp models deep semantic edges across {{ site.data.counts.frameworks }} web frameworks and provides verified AST refactoring write tools (`refactor_rename`, `refactor_extract`, `refactor_move`, `refactor_codemod`) and OWASP taint analysis, neither of which exists in Graft.

Pick Graft if you want human-readable markdown documentation files committed directly to your repository that developers can browse in standard markdown viewers. Pick trace-mcp if you require instant local indexing with zero API bills, complete source privacy, relational graph traversal across {{ site.data.counts.frameworks }} frameworks, and safe AST refactoring write capabilities.

## Head-to-head

| Capability | trace-mcp | Graft |
|---|:---:|:---:|
| **GitHub stars** | {{ site.data.competitors.trace_mcp.stars }} | {{ site.data.competitors.graft.stars }} |
| License | **MIT** (permissive open-source) | **MIT** (permissive open-source) |
| Written in | TypeScript (Node.js) | TypeScript (Node.js) |
| Installation / Distribution | `npx -y trace-mcp@latest` (npm registry) | `npx @nanonets/graft` / `npm i -g @nanonets/graft` |
| Indexing engine | **100% deterministic local WASM** (Tree-sitter) | Hybrid: Tree-sitter + external LLM calls (Claude / OpenAI) |
| Indexing cost | **$0.00** (zero API tokens, zero keys) | Requires external API keys, bills tokens per file |
| Code privacy | **100% local** (code never leaves the machine) | Sends code chunks to external LLM APIs for summarization |
| Underlying storage | Embedded SQLite WAL + FTS5 full-text index | Folder of loose markdown files (`graft/*.md`) + front matter |
| Query speed | **Sub-millisecond** indexed SQL queries | File system traversal and front matter text parsing |
| Languages (AST parsing) | **{{ site.data.counts.languages }}** (precompiled WASM) | 9 (native C++ tree-sitter grammars) |
| Build dependencies | **Zero native builds** (WASM sandboxes) | Native C++ compiler toolchain required (`node-gyp`, Python) |
| Framework integrations | **{{ site.data.counts.frameworks }}** semantic integrations | 0 (generic syntax AST only) |
| Framework-aware edges | ✓ route → handler, controller → template, ORM → table | ✗ (syntax AST only) |
| MCP tools defined | {{ site.data.counts.tools }} tools (adaptive task presets) | 6 tools (`graft_find_code`, `graft_trace_calls`, etc.) |
| Default advertised tools | **29** (~11.6K tok, task presets `minimal`, `review`, `dev`) | 6 tools advertised unconditionally |
| Refactoring write tools | ✓ AST-native transforms (rename, extract, move, codemods) | ✗ (read-only context retrieval) |
| Security analysis | ✓ OWASP Top-10 taint analysis, SARIF 2.1.0 | ✗ |
| Session & decision memory | ✓ Symbol-bound decision knowledge graph with staleness checks | ✗ (file freshness check only) |
| Human-browsable markdown docs | ✗ (structured query context via MCP) | ✓ Generates readable markdown files in `graft/` |

Verified on September 11, 2026 against Graft repository at `main` (v0.18.0, {{ site.data.competitors.graft.stars }} stars, `trailhq/Graft`). Tool definitions from `src/mcp/tool-names.ts` and `src/mcp/tools.ts`, package dependencies from `package.json`, graph representation from `src/graph/`, and CLI configuration from `src/cli/`.

## Key architectural differences

### 1. Indexing Cost & Privacy: Local Deterministic Parsing vs. External Paid LLMs

The most fundamental architectural difference between trace-mcp and Graft is how the codebase graph is constructed.

Graft relies on external generative LLMs (`@anthropic-ai/sdk`, `openai`) to synthesize concept nodes and describe subsystems:
- Before Graft can build a graph, developers must supply an Anthropic or OpenAI API key.
- Source code is partitioned and sent over the network to commercial LLM providers, raising data privacy, compliance, and NDA concerns on proprietary codebases.
- Indexing incurs continuous token costs on every initial build and subsequent update, scaling with the size and churn of the codebase.

trace-mcp is **100% local, offline, and private**:
- Code is parsed entirely on your workstation using sandboxed `web-tree-sitter` WebAssembly binaries.
- Your code, ASTs, and indices never leave your local environment.
- Indexing an entire enterprise monorepo of 50,000+ files completes in seconds with zero API tokens consumed and zero dollars spent.

### 2. Storage Architecture: Relational SQLite WAL vs. File-Based Markdown Cache

Graft stores its knowledge graph as a directory of loose markdown files (`graft/*.md`) using YAML front matter (`gray-matter`):
- Subsystems and concept nodes are saved as individual `.md` files in the repository.
- While markdown files are easy for humans to open and read, traversing multi-hop symbol relationships (e.g., finding all indirect callers of an authentication helper across 20 modules) requires walking directories and parsing text files off disk.
- Maintaining graph integrity across thousands of loose files is vulnerable to disk fragmentation, file lock contention, and drift.

trace-mcp stores symbols, calls, and relationships in an **embedded SQLite database** with WAL (Write-Ahead Logging) mode and FTS5 (Full-Text Search):
- Relational tables and B-tree indices support instant sub-millisecond graph traversals (`find_symbol`, `get_callers`, `get_callees`, `find_path`, `get_change_impact`).
- Multi-tier resolution (from compiler-verified to heuristic AST matching) executes within structured SQL queries.
- SQLite WAL mode ensures concurrent read access and instantaneous updates when files change.

### 3. Tool Surface & Write Path: AST Refactoring vs. Read-Only Retrieval

Graft exposes 6 read-only MCP tools:
- `graft_find_code`: Natural language code search across generated markdown concepts.
- `graft_find_all`: Symbol and pattern grep.
- `graft_trace_calls`: Upstream and downstream call tracing.
- `graft_file_api`: File outline / skeleton extraction.
- `graft_repo_map`: Top-level subsystem map.
- `graft_check_freshness`: Checks if markdown documentation is out of date relative to source files.

Graft offers zero tools to modify code. If an agent needs to refactor a function, rename a symbol across 50 files, or extract duplicate logic, it must fall back to blind string replacement or manual file rewrites.

trace-mcp pairs comprehensive graph navigation with **production-grade AST refactoring write tools**:
- `refactor_rename`: Performs scope-aware symbol renames across the entire codebase, updating call sites and cross-file imports while validating syntax integrity.
- `refactor_extract`: Extracts selected statements into new functions with inferred arguments and return types.
- `refactor_move`: Moves functions or classes across file boundaries and automatically rewrites dependent imports.
- `refactor_codemod`: Executes structural AST transformations with compiler validation.
- `taint_analysis`: Tracks untrusted user input to security-sensitive sinks across the call graph and exports SARIF 2.1.0 reports.

### 4. Framework Awareness: 88 Web Framework Integrations vs. Generic Syntax

Graft extracts syntactic symbols (classes, functions, calls) from raw language grammars. It does not model web application frameworks or cross-tier abstractions:
- It cannot link an HTTP route declared in a router file to its controller action and underlying database model.
- It does not resolve dependency injection bindings (e.g. NestJS, Spring Boot, Angular).
- It does not track ORM models (Prisma, Drizzle, TypeORM, SQLAlchemy) to database tables and migrations.

trace-mcp constructs semantic graph edges across **{{ site.data.counts.frameworks }} frameworks**:
- Connects frontend API calls to backend endpoints.
- Maps ORM models to database schemas and migrations.
- Resolves framework-specific lifecycle hooks, middleware pipelines, and controller routes.

When an AI agent modifies a backend controller, trace-mcp warns the agent about affected frontend callers and impacted database queries.

### 5. Build Portability: Sandboxed WASM vs. Native C++ Compilations

Graft relies on native Node.js addons:
- Native C++ Tree-sitter bindings compiled via `node-gyp` across multiple language packages (`tree-sitter-go`, `tree-sitter-java`, `tree-sitter-python`, `tree-sitter-swift`, etc.).
- Installing Graft requires a host C++ compiler toolchain (`gcc`, `clang`, `make`, `python3`). On minimal CI containers, Alpine Linux, or locked-down developer laptops, `npm install` frequently fails due to missing compilation tools.

trace-mcp is engineered for **zero-setup, universal portability**:
- Code parsing runs inside isolated WASM sandboxes via `web-tree-sitter` and precompiled WASM grammars.
- Storage runs in embedded `better-sqlite3` with prebuilt platform binaries.
- Running `npx -y trace-mcp@latest` requires only Node.js—no C++ compilers, no Python build scripts, and no native compilation steps.

## When to choose Graft

- **Human-browsable documentation**: You want plain-English markdown files committed to `graft/` in your repository so team members can read architectural overviews in GitHub or markdown viewers.
- **Natural language concept indexing**: You prefer an external LLM synthesizing English descriptions of what each subsystem does rather than querying AST relationships.
- **Small to medium codebases with cloud LLM access**: Your organization allows sending source code to Anthropic or OpenAI, and you don't mind paying API token bills for graph generation.

## When to choose trace-mcp

- **Zero token cost & complete code privacy**: You need local-first code intelligence that runs 100% offline, requires no API keys, incurs no token bills, and never sends source code to external servers.
- **Fast, relational graph traversal**: You need sub-millisecond graph queries (`get_callers`, `get_callees`, `get_change_impact`) backed by an embedded SQLite database.
- **Web framework depth**: You build with modern stacks (React, Next.js, Express, NestJS, Django, FastAPI, Spring Boot, Rails, etc.) and require semantic edges across routes, controllers, and ORM models.
- **Safe AST refactoring**: You want your AI agent to safely rename symbols across files, extract functions, move modules, and run codemods with syntax verification.
- **Security & quality gates**: You want automated OWASP Top-10 taint analysis and CI-ready SARIF 2.1.0 vulnerability reporting.
- **Instant zero-setup portability**: You want a tool that runs immediately via `npx -y trace-mcp@latest` with zero native C++ compiler toolchains.

## Next steps

- Learn how a persistent code graph reduces token costs on every turn: [Code graph MCP server](/code-graph-mcp.html).
- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs GitNexus](/vs/gitnexus.html) · [vs Repomix](/vs/repomix.html) · [vs Serena](/vs/serena.html) · [vs codebase-memory-mcp](/vs/codebase-memory-mcp.html) · [vs codegraph](/vs/codegraph.html) · [vs CodeGraphContext](/vs/codegraphcontext.html) · [vs SocratiCode](/vs/socraticode.html) · [vs jCodeMunch](/vs/jcodemunch.html) · [vs TokenSave](/vs/tokensave.html) · [vs Context Mode](/vs/context-mode.html) · [vs code-review-graph](/vs/code-review-graph.html) · [Repomix vs codegraph](/vs/repomix-vs-codegraph.html)
- Explore measured token savings and quality results across 60 open-source pull requests: [PR context benchmark](/pr-context-benchmark.html).
- Explore all MCP tools in the [tools reference](/tools-reference.html).
- Read the [architecture](/architecture.html) guide to see how embedded SQLite and tree-sitter WASM work together.
- Install trace-mcp in seconds: `npx -y trace-mcp@latest init`.
