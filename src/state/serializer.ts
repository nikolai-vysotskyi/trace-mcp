import type { AgentExecutionState } from './types.js';

/**
 * Serializes an AgentExecutionState into a compact, token-dense Markdown format.
 *
 * Designed to fit a typical task state in ~150-250 tokens (35-50% savings over raw JSON),
 * keeping prompt overhead constant O(1) across hundreds of steps.
 */
export function serializeStateToMarkdown(state: AgentExecutionState): string {
  const parts: string[] = [];

  // 1. Header: Goal, Status, Version
  parts.push(`## Task State: ${state.goal} [status: ${state.status}, rev: ${state.version}]`);

  // 2. Plan Checklist
  if (state.plan?.steps && state.plan.steps.length > 0) {
    parts.push('### Plan:');
    for (const step of state.plan.steps) {
      let mark = '[ ]';
      if (step.status === 'completed') mark = '[x]';
      else if (step.status === 'in_progress' || step.id === state.plan.active_step_id) mark = '[>]';
      else if (step.status === 'failed') mark = '[!]';
      else if (step.status === 'skipped') mark = '[-]';

      const notes = step.notes ? ` (${step.notes})` : '';
      parts.push(`${mark} ${step.id}: ${step.title}${notes}`);
    }
  }

  // 3. Facts & Architecture Notes
  const hasNotes = state.facts?.architecture_notes && state.facts.architecture_notes.length > 0;
  const hasSymbols = state.facts?.key_symbols && state.facts.key_symbols.length > 0;
  if (hasNotes || hasSymbols) {
    parts.push('### Facts:');
    if (hasSymbols) {
      parts.push(`- Symbols: ${state.facts.key_symbols.join(', ')}`);
    }
    if (hasNotes) {
      for (const note of state.facts.architecture_notes) {
        parts.push(`- ${note}`);
      }
    }
  }

  // 4. Working Context (Modified Files, Diff Summary, Test Targets)
  const hasFiles =
    state.working_context?.modified_files && state.working_context.modified_files.length > 0;
  const hasTests =
    state.working_context?.test_targets && state.working_context.test_targets.length > 0;
  const hasDiff = Boolean(state.working_context?.diff_summary);

  if (hasFiles || hasTests || hasDiff) {
    parts.push('### Context:');
    if (hasFiles) parts.push(`- Files: ${state.working_context.modified_files.join(', ')}`);
    if (hasDiff) parts.push(`- Diff: ${state.working_context.diff_summary}`);
    if (hasTests) parts.push(`- Tests: ${state.working_context.test_targets.join(', ')}`);
  }

  // 5. Blockers & Dead Ends (Critical for preventing repetitive loops)
  const hasError = Boolean(state.blockers_and_dead_ends?.last_error);
  const deadEnds = state.blockers_and_dead_ends?.dead_ends ?? [];
  if (hasError || deadEnds.length > 0) {
    parts.push('### Dead Ends & Blockers:');
    if (hasError) {
      parts.push(`- Last Error: ${state.blockers_and_dead_ends.last_error}`);
    }
    for (const deadEnd of deadEnds) {
      parts.push(`- [x-discarded] ${deadEnd}`);
    }
  }

  // 6. Next Action
  if (state.next_action) {
    parts.push(`### Next Action:\n${state.next_action}`);
  }

  return parts.join('\n');
}

/**
 * Returns formatted representation according to format flag ('json' or 'compact').
 */
export function formatState(
  state: AgentExecutionState,
  format: 'json' | 'compact' = 'compact',
): string {
  if (format === 'json') {
    return JSON.stringify(state, null, 2);
  }
  return serializeStateToMarkdown(state);
}
