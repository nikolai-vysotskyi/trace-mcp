/**
 * Compact Markdown Serializer for Agent Execution State.
 *
 * Converts structured state into a token-optimized Markdown block (~150-250 tokens),
 * which is 35-50% more compact than raw JSON while preserving complete semantic clarity.
 */

import type { AgentExecutionPlan, AgentExecutionState, AgentStep } from './types.js';

function formatStep(step: AgentStep, activeStepId?: string | null): string {
  let mark = ' ';
  let suffix = '';

  if (step.status === 'completed') {
    mark = 'x';
  } else if (step.status === 'in_progress' || step.id === activeStepId) {
    mark = '>';
    suffix = ' *(active)*';
  } else if (step.status === 'failed') {
    mark = '!';
    suffix = ' *(failed)*';
  } else if (step.status === 'skipped') {
    mark = '-';
    suffix = ' *(skipped)*';
  }

  const note = step.notes ? ` — *${step.notes}*` : '';
  return `- [${mark}] ${step.title}${suffix}${note}`;
}

export function serializePlan(plan: AgentExecutionPlan): string {
  if (!plan.steps || plan.steps.length === 0) return '';
  const completed = plan.steps.filter((s) => s.status === 'completed').length;
  const total = plan.steps.length;

  const lines = [`## Plan (${completed}/${total})`];
  for (const step of plan.steps) {
    lines.push(formatStep(step, plan.active_step_id));
  }
  return lines.join('\n');
}

/**
 * Serializes AgentExecutionState to ultra-compact Markdown format.
 * Omits empty sections to conserve prompt tokens.
 */
export function serializeStateToMarkdown(state: AgentExecutionState, version = 1): string {
  const parts: string[] = [];

  // Header & Goal
  parts.push(`# State: ${state.task_id} (v${version} • ${state.status})`);
  parts.push(`**Goal:** ${state.goal}`);
  if (state.next_action) {
    parts.push(`**Next Action:** ${state.next_action}`);
  }

  // Plan
  const planMd = serializePlan(state.plan);
  if (planMd) {
    parts.push(planMd);
  }

  // Working Context
  const wc = state.working_context;
  const wcLines: string[] = [];
  if (wc) {
    if (wc.modified_files && wc.modified_files.length > 0) {
      wcLines.push(`- **Modified:** ${wc.modified_files.map((f) => `\`${f}\``).join(', ')}`);
    }
    if (wc.diff_summary) {
      wcLines.push(`- **Diff:** ${wc.diff_summary}`);
    }
    if (wc.test_targets && wc.test_targets.length > 0) {
      wcLines.push(`- **Tests:** ${wc.test_targets.map((t) => `\`${t}\``).join(', ')}`);
    }
    if (wc.open_questions && wc.open_questions.length > 0) {
      wcLines.push(`- **Open Questions:** ${wc.open_questions.join('; ')}`);
    }
  }
  if (wcLines.length > 0) {
    parts.push(`## Working Context\n${wcLines.join('\n')}`);
  }

  // Facts & Architecture
  const facts = state.facts;
  const factLines: string[] = [];
  if (facts) {
    if (facts.architecture_notes && facts.architecture_notes.length > 0) {
      for (const note of facts.architecture_notes) {
        factLines.push(`- ${note}`);
      }
    }
    if (facts.key_symbols && facts.key_symbols.length > 0) {
      factLines.push(`- **Key Symbols:** ${facts.key_symbols.map((s) => `\`${s}\``).join(', ')}`);
    }
    if (facts.learned_constraints && facts.learned_constraints.length > 0) {
      for (const c of facts.learned_constraints) {
        factLines.push(`- **Constraint:** ${c}`);
      }
    }
  }
  if (factLines.length > 0) {
    parts.push(`## Facts\n${factLines.join('\n')}`);
  }

  // Dead Ends & Blockers
  const b = state.blockers_and_dead_ends;
  const bLines: string[] = [];
  if (b) {
    if (b.last_error) {
      bLines.push(`- **Last Error:** ${b.last_error}`);
    }
    if (b.dead_ends && b.dead_ends.length > 0) {
      for (const de of b.dead_ends) {
        bLines.push(`- **Avoid approach:** "${de.approach}" — *Reason: ${de.reason}*`);
      }
    }
  }
  if (bLines.length > 0) {
    parts.push(`## Dead Ends & Blockers\n${bLines.join('\n')}`);
  }

  return parts.join('\n\n');
}

/**
 * Fast character-based token estimator (~3.8 characters per token for English markdown).
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 3.8);
}
