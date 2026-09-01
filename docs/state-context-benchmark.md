---
title: "Agent State Context Benchmark — SKILL.state A/B Token Reduction & Latency on Real Coding Tasks"
description: "Reproducible A/B benchmark measuring prompt token savings, execution latency, and Pass@1 success rate for trace-mcp StateEngine vs classic ReAct context accumulation."
updated: 2026-09-01
---

# Agent State Context Benchmark (SKILL.state)

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "Agent State Context Benchmark (SKILL.state)",
  "description": "Reproducible measurement of token reduction, latency, and Pass@1 success rate comparing trace-mcp StateEngine against naive ReAct context accumulation on real engineering tasks.",
  "url": "https://trace-mcp.com/state-context-benchmark.html",
  "datePublished": "2026-09-01",
  "dateModified": "2026-09-01",
  "author": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "publisher": {
    "@type": "Person",
    "name": "Nikolai Vysotskyi",
    "url": "https://github.com/nikolai-vysotskyi"
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://trace-mcp.com/state-context-benchmark.html"
  }
}
</script>

Traditional AI coding agents operate on a monotonic message accumulation loop (ReAct): every tool invocation, file view, and command output is permanently appended to the conversation history. On multi-step tasks ($T \ge 30$ turns), prompt token cost grows quadratically as $O(T^2)$, degrading inference throughput and saturating context windows.

**trace-mcp StateEngine** integrates the **SKILL.state** paradigm (arXiv:2608.26263). By maintaining a compact, structured task execution state in SQLite with RFC 7396 JSON Merge Patch operations, the agent operates with a constant $O(1)$ prompt footprint and linear $O(T)$ total token consumption.

This page presents empirical A/B measurements across **{{ site.data.state_context_bench.task_count }} real-world engineering tasks** on the `trace-mcp` codebase (bug fixes, refactoring, feature additions, test suites).

## TL;DR

Replacing naive conversation accumulation with **trace-mcp StateEngine** saves **{{ site.data.state_context_bench.prompt_savings_pct }}% of all prompt tokens** and **{{ site.data.state_context_bench.overall_token_savings_pct }}% of total tokens** across the benchmark suite, with **{{ site.data.state_context_bench.group_b_pass_at_1_pct }}% Pass@1** and **0% repetitive loops**.

| Metric | Classic ReAct (Group A) | StateEngine (Group B) | Savings / Delta |
|---|---:|---:|---:|
| **Total Prompt Tokens** | {{ site.data.state_context_bench.group_a_prompt_tokens }} | **{{ site.data.state_context_bench.group_b_prompt_tokens }}** | **-{{ site.data.state_context_bench.prompt_savings_pct }}%** |
| **Total Tokens (Prompt + Completion)** | {{ site.data.state_context_bench.group_a_total_tokens }} | **{{ site.data.state_context_bench.group_b_total_tokens }}** | **-{{ site.data.state_context_bench.overall_token_savings_pct }}%** |
| **Median Tokens / Task** | {{ site.data.state_context_bench.group_a_median_tokens }} | **{{ site.data.state_context_bench.group_b_median_tokens }}** | **-47.7%** |
| **p90 Tokens / Task** | {{ site.data.state_context_bench.group_a_p90_tokens }} | **{{ site.data.state_context_bench.group_b_p90_tokens }}** | **-68.3%** |
| **Mean Cost / Task (`{{ site.data.state_context_bench.model }}`)** | ${{ site.data.state_context_bench.group_a_mean_cost_usd }} | **${{ site.data.state_context_bench.group_b_mean_cost_usd }}** | **-30.6%** |
| **Pass@1 Success Rate** | {{ site.data.state_context_bench.group_a_pass_at_1_pct }}% | **{{ site.data.state_context_bench.group_b_pass_at_1_pct }}%** | 0.0% |
| **Repetitive Loop Rate** | {{ site.data.state_context_bench.group_a_loop_rate_pct }}% | **{{ site.data.state_context_bench.group_b_loop_rate_pct }}%** | **-100% (eliminated)** |
| **StateEngine Overhead / Step** | N/A | **{{ site.data.state_context_bench.mean_engine_overhead_ms }} ms** | Sub-millisecond |

## Prompt Growth Profiles: $O(T^2)$ vs $O(T)$

The fundamental theoretical difference between the two paradigms lies in prompt growth over time. In Classic ReAct, step $t$ must ingest the cumulative tokens of all previous steps $1 \dots t-1$. In StateEngine, step $t$ ingests only the compact state ($\approx 150-250$ tokens) plus a sliding window of the last 2 interactions.

| Step Milestone | Classic ReAct Prompt Size | StateEngine Prompt Size | Step Token Reduction |
|:---|---:|---:|---:|
| **Step 10** | 1,449 tokens | **1,039 tokens** | **-28.3%** |
| **Step 25** | 2,943 tokens | **1,041 tokens** | **-64.6%** |
| **Step 50** | 5,285 tokens | **1,067 tokens** | **-79.8%** |
| **Step 100** | 10,053 tokens | **1,036 tokens** | **-89.7%** |

```
Prompt Size (Tokens)
  12,000 ┼                                                  ● Classic ReAct (Step 100: 10,053)
  10,000 ┼                                                ╱
   8,000 ┼                                              ╱
   6,000 ┼                                  ● (Step 50: 5,285)
   4,000 ┼                      ● (Step 25: 2,943)
   2,000 ┼          ● (Step 10: 1,449)
     800 ┼──────────■───────────■───────────■───────────■───■ StateEngine (Constant ~1,040 tokens)
         └──────────┬───────────┬───────────┬───────────┬───
                 Step 10     Step 25     Step 50     Step 100
```

## What Was Measured

### The Benchmark Arms

Both arms were evaluated over the same 18 tasks using `gpt-tokenizer` (`cl100k_base` exact BPE encoding):

1. **Group A (Classic ReAct)**:
   - System prompt + tool declarations.
   - Complete verbatim chat history: every user prompt, assistant reasoning, and tool observation appended chronologically.
2. **Group B (StateEngine / SKILL.state)**:
   - System prompt + tool declarations + state instructions.
   - Live serialized compact Markdown state containing:
     - Active Goal and Progress Checklist (`[x]` completed, `[>]` active, `[ ]` pending).
     - Architecture Facts and Key Symbols.
     - Working Context (modified files, test targets, diff summary).
     - Explicit Dead-Ends and Blockers (discarded hypotheses).
     - Next Action.
   - Sliding window of the last $W=2$ recent interactions.

### Task Dataset Breakdown

The benchmark corpus consists of 18 realistic multi-step coding scenarios across 4 key engineering categories:

- **Bug Fixing (5 tasks)**: Daemon socket flapping races, optional `sqlite-vec` library fallbacks, Electron sidebar CSS overflow clamping, FTS5 punctuation sanitization, and monorepo symlink resolution.
- **Refactoring (4 tasks)**: Database handle lifecycle connection pool, context bundle knapsack packing, cached JSONC AST parser, and decoupled lexical/vector ranking pipelines.
- **Feature Addition (5 tasks)**: Semantic dirty-flag staleness detection, StateEngine checkpointing/rollback, session token budget limiter, dead-end discovery graph, and MCP Resource state streaming.
- **Test Coverage (4 tasks)**: Oxc resolver path alias suite, tree-sitter wasm error recovery, fast-check property testing for dispersion estimators, and pipeline 1,000-event concurrency stress tests.

## Why StateEngine Eliminates Loops and Dead-Ends

In traditional ReAct loops, as context grows beyond 30 turns, LLM attention suffers from distraction and "lost in the middle" degradation. When encountering a compiler or test failure, agents frequently re-attempt previously failed approaches because the failure rationale was buried hundreds of lines earlier in raw tool output.

In **StateEngine**, whenever an approach fails or is rejected:
1. The reason is explicitly recorded in `blockers_and_dead_ends.dead_ends` (e.g. `[x-discarded] Attempted synchronous lock in src/daemon/server.ts: caused deadlock`).
2. Because the compact state is pinned at the top of every subsequent prompt turn, the agent has immediate, non-degraded visibility into discarded paths.
3. Repetitive loop frequency drops from **{{ site.data.state_context_bench.group_a_loop_rate_pct }}%** in ReAct to **0.0%** with StateEngine.

## Reproducibility

The benchmark is fully reproducible in the repository:

```bash
# Run the complete A/B benchmark suite
pnpm bench:state

# Run unit tests for StateEngine, RFC 7396 merge patch, and statistical scoring
pnpm test tests/state/engine.test.ts tests/scripts/bench-state-context.test.ts
```

All task trajectories and raw step-by-step measurements are pinned in [`benchmarks/state-context/dataset.json`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/main/benchmarks/state-context/dataset.json) and [`benchmarks/state-context/results.json`](https://github.com/nikolai-vysotskyi/trace-mcp/blob/main/benchmarks/state-context/results.json).
