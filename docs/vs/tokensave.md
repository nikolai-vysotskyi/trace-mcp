---
title: "TokenSave Alternative: trace-mcp vs TokenSave for AI agents"
description: "TokenSave offers 86 MCP tools in Rust under MIT. trace-mcp adds 88 framework integrations, AST refactoring, and OWASP taint analysis."
updated: 2026-09-08
---

# TokenSave alternative: trace-mcp vs TokenSave

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vs/tokensave.html",
      "datePublished": "2026-09-08",
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
        "@id": "https://trace-mcp.com/vs/tokensave.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the core difference between TokenSave and trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "TokenSave is a Rust-based MCP server providing 86 code-intelligence tools over an embedded libSQL database with tree-sitter AST parsing across 50+ languages. trace-mcp is a Node.js/TypeScript code intelligence engine providing a persistent 5-tier code graph, deep semantic edges across {{ site.data.counts.frameworks }} frameworks, AST-native refactoring write tools, and OWASP Top-10 taint analysis."
          }
        },
        {
          "@type": "Question",
          "name": "How do their MCP tool surfaces compare?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "TokenSave defines 86 tools and advertises all 85+ tools by default on standard MCP hosts, consuming ~12-15K tokens of schema listing on tools/list before the agent begins work (only 5 tools carry anthropic/alwaysLoad). trace-mcp ships a default minimal preset of 28 tools (~11.6K tokens), provides task-tailored presets (review, architecture, dev), and escalates dynamically via load_tools without bloating the prompt."
          }
        },
        {
          "@type": "Question",
          "name": "Does TokenSave support web framework semantics?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "TokenSave extracts structural syntax (functions, structs, classes, call sites, imports) across 50+ languages, but models zero framework semantics. trace-mcp builds typed semantic edges across {{ site.data.counts.frameworks }} frameworks, connecting HTTP routes to handlers, controllers to UI templates, and ORM models to database tables."
          }
        },
        {
          "@type": "Question",
          "name": "How does refactoring and code modification compare?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "TokenSave provides string replacement and insertion primitives (tokensave_str_replace, tokensave_insert_at) alongside optional ast-grep rewrites. trace-mcp provides semantic AST refactoring tools (refactor_rename, refactor_extract, refactor_move, codemods) that perform scope-aware symbol updates across files, including import graph rewrites."
          }
        },
        {
          "@type": "Question",
          "name": "How do their session memory architectures compare?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "TokenSave records text decisions and code areas with 14-day exponential recency decay, summarizing past decisions on session start. trace-mcp binds architectural decisions directly to symbol IDs and file nodes, actively verifying code staleness before returning past context to the agent."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** TokenSave is a Rust-based code intelligence MCP server that indexes code into an embedded libSQL (SQLite) database with tree-sitter parsers across 50+ languages. It features 86 specialized MCP tools, subprocess-isolated grammar extraction, multi-branch indexing, git blame integration, and text replacement editing primitives.

The core architectural differences center on advertised prompt overhead, framework awareness, refactoring safety, and security. TokenSave advertises all 85+ tools by default on standard MCP hosts, consuming significant schema tokens on every session start, whereas trace-mcp ships a 28-tool `minimal` preset and dynamically escalates via `load_tools`. TokenSave extracts language syntax without resolving framework connections; trace-mcp builds semantic graph edges across {{ site.data.counts.frameworks }} frameworks (routes, controllers, templates, ORM models). TokenSave edits code via string-replacement primitives; trace-mcp executes scope-aware AST refactorings with cross-file import rewrites and includes OWASP Top-10 taint analysis with SARIF output.

Pick TokenSave if you want a Rust binary indexing broad syntax across 50+ languages (including shaders, Basic dialects, and mainframe languages) with multi-branch database isolation. Pick trace-mcp if you develop web applications in modern frameworks, require compiler-calibrated 5-tier call graphs, need safe AST refactoring write tools, and want zero-setup distribution via npm.

## Head-to-head

| Capability | trace-mcp | TokenSave |
|---|:---:|:---:|
| **GitHub stars** | {{ site.data.competitors.trace_mcp.stars }} | {{ site.data.competitors.tokensave.stars }} |
| License | **MIT** (permissive open-source) | **MIT** (permissive open-source) |
| Written in | TypeScript (Node.js) | Rust (edition 2021) |
| Installation / Distribution | `npx -y trace-mcp@latest` (npm registry) | `cargo binstall tokensave` / Homebrew tap / Scoop / prebuilt binary |
| Underlying storage | Embedded SQLite + FTS5 + local ONNX | Embedded libSQL (SQLite fork) + FTS5 + ONNX runtime (`ort`) |
| Languages (AST parsing) | **{{ site.data.counts.languages }}** (tree-sitter WASM) | 50+ (tree-sitter native, lite/medium/full tiers) |
| Framework integrations | **{{ site.data.counts.frameworks }}** semantic integrations | ✗ (syntax AST only, no framework semantics) |
| Framework-aware edges | ✓ route → handler, middleware, template, ORM | ✗ |
| MCP tools defined | {{ site.data.counts.tools }} | 86 tools |
| Default advertised tools | **28** (~11.6K tok, task presets) | **85+** advertised on standard hosts (~12-15K tok schema) |
| Tool surface management | Task presets (`minimal`, `review`, `architecture`, `dev`) + `load_tools` | 5 tools marked `anthropic/alwaysLoad`; 85+ returned on `tools/list` |
| Call graph resolution | 5-tier resolution (`compiler_verified` to `fuzzy`) with calibrated confidence | Graph traversal (`callers`, `callees`, `call_chain`) over AST call sites |
| Refactoring capability | ✓ AST-native safe transforms (rename, extract, move, codemods) | String replacement primitives (`str_replace`, `multi_str_replace`, `insert_at`) |
| Security scanning | ✓ OWASP Top-10 taint analysis, SARIF 2.1.0 | ✗ (`tokensave_unsafe_patterns` syntactic grep only) |
| Session memory | ✓ code-linked decision graph with staleness checks | Text decisions with 14-day recency decay (`tokensave_record_decision`) |
| Extraction crash safety | WASM sandbox (memory-safe, crash-isolated by runtime) | Subprocess worker pool (`extraction_worker.rs`) |
| Multi-branch indexing | Git-aware commit/file tracking in unified SQLite WAL | Opt-in separate libSQL database per git branch |

Verified on September 8, 2026 against TokenSave's repository at `master` (v7.11.1, {{ site.data.competitors.tokensave.stars }} stars). Tool definitions from `src/mcp/tools/definitions.rs`, server dispatch from `src/mcp/server.rs`, memory architecture from `src/tokensave/memory.rs`, storage and extraction from `src/db/` and `src/extraction/`.

## Key architectural differences

### 1. Tool Surface Management: 86 Advertised Tools vs. 28-Tool Minimal Preset

The number of tools an MCP server exposes directly impacts agent performance. Every tool definition consumes prompt tokens in the initial `tools/list` response, and large tool lists increase parameter hallucination and tool mis-selection rates (dispatch dilution).

TokenSave defines 86 MCP tools in `get_tool_definitions()`. In Anthropic-specific environments supporting the deferred-loading proposal (`_meta: { "anthropic/alwaysLoad": true }`), TokenSave tags 5 tools (`tokensave_search`, `tokensave_context`, `tokensave_callees`, `tokensave_impact`, `tokensave_status`). However, on all standard MCP hosts (including Claude Code, Codex CLI, Cursor, Antigravity, OpenCode, and Zed), the `tools/list` endpoint returns all 85+ tool definitions unconditionally. TokenSave's own source comments in `src/mcp/server.rs` record this reality:
> *"The original metric only counted the tool's own answer text, so overhead that's very real to the model — 80+ tool schemas, the call itself, warning banners — was invisible."*

To balance this, TokenSave implements session debt accounting (`settle_session_debt`), charging the schema overhead against future token savings over multiple turns.

trace-mcp addresses context overhead architecturally through **Adaptive Task Presets**:
- **28-tool `minimal` default**: Advertised by default (~11.6K tokens), providing search, navigation, outlines, and change impact without prompt bloat.
- **Workflow-tailored presets**: Dedicated presets for `review` (32 tools), `architecture` (42 tools), or `dev` (42 tools).
- **Dynamic runtime escalation**: Any deferred tool can be loaded on demand in the live session via `load_tools` without server restarts or meta-tool indirection.

### 2. Pure Syntax Parsing vs. 88 Framework Semantic Integrations

Both trace-mcp and TokenSave parse source code using tree-sitter grammars. Where they diverge is how structural syntax is translated into architectural comprehension.

TokenSave is language-broad: it includes tree-sitter grammars for 50+ languages across three compilation tiers (`lite` with 11 core languages, `medium` with 9, and `full` adding 40+ including GLSL/HLSL/Metal shaders, CUDA, Fortran, Cobol, and Basic dialects). However, its extractors capture purely syntactic constructs: functions, classes, structs, methods, import statements, and call expressions. It contains no framework-specific extractors:
- It knows an Express or FastAPI file has a function call named `app.get()`, but creates no route-to-handler relationship in the graph.
- It cannot connect a backend controller to a React/Vue/Svelte frontend component or Blade/Jinja template.
- It cannot link an ORM model (Prisma, TypeORM, Drizzle, SQLAlchemy, Django ORM) to database schema migrations.

trace-mcp builds a true semantic code graph across {{ site.data.counts.frameworks }} frameworks:
- **HTTP Routing & Middleware**: Explicit directed edges connect route definitions to handler functions, parameter schemas, and authentication middleware chains across Express, Fastify, NestJS, Next.js, Django, Flask, FastAPI, Rails, Spring Boot, Gin, Actix, and Axum.
- **Component & View Hierarchies**: Resolves relationships between backend controllers, API endpoints, and UI view layers.
- **Data Layer & ORM Models**: Connects models directly to database tables, migration files, and query callsites.

When an agent asks "what breaks if I change this endpoint parameter?", trace-mcp traverses typed framework edges. In TokenSave, the agent must trace raw call sites and manually infer route bindings.

### 3. Code Modification: String Replacement Primitives vs. AST-Verified Refactoring

AI agents frequently introduce syntax errors or broken imports when editing code. The two tools approach code modification with fundamentally different primitives.

TokenSave provides string-level and regex-anchored editing tools:
- `tokensave_str_replace`: Uniquely anchored find-and-replace for string blocks.
- `tokensave_multi_str_replace`: Applies an array of string replacements atomically.
- `tokensave_insert_at`: Inserts text before or after a matched anchor string.
- `tokensave_ast_grep_rewrite`: Optional structural pattern replacement via ast-grep CLI.

While anchored string replacement is safer than raw shell sed commands, it operates on text slices rather than semantic symbols. If a symbol is renamed across a project, string replacement cannot update importing files or adjust lexical scopes.

trace-mcp provides a complete suite of **AST-native refactoring write tools**:
- `refactor_rename`: Performs scope-aware symbol renames across all referencing files, updating import statements and call sites while verifying syntax integrity.
- `refactor_extract`: Extracts code blocks into new functions with inferred arguments and return signatures.
- `refactor_move`: Relocates functions or classes across module boundaries with automatic import resolution.
- `refactor_codemod`: Applies structural AST transformation patterns with compiler-level validation.

### 4. Memory Models: Text Recency Decay vs. Symbol-Bound Staleness Verification

Both tools provide persistent memory across agent sessions, recognizing that agents should not re-learn project architectural decisions from scratch on every turn.

TokenSave implements decision and code area memory (`src/tokensave/memory.rs`):
- `tokensave_record_decision`: Saves title, rationale, and consequences into libSQL.
- `tokensave_record_code_area`: Records high-interest file paths and architectural components.
- **Exponential recency decay**: Decisions have a 14-day half-life (`RECALL_DECAY_HALF_LIFE_SECS = 14 days`), gently lowering older decisions in search rank without expiring them.
- **Session start delta**: Summarizes the top 5 recent decisions and code areas on session startup.

However, TokenSave's decisions are stored as free-form text and path strings. If a referenced function is deleted, renamed, or refactored, the decision remains in the database and continues to be recalled.

trace-mcp implements **Symbol-Bound Decision Memory**:
- Decisions are bound directly to symbol IDs (`src/db/connection.ts::Pool#class`) and file nodes in the code graph.
- When `get_change_impact` is run on a symbol, linked decisions appear directly in the output.
- **Staleness verification**: At recall time, trace-mcp verifies that referenced symbols and files still exist in the current index. If code was removed, stale decisions are suppressed rather than misleading the agent.

### 5. Security & Quality Gates: General Intelligence vs. OWASP Top-10 Taint Analysis in CI

trace-mcp integrates static application security testing directly into the MCP server:
- **OWASP Top-10 Taint Analysis**: Tracks data flows from untrusted inputs (HTTP parameters, request bodies) to sensitive sinks (SQL queries, shell execution, HTML output) with type-aware pruning.
- **OASIS SARIF 2.1.0 Export**: Generates standardized vulnerability reports for GitHub Code Scanning, GitLab CI, and Azure DevOps.
- **Configurable Quality Gates**: Enforces architectural boundaries, dependency cycles, and dead-code thresholds in CI.

TokenSave includes `tokensave_unsafe_patterns`, which performs regex/AST pattern matching for known hazardous constructs (such as `eval` or `unsafe` blocks in Rust), but provides no cross-file taint analysis, no source-to-sink data flow tracking, and no SARIF report generation.

## When to choose TokenSave

- **Polyglot codebases with niche or shader languages**: Your repository contains GLSL/HLSL/Metal shaders, CUDA, Fortran, Cobol, Pascal, or QuickBasic alongside general-purpose code.
- **Independent multi-branch index databases**: You work in multiple active git worktrees and prefer completely separate libSQL databases per branch.
- **Git blame and commit archaeology**: You want native blame-graph metrics (`tokensave_blame`, `tokensave_log`, `tokensave_diff`) built into your MCP queries.
- **You prefer a compiled Rust native binary**: You want a self-contained single binary installed via `cargo binstall` or Homebrew rather than running Node.js.

## When to choose trace-mcp

- **Modern web and backend frameworks**: You build with Next.js, React, Vue, Express, Fastify, Django, FastAPI, Rails, Spring Boot, or Laravel, and need semantic edges between routes, middleware, templates, and ORM models.
- **Prompt budget efficiency**: You want a lean 28-tool `minimal` preset (~11.6K tokens) that protects the model's context window on every turn, with dynamic escalation via `load_tools`.
- **Safe, automated AST refactoring**: You want your AI agent to perform atomic renames, extractions, and file moves with syntax validation and import graph updates.
- **High-confidence impact analysis**: You need a 5-tier call graph that explicitly distinguishes compiler-verified relationships from heuristic inferences.
- **Integrated CI security & quality gates**: You want OWASP Top-10 taint analysis and SARIF reporting built into your code graph workflow.
- **Zero-setup npm distribution**: You want instant execution via `npx -y trace-mcp@latest` with embedded SQLite and bundled ONNX embeddings.

## Next steps

- Learn how a persistent code graph reduces token costs on every turn: [Code graph MCP server](/code-graph-mcp.html).
- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs Repomix](/vs/repomix.html) · [vs Serena](/vs/serena.html) · [vs codebase-memory-mcp](/vs/codebase-memory-mcp.html) · [vs codegraph](/vs/codegraph.html) · [vs CodeGraphContext](/vs/codegraphcontext.html) · [vs SocratiCode](/vs/socraticode.html) · [vs jCodeMunch](/vs/jcodemunch.html) · [vs Context Mode](/vs/context-mode.html) · [vs code-review-graph](/vs/code-review-graph.html)
- Explore measured token savings and quality results across 60 open-source pull requests: [PR context benchmark](/pr-context-benchmark.html).
- Explore all MCP tools in the [tools reference](/tools-reference.html).
- Read the [architecture](/architecture.html) guide to see how embedded SQLite and tree-sitter WASM work together.
- Install trace-mcp in seconds: `npx -y trace-mcp@latest init`.
