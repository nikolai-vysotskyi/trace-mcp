---
name: trace-mcp
description: Use trace-mcp through bb to search indexed code and recall project decisions with compact context.
---

Use `trace_search` to find symbols before reading whole files. Use `trace_get_symbol` for an exact definition and `trace_get_outline` for file structure. Use `trace_query_decisions` when past project decisions matter. For other capabilities, search the catalog with `trace_tools` and pass the selected tool name and arguments to `trace_call`.

The plugin runs trace-mcp in the bb environment's repository on its host machine. A thread needs an environment with a path. On first use, indexing may take time. Tool results are capped; narrow or page a query when a result says it was shortened.
