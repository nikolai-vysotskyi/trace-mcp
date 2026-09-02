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
1. **Compact State Block** (~150–250 tokens in Markdown format).
2. **Sliding Window** of the last 1–2 tool interactions (~1,000 tokens).

$$\text{Tokens}_{\text{StateEngine}} = \sum_{t=1}^T \left( C_0 + |S(t)| + W \right) = \mathcal{O}(T)$$

This delivers **60% to 88% prompt token reductions** on long-horizon agent tasks while increasing Pass@1 rates through explicit dead-end avoidance and atomic checkpoints.

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
