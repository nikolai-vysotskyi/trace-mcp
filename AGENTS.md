<!-- trace:start -->
## trace Tool Routing

IMPORTANT: For ANY code exploration task, ALWAYS use trace tools first. NEVER use host file-reading, grep, glob, or shell (ls, find) tools for navigating source code.

| Task | trace tool | Instead of |
|------|------------|------------|
| Find a function/class/method | `search` | text grep |
| Understand a file before editing | `get_outline` | full-file read |
| Read one symbol's source | `get_symbol` | full-file read |
| What breaks if I change X | `get_change_impact` | guessing |
| All usages of a symbol | `find_usages` | text grep |
| All implementations of an interface | `get_implementations` | directory search (ls/find) |
| All classes implementing X | `search` with `implements` filter | text grep |
| Project health / coverage gaps | `self_audit` | manual inspection |
| Dead code / dead exports | `get_dead_code` (`mode: "exports_only"`) | text grep for unused |
| Context for a task | `get_feature_context` | reading 15 files |
| Tests for a symbol | `get_tests_for` | glob + grep |
| Untested symbols (deep) | `get_untested_symbols` (deferred — load via `load_tools`) | manual audit |
| HTTP request flow | `get_request_flow` (framework-gated) | reading route files |
| DB model relationships | `get_model_context` (framework-gated) | reading model + migrations |
| Component tree | `get_component_tree` (framework-gated) | reading component files |
| Circular dependencies | `get_circular_imports` | manual tracing |
| Task spanning many turns | `trace_state_init` once, then `trace_state_patch` / `trace_state_add_dead_end` per step, `trace_state_get` to re-read (deferred — `load_tools({preset:"state"})`) | re-reading the whole transcript every turn |

Use host file-reading and grep tools ONLY for non-code files (.md, .json, .yaml, config) or before edit.
Start sessions with `get_project_map` (summary_only=true).
<!-- trace:end -->
