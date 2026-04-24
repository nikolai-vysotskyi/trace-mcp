# Configuration

Configuration is optional — trace-mcp works out of the box for standard projects.

---

## How config works

All trace-mcp state lives in `~/.trace-mcp/`:

```
~/.trace-mcp/
  .config.json              # global config + per-project sections
  registry.json             # registered projects
  index/
    my-app-a1b2c3d4e5f6.db  # per-project databases
```

### Config merge order

1. **Global defaults** — `~/.trace-mcp/.config.json` (top-level keys)
2. **Per-project section** — `~/.trace-mcp/.config.json → projects["/path/to/project"]` (created by `trace-mcp add`)
3. **Local override** — `.trace-mcp.json` in the project directory (optional, for project-specific overrides)
4. **Zod schema defaults** — fallback values

### Global config example

`~/.trace-mcp/.config.json`:
```jsonc
{
  // Global defaults (apply to all projects)
  "ai": {
    "enabled": true
    // provider defaults to "onnx" — local embeddings, no API keys
  },
  "security": {
    "max_file_size_bytes": 524288
  },

  // Per-project settings (created by `trace-mcp add`)
  "projects": {
    "/Users/me/projects/my-app": {
      "root": ".",
      "include": ["app/**/*.php", "routes/**/*.php", "src/**/*.{ts,vue}"],
      "exclude": ["vendor/**", "node_modules/**"]
    },
    "/Users/me/projects/api": {
      "root": ".",
      "include": ["src/**/*.ts"],
      "exclude": ["node_modules/**", "dist/**"]
    }
  }
}
```

### Per-project config file (optional)

You can place a config file at `.trace-mcp/.config.json` in your project root to override settings without editing the global config:

```jsonc
// /path/to/project/.trace-mcp/.config.json
{
  "include": ["src/**/*.ts", "lib/**/*.ts"],
  "exclude": ["node_modules/**", "dist/**", "coverage/**"],
  "ignore": {
    "directories": ["generated", "proto"],
    "patterns": ["**/fixtures/**", "**/*.generated.ts"]
  }
}
```

Alternative locations (checked in order): `.trace-mcp/.config.json`, `.trace-mcp.json`, `.trace-mcp`, `.config/trace-mcp.json`, `package.json` (under `"trace-mcp"` key).

---

## .traceignore

Place a `.traceignore` file in your project root to exclude files and directories from indexing. It uses the same syntax as `.gitignore`:

```gitignore
# Skip generated code
generated/
**/generated/**

# Skip protobuf definitions
proto/

# Skip test fixtures
tests/fixtures/

# Skip specific file patterns
*.generated.ts
*.pb.go

# Negation — re-include something
!proto/important.proto
```

### Difference from .gitignore

| | `.gitignore` | `.traceignore` |
|---|---|---|
| **Effect** | Files are indexed for the dependency graph, but source content is hidden from AI output | Files are **completely skipped** — not indexed at all |
| **Use case** | Secrets, credentials, env files | Generated code, vendored deps, large data files |

### Built-in skip directories

These directories are always skipped (no configuration needed):

`node_modules`, `.git`, `dist`, `build`, `.next`, `__pycache__`, `.venv`, `vendor`, `.trace-mcp`, `coverage`, `.turbo`

You can add more via `.traceignore` or the `ignore.directories` config key.

---

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `root` | `string` | `"."` | Project root directory |
| `include` | `string[]` | Auto-detected | Glob patterns for files to index |
| `exclude` | `string[]` | Common exclusions | Glob patterns to skip |
| `ignore.directories` | `string[]` | `[]` | Extra directory names to skip (added to built-in list) |
| `ignore.patterns` | `string[]` | `[]` | Extra gitignore-style patterns to exclude from indexing |
| `plugins` | `string[]` | `[]` | Paths to custom plugins |
| `security.secret_patterns` | `string[]` | Common patterns | Regex patterns for secret filtering |
| `security.max_file_size_bytes` | `number` | `524288` | Max file size to index (bytes) |

### Framework-specific options

```jsonc
{
  "frameworks": {
    "laravel": {
      "artisan": {
        "enabled": true,    // Enable artisan integration
        "timeout": 10000    // Command timeout in ms
      },
      "graceful_degradation": true  // Continue if artisan fails
    }
  }
}
```

---

## AI configuration

AI features enable semantic search (vector embeddings) and optional LLM-powered summarization. trace-mcp supports three embedding providers, with a **zero-config local option** as the default.

### Provider overview

| Provider | Embeddings | LLM (summarization) | Requires | Setup |
|---|---|---|---|---|
| **`onnx`** (default) | ✅ local, offline | ❌ | `@huggingface/transformers` (optional dep) | Zero-config — model auto-downloads (~23 MB) on first use |
| **`ollama`** | ✅ via Ollama | ✅ via Ollama | Running Ollama instance | Install Ollama + pull models |
| **`lmstudio`** | ✅ via LM Studio | ✅ via LM Studio | LM Studio server running | OpenAI-compatible, no API key |
| **`openai`** | ✅ | ✅ | API key | `api_key` or `OPENAI_API_KEY` env |
| **`anthropic`** | ❌ (no embeddings API) | ✅ | API key | `api_key` or `ANTHROPIC_API_KEY` env |
| **`gemini`** | ✅ | ✅ | API key | Google Generative Language API (consumer) — `api_key` (AIza…) or `GEMINI_API_KEY` env |
| **`vertex`** | ✅ | ✅ | OAuth token + GCP project | Google Vertex AI (GCP) — `api_key` = access token, plus `vertex_project` + `vertex_location` |
| **`voyage`** | ✅ (code-tuned) | ❌ | API key | Voyage AI embeddings only — pair with another provider for inference |
| **`mistral`** / **`groq`** / **`together`** / **`deepseek`** / **`xai`** | ✅ | ✅ | API key | OpenAI-compatible endpoints — per-provider `*_API_KEY` env |

### Minimal setup — local embeddings (no API keys)

```jsonc
{
  "ai": {
    "enabled": true
    // provider defaults to "onnx"
    // model defaults to Xenova/all-MiniLM-L6-v2 (384 dims, Apache 2.0)
    // auto-downloads ~23 MB on first embed_repo or semantic search
  }
}
```

This enables semantic/hybrid `search` and `query_by_intent` with zero configuration. No API keys, no external services, works fully offline after first model download.

### Full setup — Ollama (embeddings + LLM summarization)

```jsonc
{
  "ai": {
    "enabled": true,
    "provider": "ollama",
    "base_url": "http://localhost:11434",
    "inference_model": "gemma4:e4b",
    "fast_model": "gemma4:e4b",
    "embedding_model": "qwen3-embedding:0.6b",
    "summarize_on_index": true,
    "summarize_batch_size": 20,
    "summarize_kinds": ["class", "function", "method", "interface", "trait", "enum", "type"],
    "concurrency": 4
  }
}
```

### Full setup — OpenAI

```jsonc
{
  "ai": {
    "enabled": true,
    "provider": "openai",
    "api_key": "sk-...",
    "inference_model": "gpt-4o-mini",
    "embedding_model": "text-embedding-3-small",
    "embedding_dimensions": 1536,
    "summarize_on_index": true
  }
}
```

### Full setup — Google Gemini (consumer API)

Uses the Google Generative Language API (`generativelanguage.googleapis.com`) with a simple `AIza…` API key from [ai.google.dev](https://ai.google.dev). For GCP-governed workloads, use the `vertex` provider instead.

```jsonc
{
  "ai": {
    "enabled": true,
    "provider": "gemini",
    "api_key": "AIza...",
    "inference_model": "gemini-2.5-flash",
    "embedding_model": "text-embedding-004",
    "embedding_dimensions": 768
  }
}
```

### Full setup — Google Vertex AI (GCP)

Uses Vertex AI with a short-lived OAuth2 access token (~1h TTL). Generate via `gcloud auth print-access-token` — you're responsible for refreshing it.

```jsonc
{
  "ai": {
    "enabled": true,
    "provider": "vertex",
    "api_key": "ya29....",                // `gcloud auth print-access-token`
    "vertex_project": "my-gcp-project",
    "vertex_location": "us-central1",
    "inference_model": "gemini-2.5-flash",
    "embedding_model": "text-embedding-005",
    "embedding_dimensions": 768
  }
}
```

Environment variables: `GOOGLE_ACCESS_TOKEN`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` are honored when the config fields are unset.

### Full setup — Voyage AI (embeddings only)

Voyage specializes in retrieval-grade embeddings. `voyage-code-3` is tuned for source code and is the recommended default for this project. Voyage has no inference API — keep `features.inference` disabled, or layer Voyage embeddings on top of Anthropic/OpenAI/Ollama for summarization by switching providers per-capability in your own setup.

```jsonc
{
  "ai": {
    "enabled": true,
    "provider": "voyage",
    "api_key": "pa-...",                   // or VOYAGE_API_KEY env
    "embedding_model": "voyage-code-3",
    "embedding_dimensions": 1024,
    "features": { "embedding": true, "inference": false, "fast_inference": false }
  }
}
```

### All options

| Option | Default | Description |
|---|---|---|
| `ai.enabled` | `false` | Enable AI features |
| `ai.provider` | `"onnx"` | `onnx`, `ollama`, `lmstudio`, `openai`, `anthropic`, `gemini`, `vertex`, `voyage`, `mistral`, `groq`, `together`, `deepseek`, `xai` |
| `ai.base_url` | — | Custom API endpoint (providers that honor it) |
| `ai.api_key` | — | API key, or OAuth access token for `vertex`. Env fallbacks: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_ACCESS_TOKEN`, `VOYAGE_API_KEY`, etc. |
| `ai.vertex_project` | — | Vertex only — GCP project ID (or `GOOGLE_CLOUD_PROJECT` env) |
| `ai.vertex_location` | `us-central1` | Vertex only — GCP region (or `GOOGLE_CLOUD_LOCATION` env) |
| `ai.inference_model` | — | LLM for explanations and reviews (ollama/openai only) |
| `ai.fast_model` | — | Faster LLM for lightweight tasks (ollama/openai only) |
| `ai.embedding_model` | auto per provider | `"Xenova/all-MiniLM-L6-v2"` (onnx), `"qwen3-embedding:0.6b"` (ollama), `"text-embedding-3-small"` (openai) |
| `ai.embedding_dimensions` | auto per provider | `384` (onnx), `768` (ollama), `1536` (openai) |
| `ai.summarize_on_index` | `false` | Auto-summarize symbols after indexing (requires ollama/openai with LLM model) |
| `ai.summarize_batch_size` | `20` | Symbols per summarization batch |
| `ai.summarize_kinds` | `["class", "function", ...]` | Symbol kinds to summarize |
| `ai.concurrency` | `1` | Max parallel requests to AI provider (1–32) |
| `ai.reranker_model` | — | Model for search result reranking (ollama/openai only) |

> **ONNX provider details:** Uses `@huggingface/transformers` (installed as optional dependency). The default model `Xenova/all-MiniLM-L6-v2` is Apache 2.0 licensed, produces 384-dimensional L2-normalized mean-pooled vectors, and weighs ~23 MB. The model is cached locally after first download. You can use any ONNX-compatible model from HuggingFace by setting `embedding_model`.

> **Ollama parallelism:** When setting `concurrency` > 1, you must also configure Ollama to handle parallel requests. The desktop app UI does not expose this setting — use one of these methods:
>
> **Option 1 — Environment variable for the desktop app (macOS):**
> ```bash
> launchctl setenv OLLAMA_NUM_PARALLEL 4
> ```
> Then quit and reopen the Ollama app. The variable persists until logout.
>
> **Option 2 — Run from terminal instead of the desktop app:**
> ```bash
> OLLAMA_NUM_PARALLEL=4 ollama serve
> ```
>
> **Option 3 — Persist via shell profile** (add to `~/.zshrc`):
> ```bash
> export OLLAMA_NUM_PARALLEL=4
> ```
> Then `source ~/.zshrc` and restart Ollama.
>
> Set `OLLAMA_NUM_PARALLEL` to match your `ai.concurrency` value. Higher parallelism uses more VRAM/RAM — start with 2–4 and increase if your hardware allows.

---

## LSP enrichment

trace-mcp can optionally use Language Server Protocol (LSP) servers to enrich call graph edges with **compiler-grade type resolution**. This resolves dynamic dispatch, interface polymorphism, generics, and other cases that tree-sitter AST analysis alone cannot handle.

**Disabled by default** — opt-in via configuration. When enabled, LSP runs as a post-indexing enrichment pass (Pass 3) after the standard tree-sitter indexing completes. If an LSP server is not installed or fails to start, indexing continues normally without LSP edges.

```jsonc
{
  "lsp": {
    "enabled": true,              // default: false — must opt-in
    "auto_detect": true,          // default: true — auto-detect available LSP servers
    "max_concurrent_servers": 2,  // default: 2 — limit parallel LSP processes
    "enrichment_timeout_ms": 120000, // default: 120000 — overall enrichment timeout
    "batch_size": 100,            // default: 100 — symbols per batch
    "servers": {                  // optional: override auto-detected server commands
      "typescript": {
        "command": "npx",
        "args": ["typescript-language-server", "--stdio"],
        "timeout_ms": 30000
      }
    }
  }
}
```

| Option | Default | Description |
|---|---|---|
| `lsp.enabled` | `false` | Enable LSP enrichment pass |
| `lsp.auto_detect` | `true` | Auto-detect available LSP servers based on project files |
| `lsp.max_concurrent_servers` | `2` | Maximum number of LSP servers running simultaneously |
| `lsp.enrichment_timeout_ms` | `120000` | Overall timeout for the entire LSP enrichment pass |
| `lsp.batch_size` | `100` | Number of symbols to process per batch |
| `lsp.servers.<lang>.command` | — | Override the LSP server command for a language |
| `lsp.servers.<lang>.args` | `[]` | Arguments for the LSP server command |
| `lsp.servers.<lang>.timeout_ms` | `30000` | Per-request timeout for this server |
| `lsp.servers.<lang>.initializationOptions` | — | Custom LSP initialization options |

### Auto-detected servers

| Language | Server | Detection |
|---|---|---|
| TypeScript/JavaScript | `typescript-language-server` | `tsconfig.json` or `package.json` exists |
| Python | `pyright-langserver` | `pyproject.toml`, `requirements.txt`, or `setup.py` exists |
| Go | `gopls` | `go.mod` exists |
| Rust | `rust-analyzer` | `Cargo.toml` exists |

Servers are only started if the corresponding language has files in the index AND the server binary is available on PATH.

---

## Tool exposure & agent behavior

The `tools.*` section controls what the MCP server injects into every session — tool set, instruction verbosity, and optional agent behavior rules.

```jsonc
{
  "tools": {
    "preset": "full",                    // "full" | "minimal" | custom preset
    "description_verbosity": "full",     // "full" | "minimal" | "none"
    "instructions_verbosity": "full",    // "full" | "minimal" | "none" — controls the tool-routing block
    "agent_behavior": "off",             // "strict" | "minimal" | "off" — see below
    "meta_fields": true,                 // true | false | ["_hints", "_budget_warning", ...]
    "compact_schemas": false             // strip advanced params from tool schemas (saves tokens)
  }
}
```

| Option | Default | Description |
|---|---|---|
| `tools.preset` | `"full"` | Tool preset (`full`, `minimal`, or custom name from `~/.trace-mcp/presets/`) |
| `tools.include` | — | Whitelist specific tools by name |
| `tools.exclude` | — | Blacklist specific tools by name |
| `tools.description_verbosity` | `"full"` | Per-tool description length. `minimal` = first sentence. `none` = empty |
| `tools.instructions_verbosity` | `"full"` | Server-level instructions (the tool-routing block). `full` ~2K tokens, `minimal` ~200 |
| `tools.agent_behavior` | `"off"` | Behavior rules appended to instructions — see [Agent behavior rules](#agent-behavior-rules) |
| `tools.meta_fields` | `true` | Meta fields in responses (`_hints`, `_budget_warning`, etc.). Set `false` or list to narrow |
| `tools.compact_schemas` | `false` | Strip advanced/optional params from tool schemas. Cuts schema size 40–60% |

### Agent behavior rules

`tools.agent_behavior` appends generic discipline rules (anti-sycophancy, anti-fabrication, goal-driven execution, 2-strike session hygiene, no drive-by refactors) to the server instructions. These are client-agnostic — every MCP-compatible client (Claude Code, Cursor, Codex, Windsurf, …) receives them.

| Value | What ships | When to use |
|---|---|---|
| `"off"` *(default)* | Nothing | Default — you already manage agent behavior elsewhere (CLAUDE.md, tweakcc), or don't want opinionated rules |
| `"minimal"` | One rule: never fabricate paths/symbols/APIs — call `search`/`get_symbol`/run the command | Minimal nudge tied to trace-mcp tool use, no personality prescription |
| `"strict"` | 8 rules: no flattery, disagree on wrong premises, never fabricate, stop when confused, goal-driven execution, verify before reporting "done", 2-strike rule, surgical changes only | Max-tier default — aligns agent behavior across a team |

**Auto-set by `trace-mcp init`:** picking the **Max** enforcement level writes `"agent_behavior": "strict"` to your global config. Picking Base/Standard writes `"off"`. Re-run `init` to change tiers — the value updates idempotently.

**Why it lives in MCP instructions (not CLAUDE.md or tweakcc):**
- Cross-client — Cursor/Codex/Windsurf users get the same behavior without CC-specific setup.
- Auto-updates on `npm upgrade trace-mcp` — no re-init required to pull new rule wording.
- Single source of truth alongside the tool-routing block.

If you want to override in one project without affecting others, put `"agent_behavior": "off"` (or any other value) in that project's `.trace-mcp/.config.json` — per-project config takes precedence over global.

### 4-tier resolution system

Every edge in the call graph carries a `resolution_tier` indicating how it was resolved:

| Tier | Source | Confidence |
|---|---|---|
| `lsp_resolved` | LSP call hierarchy | Compiler-grade (highest) |
| `ast_resolved` | Tree-sitter + module resolution | Static AST (default) |
| `ast_inferred` | Heuristic inference from imports | Medium |
| `text_matched` | Name/text similarity matching | Lowest |

The `get_call_graph` tool reports a `resolution_tiers` summary showing the distribution across all edges, so you can see how much of the graph has compiler-grade confidence.

---

## Topology & subprojects

trace-mcp includes a **topology layer** for cross-service analysis and a **subproject layer** for linking dependency graphs across subprojects within a project.

A **subproject** is any working repository that is part of your project's ecosystem: microservices, frontends, backends, shared libraries, CLI tools, etc. Each directory with its own root marker (`package.json`, `composer.json`, `go.mod`, etc.) is a subproject. A project contains one or more subprojects; the project itself is not a subproject. Subprojects can live inside the project directory (e.g. `project/frontend/`) or outside it (added manually via `subproject add`).

Both topology and subprojects are **enabled by default** — every indexed project auto-detects its subprojects.

```jsonc
{
  "topology": {
    "enabled": true,           // default: true — enable topology + subproject tools
    "auto_discover": true,     // default: true — auto-detect and register subprojects on indexing
    "auto_detect": true,       // default: true — auto-detect from Docker Compose
    "repos": [],               // additional repo paths to include in topology
    "contract_globs": []       // explicit contract file patterns (e.g. ["api/openapi.yaml"])
  }
}
```

| Option | Default | Description |
|---|---|---|
| `topology.enabled` | `true` | Enable topology and subproject tools |
| `topology.auto_discover` | `true` | Auto-detect and register subprojects on every index |
| `topology.auto_detect` | `true` | Auto-detect subprojects from Docker Compose / workspace structure |
| `topology.repos` | `[]` | Additional repo paths to include in the topology graph |
| `topology.contract_globs` | — | Explicit paths to API contract files (relative to project root) |

### Auto-discovery flow

When a project is indexed (via `serve`, `serve-http`, or `index`):

1. **Subprojects are detected** within the project root using these strategies (in order):
   - **Docker Compose** — parses `docker-compose.yml` / `compose.yml` for service definitions
   - **Flat workspace** — scans first-level subdirectories for root markers (`package.json`, `composer.json`, `go.mod`, etc.). Requires ≥2 found (e.g. `project/frontend/` + `project/backend/`)
   - **Grouped workspace** — scans two levels deep (`root/group/service/`). Requires ≥2 found (e.g. `project/org/service-a/` + `project/org/service-b/`)
   - **Monolith fallback** — treats the project root as a single subproject
2. Each detected subproject is **registered** and bound to the project in `~/.trace-mcp/topology.db`
3. **API contracts** are parsed (OpenAPI, GraphQL SDL, Protobuf) for each subproject
4. Code is **scanned** for HTTP/gRPC client calls (fetch, axios, Http::, requests, etc.)
5. Client calls are **matched** to known endpoints from other subprojects
6. **Cross-subproject edges** are created

This is non-blocking — the server starts immediately, and subproject syncs in the background.

### Disabling

To disable auto-discovery while keeping topology tools:
```jsonc
{ "topology": { "enabled": true, "auto_discover": false } }
```

To disable everything:
```jsonc
{ "topology": { "enabled": false } }
```

### Subproject CLI

```bash
# Add a subproject (can be inside or outside project dir)
trace-mcp subproject add --repo=../service-b --project=. [--contract=openapi.yaml] [--name=my-service]
trace-mcp subproject remove <name-or-path>
trace-mcp subproject list [--project=.] [--json]
trace-mcp subproject sync
trace-mcp subproject impact --endpoint=/api/users [--method=GET] [--service=user-svc]
```

### Supported contract formats

| Format | Auto-detected files |
|---|---|
| **OpenAPI / Swagger** | `openapi.yml`, `openapi.yaml`, `openapi.json`, `swagger.yml`, `swagger.yaml`, `swagger.json`, `api-spec.yml`, `api-spec.yaml`, `api-spec.json` |
| **GraphQL SDL** | `schema.graphql`, `schema.gql` |
| **Protobuf / gRPC** | `*.proto` |

### Supported client call patterns

The scanner detects HTTP/gRPC/GraphQL calls in 12+ patterns across all supported languages:

| Pattern | Languages | Example |
|---|---|---|
| `fetch()` | JS/TS | `fetch('/api/users')` |
| `axios.*()` | JS/TS | `axios.get('/api/users')` |
| `Http::*()` | PHP/Laravel | `Http::post('/api/orders')` |
| `requests.*()` | Python | `requests.get('https://api.example.com/users')` |
| `http.Get/Post()` | Go | `http.Get("http://svc/api/users")` |
| `RestTemplate.*()` | Java/Kotlin | `.getForObject("/api/users")` |
| gRPC stubs | All | `client.GetUser()` |
| GraphQL operations | All | `query GetUser { ... }` |

---

## Hermes Agent sessions

Hermes Agent (NousResearch) stores conversations in a SQLite database at `$HERMES_HOME/state.db` (default `~/.hermes/state.db`) plus one DB per profile under `<home>/profiles/<name>/state.db`. trace-mcp reads these read-only and exposes them through:

- `discover_hermes_sessions` — MCP tool that lists sessions without mining or indexing them.
- `mine_sessions` — if you pass a `project_root`, the decision miner also walks every Hermes session it can see and records any decisions it finds under that project. When `project_root` is absent Hermes is skipped entirely — global conversations are deliberately not attributed to a guessed project.

Hermes sessions are global (no per-project binding in the upstream schema). Do not expect project scoping on the provider side.

```jsonc
{
  "hermes": {
    "enabled": "auto",       // "auto" (default) | true | false
    "home_override": null,   // override $HERMES_HOME / ~/.hermes resolution
    "profile": null          // scope discovery to <home>/profiles/<name>/
  }
}
```

With `enabled: "auto"` the provider is registered at boot; discovery returns an empty list when no `state.db` exists, so there is no penalty on machines that don't use Hermes.

---

## Environment variables

| Variable | Description |
|---|---|
| `TRACE_MCP_LOG_LEVEL` | Log level (debug, info, warn, error) |
| `HERMES_HOME` | Override for Hermes Agent storage root (default `~/.hermes`). Read by `discover_hermes_sessions` and the Hermes session provider. |

---

## CLI

```bash
# Setup
trace-mcp init                 # One-time global setup (MCP clients, hooks, CLAUDE.md)
trace-mcp add [dir]            # Register a project for indexing
trace-mcp list                 # List all registered projects
trace-mcp upgrade [dir]        # Upgrade all projects (or specific one) — migrations + reindex

# Server
trace-mcp serve                # Start MCP server (stdio transport)
trace-mcp serve-http           # Start HTTP/SSE server (default: 127.0.0.1:3741)
  -p, --port <port>            # Custom port
  --host <host>                # Custom host

# Manual indexing
trace-mcp index <dir>          # Index a project directory
  -f, --force                  # Force reindex all files

# Subprojects (= services bound to projects)
trace-mcp subproject add       # Add a subproject to a project
  --repo <path>                # Subproject/service path (required)
  --project <path>             # Project this subproject belongs to (required)
  --contract <paths...>        # Explicit contract file paths
  --name <name>                # Display name
trace-mcp subproject remove <name-or-path>   # Remove a subproject
trace-mcp subproject list                    # List subprojects
  --project <path>             # Filter to a specific project
  --json                       # Output as JSON
trace-mcp subproject sync                    # Re-scan all subprojects
trace-mcp subproject impact                  # Cross-subproject impact analysis
  --endpoint <path>            # Endpoint path pattern
  --method <method>            # HTTP method filter
  --service <name>             # Service name filter
  --json                       # Output as JSON

# Hooks
trace-mcp setup-hooks          # Install guard hook (blocks Read/Grep/Glob/Bash on code + Agent(Explore))
  --global                     # Install globally
  --uninstall                  # Remove hook

# Analytics (see docs/analytics.md)
trace-mcp analytics sync       # Parse session logs into analytics DB
  --full                       # Force full rescan
trace-mcp analytics report     # Token usage report
  --period <p>                 # today, week, month, all (default: week)
trace-mcp analytics optimize   # Optimization recommendations
trace-mcp analytics savings    # Real savings analysis
trace-mcp analytics benchmark  # Synthetic token efficiency benchmark
  --queries <n>                # Queries per scenario (default: 10)
  --format <fmt>               # text, json, markdown
trace-mcp analytics coverage   # Technology coverage report
trace-mcp analytics trends     # Daily usage trends
  --days <n>                   # Number of days (default: 30)
```

---

## Security

- **Path traversal protection** — all file access validated against project root
- **Symlink detection** — prevents escape from project boundary
- **Secret pattern filtering** — configurable regex patterns filter out secrets from tool output
- **File size limits** — per-file byte cap prevents OOM on large files
- **Artisan whitelist** — only safe artisan commands allowed (when Laravel integration is enabled)
- **HTTP rate limiting** — 60 req/min per IP on HTTP/SSE transport
