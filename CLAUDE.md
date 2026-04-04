# trace-mcp Development Guide

## What this project is

trace-mcp is a framework-aware code intelligence MCP server. It indexes source code into a dependency graph with full-text search, understanding 48+ frameworks across 44 languages. It exposes MCP tools for navigation, impact analysis, and framework-specific queries.

## Build & Test

```bash
npm run build          # TypeScript compilation
npm test               # Vitest (all tests)
npm test -- --run <pattern>  # Run specific test
```

## trace-mcp Tool Routing (for AI agents working ON this codebase)

Since trace-mcp is its own MCP server, when developing it you should use trace-mcp tools to navigate the codebase:

### Decision Matrix

| Task | Tool | Why not native |
|------|------|----------------|
| Find a function/class/method | `search` | Understands symbol kinds, FQNs, language filters |
| Understand a file before editing | `get_outline` | Signatures only, no bodies — cheaper than Read |
| Read one symbol's source | `get_symbol` | Returns only the symbol, not 800 lines |
| What breaks if I change X | `get_change_impact` | Traverses dependency graph, not just text |
| Who calls this / what does it call | `get_call_graph` | Bidirectional, semantic |
| Find all usages of a symbol | `find_usages` | Semantic edges, not grep matches |
| Get context for a task | `get_feature_context` | NL query → relevant symbols + source within token budget |
| Find tests for a symbol | `get_tests_for` | Understands test-to-source mapping |
| Project overview | `get_project_map` (summary_only=true) | Structured: frameworks, languages, counts |

### When to use native tools

- **Read**: non-code files (.md, .json, .yaml, config), or reading a file before Edit
- **Grep**: searching non-code file content, or regex patterns in config files
- **Glob**: finding files by name pattern (e.g., `*.test.ts`)

### Plugin architecture

- Language plugins: `src/indexer/plugins/lang/` — one per language (ts, python, go, etc.)
- Integration plugins: `src/indexer/plugins/integration/` — framework-specific (api/, framework/, orm/, etc.)
- Each plugin implements `LanguagePlugin` or `IntegrationPlugin` interface from `src/plugin-api/types.ts`
- Plugin registry: `src/plugin-api/registry.ts`
