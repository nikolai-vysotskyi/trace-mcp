# Role Preset Telemetry & Token Optimization Ledger

Empirical audit of real-world agent tool usage, preset coverage, and token savings across live Multica workspace sessions (TRA-604 / TRA-1194 / TRA-1208 / TRA-1223 / TRA-1356).

## Context

TRA-601 defined role-tailored tool presets (`review`, `dev`, `security`, `design`, `perf`, `architecture`, `minimal`) to reduce tool schema overhead from ~38k tokens (`full`) down to 5k–12k tokens without starving agents of the tools their roles actually invoke.

On 2026-09-02 (TRA-604), role presets were rolled out to active Multica workspace agents. At the time of rollout, the issue noted:
> *"Реальных данных «до/после» по расходу токенов в живых прогонах по-прежнему нет — конфиги только что применились... Появятся после того, как каждый агент отработает несколько задач."*

This ledger records continuous post-rollout audits covering over a week of live operation across 13 agents (2026-09-02 to 2026-09-11, v3.25.0).

---

## 1. Live Telemetry Sample

Mined from `~/.trace/sessions/`, `~/.trace/savings.json`, and `~/.trace/analytics.db`:
- **Pre-rollout Multica sessions** (< 2026-09-02 17:10Z): 1,935 sessions, 71,831 tool calls across all tools.
- **Post-rollout Multica sessions** (>= 2026-09-02 17:10Z in `analytics.db`): **470 sessions, 37,574 total tool calls**, including **1,295 trace-mcp calls** across 146 active sessions.
- **Maintainer store (`savings.json`)**: 29,388 calls across 2,667 sessions through 2026-09-11.

### Multica Tool Call Distribution (Post-Rollout in `analytics.db`, N = 1,295 calls)

| Tool | Calls | Share (%) | Notes |
|---|---|---|---|
| `search` | 304 | 23.5% | In all role presets |
| `get_outline` | 212 | 16.4% | In all role presets |
| `get_symbol` | 208 | 16.1% | In all role presets |
| `register_edit` | 162 | 12.5% | Core edit loop in all presets |
| `batch` | 154 | 11.9% | Round-trip request collapsing in all presets |
| `find_usages` | 56 | 4.3% | Guaranteed via `withLookupFloor` (TRA-1162) |
| `search_text` | 41 | 3.2% | In all role presets |
| `get_index_health` | 36 | 2.8% | Health check across presets |
| `get_project_map` | 20 | 1.5% | Orientation in all presets |
| `load_tools` | 20 | 1.5% | Escalation path (only 1.5% of calls!) |
| `get_untested_symbols` | 14 | 1.1% | Reviewer symbol inspection |
| `get_context_bundle` | 13 | 1.0% | Context assembly |
| `reindex` | 10 | 0.8% | Incremental refresh |
| `get_tests_for` | 10 | 0.8% | Test discovery |
| `get_feature_context` | 9 | 0.7% | Feature context |
| `get_task_context` | 5 | 0.4% | Task context |
| `apply_codemod` | 4 | 0.3% | Refactoring automation |
| `get_call_graph` | 4 | 0.3% | Blast radius analysis |
| `check_quality_gates` | 3 | 0.2% | Pre-merge verification |
| Tail calls (`self_audit`, `scan_code_smells`, etc.) | 9 | 0.7% | Progressive disclosure via `load_tools` |

**Key Finding on Lookup Floor & Direct Resolution:**
- `find_usages` is the 6th most called tool (56 calls in Multica sessions, 984 in savings.json). Including it in `NAVIGATION_PRIMITIVES` (`withLookupFloor`) across all role presets prevented dozens of unnecessary tool escalations.
- `load_tools` was called only 20 times out of 1,295 calls (**1.5% escalation rate**). 98.5% of agent tool calls were satisfied directly by their active role preset!

---

## 2. Empirical Preset Coverage & Schema Savings (v3.25.0)

Measured against the serialized MCP wire payload (`captureAllTools` + `gpt-tokenizer` o200k) updated for `get_diagnostics` (TRA-1222):

| Preset | Tools | Wire Tokens | Token Saving vs Full | Empirical Multica DB Coverage | Overall Call Coverage (`savings.json`) |
|---|---|---|---|---|---|
| `router` | 10 | 1,606 | **-95.8%** | 13.8% | 0.0% (dispatches through `batch`) |
| `state` | 20 | 3,743 | **-90.2%** | 65.9% | 39.1% |
| `design` | 21 | 5,142 | **-86.5%** | **95.8%** | **91.4%** |
| `perf` | 35 | 8,409 | **-77.9%** | **95.9%** | **92.3%** |
| `minimal` | 29 | 8,125 | **-78.7%** | **96.5%** | **92.3%** |
| `review` | 33 | 8,876 | **-76.7%** | **97.9%** | **94.2%** |
| `security` | 36 | 10,045 | **-73.6%** | **96.1%** | **92.7%** |
| `architecture`| 42 | 10,619 | **-72.1%** | **94.3%** | **91.4%** |
| `dev` | 43 | 12,152 | **-68.1%** | **98.6%** | **95.8%** |
| `standard` | 56 | 15,181 | **-60.1%** | **98.8%** | **98.3%** |
| `full` | 163 | 38,070 | 0.0% | **100.0%** | **100.0%** |

All active role presets achieve **94.3%–98.6% empirical call coverage** in Multica agent runs while maintaining **68.1%–86.5% token reduction** on tool schemas.

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

### Full Workspace Role Preset Matrix (13 / 13 agents, 100% configured, v3.25.0):
- `review` preset (33 tools / 8,876 tokens): Reviewer C, Reviewer B, Code Reviewer
- `dev` preset (43 tools / 12,152 tokens): Implementation Engineer, Lead Engineer
- `security` preset (36 tools / 10,045 tokens): Security Agent
- `design` preset (21 tools / 5,142 tokens): Design/UX Agent, Web Design Agent
- `perf` preset (35 tools / 8,409 tokens): Performance Agent
- `minimal` preset (29 tools / 8,125 tokens): Ops Sweeper, SEO Agent, Growth & Outreach Agent, TraceMCP Research Analyst

### Fleet Verification Audit (2026-09-11, TRA-1356):
- **Fleet status**: 13 of 13 agents actively configured with custom presets via `--mcp-config-file`.
- **Direct resolution**: 98.5% of tool calls in Multica sessions resolved directly by active presets without escalation.
- **Escalations**: 20 `load_tools` calls out of 1,295 total calls (1.5%), with 0 blocking errors.
- **Net schema reduction**: ~25k to ~33k schema tokens saved per agent turn across all runs.

Backups and rollout records preserved in `/Users/nikolai/.multica-mcp-backups/README-2026-09-09.md`.

---

## 4. Reproducible Tooling

Maintained `scripts/multica-audit.ts` in trace-mcp:
- Scans `~/.trace/sessions/` for Multica workspace projects.
- Ingests and analyzes live `~/.trace/analytics.db` telemetry across Multica sessions.
- Evaluates tool frequency, empirical coverage, wire payload sizes, model distributions, and missing tools.
- Run anytime: `pnpm exec tsx scripts/multica-audit.ts`.

