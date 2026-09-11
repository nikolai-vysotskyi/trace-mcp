---
title: "Narsil-MCP Alternative: trace-mcp vs Narsil-MCP for AI agents"
description: "Narsil-MCP offers 90 MCP tools and SPARQL RDF in Rust. trace-mcp adds 88 framework integrations, AST refactoring write tools, and OWASP taint analysis."
updated: 2026-09-09
---

# Narsil-MCP alternative: trace-mcp vs Narsil-MCP

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      "headline": {{ page.title | jsonify }},
      "description": {{ page.description | jsonify }},
      "url": "https://trace-mcp.com/vs/narsil-mcp.html",
      "datePublished": "2026-09-09",
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
        "@id": "https://trace-mcp.com/vs/narsil-mcp.html"
      }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is the core difference between Narsil-MCP and trace-mcp?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Narsil-MCP is a Rust-based MCP server providing 90 code-intelligence tools over an Oxigraph SPARQL/RDF triple store with 4-layer Code Context Graph (CCG) progressive disclosure across 32 languages. trace-mcp is a Node.js/TypeScript code intelligence engine providing a persistent 5-tier directed code graph, deep semantic edges across {{ site.data.counts.frameworks }} frameworks, AST-native refactoring write tools, and OWASP Top-10 taint analysis with SARIF output."
          }
        },
        {
          "@type": "Question",
          "name": "How do their code graph architectures (CCG vs. 5-tier graph) differ?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Narsil-MCP implements the Code Context Graph (CCG) v0.2 spec, structuring code as RDF triples across four progressive tiers (L0 Manifest, L1 Architecture, L2 Symbol Index, L3 Full RDF) queried via SPARQL 1.1. trace-mcp maintains a persistent SQLite+FTS5 directed graph with 5-tier call resolution (from compiler-verified to heuristic), resolving semantic framework edges like route to handler and controller to template."
          }
        },
        {
          "@type": "Question",
          "name": "How do their MCP tool surfaces and prompt overhead compare?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Narsil-MCP defines 90 tools across 11 categories and exposes four presets (minimal with 20-30 tools, balanced with 40-50, full with 70+, security-focused with ~30). trace-mcp ships a default minimal preset of 29 tools (~11.6K tokens total session start), provides task-tailored presets (review, architecture, dev), and escalates dynamically via load_tools without prompt bloat."
          }
        },
        {
          "@type": "Question",
          "name": "Can either tool execute automated code refactoring?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Narsil-MCP is strictly read-only and stateless across agent turns, providing analysis and complexity hotspot discovery with zero refactoring write tools. trace-mcp provides atomic AST refactoring write tools (refactor_rename, refactor_extract, refactor_move, codemods) that perform scope-aware transformations with cross-file import graph rewrites."
          }
        },
        {
          "@type": "Question",
          "name": "How does security scanning and taint analysis compare between the two?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Narsil-MCP includes security scanning with 147 rules, but its taint analyzer relies on regex-like pattern matching over function and property names. trace-mcp performs true AST dataflow taint analysis with type-aware pruning from inputs to sensitive sinks, exporting standardized OASIS SARIF 2.1.0 reports for CI quality gates."
          }
        }
      ]
    }
  ]
}
</script>

**TL;DR.** Narsil-MCP is a Rust-based code intelligence MCP server that organizes codebase knowledge into a 4-layer Code Context Graph (CCG) stored in an `oxigraph` SPARQL/RDF triple store with `tantivy` LZ4 full-text search. It exposes 90 specialized MCP tools across 4 presets, features an embedded Axum HTTP server with a React visualization SPA, and provides 147 syntactic security rules.

The fundamental architectural differences center on query ergonomics, framework semantics, refactoring capabilities, and security grounding. Narsil-MCP exposes raw SPARQL queries against RDF triples, which introduces significant syntax and hallucination overhead for LLM agents; trace-mcp provides deterministic, strongly typed MCP tools (`get_callers`, `get_change_impact`, `find_usages`). Narsil-MCP extracts syntax for 32 languages without framework models; trace-mcp builds typed semantic edges across {{ site.data.counts.frameworks }} frameworks (connecting HTTP routes to handlers, controllers to templates, and ORM models to tables). Narsil-MCP is strictly read-only with zero refactoring write tools and zero session memory; trace-mcp provides atomic AST-verified refactoring write tools (`refactor_rename`, `refactor_extract`, `refactor_move`, `refactor_codemod`) and code-linked decision memory with staleness verification.

Pick Narsil-MCP if you need formal RDF/SPARQL knowledge graph querying, want a self-contained embedded React web UI for visual exploration, or prefer a compiled Rust standalone binary. Pick trace-mcp if you develop web applications in modern frameworks, require calibrated 5-tier call graphs, need safe AST refactoring write tools, and want zero-setup execution via npm.

## Head-to-head

| Capability | trace-mcp | Narsil-MCP |
|---|:---:|:---:|
| **GitHub stars** | {{ site.data.competitors.trace_mcp.stars }} | {{ site.data.competitors.narsil_mcp.stars }} |
| License | **MIT** (permissive open-source) | **MIT OR Apache-2.0** (dual permissive) |
| Written in | TypeScript (Node.js) | Rust (edition 2021) |
| Installation / Distribution | `npx -y trace-mcp@latest` (npm registry) | `cargo install narsil-mcp` / GitHub release binaries |
| Underlying storage | Embedded SQLite + FTS5 + local ONNX | `oxigraph` (SPARQL/RDF) + `tantivy` (LZ4) + `postcard` |
| Graph specification | 5-tier directed code graph (SQLite WAL) | Code Context Graph (CCG) v0.2 spec (4 RDF layers) |
| Languages (AST parsing) | **{{ site.data.counts.languages }}** (tree-sitter WASM) | 32 (tree-sitter native) |
| Framework integrations | **{{ site.data.counts.frameworks }}** semantic integrations | ✗ (syntax AST only, no framework semantics) |
| Framework-aware edges | ✓ route → handler, middleware, template, ORM | ✗ |
| MCP tools defined | {{ site.data.counts.tools }} tools | 90 tools (11 categories) |
| Default advertised tools | **29** (~11.6K tok, task presets) | 20-30 (`minimal`) up to 70+ (`full`) |
| Tool surface management | Task presets (`minimal`, `review`, `architecture`, `dev`) + `load_tools` | 4 presets (`minimal`, `balanced`, `full`, `security-focused`) |
| Call graph resolution | 5-tier resolution (`compiler_verified` to `fuzzy`) with calibrated confidence | Graph traversal over AST call sites (`--call-graph` flag) |
| Refactoring capability | ✓ AST-native safe transforms (rename, extract, move, codemods) | ✗ (analysis-only, zero refactoring write tools) |
| Security scanning | ✓ OWASP Top-10 taint analysis, SARIF 2.1.0 | ✓ 147 rules (regex-pattern taint matching, OSV/SBOM) |
| Session memory | ✓ code-linked decision graph with staleness checks | ✗ (stateless across turns, no decision memory) |
| Graph visualization | Desktop app (cosmos.gl, offscreen headless safe) | Embedded Axum HTTP server + React SPA frontend |
| Graph query interface | Strongly typed MCP primitives + `graph_query` | SPARQL 1.1 queries against RDF triples (`query_sparql`) |

Verified on September 8, 2026 against Narsil-MCP's repository at `main` (v1.7.0, {{ site.data.competitors.narsil_mcp.stars }} stars). Tool definitions from `src/tool_metadata.rs`, presets from `src/config/preset.rs`, taint matching from `src/taint/patterns.rs`, SPARQL persistence from `src/persistence/sparql.rs`, and CCG architecture from `docs/ccg-spec.md`.

## Key architectural differences

### 1. Query Ergonomics: SPARQL 1.1 on RDF vs. Strongly Typed MCP Primitives

The core thesis of Narsil-MCP is representing codebases as semantic RDF knowledge graphs according to the Code Context Graph (CCG) specification. Its Layer 3 graph stores classes, methods, modules, and dependencies as RDF triples inside `oxigraph`.

To query this graph, Narsil-MCP exposes SPARQL 1.1 endpoints (`query_sparql`). While SPARQL is a powerful W3C standard for semantic knowledge graphs, it introduces severe friction for AI coding agents:
- **High prompt and syntax overhead**: The agent must construct valid SPARQL query strings adhering to specific namespaces (`https://codecontextgraph.com/vocab/`).
- **Parameter and URI hallucinations**: Models frequently invent predicate URIs (such as `ccg:invokesMethod` instead of `ccg:calls`), resulting in query parse errors or silent empty result sets that waste agent turns.
- **Round-trip latency**: Recovering from SPARQL errors requires additional reasoning turns and schema re-inspections.

trace-mcp is designed around **Deterministic, Strongly Typed MCP Primitives**:
- Dedicated tools for specific questions: `get_callers`, `get_change_impact`, `find_usages`, `get_outline`, `get_symbol`.
- Zero query language syntax to hallucinate: parameters are simple strings (`symbol_id`, `file_path`, `depth`).
- Deterministic structured output formatted for model comprehension without RDF triple deserialization.
- When flexible graph exploration is needed, `graph_query` provides a safe, domain-specific traversal interface without requiring SPARQL query generation.

### 2. Context Delivery: 4-Layer CCG Disclosure vs. 29-Tool Minimal Preset with Dynamic Escalation

Managing model context window budgets is critical to prevent prompt dilution and excessive token costs. The two servers approach context efficiency from different angles.

Narsil-MCP structures repository data into four progressive CCG tiers:
- **Layer 0 (Manifest)**: Minimal repository identity, symbol counts, and language breakdown (~1-2KB JSON-LD).
- **Layer 1 (Architecture)**: High-level component topology and entry points (~10-50KB).
- **Layer 2 (Symbol Index)**: Comprehensive symbol index (~100-500KB gzipped N-Quads).
- **Layer 3 (Full RDF)**: Complete semantic graph with all triples (~1-20MB).

While Layer 0 provides an ultra-compact start, accessing granular symbols in Layers 2 and 3 requires fetching large chunks of serialized graph data. Furthermore, in tool discovery, Narsil-MCP's 90 tools across 11 categories must be managed via static presets (`minimal`, `balanced`, `full`, `security-focused`). If an agent on the `minimal` preset needs a specialized tool from `full`, it cannot load it without server re-configuration.

trace-mcp addresses context overhead on both tool and data surfaces:
- **Lean 29-tool `minimal` default**: Consumes ~11.6K tokens total (schema plus server instructions) at session start, preserving prompt capacity.
- **Dynamic runtime escalation**: Any of the {{ site.data.counts.tools }} tools outside the active preset can be activated on demand in the live session via `load_tools`.
- **Targeted context slices**: Tools like `get_outline`, `get_symbol`, and `get_change_impact` return exact AST slices and blast-radius summaries rather than requiring the agent to parse megabytes of raw RDF triples.

### 3. Language Breadth vs. 88 Framework Semantic Integrations

Both engines parse source code using tree-sitter grammars. Where they diverge is how syntax trees are elevated into software architecture.

Narsil-MCP provides native tree-sitter parsers for 32 programming languages. However, its extractors capture strictly syntactic elements: function declarations, structs, class hierarchies, imports, and method invocations. It has zero framework-aware extractors:
- It records route definition function calls (e.g., `router.get('/api/users', ...)` in Express or `@app.get('/items')` in FastAPI), but creates no route-to-handler edge in the graph.
- It cannot link an MVC controller to its corresponding frontend component (React, Vue, Svelte) or template (Blade, Jinja, ERB).
- It models no database schema relationships or ORM mappings (Prisma, TypeORM, Drizzle, SQLAlchemy, Django ORM).

trace-mcp bridges syntax and application semantics across {{ site.data.counts.frameworks }} frameworks:
- **HTTP Routing & Middleware Chains**: Directly connects URL routes, parameters, and middleware pipelines to backend handler functions.
- **Component & Template Edges**: Maps relationships between server controllers and UI view templates.
- **ORM & Database Models**: Connects ORM models to database tables, migration files, and query callsites.

When an agent reviews a pull request or plans a feature, trace-mcp traces the complete path from the user-facing route to the database query. In Narsil-MCP, the agent must inspect disconnected call sites and manually reconstruct the framework flow.

### 4. Code Modification: Stateless Analysis vs. Atomic AST Refactoring Write Tools

A critical distinction between the two projects is their operational scope: read-only navigation versus active code modification.

Narsil-MCP is strictly **read-only and stateless across agent turns**:
- It identifies complexity hotspots and potential refactoring candidates based on call graph connectivity.
- It provides **zero refactoring write tools**: no symbol renaming, no function extraction, no module moves, and no codemods.
- It provides **zero session memory**: it retains no decisions, architectural constraints, or tradeoff notes across agent turns.

When an agent using Narsil-MCP needs to edit code, it must revert to generic string replacement or full file overwrites, risking broken imports and syntax errors.

trace-mcp provides a complete suite of **AST-native refactoring write tools**:
- `refactor_rename`: Performs scope-aware symbol renames across all referencing files, updating import declarations and call sites with syntax verification.
- `refactor_extract`: Extracts code blocks into new functions with inferred arguments and return signatures.
- `refactor_move`: Relocates functions or classes across module boundaries with automatic import resolution.
- `refactor_codemod`: Applies structural AST transformation patterns with compiler-level validation.
- **Symbol-bound decision memory**: Persists architectural decisions linked directly to symbol IDs, actively checking for code staleness before returning context to the agent.

### 5. Security & Taint Analysis: Syntactic Regex Matching vs. AST-Grounded Dataflow with SARIF Output

Both tools emphasize security analysis, but implement fundamentally different analysis engines.

Narsil-MCP includes security scanning with 147 rules (covering OWASP, CWE, and OSV/SBOM supply chain checks). However, its taint analysis engine (`src/taint/patterns.rs`) operates via regex-like pattern matching over function and property names (`function_patterns`, `property_patterns`). This syntactic approach cannot track dataflow through intermediate variables, assignments, or scope closures, resulting in high false-positive rates and missed vulnerabilities across complex paths.

trace-mcp implements **True AST Dataflow Taint Analysis**:
- Tracks data flow paths from untrusted sources (HTTP parameters, request payloads, environment variables) to sensitive sinks (SQL queries, shell commands, HTML outputs).
- Applies type-aware pruning to eliminate benign variables and safe type conversions.
- Generates standardized **OASIS SARIF 2.1.0** reports, enabling seamless integration into GitHub Code Scanning, GitLab CI, and automated PR quality gates.

## When to choose Narsil-MCP

- **Formal RDF and semantic web pipelines**: You require standardized RDF triples and SPARQL 1.1 query capabilities for integration into corporate knowledge graphs or ontology systems.
- **Built-in web visualization**: You want a self-contained local web UI with an embedded Axum server and interactive React SPA graph viewer compiled into the binary.
- **Multi-tenant access control**: You require the Triple-Heart WebACL access control model for tiered repository permissions.
- **You prefer a compiled Rust standalone binary**: You prefer installing a single native Rust binary via `cargo install` or GitHub releases rather than running Node.js.

## When to choose trace-mcp

- **Modern web application development**: You build with Next.js, React, Vue, Express, Fastify, Django, FastAPI, Rails, Spring Boot, or Laravel, and need semantic edges between routes, middleware, templates, and ORMs.
- **Deterministic agent tooling**: You want strongly typed, zero-hallucination MCP tools (`get_callers`, `get_change_impact`, `find_usages`) rather than generating complex SPARQL queries.
- **Safe, automated AST refactoring**: You want your AI agent to perform atomic symbol renames, extractions, and file moves with syntax validation and cross-file import rewrites.
- **Prompt budget efficiency**: You want a lean 29-tool `minimal` preset (~11.6K tokens) that protects the model's context window on every turn, with dynamic escalation via `load_tools`.
- **High-confidence impact analysis**: You need a 5-tier call graph that explicitly distinguishes compiler-verified relationships from heuristic inferences.
- **Integrated CI security & quality gates**: You want AST-grounded OWASP Top-10 taint analysis and OASIS SARIF 2.1.0 reporting built into your code graph workflow.
- **Zero-setup npm distribution**: You want instant execution via `npx -y trace-mcp@latest` with embedded SQLite and bundled ONNX embeddings.

## Next steps

- Learn how a persistent code graph reduces token costs on every turn: [Code graph MCP server](/code-graph-mcp.html).
- Full field: [how trace-mcp compares](/comparisons.html) against 20+ code-graph and memory MCP servers.
- The other head-to-heads: [vs Repomix](/vs/repomix.html) · [vs Serena](/vs/serena.html) · [vs codebase-memory-mcp](/vs/codebase-memory-mcp.html) · [vs codegraph](/vs/codegraph.html) · [vs CodeGraphContext](/vs/codegraphcontext.html) · [vs SocratiCode](/vs/socraticode.html) · [vs jCodeMunch](/vs/jcodemunch.html) · [vs TokenSave](/vs/tokensave.html) · [vs GitNexus](/vs/gitnexus.html) · [vs Context Mode](/vs/context-mode.html) · [vs code-review-graph](/vs/code-review-graph.html)
- Explore measured token savings and quality results across 60 open-source pull requests: [PR context benchmark](/pr-context-benchmark.html).
- Explore all MCP tools in the [tools reference](/tools-reference.html).
- Read the [architecture](/architecture.html) guide to see how embedded SQLite and tree-sitter WASM work together.
- Install trace-mcp in seconds: `npx -y trace-mcp@latest init`.
