/**
 * SKILL.state Prompt Templates & System Guidelines for AI Coding Agents.
 *
 * Implements the two-phase loop (Action -> State Patch) based on Google Research (arXiv:2608.26263).
 */

export const STATE_AGENT_SYSTEM_PROMPT = `
# SKILL.state Execution Protocol

You are operating with the trace-mcp State Engine. Instead of relying on quadratic conversation history, you maintain an explicit structured state.

## Two-Phase Execution Loop
On every execution cycle:
1. **Action Phase**: Execute targeted code intelligence queries, edits, or tests (e.g. \`get_symbol\`, \`find_usages\`, \`register_edit\`).
2. **State Patch Phase**: Atomically update your execution state using \`trace_state_patch\` with an RFC 7396 diff:
   - Mark completed steps as \`status: "completed"\`.
   - Update \`active_step_id\` and \`next_action\`.
   - Record modified files in \`working_context.modified_files\`.
   - Record key facts/discoveries in \`facts.architecture_notes\` or \`facts.key_symbols\`.

## Checkpointing and Dead-End Recovery
- Before initiating a risky or speculative refactoring, save a checkpoint:
  \`trace_state_checkpoint(task_id: "...", label: "before-refactor")\`
- If an approach fails, immediately record the dead end and roll back:
  \`trace_state_add_dead_end(task_id: "...", reason: "Approach caused regression in X")\`
  \`trace_state_rollback(task_id: "...", checkpoint: "before-refactor")\`

## Reading State
- Read your state at any time via MCP Resource \`trace://state/{task_id}\` or tool \`trace_state_get\`.
`;

export function generateInitialStatePrompt(taskId: string, goal: string, steps: string[]): string {
  // Every value goes through JSON.stringify: a goal or id carrying a quote must
  // not be able to break out of the call it is being rendered into.
  return `Initialize task state using trace_state_init:
trace_state_init({
  task_id: ${JSON.stringify(taskId)},
  goal: ${JSON.stringify(goal)},
  initial_plan: ${JSON.stringify(steps)}
})`;
}
