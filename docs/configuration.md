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
    "enabled": true,
    "provider": "ollama",
    "base_url": "http://localhost:11434"
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

### Local override (optional)

You can also place a `.trace-mcp.json` in your project root to override settings without editing the global config. This is useful for project-specific `include`/`exclude` patterns that shouldn't live in the global config:

```jsonc
// /path/to/project/.trace-mcp.json
{
  "include": ["src/**/*.ts", "lib/**/*.ts"],
  "exclude": ["node_modules/**", "dist/**", "coverage/**"]
}
```

---

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `root` | `string` | `"."` | Project root directory |
| `include` | `string[]` | Auto-detected | Glob patterns for files to index |
| `exclude` | `string[]` | Common exclusions | Glob patterns to skip |
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

When `ai.enabled` is `true`, trace-mcp runs background summarization and embedding pipelines after indexing and unlocks 5 additional AI-powered tools (`explain_symbol`, `suggest_tests`, `review_change`, `find_similar`, `explain_architecture`).

```jsonc
{
  "ai": {
    "enabled": true,
    "provider": "ollama",
    "base_url": "http://localhost:11434",
    "inference_model": "gemma4-e4b",
    "embedding_model": "qwen3-embedding:0.6b",
    "summarize_on_index": true,
    "summarize_batch_size": 20,
    "summarize_kinds": ["class", "function", "method", "interface", "trait", "enum", "type"],
    "concurrency": 4
  }
}
```

| Option | Default | Description |
|---|---|---|
| `ai.enabled` | `false` | Enable AI features |
| `ai.provider` | `"ollama"` | `"ollama"` or `"openai"` |
| `ai.base_url` | — | Custom API endpoint |
| `ai.api_key` | — | API key (required for OpenAI) |
| `ai.inference_model` | `"gemma4-e4b"` (ollama) | Model for explanations and reviews |
| `ai.fast_model` | `"gemma4-e4b"` (ollama) | Faster model for lightweight tasks |
| `ai.embedding_model` | `"qwen3-embedding:0.6b"` (ollama) | Model for vector embeddings |
| `ai.embedding_dimensions` | — | Embedding vector dimensions |
| `ai.summarize_on_index` | `true` | Auto-summarize symbols after indexing |
| `ai.summarize_batch_size` | `20` | Symbols per summarization batch |
| `ai.summarize_kinds` | `["class", "function", ...]` | Symbol kinds to summarize |
| `ai.concurrency` | `1` | Max parallel requests to AI provider (1–32) |
| `ai.reranker_model` | — | Model for search result reranking |

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

## Topology & federation

trace-mcp includes a **topology layer** for cross-service analysis and a **federation layer** for linking dependency graphs across separate repositories.

Both are **enabled by default** — every indexed project is automatically registered in the federation, its contracts parsed, and client calls scanned.

```jsonc
{
  "topology": {
    "enabled": true,           // default: true — enable topology + federation tools
    "auto_federation": true,   // default: true — auto-register projects on indexing
    "auto_detect": true,       // default: true — auto-detect services from Docker Compose
    "repos": [],               // additional repo paths to include in topology
    "contract_globs": []       // explicit contract file patterns (e.g. ["api/openapi.yaml"])
  }
}
```

| Option | Default | Description |
|---|---|---|
| `topology.enabled` | `true` | Enable topology and federation tools |
| `topology.auto_federation` | `true` | Auto-register project in federation on every index |
| `topology.auto_detect` | `true` | Auto-detect services from Docker Compose / workspace manifests |
| `topology.repos` | `[]` | Additional repo paths to include in the topology graph |
| `topology.contract_globs` | — | Explicit paths to API contract files (relative to project root) |

### Auto-federation flow

When a project is indexed (via `serve`, `serve-http`, or `index`):

1. Project is registered in `~/.trace-mcp/topology.db`
2. Services are detected (Docker Compose, workspace fallback)
3. API contracts are parsed (OpenAPI, GraphQL SDL, Protobuf)
4. Code is scanned for HTTP/gRPC client calls (fetch, axios, Http::, requests, etc.)
5. Client calls are matched to known endpoints from other federated repos
6. Cross-service edges are created

This is non-blocking — the server starts immediately, and federation syncs in the background.

### Disabling

To disable auto-federation while keeping topology tools:
```jsonc
{ "topology": { "enabled": true, "auto_federation": false } }
```

To disable everything:
```jsonc
{ "topology": { "enabled": false } }
```

### Federation CLI

```bash
trace-mcp federation add --repo=../service-b [--contract=openapi.yaml] [--name=my-service]
trace-mcp federation remove <name-or-path>
trace-mcp federation list [--json]
trace-mcp federation sync
trace-mcp federation impact --endpoint=/api/users [--method=GET] [--service=user-svc]
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

## Environment variables

| Variable | Description |
|---|---|
| `TRACE_MCP_LOG_LEVEL` | Log level (debug, info, warn, error) |

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

# Federation
trace-mcp federation add       # Add a repo to the federation
  --repo <path>                # Repository path (required)
  --contract <paths...>        # Explicit contract file paths
  --name <name>                # Display name
trace-mcp federation remove <name-or-path>   # Remove from federation
trace-mcp federation list [--json]           # List all federated repos
trace-mcp federation sync                    # Re-scan all repos
trace-mcp federation impact                  # Cross-repo impact analysis
  --endpoint <path>            # Endpoint path pattern
  --method <method>            # HTTP method filter
  --service <name>             # Service name filter
  --json                       # Output as JSON

# Hooks
trace-mcp setup-hooks          # Install guard hook
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
