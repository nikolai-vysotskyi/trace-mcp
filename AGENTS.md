<!-- trace-mcp:start -->
## trace-mcp Tool Routing

IMPORTANT: For ANY code exploration task, ALWAYS use trace-mcp tools first. NEVER use Read/Grep/Glob/Bash(ls,find) for navigating source code.

| Task | trace-mcp tool | Instead of |
|------|---------------|------------|
| Find a function/class/method | `search` | Grep |
| Understand a file before editing | `get_outline` | Read (full file) |
| Read one symbol's source | `get_symbol` | Read (full file) |
| What breaks if I change X | `get_change_impact` | guessing |
| All usages of a symbol | `find_usages` | Grep |
| All implementations of an interface | `get_type_hierarchy` | ls/find on directories |
| All classes implementing X | `search` with `implements` filter | Grep |
| Project health / coverage gaps | `self_audit` | manual inspection |
| Dead code / dead exports | `get_dead_code` / `get_dead_exports` | Grep for unused |
| Context for a task | `get_feature_context` | reading 15 files |
| Tests for a symbol | `get_tests_for` | Glob + Grep |
| Untested symbols (deep) | `get_untested_symbols` (classifies "unreached" vs "imported_not_called") | manual audit |
| Circular dependencies | `get_circular_imports` | manual tracing |

Use Read/Grep/Glob ONLY for non-code files (.md, .json, .yaml, config) or before Edit.
Start sessions with `get_project_map` (summary_only=true).

### Not yet implemented (planned / roadmap only — do not call these)

The following tool names have appeared in earlier drafts of this guidance but are **not registered** in this project (confirmed via `get_plugin_registry` / tool search). Do not call them; fall back to reading route/model/component files directly until they land:

| Planned capability | Planned tool name | Current fallback |
|------|---------------|------------|
| HTTP request flow | `get_request_flow` (not implemented) | reading route files |
| DB model relationships | `get_model_context` (not implemented) | reading model + migrations |
| Component tree | `get_component_tree` (not implemented) | reading component files |
<!-- trace-mcp:end -->
