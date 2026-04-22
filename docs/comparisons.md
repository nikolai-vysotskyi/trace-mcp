# How trace-mcp compares

trace-mcp is not just a code intelligence server — it combines **code graph navigation**, **cross-session memory**, and **real-time code understanding** in a single tool. Other projects solve one of these; trace-mcp unifies all three.

_Last updated: April 22, 2026. Based on public documentation and GitHub repos. If you maintain one of these projects and see an inaccuracy, [open an issue](https://github.com/nikolai-vysotskyi/trace-mcp/issues). Includes capabilities shipped through the April 22 release: debug-artifact detection (10 languages), expanded antipatterns (god_class / long_method / long_parameter_list / deep_nesting), and AST Type-2 clone detection via tree-sitter subtree hashing._

## vs. token-efficient code exploration

Tools that help AI agents read code with fewer tokens — AST parsing, outlines, context packing.

| Capability | trace-mcp | Repomix | Context Mode | code-review-graph | jCodeMunch | codebase-memory-mcp | cymbal |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 23.8K | 8.8K | 12.4K | 1.6K | 1.7K | 165 |
| Tree-sitter AST parsing | ✅ 81 languages | ✅ compress only (~20) | ❌ no code parsing | ✅ 23 langs + Jupyter | ✅ 70+ languages | ✅ 66 languages | ✅ 22 languages |
| Token-efficient symbol lookup | ✅ outlines, symbols, bundles | ❌ packs entire files | ✅ sandboxed output (98% reduction) | ✅ | ✅ core focus (~95% reduction) | ✅ | ✅ outline/show/context |
| Cross-file dependency graph | ✅ directed edge graph | ❌ | ❌ | ✅ incremental knowledge graph | ✅ import graph | ✅ knowledge graph | ✅ refs/importers |
| Framework-aware edges | ✅ 68 integrations (22 web frameworks, 8 ORMs, 6 UI libs, 32 tooling) | ❌ | ❌ | ❌ | ✅ 21 frameworks (route/middleware) | partial (REST routes) | ❌ |
| Impact analysis | ✅ reverse dep traversal + decorator filter | ❌ | ❌ | ✅ blast-radius + Leiden communities | ✅ blast radius + decorator filter | ✅ detect_changes | ✅ impact command |
| Call graph | ✅ bidirectional, graph-based | ❌ | ❌ | ✅ graph-based | ✅ AST-based, bidirectional | ✅ trace_call_path | ✅ refs/importers |
| Refactoring tools | ✅ rename, extract, dead code, codemod | ❌ | ❌ | ❌ | ❌ (dead code detect only) | ❌ | ❌ |
| Security scanning | ✅ OWASP Top-10, taint | ✅ Secretlint | ❌ | ❌ | ❌ | ❌ | ❌ |
| Multi-repo subprojects | ✅ cross-repo API linking | ✅ remote repos | ❌ | ✅ multi-repo daemon | ✅ GitHub repos | ✅ cross-service HTTP linking | ❌ |
| Session memory | ✅ built-in | ❌ | ✅ SQLite FTS5 journal | ❌ | ✅ index persistence | ✅ persistent graph | ❌ |
| Written in | TypeScript | TypeScript | TypeScript | Python | Python | C | Go |

## vs. AI session memory

Tools that persist context across AI agent sessions — activity logs, knowledge graphs, memory compression.

| Capability | trace-mcp | MemPalace | claude-mem | mem0 / OpenMemory | engram | ConPort |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 49K | 65.5K | 53.8K | 2.7K | 761 |
| Cross-session context carryover | ✅ `get_session_resume` + decisions | ✅ wings/rooms | ✅ core focus | ✅ multi-level (User/Session/Agent) | ✅ | ✅ |
| Cross-session content search | ✅ `search_sessions` FTS5 | ✅ BM25+vector hybrid (96.6% R@5 LongMemEval) | ✅ SQLite + Chroma hybrid | ✅ hybrid semantic+keyword+entity (91.6 LoCoMo) | ✅ SQLite FTS5 | ❌ |
| Decision knowledge graph | ✅ temporal, code-linked | ✅ temporal + "Closets" (+38% R@1) | ❌ | ✅ temporal + entity linking | ❌ | ✅ project-level |
| Code-graph-aware memory | ✅ decisions → symbols & files | ❌ text-only | ❌ text-only | ❌ text-only | ❌ text-only | ❌ text-only |
| Auto-extraction from sessions | ✅ pattern-based (0 LLM calls) | ✅ via hooks | ✅ AI-compressed + citations | ❌ | ❌ | ❌ |
| Wake-up context | ✅ ~300 tok (code-linked decisions) | ✅ ~170 tok (AAAK) | ✅ progressive disclosure (~10× savings) + Endless Mode | ❌ | ❌ | ❌ |
| Decision enrichment in tools | ✅ impact/plan_turn/resume | ❌ standalone | ❌ | ❌ | ❌ | ❌ |
| Service/subproject scoping | ✅ decisions per service | ✅ wings per project | ❌ | ❌ | ❌ | ❌ |
| Token usage analytics | ✅ per-tool cost breakdown | ❌ | partial | ❌ | ❌ | ❌ |
| Code intelligence included | ✅ 131+ tools, 180+ edge types | ❌ | ❌ | ❌ | ❌ | ❌ |
| Works as standalone memory | ❌ code-focused | ✅ general-purpose | ❌ Claude-specific | ✅ agent-agnostic | ✅ agent-agnostic | ✅ project-scoped |
| Written in | TypeScript | Python | TypeScript | TS + Python | Go | Python |

> **Key difference:** MemPalace stores "decided to use PostgreSQL" as text in ChromaDB. trace-mcp stores the same decision **linked to `src/db/connection.ts::Pool#class`** — and when you run `get_change_impact` on that symbol, the decision shows up in `linked_decisions`. General-purpose memory tools remember *what you said*. trace-mcp remembers *what you said* AND *which code it's about*.

## vs. documentation generation & RAG

Tools that generate docs from code or provide embedding-based code search for AI retrieval.

| Capability | trace-mcp | Repomix | DeepContext | smart-coding-mcp | mcp-local-rag¹ | knowledge-rag¹ |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 23.8K | ~300 | ~200 | ~200 | ~60 |
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

> **Key difference:** RAG tools answer "find code similar to this query." trace-mcp answers "show me the execution path, the dependencies, and the tests for this feature." Graph traversal finds structurally relevant code that embedding similarity misses — and never returns stale results because the graph updates incrementally with every file save.

## vs. code graph MCP servers

| Capability | trace-mcp | Serena | code-review-graph | codebase-memory-mcp | SocratiCode | Narsil-MCP | Roam-Code |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 23K | 12.4K | 1.7K | ~900 | ~100 | ~500 |
| Languages | 79 | 40+ (via LSP) | 23 + Jupyter | 66 | 19 | 32 | 27 |
| Framework integrations | 68 (22 web fw + 8 ORM + 6 UI + 32 tooling) | ❌ | ❌ (Python entry points only) | ❌ | ❌ | ❌ | ~15 (ORM N+1 / API drift only) |
| Cross-language edges | ✅ | ❌ | ❌ | ✅ cross-service HTTP | ✅ polyglot dep graph | ❌ | ✅ PHP↔TS API drift |
| MCP tools | 131+ | ~15 | ~28 | 14 | 21 | 90 | 102 (24 in core preset) |
| Session memory | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| CI/PR reports | ✅ | ❌ | ✅ blast-radius | ❌ | ❌ | ❌ | ✅ SARIF 2.1.0 + GH/GL/Azure |
| Multi-repo subprojects | ✅ | ❌ | ✅ multi-repo daemon | ✅ cross-service | ✅ cross-project search | ❌ | ❌ |
| Control-flow / data-flow | ✅ CFG + dataflow | ❌ | ❌ | ❌ | ❌ | ✅ CFG w/ basic blocks + loop edges | ❌ |
| Security scanning | ✅ OWASP/taint | ❌ | ❌ | ❌ | ❌ | ✅ taint/OWASP/CWE/SBOM/supply-chain | ❌ |
| IaC as graph nodes | ❌ | ❌ | ❌ | ✅ K8s/Kustomize/HCL/Docker | ❌ | ❌ | ❌ |
| Graph visualization | ✅ desktop app (cosmos.gl) | ❌ | ❌ | ✅ 3D web UI | ❌ | ✅ SPA frontend | ❌ |
| Knowledge graph queries | ✅ `graph_query` | ❌ | ❌ | ❌ | ❌ | ✅ SPARQL / RDF | ❌ |
| Refactoring tools | ✅ rename/move/signature/codemod/extract | ✅ rename/move/inline/safe-delete | ❌ | ❌ | ❌ | ❌ | ❌ |
| Antipatterns / clone detection | ✅ 11 antipatterns (N+1 across 8 ORMs, god_class, long_method, long_parameter_list, deep_nesting, memory leaks, …) + 4 code smells (incl. debug artifacts across 10 langs) + AST Type-2 subtree hashing + name/signature duplication | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ 23 patterns + AST Type-2 subtree hashing |
| Architecture governance | ✅ | ❌ | ✅ Leiden communities | ❌ | ❌ | ❌ | ✅ + counterfactual simulation |
| Token savings tracking | ✅ | ❌ | ✅ (6.8×–49×) | ❌ | ✅ (~61% claimed) | ❌ | ✅ (~92% claimed) |
| Written in | TypeScript | Python | Python | C | TypeScript | Rust | Python |

> **Why framework awareness matters:** A graph that knows `UserController` exists but doesn't know it renders `Users/Show.vue` via Inertia is missing the edges that matter most. Framework integrations turn a syntax graph into a **semantic** graph — the agent sees the same connections a developer sees.

## Honest assessment: where competitors lead

No tool is uniformly ahead. Where trace-mcp has real gaps worth watching:

- **Roam-Code** is the closest peer in architectural intent. trace-mcp goes broader on ORM N+1 (8 ORM backends vs ~5) and framework coverage (68 integrations vs ~15), and matches Roam-Code on AST Type-2 clone detection via subtree hashing. Where Roam-Code still leads: a bigger antipattern catalog (23 patterns vs our 11+4), Salesforce ecosystem (Apex/Aura/LWC/Visualforce), multi-agent swarm partitioning, and counterfactual architecture simulation.
- **Narsil-MCP** is the closest threat on depth — real control-flow graphs with basic blocks + loop back-edges, SPARQL/RDF knowledge-graph queries, and supply-chain security tooling. trace-mcp has broader coverage; Narsil has compiler-grade rigor in a single Rust binary.
- **codebase-memory-mcp** pioneered Infrastructure-as-Code as first-class graph nodes — Kubernetes manifests, Kustomize overlays, Dockerfiles, HCL. A feature trace-mcp does not have and probably should.
- **Serena** v1.0 GA (April 2026) leads on raw LSP coverage (40+ languages including AL, Lean 4, Haxe, HLSL, GLSL, WGSL, Luau, Crystal) and cross-dependency/external-project symbol queries.
- **Repomix** owns the one-shot "pack the entire repo into a prompt file" workflow — a fallback mode trace-mcp doesn't offer for non-MCP consumers.
- **MemPalace** achieves 96.6% R@5 on LongMemEval with zero API calls via its "Closets" hybrid retrieval — a memory-retrieval benchmark trace-mcp doesn't publish numbers for.

**Bottom line:** trace-mcp is the only tool that combines framework-aware code intelligence + refactoring engine + session memory in one server. No competitor overlaps all three. But on any single axis (raw LSP languages, CFG depth, IaC nodes, memory benchmarks, antipattern catalog), there is a specialist that goes deeper.
