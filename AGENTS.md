<!-- trace-mcp:start -->
## trace Tool Routing

IMPORTANT: For ANY code exploration task, ALWAYS use trace tools first. NEVER use Read/Grep/Glob/Bash(ls,find) for navigating source code.

| Task | trace tool | Instead of |
|------|---------------|------------|
| Find a function/class/method | `search` | Grep |
| Understand a file before editing | `get_outline` | Read (full file) |
| Read one symbol's source | `get_symbol` | Read (full file) |
| What breaks if I change X | `get_change_impact` | guessing |
| All usages of a symbol | `find_usages` | Grep |
| All implementations of an interface | `get_implementations` | ls/find on directories |
| All classes implementing X | `search` with `implements` filter | Grep |
| Project health / coverage gaps | `self_audit` | manual inspection |
| Dead code / dead exports | `get_dead_code` (`mode: "exports_only"`) | Grep for unused |
| Context for a task | `get_feature_context` | reading 15 files |
| Tests for a symbol | `get_tests_for` | Glob + Grep |
| Untested symbols (deep) | `get_untested_symbols` (deferred — load via `load_tools`) | manual audit |
| HTTP request flow | `get_request_flow` (framework-gated) | reading route files |
| DB model relationships | `get_model_context` (framework-gated) | reading model + migrations |
| Component tree | `get_component_tree` (framework-gated) | reading component files |
| Circular dependencies | `get_circular_imports` | manual tracing |

Use Read/Grep/Glob ONLY for non-code files (.md, .json, .yaml, config) or before Edit.
Start sessions with `get_project_map` (summary_only=true).
<!-- trace-mcp:end -->
