import type { AgentExecutionState } from './types.js';

/**
 * Compact Markdown serializer for AgentExecutionState.
 * Designed to provide agents with essential context in minimal tokens.
 */
export function serializeStateCompact(state: AgentExecutionState): string {
  const lines: string[] = [];
  lines.push(`## Task State: ${state.task_id} (v${state.version})`);
  lines.push(`- **Goal**: ${state.goal}`);
  lines.push(`- **Status**: ${state.status}`);

  if (state.plan.steps && state.plan.steps.length > 0) {
    lines.push('- **Plan**:');
    for (const step of state.plan.steps) {
      const mark =
        step.status === 'completed'
          ? '[x]'
          : step.status === 'in_progress'
            ? '[>]'
            : step.status === 'failed'
              ? '[!]'
              : step.status === 'skipped'
                ? '[-]'
                : '[ ]';
      const isActive = step.id === state.plan.active_step_id ? ' *(active)*' : '';
      lines.push(`  ${mark} ${step.id}: ${step.description} (${step.status})${isActive}`);
    }
  } else {
    lines.push('- **Plan**: (none)');
  }

  if (state.next_action) {
    lines.push(`- **Next Action**: ${state.next_action}`);
  }

  if (state.working_context?.modified_files && state.working_context.modified_files.length > 0) {
    lines.push(`- **Modified Files** (${state.working_context.modified_files.length}):`);
    for (const file of state.working_context.modified_files) {
      lines.push(`  - ${file}`);
    }
  }

  if (state.working_context?.diff_summary) {
    lines.push(`- **Diff Summary**: ${state.working_context.diff_summary}`);
  }

  if (state.working_context?.test_targets && state.working_context.test_targets.length > 0) {
    lines.push(`- **Test Targets**: ${state.working_context.test_targets.join(', ')}`);
  }

  if (state.facts?.architecture_notes && state.facts.architecture_notes.length > 0) {
    lines.push('- **Architecture Notes**:');
    for (const note of state.facts.architecture_notes) {
      lines.push(`  - ${note}`);
    }
  }

  if (state.facts?.key_symbols && state.facts.key_symbols.length > 0) {
    lines.push(`- **Key Symbols**: ${state.facts.key_symbols.join(', ')}`);
  }

  if (state.blockers_and_dead_ends?.last_error) {
    lines.push(`- **Last Error**: ${state.blockers_and_dead_ends.last_error}`);
  }

  if (
    state.blockers_and_dead_ends?.dead_ends &&
    state.blockers_and_dead_ends.dead_ends.length > 0
  ) {
    lines.push(`- **Dead Ends** (${state.blockers_and_dead_ends.dead_ends.length}):`);
    for (const deadEnd of state.blockers_and_dead_ends.dead_ends) {
      lines.push(`  - 🛑 ${deadEnd}`);
    }
  }

  return lines.join('\n');
}
