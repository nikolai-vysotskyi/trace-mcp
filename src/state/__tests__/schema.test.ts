import { describe, expect, it } from 'vitest';
import { AgentExecutionStateSchema, AgentStepSchema } from '../schema.js';

describe('AgentExecutionState Schema validation', () => {
  it('validates a complete valid state', () => {
    const valid = {
      task_id: 'TRA-596',
      goal: 'Integrate SKILL.state StateEngine into trace-mcp',
      status: 'in_progress',
      plan: {
        active_step_id: 'step_1',
        steps: [
          { id: 'step_1', title: 'Implement SQLite schema', status: 'completed' },
          { id: 'step_2', title: 'Implement MCP tools', status: 'in_progress', notes: 'Stage 2' },
        ],
      },
      facts: {
        architecture_notes: ['Use WAL mode in SQLite'],
        key_symbols: ['StateEngine', 'applyJsonMergePatch'],
      },
      working_context: {
        modified_files: ['src/state/state-engine.ts'],
        diff_summary: '+120 lines',
        test_targets: ['pnpm test src/state'],
      },
      blockers_and_dead_ends: {
        last_error: null,
        dead_ends: [],
      },
      next_action: 'Write MCP tool wrappers',
    };

    const parsed = AgentExecutionStateSchema.parse(valid);
    expect(parsed.task_id).toBe('TRA-596');
    expect(parsed.plan.steps.length).toBe(2);
  });

  it('supplies sensible defaults for omitted optional sections', () => {
    const minimal = {
      task_id: 'TASK-1',
      goal: 'Quick goal',
    };

    const parsed = AgentExecutionStateSchema.parse(minimal);
    expect(parsed.status).toBe('in_progress');
    expect(parsed.plan.steps).toEqual([]);
    expect(parsed.facts.architecture_notes).toEqual([]);
    expect(parsed.working_context.modified_files).toEqual([]);
    expect(parsed.blockers_and_dead_ends.dead_ends).toEqual([]);
  });

  it('rejects invalid step status', () => {
    expect(() =>
      AgentStepSchema.parse({
        id: 's1',
        title: 'Step',
        status: 'unknown_status',
      }),
    ).toThrow();
  });

  it('allows extensible custom facts and working context keys', () => {
    const custom = {
      task_id: 'TASK-2',
      goal: 'Extensible goal',
      facts: {
        custom_domain_knowledge: 'Special rule',
      },
      working_context: {
        branch_name: 'feature/skill-state',
      },
    };

    const parsed = AgentExecutionStateSchema.parse(custom);
    expect((parsed.facts as Record<string, unknown>).custom_domain_knowledge).toBe('Special rule');
    expect((parsed.working_context as Record<string, unknown>).branch_name).toBe('feature/skill-state');
  });
});
