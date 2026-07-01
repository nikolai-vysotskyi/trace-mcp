# How trace-mcp compares

trace-mcp is not just a code intelligence server — it combines **code graph navigation**, **cross-session memory**, and **real-time code understanding** in a single tool. Other projects solve one of these; trace-mcp unifies all three.

_Last updated: July 1, 2026. Based on public documentation and GitHub repos. If you maintain one of these projects and see an inaccuracy, [open an issue](https://github.com/nikolai-vysotskyi/trace-mcp/issues). This revision re-verifies the April 2026 peer set, refreshes star/version/feature facts (several moved sharply), and adds new entrants: Kage, grafel, GitNexus, Code Pathfinder, CodeGraphContext, tokensave. Competitor facts current as of June 2026 — star counts drift, treat as approximate. The "Honest assessment" section below was updated after six of seven identified gaps shipped and went through an adversarial deep-validation pass._

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

_New entrants since April 2026 (direct code-graph MCP peers): **grafel** (Rust, multi-repo daemon, cross-repo + IaC topology, watcher-driven, FlatBuffer in-memory graph); **GitNexus** (MCP-native KG, Leiden communities with cohesion scores); **Code Pathfinder** (5-pass AST indexing, NL queries, dataflow); **CodeGraphContext / CGC** (tree-sitter **+ optional SCIP indexers** → property graph — the one peer already wiring in SCIP for compiler-grade refs). Serena shipped a live debugger tool (breakpoints / variable inspection) in v1.5.x — out of the static-graph lane but notable._

> **Why framework awareness matters:** A graph that knows `UserController` exists but doesn't know it renders `Users/Show.vue` via Inertia is missing the edges that matter most. Framework integrations turn a syntax graph into a **semantic** graph — the agent sees the same connections a developer sees.

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

- **Validated code-health metric.** A temporal-holdout calibration script now correlates `predict_bugs`/`get_risk_hotspots` against real future-fix commits on this repo (churn Spearman ≈0.34, precision@20 ≈2.1–2.4× over random) and the tool descriptions were reworded to honest "heuristic triage" language. This is evidence, not CodeScene-grade external validation — the gap to a peer-reviewed, cross-repo-validated metric remains.
- **Worst-case decision-verification latency.** The memoization fix above only helps when decisions cluster on a handful of files; a batch fully scattered across N distinct files is still O(N) git subprocess spawns. An async/batched redesign would be needed to bound the worst case.
- **CFG is line-based, not AST-based**, and taint analysis remains lexical/regex, not a real dataflow engine — both are known architectural ceilings, not just untested edge cases; a full AST/dataflow rewrite of either is out of scope for now.

**Deliberately NOT chasing (out of lane or vanity):** live runtime debugger (Serena — runtime, not static graph); counterfactual architecture simulation / multi-agent swarm (Roam-Code — unverified, speculative); the 158-language count race (codebase-memory-mcp — trace-mcp's 79+ already covers the real-world long tail); tool-count arms race (Roam 224, Narsil 90 — quality of edges beats tool count); verbatim chat storage and 20× "Endless Mode" (MemPalace / claude-mem — trace-mcp's extract-then-store model is deliberate, and Endless Mode adds 60–90s latency per tool).

**Bottom line:** trace-mcp's moat — framework-aware graph + refactoring + code-linked memory in one local MCP — is intact and unmatched as a *combination*. Six of seven gaps identified in the June 2026 re-verification are now shipped; the adversarial validation pass that followed found and fixed 15+ real bugs (several of them "the feature silently didn't work at all," not cosmetic) rather than taking the initial implementation on faith. The one deliberately-open gap (a peer-reviewed validated health metric) is honestly labeled as such rather than oversold.
