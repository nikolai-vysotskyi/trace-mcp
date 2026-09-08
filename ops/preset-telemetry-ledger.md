# Role Preset Telemetry & Token Optimization Ledger

Empirical audit of real-world agent tool usage, preset coverage, and token savings across live Multica workspace sessions (TRA-604 / TRA-1194).

## Context

TRA-601 defined role-tailored tool presets (`review`, `dev`, `security`, `design`, `perf`, `architecture`, `minimal`) to reduce tool schema overhead from ~38k tokens (`full`) down to 5k–12k tokens without starving agents of the tools their roles actually invoke.

On 2026-09-02 (TRA-604), role presets were rolled out to active Multica workspace agents. At the time of rollout, the issue noted:
> *"Реальных данных «до/после» по расходу токенов в живых прогонах по-прежнему нет — конфиги только что применились... Появятся после того, как каждый агент отработает несколько задач."*

This ledger records the first full-scale post-rollout audit covering a week of continuous live operation (2026-09-02 to 2026-09-08).

---

## 1. Live Telemetry Sample

Mined from `~/.trace/sessions/` and `~/.trace/analytics.db`:
- **Pre-rollout Multica sessions** (< 2026-09-02 17:10Z): 669 sessions, 2,548 tool calls.
- **Post-rollout Multica sessions** (>= 2026-09-02 17:10Z): **448 sessions, 7,143 tool calls**.

### Tool Call Distribution (Post-Rollout N = 7,143 calls)

| Tool | Calls | Share (%) | Notes |
|---|---|---|---|
| `search` | 2,053 | 28.7% | In all role presets |
| `get_outline` | 1,135 | 15.9% | In all role presets |
| `search_text` | 978 | 13.7% | In all role presets |
| `find_usages` | 472 | 6.6% | Guaranteed via `withLookupFloor` (TRA-1162) |
| `get_symbol` | 457 | 6.4% | In all role presets |
| `register_edit` | 429 | 6.0% | Core infra in all presets |
| `reindex` | 158 | 2.2% | Core edit-refresh cycle |
| `get_index_health` | 127 | 1.8% | Project health inspection |
| `get_project_map` | 126 | 1.8% | Project orientation |
| `get_task_context` | 106 | 1.5% | Context assembly |
| `get_context_bundle` | 95 | 1.3% | Context assembly |
| `get_feature_context` | 94 | 1.3% | Context assembly |
| `get_call_graph` | 92 | 1.3% | Blast radius analysis |
| `get_tests_for` | 88 | 1.2% | Test discovery |
| `get_complexity_report`| 72 | 1.0% | Code quality analysis |
| All other tools | 674 | 9.4% | Tail calls |

**Key Finding on Lookup Floor:**
In TRA-1162, `find_usages` was added to `NAVIGATION_PRIMITIVES` (`withLookupFloor`) across all role presets. The telemetry validates this decision: `find_usages` is the **4th most called tool** (472 calls, 6.6% of all calls). Without `withLookupFloor`, `perf`, `security`, and `architecture` presets would have suffered 472 avoidable `load_tools` escalations.

---

## 2. Empirical Preset Coverage & Schema Savings

Measured against the serialized MCP wire payload (`captureAllTools` + `gpt-tokenizer` o200k) on 448 live Multica sessions:

| Preset | Tools | Wire Tokens | Token Saving vs Full | Empirical Call Coverage | Top Uncovered Calls |
|---|---|---|---|---|---|
| `router` | 10 | 1,606 | **-95.8%** | 0.0% (by design) | Dispatches through `batch` |
| `design` | 21 | 5,142 | **-86.4%** | **83.5%** | `reindex` (158), `get_task_context` (106) |
| `perf` | 35 | 8,409 | **-77.8%** | **86.3%** | `reindex` (158), `get_feature_context` (94) |
| `review` | 32 | 8,679 | **-77.1%** | **90.4%** | `reindex` (158), `get_feature_context` (94) |
| `security` | 36 | 10,045 | **-73.5%** | **87.1%** | `reindex` (158), `get_feature_context` (94) |
| `architecture`| 42 | 10,619 | **-71.9%** | **82.9%** | `reindex` (158), `get_task_context` (106) |
| `dev` | 42 | 11,955 | **-68.4%** | **91.9%** | `get_complexity_report` (72), `get_env_vars` (70) |
| `minimal` | 28 | 7,928 | **-79.1%** | **86.4%** | `reindex` (158), `get_tests_for` (88) |
| `standard` | 55 | 14,984 | **-60.4%** | **97.7%** | `list_projects` (68), `check_claudemd_drift` (67) |
| `full` | 162 | 37,853 | 0.0% | **100.0%** | None |

All active role presets achieve **83%–92% empirical call coverage** while maintaining **68%–86% token reduction** on tool schemas.

---

## 3. Operational Gaps Identified & Fixed

During the audit, inspecting active Multica agent definitions revealed two unconfigured agents created on 2026-09-06 (after TRA-604 rollout):

1. **Reviewer C** (`5108ae67-fc2a-4bbf-b1b7-5899952721a9`):
   - Created on 2026-09-06 as the primary reviewer for routine diffs.
   - Had `mcp_config = null`, falling back to machine-wide `standard` preset (55 tools, 14,984 tokens).
   - Ran 98 tasks burning an extra **6,305 schema tokens per turn**.
   - **Remedy applied**: Configured with `review.json` (`trace-mcp serve --preset review`, 32 tools, 8,679 tokens).
   - **Impact**: -6,305 tokens/turn (-42.1% schema cost).

2. **Ops Sweeper** (`2f9825c0-8b35-4f80-a2e9-5b46a208c673`):
   - Created on 2026-09-06 for mechanical sweeps (PR checks, digests, dependency bumps).
   - Had `mcp_config = null`, falling back to `standard` preset.
   - **Remedy applied**: Configured with `minimal.json` (`trace-mcp serve --preset minimal`, 28 tools, 7,928 tokens).
   - **Impact**: -7,056 tokens/turn (-47.1% schema cost).

Backups and rollout records preserved in `/Users/nikolai/.multica-mcp-backups/README-2026-09-08.md`.

---

## 4. Reproducible Tooling

Added `scripts/multica-audit.ts` to trace-mcp:
- Scans `~/.trace/sessions/` for Multica workspace projects.
- Computes pre/post-rollout session and call counts.
- Evaluates tool frequency, empirical coverage, wire payload sizes, and top missing tools.
- Run anytime: `pnpm exec tsx scripts/multica-audit.ts`.
