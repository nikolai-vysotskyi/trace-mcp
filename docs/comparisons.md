# How trace-mcp compares

trace-mcp is not just a code intelligence server — it combines **code graph navigation**, **cross-session memory**, and **real-time code understanding** in a single tool. Other projects solve one of these; trace-mcp unifies all three.

_Last updated: June 30, 2026. Based on public documentation and GitHub repos. If you maintain one of these projects and see an inaccuracy, [open an issue](https://github.com/nikolai-vysotskyi/trace-mcp/issues). This revision re-verifies the April 2026 peer set, refreshes star/version/feature facts (several moved sharply), and adds new entrants: Kage, grafel, GitNexus, Code Pathfinder, CodeGraphContext, tokensave. Competitor facts current as of June 2026 — star counts drift, treat as approximate._

## vs. token-efficient code exploration

Tools that help AI agents read code with fewer tokens — AST parsing, outlines, context packing.

| Capability | trace-mcp | Repomix | Context Mode | code-review-graph | jCodeMunch | codebase-memory-mcp | cymbal |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | ~26.7K | 8.8K | ~19K | 1.6K | ~18.1K | 165 |
| Tree-sitter AST parsing | ✅ 81 languages | ✅ compress only (~20) | ❌ no code parsing | ✅ 23 langs + Jupyter | ✅ 70+ languages | ✅ 158 languages | ✅ 22 languages |
| Token-efficient symbol lookup | ✅ outlines, symbols, bundles | ❌ packs entire files | ✅ sandboxed output (98% reduction) | ✅ | ✅ core focus (~95% reduction) | ✅ | ✅ outline/show/context |
| Cross-file dependency graph | ✅ directed edge graph | ❌ | ❌ | ✅ incremental knowledge graph | ✅ import graph | ✅ knowledge graph | ✅ refs/importers |
| Framework-aware edges | ✅ 68 integrations (22 web frameworks, 8 ORMs, 6 UI libs, 32 tooling) | ❌ | ❌ | ❌ | ✅ 21 frameworks (route/middleware) | partial (REST routes) | ❌ |
| Impact analysis | ✅ reverse dep traversal + decorator filter | ❌ | ❌ | ✅ blast-radius + Leiden communities | ✅ blast radius + decorator filter | ✅ detect_changes | ✅ impact command |
| Call graph | ✅ bidirectional, graph-based | ❌ | ❌ | ✅ graph-based | ✅ AST-based, bidirectional | ✅ trace_call_path | ✅ refs/importers |
| Refactoring tools | ✅ rename, extract, dead code, codemod | ❌ | ❌ | ❌ | ❌ (dead code detect only) | ❌ | ❌ |
| Security scanning | ✅ OWASP Top-10, taint | ✅ Secretlint | ❌ | ❌ | ❌ | ❌ | ❌ |
| Multi-repo subprojects | ✅ cross-repo API linking | ✅ remote repos | ❌ | ✅ multi-repo daemon | ✅ GitHub repos | ✅ cross-service HTTP linking | ❌ |
| IaC as graph nodes | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ K8s/Kustomize/HCL/Docker | ❌ |
| Session memory | ✅ built-in | ❌ | ✅ SQLite FTS5 journal | ❌ | ✅ index persistence | ✅ persistent graph | ❌ |
| Written in | TypeScript | TypeScript | TypeScript | Python | Python | C | Go |

_New entrants since April 2026 (local code-graph / packing lane, worth tracking): **Repomix** ships an official MCP server (`--mcp`) + tree-sitter `--compress` (~70% reduction); **tokensave** (40+ tools, 30+ langs, pre-indexed semantic KG); **codegraph** (colbymchenry — function-level dep graph, tree-sitter→SQLite, auto-sync). `cymbal` and `Context Mode` could not be re-verified in June 2026 — possibly renamed or inactive._

## vs. AI session memory

Tools that persist context across AI agent sessions — activity logs, knowledge graphs, memory compression.

| Capability | trace-mcp | Kage | MemPalace | claude-mem | mem0 / OpenMemory | engram | ConPort |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | new (2026) | ~56.7K | ~21.5K | ~53K | 2.7K | 761 |
| Cross-session context carryover | ✅ `get_session_resume` + decisions | ✅ git-committed packets | ✅ wings/rooms | ✅ core focus | ✅ multi-level (User/Session/Agent) | ✅ branch-scoped handoffs | ✅ |
| Cross-session content search | ✅ `search_sessions` FTS5 | partial (JSON packets) | ✅ vector+keyword+temporal (+optional rerank), 96.6% R@5 LongMemEval | ✅ SQLite + Chroma hybrid | ✅ hierarchical, ≤7K tok/retrieval (94.4 LongMemEval) | ✅ local ONNX embeddings | ✅ vector semantic |
| Decision knowledge graph | ✅ temporal, code-linked | ✅ temporal, code-linked | ✅ temporal + "Closets" storage | ❌ | ✅ temporal + state-key supersession | ❌ | ✅ project-level |
| Code-graph-aware memory | ✅ decisions → symbols & files | ✅ **+ citation verification (staleness check)** | ❌ text-only | ❌ text-only | ❌ text-only | ❌ text-only | ❌ text-only |
| Auto-extraction from sessions | ✅ pattern-based (0 LLM calls); hybrid LLM opt-in | ❌ agent-written | ❌ verbatim, zero extraction | ✅ AI-compressed + citations | ✅ single-pass hierarchical LLM | ❌ | ❌ |
| Wake-up context | ✅ ~300 tok (code-linked decisions) | — | ✅ ~170 tok (AAAK) | ✅ progressive disclosure (~10×) + Endless Mode | ❌ | ❌ | ❌ |
| Decision enrichment in tools | ✅ impact/plan_turn/resume | ❌ | ❌ standalone | ❌ | ❌ | ❌ | ❌ |
| Service/subproject scoping | ✅ decisions per service | ❌ | ✅ wings per project | ❌ | ❌ | ✅ per branch | ✅ per workspace |
| Published retrieval benchmark | ❌ | ❌ | ✅ LongMemEval / LoCoMo / MemBench | ❌ | ✅ LoCoMo / LongMemEval / BEAM | ❌ | ❌ |
| Code intelligence included | ✅ 131+ tools, 180+ edge types | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Works as standalone memory | ❌ code-focused | ✅ git-native, code-focused | ✅ general-purpose | ❌ Claude-specific | ✅ agent-agnostic | ✅ agent-agnostic | ✅ project-scoped |
| Written in | TypeScript | — | Python | TypeScript | TS + Python | Go / Rust | Python |

> **Key difference:** MemPalace stores "decided to use PostgreSQL" as text in ChromaDB. trace-mcp stores the same decision **linked to `src/db/connection.ts::Pool#class`** — and when you run `get_change_impact` on that symbol, the decision shows up in `linked_decisions`. General-purpose memory tools remember *what you said*. trace-mcp remembers *what you said* AND *which code it's about*.
>
> **Where the field moved (April → June 2026):** (1) Retrieval became a *published number* — mem0 (94.4 LongMemEval, ≤7K tok/retrieval) and MemPalace (96.6% R@5) both ship benchmarks; trace-mcp's decision recall is still FTS5-only with no published figure. (2) **Kage** is the first peer to share trace-mcp's code-linked-memory premise *and* add what trace-mcp lacks: it verifies each memory's cited code at recall and diff time, withholding decisions whose code was renamed/deleted (claimed 0% stale-served). (3) mem0 added search-time temporal decay (1.5× recency / 0.3× stale) and state-key supersession — close analogs to trace-mcp's `order_by:"heat"` and `invalidate_decision`, but automatic.

## vs. documentation generation & RAG

Tools that generate docs from code or provide embedding-based code search for AI retrieval.

| Capability | trace-mcp | Repomix | DeepContext | smart-coding-mcp | mcp-local-rag¹ | knowledge-rag¹ |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | ~26.7K | ~300 | ~200 | ~200 | ~60 |
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
| **GitHub stars** | — | ~25.6K | ~19K | ~18.1K | ~900 | ~100 | ~500 |
| Languages | 79 | 40+ (via LSP) | 23 + Jupyter | 158 | 19 | 32 | 28 |
| Framework integrations | 68 (22 web fw + 8 ORM + 6 UI + 32 tooling) | ❌ | ❌ (Python entry points only) | ❌ | ❌ | ❌ | ~15 (ORM N+1 / API drift only) |
| Cross-language edges | ✅ | ❌ | ❌ | ✅ cross-service HTTP | ✅ polyglot dep graph | ❌ | ✅ PHP↔TS API drift |
| MCP tools | 131+ | ~55 | ~28 | 14 | 21 | 90 | 224 |
| Session memory | ✅ | ✅ (manual notes) | ❌ | ✅ | ❌ | ❌ | ❌ |
| CI/PR reports | ✅ | ❌ | ✅ blast-radius GitHub Action | ❌ | ❌ | ❌ | ✅ SARIF 2.1.0 + GH/GL/Azure |
| Multi-repo subprojects | ✅ | ❌ | ✅ multi-repo daemon | ✅ cross-service | ✅ cross-project search | ❌ | ❌ |
| Control-flow / data-flow | ✅ CFG + dataflow | ❌ | ❌ | ❌ | ❌ | ✅ CFG w/ basic blocks + loop edges; type-aware taint | ❌ |
| Security scanning | ✅ OWASP/taint | ❌ | ❌ | ❌ | ❌ | ✅ 147 rules (taint/OWASP/CWE) + SBOM + OSV/supply-chain | ❌ |
| IaC as graph nodes | ❌ | ❌ | ❌ | ✅ K8s/Kustomize/HCL/Docker | ❌ | ❌ | ❌ |
| Compiler-grade precision | partial (opt-in LSP enrichment) | ✅ live LSP (rename/refs/diagnostics) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Graph visualization | ✅ desktop app (cosmos.gl) | ❌ | ❌ | ✅ 3D web UI | ✅ interactive HTML | ✅ SPA frontend | ❌ |
| Knowledge graph queries | ✅ `graph_query` | ❌ | ❌ | ✅ Cypher-like | ❌ | ✅ SPARQL / RDF | ❌ |
| Refactoring tools | ✅ rename/move/signature/codemod/extract¹ | ✅ rename/move/inline/safe-delete | ❌ | ❌ | ❌ | ❌ | ❌ |
| Antipatterns / clone detection | ✅ 11 antipatterns + 4 code smells (debug artifacts across 10 langs) + AST Type-2 subtree hashing + name/signature duplication | ❌ | ❌ | ✅ MinHash near-clone + Louvain communities | ❌ | ❌ | ✅ 23 patterns + AST Type-2 subtree hashing |
| Architecture governance | ✅ | ❌ | ✅ Leiden communities | ✅ Louvain communities | ❌ | ❌ | ✅ change-safety gates |
| Token savings tracking | ✅ | ❌ | ✅ (6.8×–49×) | ✅ | ✅ (~61% claimed) | ❌ | ✅ (~92% claimed) |
| Written in | TypeScript | Python | Python | C | TypeScript | Rust | Python |

_¹ trace-mcp's `apply_codemod` is currently regex-based and `extract_function` is temporarily disabled pending an AST-rewrite layer (see "where competitors lead" below)._

_New entrants since April 2026 (direct code-graph MCP peers): **grafel** (Rust, multi-repo daemon, cross-repo + IaC topology, watcher-driven, FlatBuffer in-memory graph); **GitNexus** (MCP-native KG, Leiden communities with cohesion scores); **Code Pathfinder** (5-pass AST indexing, NL queries, dataflow); **CodeGraphContext / CGC** (tree-sitter **+ optional SCIP indexers** → property graph — the one peer already wiring in SCIP for compiler-grade refs). Serena shipped a live debugger tool (breakpoints / variable inspection) in v1.5.x — out of the static-graph lane but notable._

> **Why framework awareness matters:** A graph that knows `UserController` exists but doesn't know it renders `Users/Show.vue` via Inertia is missing the edges that matter most. Framework integrations turn a syntax graph into a **semantic** graph — the agent sees the same connections a developer sees.

## Honest assessment: where competitors lead

No tool is uniformly ahead. trace-mcp is the only one combining framework-aware code intelligence + a refactoring engine + code-linked session memory in a single local MCP server — but on individual axes, specialists go deeper. Re-verified June 2026, the real gaps worth closing (in priority order, all in-lane):

**Strategic — they close a credibility or uniqueness gap:**

- **AST-based rewrite engine.** trace-mcp's `apply_codemod` is regex-based and `extract_function` is disabled. **ast-grep** (and its embeddable `@ast-grep/napi` library) does true AST pattern rewrites with metavariables — structurally precise, no false matches in strings/comments. The realistic path: rebuild `apply_codemod` on `@ast-grep/napi`. (GritQL/Biome lacks shipped autofix; OpenRewrite is JVM/LST-heavy — both rejected for now.)
- **Compiler-grade reference/rename precision.** trace-mcp defaults to tree-sitter heuristics; LSP enrichment is opt-in and slow. **Serena** runs live LSP for compiler-accurate rename/references; **Blarify** and **CodeGraphContext** ingest **SCIP** offline (Blarify reports references resolved far faster than live LSP at the same accuracy). The realistic path: ingest precomputed `.scip` (scip-typescript / scip-python / rust-analyzer→SCIP) into a new `scip_resolved` edge tier above `lsp_resolved`. This is also what makes a *correct* `extract_function` (param inference) and *safe* `apply_rename` possible.
- **Staleness verification of code-linked memory.** **Kage** is the first peer with trace-mcp's code-linked-decision premise — and it verifies cited code at recall and diff time, withholding decisions whose code changed. trace-mcp links decisions to `symbol_id` with temporal validity but does *not* check the symbol still resolves before serving. The primitives already exist (`get_symbol verify_against_git`, `register_edit`, `symbol_id` links) — wiring recall to drop/flag decisions whose code moved is the missing piece, and it's directly in trace-mcp's strongest lane.
- **Decision-retrieval quality + a published benchmark.** **mem0** (94.4 LongMemEval, ≤7K tok/retrieval) and **MemPalace** (96.6% R@5) both ship hybrid retrieval (BM25 + vector + optional rerank) and public numbers. trace-mcp's `query_decisions` is FTS5-only with no published figure — the clearest credibility gap on the memory side. Extend the symbol-index's hybrid ranking to the decision store and track LongMemEval/LoCoMo.
- **Validated code-health metric.** trace-mcp's risk/hotspot scores are heuristic and unbenchmarked; CodeScene's Code Health is research-validated. Until correlated against an external standard, position trace-mcp's score as triage, not a validated metric.
- **Deeper, type-aware SAST.** **Narsil-MCP** does type-aware taint (type inference + trait resolution) with 147 bundled rules + SBOM/OSV; trace-mcp's taint is framework-pattern-based with more false positives. Add type inference to `taint_analysis` or integrate a real SAST engine; position OWASP scanning as agent-time triage, not certified SAST.

**Quick wins — low effort, high leverage:**

- **SARIF 2.1.0 output.** Roam-Code and code-review-graph emit SARIF that GitHub/GitLab/Azure code-scanning ingest for free. trace-mcp's `scan_security` / `detect_antipatterns` / `check_quality_gates` already produce the findings — only the export format is missing. Aligns with the P0 CI-reporting roadmap.
- **IaC as first-class graph nodes.** **codebase-memory-mcp** is alone in treating K8s manifests / Kustomize overlays / Dockerfiles / HCL as queryable graph nodes (Resource/Module) with `IMPORTS` edges — the single most differentiated capability in the field, and still squarely a dependency graph. trace-mcp's `get_artifacts` already *discovers* infra; promoting those to graph nodes with edges is the natural next step.
- **Real CFG with loop back-edges.** Narsil models basic blocks + loop back-edges. Verify trace-mcp's `get_control_flow` does the same (not just if/else trees) — a precision win for dataflow/taint.
- **Search-time decay + auto-supersession of decisions.** mem0's recency boost (1.5×) / stale dampening (0.3×) and state-key supersession map onto trace-mcp's existing `order_by:"heat"` and `invalidate_decision` — small diffs, proven gains.
- **Progressive disclosure of decisions.** claude-mem's ID-first → details-on-demand pattern is a pure token win; add a decision-index tier (id + title + 1 line) before the agent pulls full `content`.

**Deliberately NOT chasing (out of lane or vanity):** live runtime debugger (Serena — runtime, not static graph); counterfactual architecture simulation / multi-agent swarm (Roam-Code — unverified, speculative); the 158-language count race (codebase-memory-mcp — trace-mcp's 79+ already covers the real-world long tail); tool-count arms race (Roam 224, Narsil 90 — quality of edges beats tool count); verbatim chat storage and 20× "Endless Mode" (MemPalace / claude-mem — trace-mcp's extract-then-store model is deliberate, and Endless Mode adds 60–90s latency per tool).

**Bottom line:** trace-mcp's moat — framework-aware graph + refactoring + code-linked memory in one local MCP — is intact and unmatched as a *combination*. The honest exposure is on four axes the maintainer has confirmed (AST rewrite, compiler-grade precision, validated health metric, deep SAST) plus two newly sharpened by June 2026 (Kage-style staleness verification and benchmarked hybrid decision retrieval). Each has a concrete, in-architecture path to close.
