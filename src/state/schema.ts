/**
 * Zod validation schemas for SKILL.state AgentExecutionState.
 */

import { z } from 'zod';

export const AgentStepStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'skipped',
]);

export const AgentStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: AgentStepStatusSchema.default('pending'),
  notes: z.string().optional(),
});

export const AgentExecutionPlanSchema = z.object({
  steps: z.array(AgentStepSchema).default([]),
  active_step_id: z.string().nullable().optional(),
});

export const AgentFactsSchema = z
  .object({
    architecture_notes: z.array(z.string()).default([]),
    key_symbols: z.array(z.string()).default([]),
    learned_constraints: z.array(z.string()).default([]),
  })
  .passthrough();

export const AgentWorkingContextSchema = z
  .object({
    modified_files: z.array(z.string()).default([]),
    diff_summary: z.string().optional(),
    test_targets: z.array(z.string()).default([]),
    open_questions: z.array(z.string()).default([]),
  })
  .passthrough();

export const AgentDeadEndSchema = z.object({
  approach: z.string().min(1),
  reason: z.string().min(1),
  timestamp: z.string().optional(),
});

export const AgentBlockersAndDeadEndsSchema = z.object({
  last_error: z.string().nullable().optional(),
  dead_ends: z.array(AgentDeadEndSchema).default([]),
});

export const AgentExecutionStatusSchema = z.enum([
  'in_progress',
  'completed',
  'failed',
  'blocked',
  'paused',
]);

export const AgentExecutionStateSchema = z.object({
  task_id: z.string().min(1),
  goal: z.string().min(1),
  status: AgentExecutionStatusSchema.default('in_progress'),
  plan: AgentExecutionPlanSchema.default(() => AgentExecutionPlanSchema.parse({})),
  facts: AgentFactsSchema.default(() => AgentFactsSchema.parse({})),
  working_context: AgentWorkingContextSchema.default(() => AgentWorkingContextSchema.parse({})),
  blockers_and_dead_ends: AgentBlockersAndDeadEndsSchema.default(() =>
    AgentBlockersAndDeadEndsSchema.parse({}),
  ),
  next_action: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AgentExecutionStateInput = z.input<typeof AgentExecutionStateSchema>;
