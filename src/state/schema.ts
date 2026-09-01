import { z } from 'zod';

export const AgentStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'blocked',
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const PlanStepStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'skipped',
]);
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;

export const PlanStepSchema = z.object({
  id: z.string().min(1, 'step id must not be empty'),
  title: z.string().min(1, 'step title must not be empty'),
  status: PlanStepStatusSchema.default('pending'),
  details: z.string().optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
  steps: z.array(PlanStepSchema).default([]),
  active_step_id: z.string().nullable().default(null),
});
export type Plan = z.infer<typeof PlanSchema>;

export const FactsSchema = z.object({
  architecture_notes: z.array(z.string()).default([]),
  key_symbols: z.array(z.string()).default([]),
});
export type Facts = z.infer<typeof FactsSchema>;

export const WorkingContextSchema = z.object({
  modified_files: z.array(z.string()).default([]),
  diff_summary: z.string().default(''),
  test_targets: z.array(z.string()).default([]),
});
export type WorkingContext = z.infer<typeof WorkingContextSchema>;

export const BlockersAndDeadEndsSchema = z.object({
  last_error: z.string().nullable().default(null),
  dead_ends: z.array(z.string()).default([]),
});
export type BlockersAndDeadEnds = z.infer<typeof BlockersAndDeadEndsSchema>;

export const AgentExecutionStateSchema = z.object({
  task_id: z.string().min(1, 'task_id must not be empty'),
  goal: z.string().min(1, 'goal must not be empty'),
  status: AgentStatusSchema.default('in_progress'),
  plan: PlanSchema.default({ steps: [], active_step_id: null }),
  facts: FactsSchema.default({ architecture_notes: [], key_symbols: [] }),
  working_context: WorkingContextSchema.default({
    modified_files: [],
    diff_summary: '',
    test_targets: [],
  }),
  blockers_and_dead_ends: BlockersAndDeadEndsSchema.default({
    last_error: null,
    dead_ends: [],
  }),
  next_action: z.string().nullable().default(null),
});

export type AgentExecutionState = z.infer<typeof AgentExecutionStateSchema>;

/** Input type allowing defaults for optional / nested sections */
export type AgentExecutionStateInput = z.input<typeof AgentExecutionStateSchema>;
