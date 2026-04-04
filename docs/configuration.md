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
    "inference_model": "llama3",
    "embedding_model": "nomic-embed-text",
    "summarize_on_index": true,
    "summarize_batch_size": 20,
    "summarize_kinds": ["class", "function", "method", "interface", "trait", "enum", "type"]
  }
}
```

| Option | Default | Description |
|---|---|---|
| `ai.enabled` | `false` | Enable AI features |
| `ai.provider` | `"ollama"` | `"ollama"` or `"openai"` |
| `ai.base_url` | — | Custom API endpoint |
| `ai.api_key` | — | API key (required for OpenAI) |
| `ai.inference_model` | — | Model for explanations and reviews |
| `ai.fast_model` | — | Faster model for lightweight tasks |
| `ai.embedding_model` | — | Model for vector embeddings |
| `ai.embedding_dimensions` | — | Embedding vector dimensions |
| `ai.summarize_on_index` | `true` | Auto-summarize symbols after indexing |
| `ai.summarize_batch_size` | `20` | Symbols per summarization batch |
| `ai.summarize_kinds` | `["class", "function", ...]` | Symbol kinds to summarize |
| `ai.reranker_model` | — | Model for search result reranking |

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

# Hooks
trace-mcp setup-hooks          # Install guard hook
  --global                     # Install globally
  --uninstall                  # Remove hook
```

---

## Security

- **Path traversal protection** — all file access validated against project root
- **Symlink detection** — prevents escape from project boundary
- **Secret pattern filtering** — configurable regex patterns filter out secrets from tool output
- **File size limits** — per-file byte cap prevents OOM on large files
- **Artisan whitelist** — only safe artisan commands allowed (when Laravel integration is enabled)
- **HTTP rate limiting** — 60 req/min per IP on HTTP/SSE transport
