import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ServerContext, ToolResponse } from '../../../server/types.js';
import { StateEngine } from '../../../state/state-engine.js';
import { registerStateTools } from '../state.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

describe('SKILL.state MCP Tools (TRA-598)', () => {
  let db: Database.Database;
  let stateEngine: StateEngine;
  let toolHandlers: Map<string, ToolHandler>;
  let ctx: ServerContext;

  beforeEach(() => {
    db = new Database(':memory:');
    stateEngine = new StateEngine(db);
    toolHandlers = new Map();

    const mockServer = {
      tool: (
        name: string,
        _desc: string,
        _schema: Record<string, z.ZodTypeAny>,
        handler: ToolHandler,
      ) => {
        toolHandlers.set(name, handler);
      },
    };

    ctx = {
      stateEngine,
      store: { db } as unknown as ServerContext['store'],
      j: (v: unknown) => JSON.stringify(v),
    } as unknown as ServerContext;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerStateTools(mockServer as any, ctx);
  });

  it('registers all 6 trace_state_* tools', () => {
    expect(toolHandlers.has('trace_state_init')).toBe(true);
    expect(toolHandlers.has('trace_state_patch')).toBe(true);
    expect(toolHandlers.has('trace_state_get')).toBe(true);
    expect(toolHandlers.has('trace_state_checkpoint')).toBe(true);
    expect(toolHandlers.has('trace_state_rollback')).toBe(true);
    expect(toolHandlers.has('trace_state_add_dead_end')).toBe(true);
  });

  describe('trace_state_init', () => {
    it('initializes state and returns JSON result', async () => {
      const handler = toolHandlers.get('trace_state_init')!;
      const res = await handler({
        task_id: 'TRA-598',
        goal: 'Implement state MCP tools',
        initial_plan: ['Step 1: Write schemas', 'Step 2: Wire tools', 'Step 3: Test'],
      });

      expect(res.isError).toBeFalsy();
      const data = JSON.parse(res.content[0].text);
      expect(data.task_id).toBe('TRA-598');
      expect(data.goal).toBe('Implement state MCP tools');
      expect(data.status).toBe('in_progress');
      expect(data.version).toBe(1);
      expect(data.plan.steps).toHaveLength(3);
      expect(data.plan.steps[0].id).toBe('step_1');
      expect(data.plan.steps[0].status).toBe('in_progress');
      expect(data.plan.active_step_id).toBe('step_1');
    });

    it('returns error on empty inputs', async () => {
      const handler = toolHandlers.get('trace_state_init')!;
      const res = await handler({
        task_id: '',
        goal: '',
      });

      expect(res.isError).toBe(true);
      const data = JSON.parse(res.content[0].text);
      expect(data.error).toBeDefined();
    });
  });

  describe('trace_state_patch', () => {
    it('applies merge patch and returns compact success status', async () => {
      const initHandler = toolHandlers.get('trace_state_init')!;
      await initHandler({
        task_id: 'TRA-598',
        goal: 'Implement state MCP tools',
        initial_plan: ['Step 1', 'Step 2'],
      });

      const patchHandler = toolHandlers.get('trace_state_patch')!;
      const res = await patchHandler({
        task_id: 'TRA-598',
        patch: {
          plan: {
            active_step_id: 'step_2',
            steps: [
              { id: 'step_1', description: 'Step 1', status: 'completed' },
              { id: 'step_2', description: 'Step 2', status: 'in_progress' },
            ],
          },
          working_context: {
            modified_files: ['src/tools/register/state.ts'],
          },
        },
      });

      expect(res.isError).toBeFalsy();
      const data = JSON.parse(res.content[0].text);
      expect(data.success).toBe(true);
      expect(data.version).toBe(2);
      expect(data.active_step_id).toBe('step_2');
    });

    it('returns error when task does not exist', async () => {
      const patchHandler = toolHandlers.get('trace_state_patch')!;
      const res = await patchHandler({
        task_id: 'UNKNOWN-1',
        patch: { status: 'completed' },
      });

      expect(res.isError).toBe(true);
    });
  });

  describe('trace_state_get', () => {
    beforeEach(async () => {
      const initHandler = toolHandlers.get('trace_state_init')!;
      await initHandler({
        task_id: 'TRA-598',
        goal: 'Implement state MCP tools',
        initial_plan: ['Step 1: Write schemas', 'Step 2: Wire tools'],
      });
    });

    it('returns full JSON format by default', async () => {
      const getHandler = toolHandlers.get('trace_state_get')!;
      const res = await getHandler({
        task_id: 'TRA-598',
      });

      expect(res.isError).toBeFalsy();
      const data = JSON.parse(res.content[0].text);
      expect(data.task_id).toBe('TRA-598');
      expect(data.goal).toBe('Implement state MCP tools');
    });

    it('returns compact Markdown format when format="compact"', async () => {
      const getHandler = toolHandlers.get('trace_state_get')!;
      const res = await getHandler({
        task_id: 'TRA-598',
        format: 'compact',
      });

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('## Task State: TRA-598');
      expect(res.content[0].text).toContain('**Goal**: Implement state MCP tools');
      expect(res.content[0].text).toContain('step_1: Step 1: Write schemas (in_progress)');
    });

    it('returns error when task state is not found', async () => {
      const getHandler = toolHandlers.get('trace_state_get')!;
      const res = await getHandler({
        task_id: 'NONEXISTENT',
      });

      expect(res.isError).toBe(true);
      const data = JSON.parse(res.content[0].text);
      expect(data.error.message).toContain('not found');
    });
  });

  describe('trace_state_checkpoint and trace_state_rollback', () => {
    it('creates checkpoint and rolls back to it', async () => {
      const initHandler = toolHandlers.get('trace_state_init')!;
      await initHandler({
        task_id: 'TRA-598',
        goal: 'Checkpoint test',
        initial_plan: ['Step 1'],
      });

      const chkHandler = toolHandlers.get('trace_state_checkpoint')!;
      const chkRes = await chkHandler({
        task_id: 'TRA-598',
        label: 'stable_point',
      });

      expect(chkRes.isError).toBeFalsy();
      const chkData = JSON.parse(chkRes.content[0].text);
      expect(chkData.success).toBe(true);
      expect(chkData.label).toBe('stable_point');

      // Now break state in patch
      const patchHandler = toolHandlers.get('trace_state_patch')!;
      await patchHandler({
        task_id: 'TRA-598',
        patch: {
          status: 'failed',
          working_context: { modified_files: ['bad_file.ts'] },
        },
      });

      // Rollback
      const rollbackHandler = toolHandlers.get('trace_state_rollback')!;
      const rollbackRes = await rollbackHandler({
        task_id: 'TRA-598',
        checkpoint_id_or_label: 'stable_point',
      });

      expect(rollbackRes.isError).toBeFalsy();
      const rollbackData = JSON.parse(rollbackRes.content[0].text);
      expect(rollbackData.success).toBe(true);
      expect(rollbackData.rolled_back_to).toBe('stable_point');
      expect(rollbackData.version).toBe(3);
      expect(rollbackData.state.status).toBe('in_progress');
      expect(rollbackData.state.working_context.modified_files).toEqual([]);
    });
  });

  describe('trace_state_add_dead_end', () => {
    it('appends dead-end reason and returns count', async () => {
      const initHandler = toolHandlers.get('trace_state_init')!;
      await initHandler({
        task_id: 'TRA-598',
        goal: 'Dead end testing',
      });

      const deadEndHandler = toolHandlers.get('trace_state_add_dead_end')!;
      const res = await deadEndHandler({
        task_id: 'TRA-598',
        reason: 'Tried approach A: too slow and memory heavy',
      });

      expect(res.isError).toBeFalsy();
      const data = JSON.parse(res.content[0].text);
      expect(data.success).toBe(true);
      expect(data.dead_ends_count).toBe(1);
      expect(data.version).toBe(2);

      // Verify in get
      const getHandler = toolHandlers.get('trace_state_get')!;
      const getRes = await getHandler({
        task_id: 'TRA-598',
        format: 'compact',
      });
      expect(getRes.content[0].text).toContain('🛑 Tried approach A: too slow and memory heavy');
    });
  });
});
