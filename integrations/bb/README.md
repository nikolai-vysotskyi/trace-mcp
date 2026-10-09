# trace-mcp for bb

The bb plugin connects a thread's environment to trace-mcp on that environment's host. It registers compact native agent tools, a **Trace context** side-panel action, and the `bb trace` CLI. The first request fetches the pinned trace-mcp package through npm on the host and may index the repository.

## In bb

Open an existing thread's right panel, choose **Actions → Trace context**, and inspect the repository index, current provider-reported context-window usage, and recent project decisions. Search or record a decision, or reindex the repository. Usage is shown only when the provider reports it; the plugin does not alter provider quotas or claim a measured saving.

Native tools include `trace_search`, `trace_get_symbol`, `trace_get_outline`, `trace_query_decisions`, `trace_remember_decision`, `trace_get_index_health`, and `trace_get_project_memo`. `trace_tools` and `trace_call` expose the remaining MCP tool surface on demand.

## CLI

Run these inside a bb thread or pass `--thread <id>`:

```text
bb trace status --thread <id>
bb trace decisions <query> --thread <id>
bb trace remember --title "Use SQLite" --content "Keep project data local" --type tech_choice --thread <id>
bb trace index --thread <id>
```

Each command accepts `--json`. The host running the environment needs Node.js and npm registry access on first use. The plugin supports bb 0.45.0 and later.
