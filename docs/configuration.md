---
title: "Configuration Reference — all config options (works with none)"
description: "Every trace-mcp config option in .trace-mcp.json — indexing, quality gates, LSP enrichment, TOON output, telemetry. Configuration is optional; trace-mcp works out of the box for standard projects."
updated: 2026-09-02
---

# Configuration

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "Configuration",
  "description": "All config file options; trace-mcp works out of the box without one.",
  "url": "https://trace-mcp.com/configuration.html",
  "datePublished": "2026-04-05",
  "dateModified": "2026-08-08",
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
    "@id": "https://trace-mcp.com/configuration.html"
  }
}
</script>
Configuration is optional — trace-mcp works out of the box for standard projects.

This page is the reference for the file itself: where it lives, how the layers
merge, and every key. Several sections of it are big enough to have their own
page — the [quality gates](quality-gates.md) thresholds, the
[telemetry](telemetry.md) span exporter, the memory knobs that bound the
[daemon](daemon-memory.md), and the [tweakcc](tweakcc.md) enforcement tier that
`trace-mcp init` writes here on your behalf.

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
    "patterns": ["**/fixtures/**", "**/*.generated.ts"],
    // Respect the project's root .gitignore when walking (default: true).
    // Set false to index git-ignored trees too — vendored and generated code
    // then competes with your own in every search result.
    "gitignore": true
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

You can add **more** directory names to skip via `.traceignore` or the `ignore.directories` config key — both only *add* to the skip list, they don't remove anything from it.

`trace-mcp add` / `trace-mcp index` print a "Skipped top-level folders" line after indexing listing every top-level directory that got skipped this way, so a folder missing from the index isn't a silent surprise.

### Getting a skipped folder indexed

Two different things can leave a folder out of the index — check which one applies:

1. **The folder name collides with a built-in skip dir** (e.g. you have your own `vendor/` or `build/` with real source in it). There's currently no per-project way to un-skip a built-in name — rename the folder, or [open an issue](https://github.com/nikolai-vysotskyi/trace-mcp/issues) if this collision is common enough to warrant a config override.
2. **The folder just isn't a built-in skip dir, but nothing in `include` matches its files.** The default `include` covers every extension a registered language plugin claims, *except* the pure data formats — JSON, XML (`.xml`, `.svg`, `.csproj`, ...) and INI (`.ini`, `.conf`, `.properties`, ...) — which are left out because lockfiles and fixtures would swamp the index. Add an explicit pattern for those:

   ```jsonc
   // .trace-mcp/.config.json
   {
     "include": ["schemas/**/*.json"]
   }
   ```

   `include` in a per-project config file **replaces** the built-in list rather than adding to it (config merge is shallow) — copy the defaults from [`src/config.ts`](../src/config.ts) alongside your addition if you still want the rest of the project indexed.

---

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `root` | `string` | `"."` | Project root directory |
| `include` | `string[]` | Auto-detected | Glob patterns for files to index |
| `exclude` | `string[]` | Common exclusions | Glob patterns to skip |
| `follow_symlinks` | `boolean` | `false` | Follow directory symlinks during file discovery. Leave off unless you know the tree is free of symlink cycles — enabling it on a tree with a cycle (e.g. Ansible Molecule's `roles/<role>/molecule/<scenario>/roles/<role> -> ../../../` layout) can silently truncate traversal. Symlinked *files* are always skipped regardless of this setting. |
| `ignore.directories` | `string[]` | `[]` | Extra directory names to skip (added to built-in list) |
| `ignore.patterns` | `string[]` | `[]` | Extra gitignore-style patterns to exclude from indexing |
| `plugins` | `string[]` | `[]` | Paths to custom plugins — see [development](development.md#adding-a-new-integration-plugin) for the plugin interface |
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
| **`onnx`** (default) | ✓ local, offline | ✗ | `@huggingface/transformers` (optional dep) | Zero-config — model auto-downloads (~23 MB) on first use |
| **`ollama`** | ✓ via Ollama | ✓ via Ollama | Running Ollama instance | Install Ollama + pull models |
| **`lmstudio`** | ✓ via LM Studio | ✓ via LM Studio | LM Studio server running | OpenAI-compatible, no API key |
| **`openai`** | ✓ | ✓ | API key | `api_key` or `OPENAI_API_KEY` env |
| **`anthropic`** | ✗ (no embeddings API) | ✓ | API key | `api_key` or `ANTHROPIC_API_KEY` env |
| **`gemini`** | ✓ | ✓ | API key | Google Generative Language API (consumer) — `api_key` (AIza…) or `GEMINI_API_KEY` env |
| **`vertex`** | ✓ | ✓ | OAuth token + GCP project | Google Vertex AI (GCP) — `api_key` = access token, plus `vertex_project` + `vertex_location` |
| **`voyage`** | ✓ (code-tuned) | ✗ | API key | Voyage AI embeddings only — pair with another provider for inference |
| **`mistral`** / **`groq`** / **`together`** / **`deepseek`** / **`xai`** | ✓ | ✓ | API key | OpenAI-compatible endpoints — per-provider `*_API_KEY` env |

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
    "embedding_dimensions": 1024,
    "summarize_on_index": true,
    "summarize_batch_size": 20,
    "summarize_kinds": ["class", "function", "method", "interface", "trait", "enum", "type"],
    "concurrency": 4
  }
}
```

> **Ollama embedding dimensions — match your model.** Ollama embedding models
> vary in output dimensionality (`nomic-embed-text` → 768, `qwen3-embedding:0.6b`
> → 1024, `mxbai-embed-large` → 1024, etc.). When `ai.embedding_dimensions` is
> **omitted**, trace-mcp auto-detects the real dimension by probing the model on
> first use, so you don't have to set it. When you **do** set it, the value MUST
> equal the model's real dimension — a wrong value makes every vector insert fail
> with a dimension mismatch, and `embed_repo` then returns `status: "error"`
> (`dimension_mismatch`) rather than a silent 0-coverage "completed". If you
> switch to a model with a different dimension, either update
> `embedding_dimensions` to match (or remove it) and re-run
> `embed_repo({ force: true })`.

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
    "preset": "standard",                // "full" | "standard" | "minimal" | "review" | "architecture" | "dev" | "security" | "design" | "perf" | "router"
    "description_verbosity": "full",     // "full" | "minimal" | "none"
    "instructions_verbosity": "full",    // "full" | "minimal" | "none" — controls the tool-routing block
    "client_profile": "auto",            // "auto" | "off" | "claude-code" | "codex" | "cursor" | "vscode" | "generic"
    "agent_behavior": "off",             // "strict" | "minimal" | "off" — see below
    "meta_fields": true,                 // true | false | ["_hints", "_budget_warning", ...]
    "compact_schemas": false             // strip advanced params from tool schemas (saves tokens)
  }
}
```

| Option | Default | Description |
|---|---|---|
| `tools.preset` | `"minimal"` | Tool preset — the number is the upper bound on the tool surface; framework-gated tools only appear when the framework is detected. `minimal` (28 tools, default), `standard` (60 tools — covers >99% of real-world tool calls per session-log mining), `review` (32 tools), `architecture` (41 tools), `dev` (42 tools), `security` (35 tools), `design` (26 tools), `perf` (31 tools), `router` (10 tools — see [The router preset](#the-router-preset)), or `full` (every registered tool, opt-in). A preset is a *deferral*, not a restriction: everything outside it is registered but hidden, and `load_tools` pulls any of it in mid-session. `tools.exclude` remains a hard restriction that `load_tools` cannot undo. |
| `tools.include` | — | Whitelist specific tools by name |
| `tools.exclude` | — | Blacklist specific tools by name |
| `tools.description_verbosity` | `"full"` | Per-tool description length. `minimal` = first sentence. `none` = empty |
| `tools.instructions_verbosity` | `"full"` | Server-level instructions (the tool-routing block). `full` ~2K tokens, `minimal` ~200 |
| `tools.client_profile` | `"auto"` | Tailors the advertised surface to the connected host — see [Client profiles](#client-profiles). `auto` detects it from the `initialize` handshake, a profile name pins it, `off` disables the layer. Env override: `TRACE_MCP_CLIENT_PROFILE` |
| `tools.agent_behavior` | `"off"` | Behavior rules appended to instructions — see [Agent behavior rules](#agent-behavior-rules) |
| `tools.meta_fields` | `true` | Meta fields in responses (`_hints`, `_budget_warning`, etc.). Set `false` or list to narrow |
| `tools.compact_schemas` | `false` | Strip advanced/optional params from tool schemas. Cuts schema size ~42% (measured 2026-08-29) |

### Progressive tool disclosure

A preset used to be permanent: a tool outside it was never registered, so the
session that saved schema tokens also lost the tool for the rest of its life.
That made the small presets a bad trade, and most sessions ran `full` and paid
the whole surface up front.

Since v3.3 a preset is a *deferral*. Tools outside it are registered but
disabled — absent from `tools/list`, so you don't pay their schemas — and the
always-available `load_tools` pulls any of them in mid-session:

```
load_tools()                                  # list what this session deferred
load_tools({ tools: ["taint_analysis"] })     # load one
load_tools({ preset: "architecture" })        # load a preset's worth
load_tools({ preset: "full" })                # load everything deferred
```

Configs written before v3.3 pinned `"preset": "full"` — that was the default at
the time, not a choice, and it kept those installs paying for the whole surface
long after the default moved. Upgrading rewrites that one value to the shipped
default, once and without asking, and records that it did so; set `full` (or any
other preset) yourself afterwards and no later upgrade will touch it. To go back
to the old behaviour, set `"preset": "full"` or run `load_tools({ preset: "full" })`.

Loading emits `notifications/tools/list_changed`, and clients that honour it
(Claude Code among them) re-read the larger surface and can call the new tools
directly. Clients that ignore the notification are not stuck: `load_tools`
returns each loaded tool's full JSON schema in its response, and the loaded tool
is immediately reachable through `batch` — `batch({ calls: [{ tool, args }] })`
— which is in every preset.

`batch` dispatches by name against the whole registry, deferred tools included,
so a deferred tool is callable through it *without* loading it first. That is
deliberate (it is what the `router` preset below is built on), and the price is
one round-trip's worth of schema you never see: you have to know the tool's
arguments, or read them from `load_tools`. `tools.exclude` is not reachable this
way — the exclusion is checked on the inner call names too, on both the local
and the daemon-backed path.

What escalation cannot do is widen `tools.exclude`. Exclusion stays a hard
restriction; `load_tools` reports those names under `blocked` and leaves them
off. If you want a tool gone, exclude it — don't rely on the preset.

A preset name that doesn't resolve — a typo, or a preset added in a version
newer than the one installed — falls back to `minimal` and logs a warning naming
the available presets. Before v3.12 it fell back to `full`, which turned a typo
in a flag set to save tokens into a 36.3k-token surface instead of a 7.8k one.
Failing toward the cheap surface costs at most one `load_tools` round-trip.

Measured `tools/list` cost of each preset on this repo (serialized chars, then
o200k tokens, 2026-09-01; `router` added 2026-09-02): `router` 7.1k / 1.6k,
`design` 21.9k / 5.0k, `perf` 32.3k / 7.5k, `minimal`
34.0k / 7.8k, `review` 37.3k / 8.6k, `security` 41.5k / 9.6k, `architecture`
44.3k / 10.2k, `dev` 51.3k / 11.9k, `standard` 64.6k / 14.9k, `full` 157.7k /
36.3k. Against `full`, that is a 67% cut on the widest role preset (`dev`) and
86% on the narrowest (`design`) — framework-gated tools are excluded, so a
project that detects the matching framework pays more.
`load_tools` itself is 0.9k of that — the price of making the other 123k optional.

### The router preset

`"preset": "router"` advertises **no** code-intelligence tools at all — only the
session meta-tools that are never gated, `load_tools` and `batch` among them. Ten
tools, 1.6k tokens, 95.6% below `full` and 79.2% below the `minimal` default.

It is usable rather than crippled because the two halves cover each other:
`load_tools()` names the ~150 deferred tools (names only — the schemas are what
you are not paying for), and `batch` calls any of them directly. So the session
pays for a catalog instead of a surface, and there is no escalation round-trip
unless you want the schemas.

```jsonc
{ "tools": { "preset": "router" } }      // or: trace-mcp --preset router
```

It is **opt-in and will not become the default.** On a host that already defers
tool schemas itself — Claude Code's ToolSearch, which keeps only the 15
`ALWAYS_LOAD_TOOLS` eagerly loaded — `router` saves ~2.9k tokens and takes away
exactly the first-five-minutes tools that stamp exists to protect. On a host
without such a mechanism it saves ~6.2k per session, every session. Take it if
your client has no tool deferral of its own, or if you are running many short
sessions where the surface is most of what you pay.

### Client profiles

The preset decides *how much* capability a session advertises. The client
profile decides what that particular host does not need to be told about.

The connected client names itself in the `initialize` handshake, so trace-mcp
knows whether it is talking to Claude Code, Codex, Cursor, VS Code, or something
it has never seen. Two things follow from that:

- **Tools the host already has are not advertised.** A CLI coding agent arrives
  with its own content search; offering ours alongside it costs schema tokens
  and gives the model two ways to do one thing. Suppression lists are short and
  deliberately conservative — `search_text` and `discover_hermes_sessions` today.
- **The instructions name the host's own tools.** The routing block is written
  for a host it cannot see, so it says "`read`, `content-match`, `glob` mean
  whatever yours are called". Once the handshake identifies the host it says
  `Read`/`Grep`/`Glob` on Claude Code and `shell` (cat/rg/find) with
  `apply_patch` on Codex.

The profile composes *after* the preset — it only removes names from whatever
the preset already advertised — and it never removes capability. A suppressed
tool stays callable by name, `load_tools({ tools: ["search_text"] })` puts it
back on `tools/list`, and `"client_profile": "off"` (or
`TRACE_MCP_CLIENT_PROFILE=off`) disables the layer entirely. An unrecognised
host resolves to `generic`, which suppresses nothing.

Measured on a live `initialize` + `tools/list` round-trip against the built
server, default `minimal` preset (serialized chars, 2026-08-30):

| Client | instructions | `tools/list` | advertised | handshake total |
|---|---|---|---|---|
| `generic` (or `client_profile: "off"`) | 7,669 | 36,523 | 28 | 44,192 |
| `claude-code` | 7,933 | 34,621 | 27 | 42,554 (−3.7%) |
| `codex` | 7,927 | 34,621 | 27 | 42,548 (−3.7%) |
| `cursor` | 7,928 | 34,621 | 27 | 42,549 (−3.7%) |

The instructions grow slightly because the profile appends one line naming what
it hid and how to get it back — without it a suppressed tool is invisible, since
`load_tools()` lists what the *preset* deferred and a suppressed tool is inside
the preset.

Every `tools.*` option works from a project-local config file (`.trace-mcp/.config.json`) as well as the global one — none of them are global-only. The tool surface is built once per MCP session, so a change takes effect on the next session (restart the MCP client); the daemon does not need restarting.

### Agent behavior rules

`tools.agent_behavior` appends generic discipline rules (anti-sycophancy, anti-fabrication, goal-driven execution, 2-strike session hygiene, no drive-by refactors) to the server instructions. These are client-agnostic — every MCP-compatible client (Claude Code, Cursor, Codex, Windsurf, …) receives them.

| Value | What ships | When to use |
|---|---|---|
| `"off"` *(default)* | Nothing | Default — you already manage agent behavior elsewhere (CLAUDE.md, [tweakcc](tweakcc.md)), or don't want opinionated rules |
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
| `scip_resolved` | Offline SCIP index ingestion (opt-in) | Compiler-grade (highest) |
| `lsp_resolved` | LSP call hierarchy | Compiler-grade |
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

### Cross-project tools

Every MCP session is still attached to exactly one project (see [stdio vs HTTP](#stdio-vs-http--choosing-your-setup)) — but two tools let an agent reach across to any OTHER project already registered with trace-mcp, without opening a second MCP connection:

- **`list_projects`** — lists every project in `~/.trace-mcp/registry.json` (root, name, type, last-indexed timestamp), plus known subprojects when topology is enabled for the current session.
- **`call_project_tool { project, tool, args }`** — runs any of the {{ site.data.counts.tools }} normal trace-mcp tools against a DIFFERENT registered project's already-indexed data and returns that tool's response verbatim. `project` must be a root from `list_projects`; an unregistered root or an unknown `tool` name returns a structured `{ error: { code, message, data } }` payload instead of throwing.

This is read-only relay wiring — it never starts indexing or a file watcher for the target project. In the HTTP daemon, a target project already warm in memory is served directly; a cold one is opened on demand via the same read-mostly path used for on-demand subprojects. Under `stdio` (no daemon), the target project's existing index database is opened directly; a project that has never been indexed cannot be relayed to.

No existing tool's schema changes because of this — `call_project_tool` dispatches to the target project's own registered handler for `tool`, so that tool's contract is exactly what it is when called directly.

---

## Supported MCP clients

`trace-mcp init` detects installed MCP clients and writes a `trace-mcp` server entry into each one's native config format. Pick clients interactively, or pass `--mcp-client <name>` for non-interactive runs.

| Client | Config path | Format | Top-level key | Notes |
|---|---|---|---|---|
| Claude Code | `~/.claude.json`, `<project>/.mcp.json` | JSON | `mcpServers` | Supports Base / Standard / Max enforcement tiers (hooks, tweakcc) |
| Claw Code | `~/.claw/settings.json`, `<project>/.claw.json` | JSON | `mcpServers` | Same enforcement tiers as Claude Code |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) | JSON | `mcpServers` | Quit Claude.app before init — it overwrites foreign keys on preference flush |
| Cursor | `~/.cursor/mcp.json`, `<project>/.cursor/mcp.json` | JSON | `mcpServers` | Also writes `.cursor/rules/trace-mcp.mdc` |
| Windsurf | `~/.windsurf/mcp.json`, `<project>/.windsurf/mcp.json` | JSON | `mcpServers` | Also writes `.windsurfrules` |
| Continue | `~/.continue/mcpServers/mcp.json` | JSON | `mcpServers` | |
| Junie | `~/.junie/mcp/mcp.json` | JSON | `mcpServers` | |
| JetBrains AI Assistant | IDE-internal XML | — | — | Manual: Settings → Tools → AI Assistant → MCP. Use "Import from Claude" if Claude Desktop is configured |
| Codex | `~/.codex/config.toml` | TOML | `[mcp_servers.trace-mcp]` | |
| Hermes Agent | `$HERMES_HOME/config.yaml` (default `~/.hermes/config.yaml`) | YAML | `mcp_servers` | Always global; also writes `AGENTS.md` and pre-allowlists hooks |
| **AMP** (Sourcegraph) | `~/.config/amp/settings.json[c]`, `<project>/.amp/settings.json[c]` | JSON / JSONC | `amp.mcpServers` (literal dot in key) | Comments and formatting preserved via `jsonc-parser`. Also writes `AGENTS.md` |
| **Warp** | Cloud-synced storage (no writable file) | — | — | Manual: Settings → Agents → MCP servers → + Add → paste JSON. If Claude Code is also configured, enable "File-based MCP servers" so Warp inherits trace-mcp from `~/.claude.json`. Also writes `AGENTS.md` |
| **Factory Droid** | `~/.factory/mcp.json`, `<project>/.factory/mcp.json` | JSON | `mcpServers` (entries need `type: "stdio"`) | Also writes `AGENTS.md` |
| **Cline** | `<VS Code User>/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | JSON | `mcpServers` | VS Code extension; global-only (globalStorage has no per-project variant). Detected only when the extension's settings dir exists |
| **Kilo Code** | `<VS Code User>/globalStorage/kilocode.kilo-code/settings/mcp_settings.json` | JSON | `mcpServers` | Legacy VS Code extension config. The newer Kilo CLI (≥ v7) uses a non-standard `~/.config/kilo/kilo.jsonc` shape (`mcp` key, `command` as array) that trace-mcp does not write — configure that manually if you use the CLI |
| **Antigravity** (Google) | `~/.gemini/config/mcp_config.json` | JSON | `mcpServers` | Global-only (no documented per-project config as of mid-2026) |
| **Kimi Code CLI** (Moonshot) | `~/.kimi/mcp.json` | JSON | `mcpServers` | Global-only; format is compatible with other MCP clients |

> `<VS Code User>` is `~/Library/Application Support/Code/User` (macOS), `%APPDATA%\Code\User` (Windows), or `~/.config/Code/User` (Linux).

**Enforcement tiers (Claude Code / Claw / Desktop only):**
- **Base** — `CLAUDE.md` block with tool routing rules.
- **Standard** — Base + PreToolUse guard hooks that intercept built-in Read/Grep/Glob.
- **Max** — Standard + tweakcc system-prompt patches and strict agent-behavior rules.

For all other clients only the Base tier applies — there is no equivalent of Claude Code hooks or tweakcc in those tools.

### Renaming `trace-mcp` → `trace`: what `init` can and can't reach

MCP clients advertise every tool prefixed with the server key, so the rename
also renames the tool prefix a client-side config may reference in full:
`mcp__trace-mcp__search` becomes `mcp__trace__search`. `trace init` (and the
post-update migration that runs automatically when the daemon starts after
an upgrade) rewrites this everywhere it owns the file:

- The `mcpServers` entry itself, in every supported client above.
- Claude Code / Claw Code **permission allowlist entries**
  (`permissions.allow` / `permissions.deny`) and **hook `matcher` strings**,
  in both the global `settings.json` and the project-scoped
  `settings.local.json`.

**What stays manual.** Anything you wrote yourself outside those specific
fields is not touched — most commonly, tool names spelled out in your own
prose inside `CLAUDE.md` / `AGENTS.md` (`init` only rewrites the routing
block it generated, not arbitrary text you added), or a permission/hook
config in a file trace-mcp doesn't manage the shape of. If a tool call stops
matching a hook, or an allowlisted tool starts re-prompting for approval
after upgrading, grep your own config for `mcp__trace-mcp__` and replace it
with `mcp__trace__`.

### Multica workspace agents

Multica agents don't run `trace-mcp init` — each agent's MCP wiring is set directly with `multica agent update --mcp-config-file <json>` (or `agent create --mcp-config-file` on first setup), scoped to that one agent. Every agent inherits a runtime-provided `trace-mcp` entry that runs the unconfigured default preset (`minimal`); to give a role its own preset, override the `trace-mcp` entry by name — the agent's own `mcp_config` always wins that collision:

```json
{
  "mcpServers": {
    "trace-mcp": { "command": "trace-mcp", "args": ["--preset", "dev"] }
  }
}
```

```bash
multica agent update <agent-id> --mcp-config-file ./trace-mcp-dev.json
```

> **Check that the agent's installed `trace-mcp` supports `--preset` before rolling this out.** The flag shipped after 3.11.0; an older binary exits immediately with `unknown option '--preset'`, and because a dead MCP server is silent, the agent simply runs with **zero** trace-mcp tools instead of a smaller set. Verify with `trace-mcp --help | grep -- --preset` on the machine the agent runs on. Same trap applies to a `command` pointing at a build inside a per-task working directory — those get cleaned up.

The role → preset matrix used in the trace-mcp workspace itself (adjust to your own roles):

| Agent role | Preset | Why |
|---|---|---|
| Independent code review | `review` | rename-safety, quality gates, risk/impact assessment — no refactor or design tools |
| Security audit | `security` | `scan_security`, `taint_analysis`, SBOM, config audit — no refactor/design tools |
| Design/UX review | `design` | component tree, screens, navigation, state — no security/perf tools |
| Implementation & bugfixing | `dev` | refactor + codemod tools (`apply_rename`, `extract_function`, `change_signature`) |
| Performance analysis | `perf` | `analyze_perf`, complexity/coupling trends, risk hotspots |

`multica agent update --mcp-config*` **replaces** the agent's entire `mcp_config` — it does not merge. If the agent already has other private MCP servers configured, read them back first (only a workspace owner/admin can; `mcp_config` reads redacted for agent actors) and include them in the new payload, or the update will silently remove them.

---

## stdio vs HTTP — choosing your setup

trace-mcp speaks MCP over two transports. Which one to pick depends on whether you want a process per repo or one long-lived daemon serving many projects.

### stdio — recommended for per-repo agent sessions

`trace-mcp serve` runs the server over stdio. Your MCP client launches one process per session with the working directory set to the repo you opened, so the project is auto-detected from there — no URL, no `?project=`, and each session is isolated to its own repo. No daemon is required: it runs in-process, and if a daemon happens to be running it transparently reuses the warm index.

Wire it up without touching a committed file:

```bash
# Across all your projects (stored in ~/.claude.json, not committed):
claude mcp add --scope user trace-mcp -- npx -y trace-mcp@latest serve

# Just one project, not committed (local scope):
claude mcp add --scope local trace-mcp -- npx -y trace-mcp@latest serve
```

To share one config with the whole team, commit a portable stdio entry to `.mcp.json` — it carries no machine-specific URL or path:

```json
{
  "mcpServers": {
    "trace-mcp": { "command": "npx", "args": ["-y", "trace-mcp@latest", "serve"] }
  }
}
```

Each developer's session spawns its own per-repo process; nothing is shared or hardcoded. Avoid committing an absolute HTTP URL such as `http://127.0.0.1:3741/mcp?project=/Users/you/...` — that path only exists on your machine and would break for everyone else.

### HTTP daemon — one warm index shared across many projects

`trace-mcp serve-http` runs a long-lived daemon (default `127.0.0.1:3741`) that holds warm indexes for several registered projects and backs the desktop app. MCP clients connect with the target project in the URL:

```
http://127.0.0.1:3741/mcp?project=/absolute/path/to/repo
```

Holding several indexes warm is what the daemon costs you in RAM: [daemon memory](daemon-memory.md) breaks the resident set down region by region and names the knob that bounds each one.

The daemon multiplexes projects — one process serves all of them — but each MCP registration is bound to a single project via `?project=` (or, for clients that cannot append a query string, the `X-Trace-Project` header or `params._meta["traceMcp/projectRoot"]`). Pick this when you want one warm index reused across sessions and tools and you're comfortable managing the per-registration URL. For one-session-per-repo workflows, stdio is simpler.

> **The daemon's trust boundary is loopback.** `serve-http` has no authentication: every `/api` route and `/mcp` itself trust the caller, and `?project=` / `X-Trace-Project` / `params._meta["traceMcp/projectRoot"]` can name any directory on the machine — the daemon will index and serve it. On `127.0.0.1` that grants nothing extra, because anything able to reach the port already runs as you and can read those files directly. Binding elsewhere hands that power to the network, so a non-loopback `--host` is refused unless you also pass `--allow-remote`, and even then you are expected to put your own authentication (SSH tunnel, reverse proxy, VPN) in front of the port.

> **One project per session.** Both transports resolve exactly one project per MCP session — stdio from the working directory, HTTP from `?project=`. A single session cannot query across repositories today; to work with several repos, register each (`trace-mcp add <path>`) and add one MCP entry per repo (HTTP) or open one session per repo (stdio). Cross-repo queries inside a single session — useful for multi-repo/pseudo-monorepo setups — are tracked as an enhancement in [#199](https://github.com/nikolai-vysotskyi/trace-mcp/issues/199).

| | stdio | HTTP daemon |
|---|---|---|
| Process model | one per session | one shared daemon |
| Project scope | auto-detected from cwd | `?project=` per registration |
| Config | command, no URL | URL with absolute path |
| Warm-index reuse | per session (shared if a daemon is running) | always shared |
| Best for | per-repo agent sessions, committed team config | desktop app, many projects, one shared index |

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
  --host <host>                # Custom host (loopback only unless --allow-remote)
  --allow-remote               # Permit a non-loopback --host (see the trust boundary note)

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

What counts as a failing security finding *in your own code* is a separate
setting — `quality_gates.rules.max_security_critical_findings`, documented with
this project's own calibrated numbers under [quality gates](quality-gates.md).
