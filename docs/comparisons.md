# How trace-mcp compares

trace-mcp is not just a code intelligence server — it combines **code graph navigation**, **cross-session memory**, and **real-time code understanding** in a single tool. Other projects solve one of these; trace-mcp unifies all three.

_Last updated: April 2026. Based on public documentation and GitHub repos. If you maintain one of these projects and see an inaccuracy, [open an issue](https://github.com/nikolai-vysotskyi/trace-mcp/issues)._

## vs. token-efficient code exploration

Tools that help AI agents read code with fewer tokens — AST parsing, outlines, context packing.

| Capability | trace-mcp | Repomix | Context Mode | code-review-graph | jCodeMunch | codebase-memory-mcp | cymbal |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 23K | 6.6K | 5.1K | 1.5K | 1.3K | 137 |
| Tree-sitter AST parsing | ✅ 81 languages | ✅ compress only (~20) | ❌ no code parsing | ✅ | ✅ ~40 languages | ✅ 66 languages | ✅ 22 languages |
| Token-efficient symbol lookup | ✅ outlines, symbols, bundles | ❌ packs entire files | ✅ sandboxed output | ✅ | ✅ core focus | ✅ | ✅ outline/show/context |
| Cross-file dependency graph | ✅ directed edge graph | ❌ | ❌ | ✅ knowledge graph | ✅ import graph | ✅ knowledge graph | ✅ refs/importers |
| Framework-aware edges | ✅ 58 integrations (15 frameworks, 7 ORMs, 13 UI libs) | ❌ | ❌ | ❌ | ✅ 21 frameworks (route/middleware) | partial (REST routes) | ❌ |
| Impact analysis | ✅ reverse dep traversal + decorator filter | ❌ | ❌ | ❌ | ✅ blast radius + decorator filter | ✅ detect_changes | ✅ impact command |
| Call graph | ✅ bidirectional, graph-based | ❌ | ❌ | ❌ | ✅ AST-based, bidirectional | ✅ trace_call_path | ✅ refs/importers |
| Refactoring tools | ✅ rename, extract, dead code, codemod | ❌ | ❌ | ❌ | ❌ (dead code detect only) | ❌ | ❌ |
| Security scanning | ✅ OWASP Top-10, taint | ✅ Secretlint | ❌ | ❌ | ❌ | ❌ | ❌ |
| Multi-repo subprojects | ✅ cross-repo API linking | ✅ remote repos | ❌ | ❌ | ✅ GitHub repos | ❌ | ❌ |
| Session memory | ✅ built-in | ❌ | ✅ SQLite journal | ❌ | ✅ index persistence | ✅ persistent graph | ❌ |
| Written in | TypeScript | TypeScript | TypeScript | Python | Python | C | Go |

## vs. AI session memory

Tools that persist context across AI agent sessions — activity logs, knowledge graphs, memory compression.

| Capability | trace-mcp | MemPalace | claude-mem | OpenMemory | engram | ConPort |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 43K | 45.7K | 3.9K | 2.3K | 761 |
| Cross-session context carryover | ✅ `get_session_resume` + decisions | ✅ wings/rooms | ✅ core focus | ✅ | ✅ | ✅ |
| Cross-session content search | ✅ `search_sessions` FTS5 | ✅ ChromaDB semantic | ❌ | ✅ | ❌ | ❌ |
| Decision knowledge graph | ✅ temporal, code-linked | ✅ temporal (text-only) | ❌ | ✅ temporal | ❌ | ✅ project-level |
| Code-graph-aware memory | ✅ decisions → symbols & files | ❌ text-only | ❌ text-only | ❌ text-only | ❌ text-only | ❌ text-only |
| Auto-extraction from sessions | ✅ pattern-based (0 LLM calls) | ✅ via hooks | ✅ AI-compressed | ❌ | ❌ | ❌ |
| Wake-up context | ✅ ~300 tok (code-linked decisions) | ✅ ~170 tok (AAAK) | ❌ | ❌ | ❌ | ❌ |
| Decision enrichment in tools | ✅ impact/plan_turn/resume | ❌ standalone | ❌ | ❌ | ❌ | ❌ |
| Service/subproject scoping | ✅ decisions per service | ✅ wings per project | ❌ | ❌ | ❌ | ❌ |
| Token usage analytics | ✅ per-tool cost breakdown | ❌ | partial | ❌ | ❌ | ❌ |
| Code intelligence included | ✅ 130+ tools | ❌ | ❌ | ❌ | ❌ | ❌ |
| Works as standalone memory | ❌ code-focused | ✅ general-purpose | ❌ Claude-specific | ✅ agent-agnostic | ✅ agent-agnostic | ✅ project-scoped |
| Written in | TypeScript | Python | TypeScript | TS + Python | Go | Python |

> **Key difference:** MemPalace stores "decided to use PostgreSQL" as text in ChromaDB. trace-mcp stores the same decision **linked to `src/db/connection.ts::Pool#class`** — and when you run `get_change_impact` on that symbol, the decision shows up in `linked_decisions`. General-purpose memory tools remember *what you said*. trace-mcp remembers *what you said* AND *which code it's about*.

## vs. documentation generation & RAG

Tools that generate docs from code or provide embedding-based code search for AI retrieval.

| Capability | trace-mcp | Repomix | DeepContext | smart-coding-mcp | mcp-local-rag¹ | knowledge-rag¹ |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **GitHub stars** | — | 23K | 274 | 193 | 204 | 44 |
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
| **GitHub stars** | — | 22.6K | 5.1K | 1.3K | — | — | — |
| Languages | 81 | ~20 (via LSP) | ~10 | 66 | ~15 | 32 | ~10 |
| Framework integrations | 58 (15 fw + 7 ORM + 13 UI + 23 other) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cross-language edges | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| MCP tools | 138 | ~35 | ~15 | ~20 | ~25 | 90 | 139 |
| Session memory | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| CI/PR reports | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Multi-repo subprojects | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Security scanning | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Refactoring tools | ✅ | ✅ rename, symbol editing | ❌ | ❌ | ❌ | ❌ | ❌ |
| Architecture governance | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Token savings tracking | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Written in | TypeScript | Python | Python | C | TypeScript | Rust | Python |

> **Why framework awareness matters:** A graph that knows `UserController` exists but doesn't know it renders `Users/Show.vue` via Inertia is missing the edges that matter most. Framework integrations turn a syntax graph into a **semantic** graph — the agent sees the same connections a developer sees.
