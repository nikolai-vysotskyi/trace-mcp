import { z } from 'zod';

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
export type TaskExecutionStatus = 'running' | 'completed' | 'failed' | 'blocked';

export const PlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'skipped']).default('pending'),
  notes: z.string().optional(),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

export const AgentPlanSchema = z.object({
  steps: z.array(PlanStepSchema).default([]),
  active_step_id: z.string().nullable().optional(),
});

export type AgentPlan = z.infer<typeof AgentPlanSchema>;

export const AgentFactsSchema = z.object({
  architecture_notes: z.array(z.string()).default([]),
  key_symbols: z.array(z.string()).default([]),
});

export type AgentFacts = z.infer<typeof AgentFactsSchema>;

export const WorkingContextSchema = z.object({
  modified_files: z.array(z.string()).default([]),
  diff_summary: z.string().optional(),
  test_targets: z.array(z.string()).default([]),
});

export type WorkingContext = z.infer<typeof WorkingContextSchema>;

export const BlockersAndDeadEndsSchema = z.object({
  last_error: z.string().nullable().optional(),
  dead_ends: z.array(z.string()).default([]),
});

export type BlockersAndDeadEnds = z.infer<typeof BlockersAndDeadEndsSchema>;

export const AgentExecutionStateSchema = z.object({
  task_id: z.string(),
  goal: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'blocked']).default('running'),
  version: z.number().int().nonnegative().default(1),
  plan: AgentPlanSchema.default({ steps: [] }),
  facts: AgentFactsSchema.default({ architecture_notes: [], key_symbols: [] }),
  working_context: WorkingContextSchema.default({ modified_files: [], test_targets: [] }),
  blockers_and_dead_ends: BlockersAndDeadEndsSchema.default({ dead_ends: [] }),
  next_action: z.string().optional(),
  created_at: z.string().default(() => new Date().toISOString()),
  updated_at: z.string().default(() => new Date().toISOString()),
});

export type AgentExecutionState = z.infer<typeof AgentExecutionStateSchema>;

export interface StateRevision {
  id: string;
  task_id: string;
  version: number;
  patch: Record<string, unknown>;
  created_at: string;
}

export interface StateCheckpoint {
  id: string;
  task_id: string;
  label: string;
  version: number;
  state: AgentExecutionState;
  created_at: string;
}

export type StatePatch = Record<string, unknown>;
