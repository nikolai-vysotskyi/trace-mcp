import { describe, expect, it } from 'vitest';
import {
  AgentExecutionStateSchema,
  AgentStatusSchema,
  BlockersAndDeadEndsSchema,
  FactsSchema,
  PlanSchema,
  PlanStepSchema,
  WorkingContextSchema,
} from '../../src/state/schema.js';

describe('AgentExecutionState Zod Schema', () => {
  describe('defaults and minimal input', () => {
    it('populates default fields when only task_id and goal are provided', () => {
      const minimal = {
        task_id: 'task-100',
        goal: 'Implement feature foo',
      };

      const parsed = AgentExecutionStateSchema.parse(minimal);
      expect(parsed).toEqual({
        task_id: 'task-100',
        goal: 'Implement feature foo',
        status: 'in_progress',
        plan: {
          steps: [],
          active_step_id: null,
        },
        facts: {
          architecture_notes: [],
          key_symbols: [],
        },
        working_context: {
          modified_files: [],
          diff_summary: '',
          test_targets: [],
        },
        blockers_and_dead_ends: {
          last_error: null,
          dead_ends: [],
        },
        next_action: null,
      });
    });
  });

  describe('valid state instances', () => {
    it('parses complete state with all fields populated', () => {
      const fullState = {
        task_id: 'task-200',
        goal: 'Refactor database models',
        status: 'in_progress' as const,
        plan: {
          steps: [
            {
              id: 'step-1',
              title: 'Analyze existing schema',
              status: 'completed' as const,
              details: 'Examined src/db/schema.ts',
            },
            {
              id: 'step-2',
              title: 'Write migration',
              status: 'in_progress' as const,
            },
          ],
          active_step_id: 'step-2',
        },
        facts: {
          architecture_notes: [
            'Uses SQLite in WAL mode',
            'Better-sqlite3 handles sync transactions',
          ],
          key_symbols: ['initializeDatabase', 'Store', 'StateEngine'],
        },
        working_context: {
          modified_files: ['src/state/engine.ts', 'src/db/schema.ts'],
          diff_summary: 'Added agent_states table',
          test_targets: ['tests/state/engine.test.ts'],
        },
        blockers_and_dead_ends: {
          last_error: 'Foreign key constraint failed',
          dead_ends: ['Using raw SQL string concatenation'],
        },
        next_action: 'Run vitest suite to verify test coverage',
      };

      const parsed = AgentExecutionStateSchema.parse(fullState);
      expect(parsed).toEqual(fullState);
    });

    it('accepts all valid agent status values', () => {
      const statuses = ['pending', 'in_progress', 'completed', 'failed', 'blocked'] as const;
      for (const status of statuses) {
        const parsed = AgentStatusSchema.parse(status);
        expect(parsed).toBe(status);

        const state = AgentExecutionStateSchema.parse({
          task_id: 't-1',
          goal: 'Test',
          status,
        });
        expect(state.status).toBe(status);
      }
    });

    it('accepts all valid plan step status values', () => {
      const stepStatuses = ['pending', 'in_progress', 'completed', 'failed', 'skipped'] as const;
      for (const status of stepStatuses) {
        const step = PlanStepSchema.parse({
          id: 'step-1',
          title: 'Step 1',
          status,
        });
        expect(step.status).toBe(status);
      }
    });
  });

  describe('invalid inputs and validation errors', () => {
    it('rejects empty task_id', () => {
      expect(() =>
        AgentExecutionStateSchema.parse({
          task_id: '',
          goal: 'Some goal',
        }),
      ).toThrow();
    });

    it('rejects empty goal', () => {
      expect(() =>
        AgentExecutionStateSchema.parse({
          task_id: 'task-1',
          goal: '',
        }),
      ).toThrow();
    });

    it('rejects missing task_id or goal', () => {
      expect(() =>
        AgentExecutionStateSchema.parse({
          goal: 'Some goal',
        }),
      ).toThrow();

      expect(() =>
        AgentExecutionStateSchema.parse({
          task_id: 'task-1',
        }),
      ).toThrow();
    });

    it('rejects invalid status', () => {
      expect(() =>
        AgentExecutionStateSchema.parse({
          task_id: 'task-1',
          goal: 'Goal',
          status: 'unknown_status',
        }),
      ).toThrow();
    });

    it('rejects plan steps missing id or title', () => {
      expect(() =>
        PlanSchema.parse({
          steps: [{ title: 'No id' }],
        }),
      ).toThrow();

      expect(() =>
        PlanSchema.parse({
          steps: [{ id: 'id-only' }],
        }),
      ).toThrow();

      expect(() =>
        PlanSchema.parse({
          steps: [{ id: '', title: 'Empty id' }],
        }),
      ).toThrow();
    });

    it('rejects non-array in facts or working_context', () => {
      expect(() =>
        FactsSchema.parse({
          architecture_notes: 'not an array',
        }),
      ).toThrow();

      expect(() =>
        WorkingContextSchema.parse({
          modified_files: 123,
        }),
      ).toThrow();
    });

    it('rejects invalid last_error types', () => {
      expect(() =>
        BlockersAndDeadEndsSchema.parse({
          last_error: 12345,
        }),
      ).toThrow();
    });
  });
});
