---
name: trace-mcp
description: Use trace-mcp through bb to search indexed code and recall project decisions with compact context.
---

Use `trace_get_index_health` to check the index, then `trace_search` to find symbols before reading whole files. Use `trace_get_symbol` for an exact definition and `trace_get_outline` for file structure. Use `trace_get_project_memo` at the start of a task when prior decisions matter, `trace_query_decisions` for a focused recall query, and `trace_remember_decision` to record an explicit English-language decision with the current bb thread as its session ID. Automatic decision capture rejects non-English text; for a manually entered decision in another language use the panel or `bb trace remember`. For other capabilities, search the catalog with `trace_tools` and pass the selected tool name and arguments to `trace_call`.

The thread's **Trace context** panel shows index health, saved decisions, and the provider's context-window usage. The same data and explicit writes are available through `bb trace status`, `bb trace decisions`, `bb trace remember`, and `bb trace index`; pass `--thread <id>` outside a bb thread.

The plugin runs trace-mcp in the bb environment's repository on its host machine. A thread needs an environment with a path. On first use, indexing may take time. Tool results are capped; narrow or page a query when a result says it was shortened.
