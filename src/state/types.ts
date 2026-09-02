/**
 * Types for the SKILL.state execution engine (arXiv:2608.26263).
 *
 * Provides structured state tracking for AI agents to transition from
 * quadratic O(T^2) conversation transcript accumulation to linear O(T)
 * structured state management.
 */

export type AgentStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface AgentStep {
  id: string;
  title: string;
  status: AgentStepStatus;
  notes?: string;
}

export interface AgentExecutionPlan {
  steps: AgentStep[];
  active_step_id?: string | null;
}

export interface AgentFacts {
  architecture_notes?: string[];
  key_symbols?: string[];
  learned_constraints?: string[];
  [key: string]: unknown;
}

export interface AgentWorkingContext {
  modified_files?: string[];
  diff_summary?: string;
  test_targets?: string[];
  open_questions?: string[];
  [key: string]: unknown;
}

export interface AgentDeadEnd {
  approach: string;
  reason: string;
  timestamp?: string;
}

export interface AgentBlockersAndDeadEnds {
  last_error?: string | null;
  dead_ends?: AgentDeadEnd[];
}

export type AgentExecutionStatus = 'in_progress' | 'completed' | 'failed' | 'blocked' | 'paused';

export interface AgentExecutionState {
  task_id: string;
  goal: string;
  status: AgentExecutionStatus;
  plan: AgentExecutionPlan;
  facts: AgentFacts;
  working_context: AgentWorkingContext;
  blockers_and_dead_ends: AgentBlockersAndDeadEnds;
  next_action?: string | null;
  metadata?: Record<string, unknown>;
}

export interface StateRow {
  task_id: string;
  goal: string;
  status: string;
  state_json: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface StateRevisionRow {
  id: number;
  task_id: string;
  version: number;
  patch_json: string;
  created_at: string;
}

export interface StateCheckpointRow {
  id: number;
  task_id: string;
  label: string;
  state_json: string;
  created_at: string;
}

export interface StateSummaryItem {
  taskId: string;
  goal: string;
  status: AgentExecutionStatus;
  version: number;
  activeStepId?: string | null;
  updatedAt: string;
}

export interface PatchStateResult {
  success: true;
  version: number;
  active_step_id?: string | null;
  status: AgentExecutionStatus;
  state: AgentExecutionState;
}

export interface CheckpointResult {
  id: number;
  taskId: string;
  label: string;
  version: number;
  createdAt: string;
}

export interface RollbackResult {
  success: true;
  version: number;
  rolledBackTo: string;
  state: AgentExecutionState;
}
