/**
 * SKILL.state Prompt Templates & System Guidelines for AI Coding Agents.
 *
 * Implements the two-phase loop (Action -> State Patch) based on Google Research (arXiv:2608.26263).
 */

export const STATE_AGENT_SYSTEM_PROMPT = `
# SKILL.state Execution Protocol

You are operating with the trace-mcp State Engine. Instead of relying on quadratic conversation history, you maintain an explicit structured state.

## How to call the state tools
The \`trace_state_*\` tools are **not advertised by the default preset** (\`minimal\`), so
\`tools/list\` will usually not contain them. Do not call them directly unless you can see
them listed. Call them through \`batch\`, which is on every preset and dispatches any
registered tool by name:
\`batch({ calls: [{ tool: "trace_state_patch", args: { ... } }] })\`
Every \`trace_state_*\` call below is written that way for that reason.

## Two-Phase Execution Loop
On every execution cycle:
1. **Action Phase**: Execute targeted code intelligence queries, edits, or tests (e.g. \`get_symbol\`, \`find_usages\`, \`register_edit\`).
2. **State Patch Phase**: Atomically update your execution state with an RFC 7396 diff:
   \`batch({ calls: [{ tool: "trace_state_patch", args: { task_id: "...", patch: { ... } } }] })\`
   - Mark completed steps as \`status: "completed"\`.
   - Update \`active_step_id\` and \`next_action\`.
   - Record modified files in \`working_context.modified_files\`.
   - Record key facts/discoveries in \`facts.architecture_notes\` or \`facts.key_symbols\`.

## Checkpointing and Dead-End Recovery
- Before initiating a risky or speculative refactoring, save a checkpoint:
  \`batch({ calls: [{ tool: "trace_state_checkpoint", args: { task_id: "...", label: "before-refactor" } }] })\`
- If an approach fails, immediately record the dead end and roll back:
  \`batch({ calls: [{ tool: "trace_state_add_dead_end", args: { task_id: "...", reason: "Approach caused regression in X" } }] })\`
  \`batch({ calls: [{ tool: "trace_state_rollback", args: { task_id: "...", checkpoint: "before-refactor" } }] })\`

## Reading State
- Read your state at any time via MCP Resource \`trace://state/{task_id}\` or
  \`batch({ calls: [{ tool: "trace_state_get", args: { task_id: "..." } }] })\`.
`;

export function generateInitialStatePrompt(taskId: string, goal: string, steps: string[]): string {
  // Routed through `batch` for the same reason the protocol above is: on the
  // default preset `trace_state_init` is not in `tools/list`, so a prompt that
  // named it directly would ask the agent to call a tool it cannot see.
  //
  // Every value goes through JSON.stringify: a goal or id carrying a quote must
  // not be able to break out of the call it is being rendered into.
  return `Initialize task state:
batch({
  calls: [
    {
      tool: "trace_state_init",
      args: {
        task_id: ${JSON.stringify(taskId)},
        goal: ${JSON.stringify(goal)},
        initial_plan: ${JSON.stringify(steps)}
      }
    }
  ]
})`;
}
