---
layout: default
title: "SKILL.state: Linear Context Architecture"
description: "State Engine in trace-mcp for O(T) linear token consumption based on Google Research (arXiv:2608.26263)."
noindex: true
---

# SKILL.state: Linear Context Architecture (arXiv:2608.26263)

`trace-mcp` includes a built-in **State Engine** implementing the `SKILL.state` paradigm (Google Research).

## The Problem: Quadratic O(T²) Context Explosion

In traditional ReAct agent architectures, the entire conversational transcript (every tool call, parameter block, and verbose tool output) accumulates in the model's context window. Over $T$ steps, cumulative prompt tokens grow quadratically:

$$\text{Tokens}_{\text{traditional}} = \sum_{t=1}^T \left( C_0 + \sum_{i=1}^t L_i \right) = \mathcal{O}(T^2)$$

For a 50-step coding workflow, an agent routinely spends **250,000+ prompt tokens** on redundant history.

## The Solution: Linear O(T) State Engine

With `SKILL.state`, the agent maintains an explicit, structured execution state in SQLite. Context is bounded to:
1. **Compact State Block** — replayed across 30 real agent sessions, the state
   block a turn actually carries averages **343 tokens**, above the ~150–250 the
   design assumed. Plans and modified-file lists on real tasks are longer than the
   examples they were sized against.
2. **Sliding Window** of the last 1–2 tool interactions (~1,000 tokens).

$$\text{Tokens}_{\text{StateEngine}} = \sum_{t=1}^T \left( C_0 + |S(t)| + W \right) = \mathcal{O}(T)$$

## What is actually measured

`pnpm bench:state-replay` replays local Claude Code session logs: the ReAct arm is
the prompt size the provider really billed each turn, and the state block is
rebuilt turn by turn from what the session had done *so far* (its TodoWrite plan,
the files it had edited, the symbols it had looked up) and sized with the shipped
serializer. Nothing a turn could not yet know is charged to it.

On 30 real sessions (median 251 turns, window = 2):

| Metric | Median |
|---|---|
| State block carried per turn | 343 tokens |
| Raw prompt-token reduction | **74.0%** |
| Reduction priced with prompt caching | **67.3%** |

Two results matter more than the headline:

- **Prompt caching eats part of the win.** ReAct's history is append-only and
  therefore almost entirely cache reads at 0.1x. A sliding window rewrites its tail
  every turn at 1.25x. Both arms are priced with the same multipliers on their
  observed ordinary / cache-write / cache-read components; raw token counts still
  overstate the saving by about 7 points at the median.
- **The win is not uniform, and short sessions can lose.** The one sub-30-turn
  session in the set (15 turns) came out at 5% raw and **−7.2%** billed. That is a
  single observation: it shows the sign can flip on short tasks, and does not
  locate the crossover. Sizing that threshold needs a stratified short-session
  sample this set does not contain.

`src/eval/state-benchmark.ts` remains a closed-form model whose output is a
restatement of its constants; the replay harness is the number to quote. Neither
measures task success — we have no Pass@1 evidence, only prompt cost.

---

## MCP Tools Suite

| Tool | Purpose |
|------|---------|
| `trace_state_init` | Initialize a new task state with goal & initial plan steps |
| `trace_state_patch` | Apply an atomic RFC 7396 JSON Merge Patch to update state |
| `trace_state_get` | Retrieve state as compact Markdown (~150 tokens) or JSON |
| `trace_state_checkpoint` | Create a named snapshot checkpoint for rollback |
| `trace_state_rollback` | Restore state to a saved checkpoint |
| `trace_state_add_dead_end` | Fast shortcut to record failed approaches and prevent repetition |
| `trace_state_list` | List active task states in storage |

---

## MCP Resource: `trace://state/{task_id}`

Clients subscribing to MCP resources receive live updates whenever `trace_state_patch` or `trace_state_rollback` mutates a task state.

---

## Agent Two-Phase Loop Recipe

```typescript
// 1. Initialize task at kickoff
await mcp.callTool('trace_state_init', {
  task_id: 'TRA-596',
  goal: 'Implement feature X',
  initial_plan: ['Step 1: Inspect symbols', 'Step 2: Edit file', 'Step 3: Test'],
});

// 2. Perform actions and patch state at each milestone
await mcp.callTool('trace_state_patch', {
  task_id: 'TRA-596',
  patch: {
    plan: {
      steps: [
        { id: 'step_1', title: 'Step 1: Inspect symbols', status: 'completed' },
        { id: 'step_2', title: 'Step 2: Edit file', status: 'in_progress' },
      ],
      active_step_id: 'step_2',
    },
    working_context: {
      modified_files: ['src/feature.ts'],
    },
    next_action: 'Run test suite',
  },
});

// 3. Checkpoint before risky operations
await mcp.callTool('trace_state_checkpoint', {
  task_id: 'TRA-596',
  label: 'before-major-refactor',
});

// 4. Recover if an approach hits a dead end
await mcp.callTool('trace_state_add_dead_end', {
  task_id: 'TRA-596',
  reason: 'Approach caused memory leak in Node parser',
  approach: 'In-memory AST cache',
});
await mcp.callTool('trace_state_rollback', {
  task_id: 'TRA-596',
  checkpoint: 'before-major-refactor',
});
```
