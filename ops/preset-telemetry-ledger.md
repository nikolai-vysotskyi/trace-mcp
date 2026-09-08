# Role Preset Telemetry & Token Optimization Ledger

Empirical audit of real-world agent tool usage, preset coverage, and token savings across live Multica workspace sessions (TRA-604 / TRA-1194 / TRA-1208 / TRA-1223).

## Context

TRA-601 defined role-tailored tool presets (`review`, `dev`, `security`, `design`, `perf`, `architecture`, `minimal`) to reduce tool schema overhead from ~38k tokens (`full`) down to 5k–12k tokens without starving agents of the tools their roles actually invoke.

On 2026-09-02 (TRA-604), role presets were rolled out to active Multica workspace agents. At the time of rollout, the issue noted:
> *"Реальных данных «до/после» по расходу токенов в живых прогонах по-прежнему нет — конфиги только что применились... Появятся после того, как каждый агент отработает несколько задач."*

This ledger records the first full-scale post-rollout audit covering a week of continuous live operation (2026-09-02 to 2026-09-09).

---

## 1. Live Telemetry Sample

Mined from `~/.trace/sessions/` and `~/.trace/analytics.db`:
- **Pre-rollout Multica sessions** (< 2026-09-02 17:10Z): 669 sessions, 2,548 tool calls.
- **Post-rollout Multica sessions** (>= 2026-09-02 17:10Z): **455 sessions, 7,843 tool calls**.

### Tool Call Distribution (Post-Rollout N = 7,843 calls)

| Tool | Calls | Share (%) | Notes |
|---|---|---|---|
| `search` | 2,251 | 28.7% | In all role presets |
| `get_outline` | 1,227 | 15.6% | In all role presets |
| `search_text` | 1,098 | 14.0% | In all role presets |
| `find_usages` | 545 | 6.9% | Guaranteed via `withLookupFloor` (TRA-1162) |
| `register_edit` | 519 | 6.6% | Core infra in all presets |
| `get_symbol` | 463 | 5.9% | In all role presets |
| `reindex` | 170 | 2.2% | Core edit-refresh cycle |
| `get_index_health` | 133 | 1.7% | Project health inspection |
| `get_project_map` | 132 | 1.7% | Project orientation |
| `get_task_context` | 112 | 1.4% | Context assembly |
| `get_context_bundle` | 101 | 1.3% | Context assembly |
| `get_feature_context` | 100 | 1.3% | Context assembly |
| `get_call_graph` | 98 | 1.2% | Blast radius analysis |
| `get_tests_for` | 94 | 1.2% | Test discovery |
| `get_complexity_report`| 78 | 1.0% | Code quality analysis |
| All other tools | 722 | 9.2% | Tail calls |

**Key Finding on Lookup Floor:**
In TRA-1162, `find_usages` was added to `NAVIGATION_PRIMITIVES` (`withLookupFloor`) across all role presets. The telemetry validates this decision: `find_usages` is the **4th most called tool** (545 calls, 6.9% of all calls). Without `withLookupFloor`, `perf`, `security`, and `architecture` presets would have suffered 545 avoidable `load_tools` escalations.

---

## 2. Empirical Preset Coverage & Schema Savings

Measured against the serialized MCP wire payload (`captureAllTools` + `gpt-tokenizer` o200k) on 455 live Multica sessions:

| Preset | Tools | Wire Tokens | Token Saving vs Full | Empirical Call Coverage | Top Uncovered Calls |
|---|---|---|---|---|---|
| `router` | 10 | 1,606 | **-95.8%** | 0.0% (by design) | Dispatches through `batch` |
| `design` | 21 | 5,142 | **-86.4%** | **83.8%** | `reindex` (170), `get_task_context` (112) |
| `perf` | 35 | 8,409 | **-77.8%** | **86.4%** | `reindex` (170), `get_feature_context` (100) |
| `review` | 32 | 8,679 | **-77.1%** | **90.5%** | `reindex` (170), `get_feature_context` (100) |
| `security` | 36 | 10,045 | **-73.5%** | **87.3%** | `reindex` (170), `get_feature_context` (100) |
| `architecture`| 42 | 10,619 | **-72.0%** | **83.2%** | `reindex` (170), `get_task_context` (112) |
| `dev` | 42 | 11,955 | **-68.4%** | **92.0%** | `get_complexity_report` (78), `get_env_vars` (76) |
| `minimal` | 28 | 7,928 | **-79.1%** | **86.6%** | `reindex` (170), `get_tests_for` (94) |
| `standard` | 55 | 14,984 | **-60.4%** | **97.7%** | `list_projects` (74), `check_claudemd_drift` (73) |
| `full` | 162 | 37,873 | 0.0% | **100.0%** | None |

All active role presets achieve **83%–92% empirical call coverage** while maintaining **68%–86% token reduction** on tool schemas.

---

## 3. Operational Gaps Identified & Fixed

During the continuous audits (TRA-1194, TRA-1208, TRA-1223), inspecting active Multica agent definitions revealed unconfigured agents operating without custom presets:

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

3. **Web Design Agent** (`88dc4060-cece-4f8e-a97a-f6a399e16ab6`):
   - Created for frontend / visual styling and web design (TRA-1208).
   - Had `mcp_config = null`, falling back to `standard` preset.
   - **Remedy applied**: Configured with `design.json` (`trace-mcp serve --preset design`, 21 tools, 5,142 tokens).
   - **Impact**: -9,842 tokens/turn (-65.7% schema cost).

4. **Lead Engineer** (`15108e50-4014-4775-ba10-e6bee6128404`, TRA-1223):
   - Architecture, planning, and code implementation.
   - Had `mcp_config = null`, falling back to `standard` preset.
   - **Remedy applied**: Configured with `dev.json` (`trace-mcp serve --preset dev`, 42 tools, 11,955 tokens).
   - **Impact**: -3,029 tokens/turn (-20.2% schema cost).

5. **TraceMCP Research Analyst** (`87ec5635-c6d5-4806-8aca-f9de408e0e65`, TRA-1223):
   - Research specialist running on `gpt-5.6-sol` (quota-sensitive model family).
   - Analysis of 184 tool calls across 20 issues showed 100% of calls are navigation primitives (`search`, `get_outline`, `get_symbol`, `find_usages`).
   - Had `mcp_config = null`, falling back to `standard` preset.
   - **Remedy applied**: Configured with `minimal.json` (`trace-mcp serve --preset minimal`, 28 tools, 7,928 tokens).
   - **Impact**: -7,056 tokens/turn (-47.1% schema cost) on GPT-5.6-sol.

6. **Growth & Outreach Agent** (`2bcb9706-b715-4703-829c-301b33389bfe`, TRA-1223):
   - Outreach and external ecosystem tracking.
   - Had `mcp_config = null`, falling back to `standard` preset.
   - **Remedy applied**: Configured with `minimal.json` (`trace-mcp serve --preset minimal`, 28 tools, 7,928 tokens).
   - **Impact**: -7,056 tokens/turn (-47.1% schema cost).

### Full Workspace Role Preset Matrix (13 / 13 agents, 100% configured):
- `review` preset (32 tools / 8,679 tokens): Reviewer C, Reviewer B, Code Reviewer
- `dev` preset (42 tools / 11,955 tokens): Implementation Engineer, Lead Engineer
- `security` preset (36 tools / 10,045 tokens): Security Agent
- `design` preset (21 tools / 5,142 tokens): Design/UX Agent, Web Design Agent
- `perf` preset (35 tools / 8,409 tokens): Performance Agent
- `minimal` preset (28 tools / 7,928 tokens): Ops Sweeper, SEO Agent, Growth & Outreach Agent, TraceMCP Research Analyst

Backups and rollout records preserved in `/Users/nikolai/.multica-mcp-backups/README-2026-09-09.md`.

---

## 4. Reproducible Tooling

Added `scripts/multica-audit.ts` to trace-mcp:
- Scans `~/.trace/sessions/` for Multica workspace projects.
- Computes pre/post-rollout session and call counts.
- Evaluates tool frequency, empirical coverage, wire payload sizes, and top missing tools.
- Run anytime: `pnpm exec tsx scripts/multica-audit.ts`.

