---
title: "Code Graph MCP Server Comparison: trace-mcp vs Repomix, Serena & 20+ alternatives"
description: "Compare trace-mcp against Repomix, Serena, Kage, codebase-memory-mcp and 20+ MCP code-graph tools — capabilities, language support, GitHub stars. Last verified August 2026."
updated: 2026-08-29
---

# How trace-mcp compares

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "How trace-mcp compares",
  "description": "Feature-by-feature comparison against other code-graph and code-intelligence MCP servers.",
  "url": "https://trace-mcp.com/comparisons.html",
  "datePublished": "2026-04-18",
  "dateModified": "2026-08-28",
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
    "@id": "https://trace-mcp.com/comparisons.html"
  }
}
</script>
trace-mcp is not just a code intelligence server — it combines **code graph navigation**, **cross-session memory**, and **real-time code understanding** in a single tool. Other projects solve one of these; trace-mcp unifies all three.

## Head-to-head pages

This page is the whole field. For the three peers people most often evaluate against trace-mcp, there is a dedicated page with a focused table, an honest "when to pick theirs" section, and an FAQ:

- **[trace-mcp vs Repomix](/vs/repomix.html)** — packing a repository into one prompt vs indexing it into a queryable graph.
- **[trace-mcp vs Serena](/vs/serena.html)** — a live LSP proxy vs a precomputed framework-aware graph.
- **[trace-mcp vs codebase-memory-mcp](/vs/codebase-memory-mcp.html)** — the closest peer: same premise, opposite bets on breadth vs depth.

_Last verification pass: August 28, 2026 — deep-dive on the two largest peers plus star/feature re-verification. Based on public documentation and GitHub repos. If you maintain one of these projects and see an inaccuracy, [open an issue](https://github.com/nikolai-vysotskyi/trace-mcp/issues). This revision re-verifies star counts against the live GitHub API — several jumped by 3-4x since July (viral GitHub-trending spikes are common in this space and can reverse just as fast), so treat every count below as a snapshot, not a ranking. The two 60K+-star entrants flagged in a previous revision got their deep-dive: **Graphify** (110.6K stars, Python, deterministic AST-to-knowledge-graph skill/MCP server, no vector store) and **Headroom** (67.6K stars, Python, reversible tool-output/JSON/log compression layer — library, HTTP proxy, or MCP server). Neither closes a real gap for us: Graphify's edge provenance tagging (`EXTRACTED`/`INFERRED`/`AMBIGUOUS`) is a 3-tier scheme trace-mcp's existing 4-tier `resolution_tier` (`scip_resolved`/`lsp_resolved`/`ast_resolved`/`ast_inferred`/`text_matched`) already exceeds, and its Cypher/GraphML export is a feature trace-mcp already ships (`export_graph`). Headroom compresses arbitrary tool output generically (JSON/logs/RAG chunks) rather than understanding code structure — orthogonal to a code-graph server, not a lane worth chasing. See their rows/footnotes below. The "Honest assessment" section below was updated after six of seven identified gaps shipped and went through an adversarial deep-validation pass._

_A note on download counts, ours and theirs: npm's totals are heavily inflated by registry mirrors that re-crawl the whole version history on every publish. For trace-mcp on 2026-08-29, 104 published versions each showed a near-uniform 136–198 weekly downloads while the median version sat at 2 — real users pull `latest`, crawlers enumerate. Stripping publish days leaves an organic baseline of ~20–50/day against a headline of 4,551/28d. The same mechanism applies to every peer on this page, so a competitor's self-reported download number is not comparable evidence in either direction, and we do not cite our own. Star counts and GitHub traffic uniques are the adoption metrics used here._

## vs. token-efficient code exploration

Tools that help AI agents read code with fewer tokens — AST parsing, outlines, context packing.

| Capability | trace-mcp | Repomix | Context Mode | code-review-graph | jCodeMunch | codebase-memory-mcp | cymbal |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | 100 | 28.1K | 20.2K | ~19K | 2.6K | 41.1K | 165 |
| Tree-sitter AST parsing | ✅ {{ site.data.counts.languages }} languages | ✅ compress only (~20) | ❌ no code parsing | ✅ 23 langs + Jupyter | ✅ 70+ languages | ✅ 161 languages | ✅ 22 languages |
| Token-efficient symbol lookup | ✅ outlines, symbols, bundles | ❌ packs entire files | ✅ sandboxed output (98% reduction) | ✅ | ✅ core focus (~95% reduction) | ✅ | ✅ outline/show/context |
| Cross-file dependency graph | ✅ directed edge graph | ❌ | ❌ | ✅ incremental knowledge graph | ✅ import graph | ✅ knowledge graph | ✅ refs/importers |
| Framework-aware edges | ✅ {{ site.data.counts.frameworks }} integrations | ❌ | ❌ | ❌ | ✅ 21 frameworks (route/middleware) | partial (REST routes) | ❌ |
| Impact analysis | ✅ reverse dep traversal + decorator filter | ❌ | ❌ | ✅ blast-radius + Leiden communities | ✅ blast radius + decorator filter | ✅ detect_changes | ✅ impact command |
| Call graph | ✅ bidirectional, graph-based | ❌ | ❌ | ✅ graph-based | ✅ AST-based, bidirectional | ✅ trace_call_path | ✅ refs/importers |
| Refactoring tools | ✅ rename, extract, dead code, codemod | ❌ | ❌ | ❌ | ❌ (dead code detect only) | ❌ | ❌ |
| Security scanning | ✅ OWASP Top-10, taint | ✅ Secretlint | ❌ | ❌ | ❌ | ❌ | ❌ |
| Multi-repo subprojects | ✅ cross-repo API linking | ✅ remote repos | ❌ | ✅ multi-repo daemon | ✅ GitHub repos | ✅ cross-service HTTP linking | ❌ |
| IaC as graph nodes | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ K8s/Kustomize/HCL/Docker | ❌ |
| Session memory | ✅ built-in | ❌ | ✅ SQLite FTS5 journal | ❌ | ✅ index persistence | ✅ persistent graph | ❌ |
| Written in | TypeScript | TypeScript | TypeScript | Python | Python | C | Go |

_New entrants since April 2026 (local code-graph / packing lane, worth tracking): **Repomix** ships an official MCP server (`--mcp`) + tree-sitter `--compress` (~70% reduction); **tokensave** (601 stars, 40+ tools, 30+ langs, pre-indexed semantic KG); **codegraph** (colbymchenry — function-level dep graph, tree-sitter→SQLite, auto-sync; went viral this cycle, now 68.5K stars, claiming ~59% fewer tokens / ~70% fewer tool calls across its own benchmark set — unverified by us); **Headroom** (67.6K stars — not a code-graph tool, a generic reversible compression layer for tool outputs/JSON/logs/RAG chunks, deployable as library/proxy/MCP server; its `CodeCompressor` is AST-aware for 7 languages but purely for shrinking output bytes, with no graph, no symbol index, no cross-file edges — complements rather than competes with token-efficient *symbol* lookup); **repo-context-mcp** (nduc99911, 103 stars, TypeScript — three tools: `repo_map` directory tree + entrypoint detection, `search_code` substring grep, `pack_context` token-budgeted markdown pack; no AST parsing, no symbol index, no dependency graph — a lighter-weight cousin of Repomix, not a code-graph competitor). `cymbal` could not be re-verified in June 2026 — possibly renamed or inactive. `Context Mode` **is** active and was re-verified on August 29, 2026 (20.2K stars, last push August 28) — the June "could not verify" note was wrong and is retracted here._

**codebase-memory-mcp's stars more than doubled over two revisions (18.1K → 41.0K verified via GitHub API) — the fastest single-project jump we've tracked in this doc.** Its authors also published a benchmark preprint (arXiv 2603.27277: "Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP") reporting 83% answer quality, 10× fewer tokens, and 2.1× fewer tool calls vs. file-by-file exploration across 31 real-world repos — the first published third-party-style benchmark from a direct code-graph peer (vs. the self-reported numbers most others cite). We have not independently reproduced it. This doesn't change our positioning (see "Honest assessment" below) but is worth flagging: a fast-growing peer with a real benchmark paper is a sharper competitive signal than a star count alone.

## vs. AI session memory

Tools that persist context across AI agent sessions — activity logs, knowledge graphs, memory compression.

| Capability | trace-mcp | Kage | MemPalace | claude-mem | mem0 / OpenMemory | engram | ConPort |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | 100 | new (2026) | ~56.7K | 91.8K | ~53K | 2.7K | 761 |
| Cross-session context carryover | ✅ `get_wake_up { scope: "resume" }` + decisions | ✅ git-committed packets | ✅ wings/rooms | ✅ core focus | ✅ multi-level (User/Session/Agent) | ✅ branch-scoped handoffs | ✅ |
| Cross-session content search | ✅ `search_sessions` FTS5 | partial (JSON packets) | ✅ vector+keyword+temporal (+optional rerank), 96.6% R@5 LongMemEval | ✅ SQLite + Chroma hybrid | ✅ hierarchical, ≤7K tok/retrieval (94.4 LongMemEval) | ✅ local ONNX embeddings | ✅ vector semantic |
| Decision knowledge graph | ✅ temporal, code-linked | ✅ temporal, code-linked | ✅ temporal + "Closets" storage | ❌ | ✅ temporal + state-key supersession | ❌ | ✅ project-level |
| Code-graph-aware memory | ✅ decisions → symbols & files | ✅ **+ citation verification (staleness check)** | ❌ text-only | ❌ text-only | ❌ text-only | ❌ text-only | ❌ text-only |
| Auto-extraction from sessions | ✅ pattern-based (0 LLM calls); hybrid LLM opt-in | ❌ agent-written | ❌ verbatim, zero extraction | ✅ AI-compressed + citations | ✅ single-pass hierarchical LLM | ❌ | ❌ |
| Wake-up context | ✅ ~300 tok (code-linked decisions) | — | ✅ ~170 tok (AAAK) | ✅ progressive disclosure (~10×) + Endless Mode | ❌ | ❌ | ❌ |
| Decision enrichment in tools | ✅ impact/plan_turn/resume | ❌ | ❌ standalone | ❌ | ❌ | ❌ | ❌ |
| Service/subproject scoping | ✅ decisions per service | ❌ | ✅ wings per project | ❌ | ❌ | ✅ per branch | ✅ per workspace |
| Published retrieval benchmark | ❌ | ❌ | ✅ LongMemEval / LoCoMo / MemBench | ❌ | ✅ LoCoMo / LongMemEval / BEAM | ❌ | ❌ |
| Code intelligence included | ✅ {{ site.data.counts.tools }} tools, 180+ edge types | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Works as standalone memory | ❌ code-focused | ✅ git-native, code-focused | ✅ general-purpose | ❌ Claude-specific | ✅ agent-agnostic | ✅ agent-agnostic | ✅ project-scoped |
| Written in | TypeScript | — | Python | TypeScript | TS + Python | Go / Rust | Python |

> **Key difference:** MemPalace stores "decided to use PostgreSQL" as text in ChromaDB. trace-mcp stores the same decision **linked to `src/db/connection.ts::Pool#class`** — and when you run `get_change_impact` on that symbol, the decision shows up in `linked_decisions`. General-purpose memory tools remember *what you said*. trace-mcp remembers *what you said* AND *which code it's about*.
>
> **Where the field moved (April → June 2026):** (1) Retrieval became a *published number* — mem0 (94.4 LongMemEval, ≤7K tok/retrieval) and MemPalace (96.6% R@5) both ship benchmarks; trace-mcp's decision recall is still FTS5-only with no published figure. (2) **Kage** is the first peer to share trace-mcp's code-linked-memory premise *and* add what trace-mcp lacks: it verifies each memory's cited code at recall and diff time, withholding decisions whose code was renamed/deleted (claimed 0% stale-served). (3) mem0 added search-time temporal decay (1.5× recency / 0.3× stale) and state-key supersession — close analogs to trace-mcp's `order_by:"heat"` and `invalidate_decision`, but automatic.

## vs. documentation generation & RAG

Tools that generate docs from code or provide embedding-based code search for AI retrieval.

| Capability | trace-mcp | Repomix | DeepContext | smart-coding-mcp | mcp-local-rag¹ | knowledge-rag¹ |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | 100 | ~26.7K | ~300 | ~200 | ~200 | ~60 |
| Real-time code understanding | ✅ live graph, always current | ❌ snapshot at pack time | ❌ manual reindex | partial (opt-in watcher) | ❌ | partial (file watcher) |
| Auto-generated project docs | ✅ `generate_docs` from graph | ❌ raw file dump | ❌ | ❌ | ❌ | ❌ |
| Semantic code search | ✅ `search` + `query_by_intent` | ❌ no search | ✅ Jina embeddings | ✅ nomic embeddings | ✅ vector search | ✅ hybrid + reranking |
| Framework-aware context | ✅ routes, models, components | ❌ | ❌ | ❌ | ❌ | ❌ |
| Task-focused context | ✅ `get_task_context` — code subgraph | ❌ packs everything | ❌ | ❌ | ❌ | ❌ |
| No doc maintenance needed | ✅ derived from code | ✅ repacks on demand | ❌ manual reindex | partial (auto on startup) | ❌ manual ingest | partial (auto-reindex) |
| Works offline, no API keys | ✅ graph + FTS5 + bundled ONNX embeddings | ✅ | ❌ requires cloud API | ❌ requires local embeddings | ❌ requires local embeddings | ❌ requires local embeddings |
| Incremental updates | ✅ file watcher, content hash | ❌ full repack | ✅ SHA-256 hashing | ✅ file hash + opt-in watcher | ❌ | ✅ mtime + dedup |
| Written in | TypeScript | TypeScript | TypeScript | JavaScript | TypeScript | Python |

_¹ mcp-local-rag and knowledge-rag are document RAG tools (PDF, DOCX, Markdown) — not code-specific. Included for comparison as they occupy adjacent mindshare._

> **Key difference:** RAG tools answer "find code similar to this query." trace-mcp answers "show me the execution path, the dependencies, and the tests for this feature." Graph traversal finds structurally relevant code that embedding similarity misses — and never returns stale results because the graph updates incrementally with every file save. (Independent evidence: the *CodeCompass* study, arXiv 2602.20048, reports +23.2 pp on hidden-dependency tasks from graph navigation over grep-style retrieval.)

## vs. code graph MCP servers

| Capability | trace-mcp | Serena | code-review-graph | codebase-memory-mcp | SocratiCode | Narsil-MCP | Roam-Code |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | 100 | ~28.6K | ~19K | 41.1K | ~900 | ~100 | ~500 |
| Languages | {{ site.data.counts.languages }} | 40+ (via LSP) | 23 + Jupyter | 161 | 19 | 32 | 28 |
| Framework integrations | {{ site.data.counts.frameworks }} | ❌ | ❌ (Python entry points only) | ❌ | ❌ | ❌ | ~15 (ORM N+1 / API drift only) |
| Cross-language edges | ✅ | ❌ | ❌ | ✅ cross-service HTTP | ✅ polyglot dep graph | ❌ | ✅ PHP↔TS API drift |
| MCP tools advertised (default) | 28 `minimal` (~9.8K tok, default); 54 `standard` (~19K); {{ site.data.counts.tools }} `full` (~50K) | ~55 | ~28 | 15 all / 11 `analysis` / 7 `scout` (~7K tok) | 21 | 90 | 224 |
| Session memory | ✅ | ✅ (manual notes) | ❌ | ✅ | ❌ | ❌ | ❌ |
| CI/PR reports | ✅ | ❌ | ✅ blast-radius GitHub Action | ❌ | ❌ | ❌ | ✅ SARIF 2.1.0 + GH/GL/Azure |
| Multi-repo subprojects | ✅ | ❌ | ✅ multi-repo daemon | ✅ cross-service | ✅ cross-project search | ❌ | ❌ |
| Control-flow / data-flow | ✅ CFG w/ basic blocks + loop back-edges + dataflow | ❌ | ❌ | ❌ | ❌ | ✅ CFG w/ basic blocks + loop edges; type-aware taint | ❌ |
| Security scanning | ✅ OWASP/taint, type-aware pruning | ❌ | ❌ | ❌ | ❌ | ✅ 147 rules (taint/OWASP/CWE) + SBOM + OSV/supply-chain | ❌ |
| IaC as graph nodes | ✅ K8s/Kustomize/HCL/Docker, cross-file resolved to real nodes | ❌ | ❌ | ✅ K8s/Kustomize/HCL/Docker | ❌ | ❌ | ❌ |
| Compiler-grade precision | ✅ opt-in LSP + offline SCIP ingestion (`scip_resolved` tier) | ✅ live LSP (rename/refs/diagnostics) | ❌ | ❌ | ❌ | ❌ | ❌ |
| SARIF / CI-scanning output | ✅ 2.1.0, OASIS-schema-validated | ❌ | ✅ blast-radius GitHub Action | ❌ | ❌ | ❌ | ✅ SARIF 2.1.0 + GH/GL/Azure |
| Graph visualization | ✅ desktop app (cosmos.gl) | ❌ | ❌ | ✅ 3D web UI | ✅ interactive HTML | ✅ SPA frontend | ❌ |
| Knowledge graph queries | ✅ `graph_query` | ❌ | ❌ | ✅ Cypher-like | ❌ | ✅ SPARQL / RDF | ❌ |
| Refactoring tools | ✅ rename/move/signature/codemod/extract¹ | ✅ rename/move/inline/safe-delete | ❌ | ❌ | ❌ | ❌ | ❌ |
| Antipatterns / clone detection | ✅ 11 antipatterns + 4 code smells (debug artifacts across 10 langs) + AST Type-2 subtree hashing + name/signature duplication | ❌ | ❌ | ✅ MinHash near-clone + Louvain communities | ❌ | ❌ | ✅ 23 patterns + AST Type-2 subtree hashing |
| Architecture governance | ✅ | ❌ | ✅ Leiden communities | ✅ Louvain communities | ❌ | ❌ | ✅ change-safety gates |
| Token savings tracking | ✅ | ❌ | ✅ (6.8×–49×) | ✅ | ✅ (~61% claimed) | ❌ | ✅ (~92% claimed) |
| Written in | TypeScript | Python | Python | C | TypeScript | Rust | Python |

_¹ `apply_codemod` now rewrites on `@ast-grep/napi` (true AST pattern matching, metavariable substitution, no false matches in strings/comments) with automatic regex fallback for non-AST languages; the native binding loads lazily and degrades to regex instead of crashing if missing. `extract_function` is re-enabled with AST free-variable analysis — it detects genuine multi-return-value slices and rejects them with a structured error rather than silently dropping a binding, and lowers `confidence` on shadowed-variable cases instead of misreporting them as clean (see "where competitors lead" below for what deep validation found)._

_New entrants since April 2026 (direct code-graph MCP peers): **grafel** (Rust, multi-repo daemon, cross-repo + IaC topology, watcher-driven, FlatBuffer in-memory graph); **GitNexus** (MCP-native KG, Leiden communities with cohesion scores); **Code Pathfinder** (5-pass AST indexing, NL queries, dataflow); **CodeGraphContext / CGC** (tree-sitter **+ optional SCIP indexers** → property graph — the one peer already wiring in SCIP for compiler-grade refs); **Graphify** (Python, 110.6K stars — deterministic tree-sitter AST → knowledge graph over 13 languages plus docs/SQL schemas/configs/PDFs/images, no vector store, `/graphify` Claude Code skill or standalone `--mcp` server, `--neo4j` Cypher export, `--wiki` crawlable markdown output; 3-tier edge provenance (`EXTRACTED`/`INFERRED`/`AMBIGUOUS`) is coarser than trace-mcp's 4-tier `resolution_tier`, and it has no refactoring tools, security scanning, or framework-aware edges). Serena shipped a live debugger tool (breakpoints / variable inspection) in v1.5.x — out of the static-graph lane but notable._

> **Why framework awareness matters:** A graph that knows `UserController` exists but doesn't know it renders `Users/Show.vue` via Inertia is missing the edges that matter most. Framework integrations turn a syntax graph into a **semantic** graph — the agent sees the same connections a developer sees.

## Deep dive: how the two largest peers shape their tool surface

Both of the biggest projects in this space (by stars) made the same product call, independently, and it is the one place they are clearly ahead of trace-mcp today. Verified by reading their source on August 28, 2026, not their READMEs.

**The 68.5K-star entrant (colbymchenry/codegraph, v1.6.0, TypeScript with a Rust kernel)** defines eight MCP tools — search, callers, callees, impact, node, explore, status, files — and by default **advertises exactly one of them**. `DEFAULT_MCP_TOOLS` is the single-element set `{explore}`; the rest stay fully implemented and re-enablable through a `CODEGRAPH_MCP_TOOLS` allowlist env var, but are not listed to agents. The stated reason, in a source comment: every other tool is a narrower slice of what `explore` already does, and *presence itself steers mis-picks*. Their whole advertised surface costs roughly **1.9K tokens** (~390 tokens of schema plus a ~5.8K-character server-instructions block). Two further mechanisms are worth noting: (1) `explore` carries a per-project **adaptive output budget** — total output cap, default file count, per-file cap and clustering threshold all tier on indexed file count, explicitly kept under the host's ~25K-char inline tool-result cap so the result is never externalised to a file the agent has to read back; (2) their file-reading tool deliberately mirrors the host's native Read contract byte-for-byte (`offset`/`limit`, `<n>\t<line>` output, "safe to Edit from") so it can be substituted for Read rather than competing with it.

**The 41.0K-star entrant (DeusData/codebase-memory-mcp, pure C)** ships 15 MCP tools (~7K tokens of schema) and adds **tool profiles**: `--tool-profile=scout` exposes 7, `--tool-profile=analysis` exposes 11, default exposes all 15. Re-verified this pass: 161 languages (up from 158), Hybrid LSP semantic type resolution across 12 languages, and two tools we had not catalogued — `manage_adr` (create/replace an Architecture Decision Record document) and `ingest_traces` (ingest runtime caller/callee counts to enrich the graph). Supply-chain posture is a deliberate selling point: SLSA Level 3, VirusTotal scanning of three behaviourally identical release candidates, OpenSSF Scorecard.

**Take:** `manage_adr` is a flat markdown document with get/update/sections modes — not code-linked memory, and no reason to copy it; trace-mcp's decisions already bind to symbol IDs and surface inside `get_change_impact`. `ingest_traces` is a genuinely missing capability (runtime-observed dynamic call edges that static analysis cannot see) but is a three-field payload — a thin veneer, worth revisiting only if users ask. The 161-language race stays out of lane, as before.

**What we took — and where it landed.** The August 2026 pass recorded a *default* tool surface small enough to be honest about as the thing to fix, and named a specific bug: the preset gate was silently bypassed on the default daemon-backed path, pinning every session at the full surface. **That is now shipped and closed.** Re-measured on August 29, 2026 with a real `initialize` + `tools/list` round-trip against the built server, reading the wire payload rather than counting names:

| Configuration | Tools | `tools/list` wire | Server instructions |
|---|---:|---:|---:|
| `preset: "minimal"` (shipped default) | 28 | ~9.8K tok | ~1.75K tok |
| `preset: "standard"` | 54 | ~18.8K tok | ~1.75K tok |
| `preset: "full"` (explicit opt-in) | 165 | ~49.9K tok | ~2.1K tok |
| `standard` + `description_verbosity: "none"` | 54 | ~8.4K tok | 0 |

The tool counts in that table are what *this* repo serves, not the preset's ceiling: registration is gated on detected frameworks, so `minimal` (28 tools) hits its ceiling here while `standard` (60 tools) serves 54 of its 60 and `full` ({{ site.data.counts.tools }} tools) serves 165. Quote the ceilings when comparing on paper and the live numbers when comparing session cost.

So the honest default is **~11.6K tokens, not the ~51K this page used to quote** — a 2.5× correction in our own favour, caused by four landed changes (preset honoured on the daemon path, seven deprecated aliases retired, `compact_schemas` extended to the whole surface, and the default preset moved to `minimal` once `load_tools` made everything outside it one call away) that this page had not caught up with. The `minimal` row's ~9.8K is derived, not re-measured: the preset grew 25 → 28 tools and 30,540 → 34,041 serialized chars when it absorbed the always-load set, +11.5% on the ~8.8K that was measured live.

**A third mechanism worth reading, from the budget-policy peer (GlitterKill/SDL-MCP, 467 stars, TypeScript; source read August 29, 2026, not its README).** It solves the same problem *losslessly* rather than by dropping tools. `src/gateway/index.ts` registers **four** namespace tools — `sdl.query`, `sdl.code`, `sdl.repo`, `sdl.agent` — each of whose wire schema is a `oneOf` over per-action envelopes (`buildGatewayWireSchema` in `src/gateway/thin-schemas.ts`), with the 29 flat tool names kept only as deprecated aliases behind `emitLegacyTools`. `src/gateway/compact-schema.ts` then flattens the union and deduplicates repeated sub-schemas into `$defs`/`$ref` before the schema ever reaches `tools/list`. Two further pieces sit on top: `src/mcp/response-projection/budgets.ts` quantises every tool *result* into eight fixed budget classes (120 / 200 / 500 / 1K / 2K / 8K tokens) rather than accepting an arbitrary caller number, with `Math.min(class, callerCap, 8K)` as the rule; and a result that overflows its class is returned as an opaque **handle** (`responseMode: "handle"`, recovered in 8 KiB pages) instead of being truncated, so nothing is silently lost. Their stated reason for fixed classes is that a size that varies per call makes responses prompt-cache-unstable — the same reasoning drives an explicit ban on timestamps, durations, session IDs, counters and machine paths in default responses.

**Take, with numbers rather than admiration:**
- **Namespace projection: not now.** It would take our 54-tool default toward a handful of advertised entries, but it is a breaking change to every tool name, and it moves tool selection from the model's native tool-picker into a `oneOf` discriminator — a real accuracy risk we would be trading blind. Revisit only if the default surface stops shrinking by other means.
- **`$defs`/`$ref` deduplication: measured and rejected.** MCP gives every tool its own `inputSchema`, so `$ref` cannot be shared across tools — only within one. Measured on our own full surface, *all* duplicated property definitions across 165 tools total ~7.5 KB (~2.1K tokens, 4% of the wire), and the top offenders are already small (`output_format` ×10 = 2.6 KB, `detail_level` ×5 = 1.2 KB). Deduplication only pays after gateway consolidation puts many actions under one schema. Filed nothing; this closes the idea.
- **Handles instead of truncation: worth taking**, and independent of the two above.
- **Fixed budget classes: worth taking**, same reason.

## Honest assessment: where competitors lead

No tool is uniformly ahead. trace-mcp is the only one combining framework-aware code intelligence + a refactoring engine + code-linked session memory in a single local MCP server — but on individual axes, specialists go deeper. As of July 2026, six of the seven gaps identified in the June re-verification have shipped and gone through an adversarial deep-validation pass (not just unit tests — a second pass that tried specifically to break each feature). That pass surfaced real bugs, which is itself worth being transparent about:

**Shipped and adversarially validated:**

- **AST-based rewrite engine.** `apply_codemod` now runs on `@ast-grep/napi` (true AST pattern matching, metavariable substitution, no false matches in strings/comments), auto-falling back to the regex engine for non-AST languages. `extract_function` is re-enabled with AST free-variable analysis. Deep validation found and fixed a real crash risk: the native `.node` binding can be silently dropped by npm's known optional-dependency bug (npm/cli#4828), and the codemod/extract modules did static top-level imports of it — meaning a missing binding **crashed the whole MCP server at startup**. Fixed with lazy loading and graceful degradation (verified via a real fresh `npm install` reproducing the drop). Also found and fixed: a shadowed-variable slice could reference the wrong out-of-scope binding in the generated `return`; a genuine multi-return-value slice silently dropped the second binding instead of being rejected; a zero-match codemod returned a hard tool-call error for the normal "nothing to change" outcome.
- **Compiler-grade reference precision via SCIP.** A new `scip_resolved` edge tier (above `lsp_resolved`) ingests precomputed `.scip` indexes (scip-typescript / scip-python / rust-analyzer→SCIP) offline — no live language-server process needed. Deep validation ran a **real `scip-typescript` indexer** end-to-end (not just synthetic protobuf bytes) and found the subsystem produced **zero `scip_resolved` edges on any real input, ever** — two decoder bugs (a length-field evaluation-order bug that corrupted every subsequent read; range fields decoded as zig-zag instead of plain varint, corrupting every position) had passed the original synthetic tests only because the hand-written test fixture shared the same wrong assumptions as the buggy decoder. Both fixed and locked in with a permanent captured-`.scip` regression fixture.
- **Staleness verification of code-linked memory.** `query_decisions`/`get_wake_up` now verify a decision's linked `symbol_id` still resolves and its source is unchanged since `created_at` before serving it — the Kage-style guarantee. Deep validation found the "fail open" contract (never hide a decision just because verification itself errored) was not actually enforced — an internal Store error propagated uncaught, and the recall-timeout fallback then silently returned an *empty* list, i.e. fail-closed data loss disguised as fail-open. Fixed. Also found and fixed a performance issue: verifying 100 decisions could take ~3.1s (synchronous git subprocess spawns per decision); memoized to ~95ms for the common case of decisions clustered on a handful of files (the fully-scattered worst case is unchanged and remains open, see below).
- **Decision-retrieval quality + a tracked benchmark.** `query_decisions` now fuses FTS5 + embedding similarity (reusing the existing Signal Fusion engine) with FTS5 as the zero-dependency fallback, plus a tracked recall@k/MRR benchmark. Deep validation found the benchmark *script* itself was broken (pointed at a build path that doesn't exist under this repo's bundled output) and had silently drifted from the tracked fixture it was supposed to measure. Fixed to run against the real fixture; corrected numbers: recall@1=0.594, recall@3=recall@5=0.969, MRR=0.823.
- **SARIF 2.1.0 output.** `scan_security` / `detect_antipatterns` / `check_quality_gates` now support `output_format: "sarif"`. Deep validation installed a JSON-schema validator and checked real generated payloads against the actual OASIS SARIF 2.1.0 schema (not just eyeballed the shape) — all required fields validated across all three finding shapes. Also found and fixed: the embedded `$schema` URL pointed at a moved/dead (404) location; corrected to the canonical OASIS URL.
- **Real CFG with loop back-edges.** `get_control_flow` now emits loop back-edges, loop-exit edges, and try/catch/finally merge nodes instead of a branch-only tree. Deep validation found and fixed a real pre-existing bug independent of the back-edge feature: the do-while detector matched *any* identifier starting with "do" (`doOuter()`, `document.write()`, `download(x)`) as a loop, injecting phantom back-edges and corrupting cyclomatic complexity on ordinary code. Verified separately: nested loops get correctly independent back-edges, `break` doesn't create a false back-edge, `continue` is modeled distinctly, switch/case fallthrough is branches not a flattened block.
- **Type-aware SAST.** `taint_analysis` now prunes flows that provably terminate at a non-string value (numeric/boolean coercion). Deep validation focused on the highest-risk failure mode for a security tool — silent false negatives from over-pruning — and found two real ones: a variable narrowed to numeric at one point but reassigned to attacker-controlled string input *before* the sink was still (wrongly) pruned; string concatenation and template-literal taint propagation (`s = '' + id`, `` `p-${id}` ``) wasn't tracked at all, producing zero flows for classic injection shapes. Both fixed; verified the fixes don't regress the pruning itself (`String(x)` casts and non-sanitizing look-alike wrappers still flag correctly).
- **IaC as first-class graph nodes.** K8s manifests, Kustomize overlays, and docker-compose→Dockerfile links are now `Resource`/`Module` graph nodes with `imports` edges, not just `get_artifacts` discoveries. Deep validation found the cross-file resolution was worse than "not wired": Kustomize/compose import edges were persisting as **useless source→source self-loops**, and a second bug meant multiple resource references (`resources: [a.yaml, b.yaml]`) silently collapsed into a single edge because they shared one SQLite `INSERT OR IGNORE` key. Fixed with a real post-pass resolver (modeled on the existing wikilink resolver) that now correctly traverses Kustomize Module → Resource and compose service → Dockerfile. Also found Terraform/HCL module→source edges were fully implemented but silently dropped at persist time for lack of a source symbol — fixed.

**Still genuinely open (honest, not closed by the validation pass):**

- **Advertised tool-surface cost — narrowed ~4.4×, still behind.** Re-measured August 29, 2026: the shipped default is the `minimal` preset at 28 tools / ~9.8K tokens of `tools/list` plus ~1.75K tokens of server instructions — ~11.6K in total, down from the ~51K this page quoted in August. (`standard`, an explicit opt-in, serves 54 tools here for ~18.8K.) The preset-bypass bug behind that number is fixed and closed. The remaining gap is real but no longer embarrassing: the two largest peers advertise ~1.9K and ~7K tokens, i.e. ~6× and ~1.7× cheaper than our default. Both buy that with a smaller *capability* surface (one peer advertises a single tool); we buy ours by deferring 141 tools out of the default and keeping them one `load_tools` call away. What is still ours to fix is that ~57% of the wire is tool and parameter *descriptions* (measured on the 54-tool `standard` surface: 22.5 KB of 67.7 KB) — `description_verbosity: "none"` roughly halves whichever preset you run, but at a cost to tool-selection accuracy nobody has measured. A middle setting that keeps the first sentence and drops the rest is the obvious unexplored win.

- **Per-project config is only partly honoured.** Found while measuring the above: `tools.preset` set in a project-local `.trace-mcp/.config.json` takes effect (165 → 54 tools), but `tools.description_verbosity` and `tools.instructions_verbosity` in the *same file* are silently ignored — byte-for-byte identical output across `full` / `minimal` / `none`. Both work when set in the global `~/.trace-mcp/.config.json` (`none` → ~8.4K tokens, instructions to zero). The configuration page promises per-project override for these. Worth up to ~10.5K tokens per session for anyone who followed the docs. Tracked as its own issue.

- **Validated code-health metric.** A temporal-holdout calibration script now correlates `predict_bugs`/`get_risk_hotspots` against real future-fix commits on this repo (churn Spearman ≈0.34, precision@20 ≈2.1–2.4× over random) and the tool descriptions were reworded to honest "heuristic triage" language. This is evidence, not CodeScene-grade external validation — the gap to a peer-reviewed, cross-repo-validated metric remains.
- **Worst-case decision-verification latency.** The memoization fix above only helps when decisions cluster on a handful of files; a batch fully scattered across N distinct files is still O(N) git subprocess spawns. An async/batched redesign would be needed to bound the worst case.
- **CFG is line-based, not AST-based**, and taint analysis remains lexical/regex, not a real dataflow engine — both are known architectural ceilings, not just untested edge cases; a full AST/dataflow rewrite of either is out of scope for now.

**Deliberately NOT chasing (out of lane or vanity):** live runtime debugger (Serena — runtime, not static graph); counterfactual architecture simulation / multi-agent swarm (Roam-Code — unverified, speculative); the 161-language count race (codebase-memory-mcp — trace-mcp's {{ site.data.counts.languages }} already covers the real-world long tail); the tool-count arms race for its own sake (Roam 224, Narsil 90 — quality of edges beats tool count; note this is a claim about which tools to *build*, not about how many to advertise by default, where we are currently behind — see above); verbatim chat storage and 20× "Endless Mode" (MemPalace / claude-mem — trace-mcp's extract-then-store model is deliberate, and Endless Mode adds 60–90s latency per tool).

## Profiling depth tracker

Which entries above got a real read of their architecture/code and a concrete take-or-pass decision, vs. which are still table rows filled from README/star-count checks only. Used to pick where the next competitor-intel pass digs deeper instead of re-scanning the same surface facts.

**Profiled deep (architecture/code read, explicit take-or-pass with reasoning):** Graphify, Headroom, Kage, mem0/OpenMemory, MemPalace, codebase-memory-mcp, codegraph, SDL-MCP.

**Tracked, still surface-level only (README + stars, no code/architecture read yet):** Serena, code-review-graph, SocratiCode, Narsil-MCP, Roam-Code, Repomix, tokensave, jCodeMunch, Context Mode, cymbal, DeepContext, smart-coding-mcp, mcp-local-rag, knowledge-rag, ConPort, engram, claude-mem, repo-context-mcp, grafel, GitNexus, Code Pathfinder, CodeGraphContext/CGC, LeanKG, CodeGraph (codegraph-ai), marm-memory.

Still unprofiled from the previous pass's "newly spotted" list: **LeanKG** (FreePeak, 215 stars, Rust, token-reduction framing); **CodeGraph** (codegraph-ai, 74 stars, C — 42 MCP tools, 38 languages, VS Code extension); **marm-memory** (338 stars, Python — session history + codebase index + concept graph in one SQLite layer).

**SDL-MCP profiled this pass** (August 29, 2026 — repo cloned and read: `src/gateway/`, `src/mcp/response-projection/`, `docs/architecture.md`, `docs/tool-output-contract.md`, `docs/tool-enforcement.md`). Findings and the take-or-pass on each are in the tool-surface deep dive above. Three things beyond the budget layer are worth recording here rather than re-discovering: it runs on an embedded **graph** database (LadybugDB / Kuzu engine) rather than SQLite+FTS5; it ships **client-side enforcement generation** (`sdl-mcp init --client claude-code --enforce-agent-tools` writes `.claude/settings.json` hooks, a subagent, and repo-local instruction files whose job is to stop the agent falling back to native Read/Bash) — a distribution idea, not a code idea, and the one place a peer is doing something we are not; and it treats native-tool substitution as a design goal, mirroring the host's Read contract byte-for-byte, which is the same move the 68.6K-star peer makes.

Priority for next deep-dive: **Serena** (~28.6K stars — now the largest peer never profiled beyond its README, and the only one with live LSP as its core premise rather than an opt-in tier), then **Context Mode** (20.2K stars, wrongly written off as inactive in June, never profiled, and its "sandbox tool output, 98% reduction" claim is directly adjacent to the response-budget work above).

**Bottom line:** trace-mcp's moat — framework-aware graph + refactoring + code-linked memory in one local MCP — is intact and unmatched as a *combination*. Six of seven gaps identified in the June 2026 re-verification are now shipped; the adversarial validation pass that followed found and fixed 15+ real bugs (several of them "the feature silently didn't work at all," not cosmetic) rather than taking the initial implementation on faith. The one deliberately-open gap (a peer-reviewed validated health metric) is honestly labeled as such rather than oversold.

## Next steps

- See the full [tools reference](/tools-reference.html) for every MCP tool trace-mcp exposes, grouped by framework.
- Read the [architecture](/architecture.html) page for how the indexing pipeline, storage, and LSP enrichment fit together.
- Check [supported frameworks & languages](/supported-frameworks.html) to confirm your stack is covered.
- [Get started](/#install) — trace-mcp works out of the box, no configuration required.
