import { z } from 'zod';

export type AgentExecutionStatus = 'in_progress' | 'completed' | 'failed' | 'blocked' | 'paused';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  details?: string;
}

export interface AgentPlan {
  steps: PlanStep[];
  active_step_id: string | null;
}

export interface AgentFacts {
  architecture_notes: string[];
  key_symbols: string[];
  [key: string]: unknown;
}

export interface AgentWorkingContext {
  modified_files: string[];
  diff_summary?: string | null;
  test_targets: string[];
  [key: string]: unknown;
}

export interface AgentBlockersAndDeadEnds {
  last_error?: string | null;
  dead_ends: string[];
  [key: string]: unknown;
}

export interface AgentExecutionState {
  task_id: string;
  goal: string;
  status: AgentExecutionStatus;
  plan: AgentPlan;
  facts: AgentFacts;
  working_context: AgentWorkingContext;
  blockers_and_dead_ends: AgentBlockersAndDeadEnds;
  next_action: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface AgentStateRevision {
  id: number;
  task_id: string;
  version: number;
  patch_json: string;
  created_at: string;
}

export interface AgentStateCheckpoint {
  id: string;
  task_id: string;
  label: string;
  state_json: string;
  created_at: string;
}

// ============================================================================
// ZOD SCHEMAS
// ============================================================================

export const AgentExecutionStatusSchema = z.enum([
  'in_progress',
  'completed',
  'failed',
  'blocked',
  'paused',
]);

export const PlanStepStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'skipped',
]);

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  status: PlanStepStatusSchema.default('pending'),
  details: z.string().optional(),
});

export const AgentPlanSchema = z.object({
  steps: z.array(PlanStepSchema).default([]),
  active_step_id: z.string().nullable().default(null),
});

export const AgentFactsSchema = z
  .object({
    architecture_notes: z.array(z.string()).default([]),
    key_symbols: z.array(z.string()).default([]),
  })
  .passthrough();

export const AgentWorkingContextSchema = z
  .object({
    modified_files: z.array(z.string()).default([]),
    diff_summary: z.string().nullable().default(null),
    test_targets: z.array(z.string()).default([]),
  })
  .passthrough();

export const AgentBlockersAndDeadEndsSchema = z
  .object({
    last_error: z.string().nullable().default(null),
    dead_ends: z.array(z.string()).default([]),
  })
  .passthrough();

export const AgentExecutionStateSchema = z
  .object({
    task_id: z.string().min(1),
    goal: z.string().min(1),
    status: AgentExecutionStatusSchema.default('in_progress'),
    plan: AgentPlanSchema.default(() => ({ steps: [], active_step_id: null })),
    facts: AgentFactsSchema.default(() => ({ architecture_notes: [], key_symbols: [] })),
    working_context: AgentWorkingContextSchema.default(() => ({
      modified_files: [],
      diff_summary: null,
      test_targets: [],
    })),
    blockers_and_dead_ends: AgentBlockersAndDeadEndsSchema.default(() => ({
      last_error: null,
      dead_ends: [],
    })),
    next_action: z.string().nullable().default(null),
    version: z.number().int().min(1).default(1),
    created_at: z.string().default(() => new Date().toISOString()),
    updated_at: z.string().default(() => new Date().toISOString()),
  })
  .passthrough();
