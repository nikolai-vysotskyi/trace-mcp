import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StateEngine } from '../../../state/state-engine.js';
import { registerStateTools } from '../state.js';

interface RegisteredToolInfo {
  name: string;
  description: string;
  schema: unknown;
  handler: (
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

interface RegisteredResourceInfo {
  name: string;
  templateOrUri: unknown;
  metadata: unknown;
  handler: (
    uri: { href: string },
    params: Record<string, unknown>,
  ) => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;
}

describe('SKILL.state MCP Tools and Resources (TRA-598, TRA-599)', () => {
  let engine: StateEngine;
  let tools: Map<string, RegisteredToolInfo>;
  let resources: Map<string, RegisteredResourceInfo>;
  let notifications: Array<{ method: string; params: unknown }>;

  beforeEach(() => {
    const memDb = new Database(':memory:');
    engine = new StateEngine(memDb);
    tools = new Map();
    resources = new Map();
    notifications = [];

    const mockServer = {
      tool: (name: string, description: string, schema: unknown, handler: unknown) => {
        tools.set(name, {
          name,
          description,
          schema,
          handler: handler as RegisteredToolInfo['handler'],
        });
      },
      resource: (name: string, templateOrUri: unknown, metadata: unknown, handler: unknown) => {
        resources.set(name, {
          name,
          templateOrUri,
          metadata,
          handler: handler as RegisteredResourceInfo['handler'],
        });
      },
      server: {
        notification: (notif: { method: string; params: unknown }) => {
          notifications.push(notif);
        },
      },
    };

    const ctx = {
      stateEngine: engine,
      j: (v: unknown) => JSON.stringify(v),
    };

    registerStateTools(mockServer as never, ctx as never);
  });

  it('registers all 7 state tools and 1 resource', () => {
    expect(tools.has('trace_state_init')).toBe(true);
    expect(tools.has('trace_state_patch')).toBe(true);
    expect(tools.has('trace_state_get')).toBe(true);
    expect(tools.has('trace_state_checkpoint')).toBe(true);
    expect(tools.has('trace_state_rollback')).toBe(true);
    expect(tools.has('trace_state_add_dead_end')).toBe(true);
    expect(tools.has('trace_state_list')).toBe(true);
    expect(resources.has('agent-state')).toBe(true);
  });

  it('executes trace_state_init and creates initial state', async () => {
    const initTool = tools.get('trace_state_init')!;
    const res = await initTool.handler({
      task_id: 'TRA-598',
      goal: 'Implement state MCP tools',
      initial_plan: ['Step 1: Write schemas', 'Step 2: Wire tools'],
    });

    expect(res.isError).toBeFalsy();
    expect(res.content[0]?.text).toContain('# State: TRA-598 (v1 • in_progress)');
    expect(res.content[0]?.text).toContain('## Plan (0/2)');
    expect(res.content[0]?.text).toContain('- [>] Step 1: Write schemas *(active)*');

    // Test JSON format
    const resJson = await initTool.handler({
      task_id: 'TRA-598-JSON',
      goal: 'Json test',
      format: 'json',
    });
    const parsed = JSON.parse(resJson.content[0]!.text);
    expect(parsed.task_id).toBe('TRA-598-JSON');
    expect(parsed.status).toBe('in_progress');
  });

  it('executes trace_state_patch and returns compact status', async () => {
    const initTool = tools.get('trace_state_init')!;
    await initTool.handler({
      task_id: 'TRA-598',
      goal: 'Test patching',
      initial_plan: ['Step 1', 'Step 2'],
    });

    const patchTool = tools.get('trace_state_patch')!;
    const patchRes = await patchTool.handler({
      task_id: 'TRA-598',
      patch: {
        plan: {
          steps: [
            { id: 'step_1', title: 'Step 1', status: 'completed' },
            { id: 'step_2', title: 'Step 2', status: 'in_progress' },
          ],
          active_step_id: 'step_2',
        },
        working_context: {
          modified_files: ['src/tools/register/state.ts'],
        },
      },
    });

    expect(patchRes.isError).toBeFalsy();
    const status = JSON.parse(patchRes.content[0]!.text);
    expect(status.success).toBe(true);
    expect(status.version).toBe(2);
    expect(status.active_step_id).toBe('step_2');
    expect(status.status).toBe('in_progress');
  });

  it('executes trace_state_get with compact and json formats', async () => {
    const initTool = tools.get('trace_state_init')!;
    await initTool.handler({
      task_id: 'TRA-598',
      goal: 'Test get tool',
      initial_plan: ['Step 1'],
    });

    const getTool = tools.get('trace_state_get')!;

    // Compact format (default)
    const compactRes = await getTool.handler({ task_id: 'TRA-598' });
    expect(compactRes.content[0]?.text).toContain('# State: TRA-598');

    // JSON format
    const jsonRes = await getTool.handler({ task_id: 'TRA-598', format: 'json' });
    const parsed = JSON.parse(jsonRes.content[0]!.text);
    expect(parsed.task_id).toBe('TRA-598');
    expect(parsed.goal).toBe('Test get tool');

    // Missing task error
    const notFoundRes = await getTool.handler({ task_id: 'NONEXISTENT' });
    expect(notFoundRes.isError).toBe(true);
  });

  it('supports checkpoints and rollback via MCP tools', async () => {
    const initTool = tools.get('trace_state_init')!;
    await initTool.handler({
      task_id: 'TRA-598',
      goal: 'Rollback test',
      initial_plan: ['Safe step'],
    });

    const cpTool = tools.get('trace_state_checkpoint')!;
    const cpRes = await cpTool.handler({
      task_id: 'TRA-598',
      label: 'clean-state',
    });
    const cpData = JSON.parse(cpRes.content[0]!.text);
    expect(cpData.success).toBe(true);
    expect(cpData.label).toBe('clean-state');

    // Mutate state with error
    const deadEndTool = tools.get('trace_state_add_dead_end')!;
    await deadEndTool.handler({
      task_id: 'TRA-598',
      reason: 'Failed experiment',
    });

    // Rollback
    const rbTool = tools.get('trace_state_rollback')!;
    const rbRes = await rbTool.handler({
      task_id: 'TRA-598',
      checkpoint: 'clean-state',
    });
    const rbData = JSON.parse(rbRes.content[0]!.text);
    expect(rbData.success).toBe(true);
    expect(rbData.rolled_back_to).toBe('clean-state');
  });

  it('lists task states via trace_state_list', async () => {
    const initTool = tools.get('trace_state_init')!;
    await initTool.handler({ task_id: 'T-1', goal: 'G1' });
    await initTool.handler({ task_id: 'T-2', goal: 'G2' });

    const listTool = tools.get('trace_state_list')!;
    const listRes = await listTool.handler({});
    const data = JSON.parse(listRes.content[0]!.text);
    expect(data.total).toBe(2);
    expect(data.states.length).toBe(2);
  });

  it('reads MCP Resource trace://state/{task_id} and triggers notifications', async () => {
    const initTool = tools.get('trace_state_init')!;
    await initTool.handler({
      task_id: 'TRA-599',
      goal: 'MCP Resource test',
      initial_plan: ['Step 1'],
    });

    const stateResource = resources.get('agent-state')!;
    const readRes = await stateResource.handler(
      { href: 'trace://state/TRA-599' },
      { task_id: 'TRA-599' },
    );

    expect(readRes.contents.length).toBe(1);
    expect(readRes.contents[0]?.mimeType).toBe('text/markdown');
    expect(readRes.contents[0]?.text).toContain('# State: TRA-599');

    // Check notifications triggered
    expect(notifications.length).toBeGreaterThan(0);
    expect(
      notifications.some((n) => (n.params as { uri: string }).uri === 'trace://state/TRA-599'),
    ).toBe(true);
  });
});
