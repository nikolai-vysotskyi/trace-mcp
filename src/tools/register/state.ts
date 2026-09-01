/**
 * SKILL.state MCP Tools — structured execution state management for AI coding agents.
 *
 * Implements tools to initialize, patch (RFC 7396), inspect, checkpoint, and rollback
 * agent execution state to achieve O(T) linear token consumption instead of quadratic O(T^2).
 */

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../../server/types.js';
import { serializeStateToMarkdown } from '../../state/serializer.js';

export function registerStateTools(server: McpServer, ctx: ServerContext): void {
  const { stateEngine, j } = ctx;
  if (!stateEngine) return;

  // --- MCP Resource: trace://state/{task_id} ---
  server.resource(
    'agent-state',
    new ResourceTemplate('trace://state/{task_id}', { list: undefined }),
    {
      mimeType: 'text/markdown',
      description: 'Structured execution state for an agent task (arXiv:2608.26263)',
    },
    async (uri, { task_id }) => {
      const taskIdStr = String(task_id);
      const entry = stateEngine.getState(taskIdStr);
      if (!entry) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/markdown',
              text: `# State: ${taskIdStr} (not initialized)\nUse \`trace_state_init\` to start tracking state.`,
            },
          ],
        };
      }

      const md = serializeStateToMarkdown(entry.state, entry.version);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: md,
          },
        ],
      };
    },
  );

  // Wire listener to send MCP resource update notifications
  stateEngine.onStateChange(({ taskId }) => {
    try {
      server.server.notification({
        method: 'notifications/resources/updated',
        params: {
          uri: `trace://state/${taskId}`,
        },
      });
    } catch {
      /* best-effort when not connected */
    }
  });

  // --- Tool: trace_state_init ---
  server.tool(
    'trace_state_init',
    'Initialize structured execution state for a task (arXiv:2608.26263). Saves state to SQLite and returns compact initial state.',
    {
      task_id: z.string().describe('Unique task identifier (e.g. TRA-596)'),
      goal: z.string().describe('High-level goal or problem statement'),
      initial_plan: z.array(z.string()).optional().describe('Initial ordered plan step titles'),
      format: z
        .enum(['compact', 'json'])
        .optional()
        .describe('Output format: "compact" (default markdown) or "json"'),
    },
    async ({ task_id, goal, initial_plan, format }) => {
      try {
        const state = stateEngine.initState(task_id, goal, initial_plan);
        if (format === 'json') {
          return { content: [{ type: 'text', text: j(state) }] };
        }
        const md = serializeStateToMarkdown(state, 1);
        return { content: [{ type: 'text', text: md }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: j({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );

  // --- Tool: trace_state_patch ---
  server.tool(
    'trace_state_patch',
    'Apply an RFC 7396 JSON Merge Patch to update state atomically. Validates schema and increments version. Returns compact status.',
    {
      task_id: z.string().describe('Task identifier'),
      patch: z
        .record(z.string(), z.unknown())
        .describe('RFC 7396 patch object (null deletes fields, objects merge recursively)'),
      format: z.enum(['compact', 'json']).optional().describe('Response format (default: compact)'),
    },
    async ({ task_id, patch, format }) => {
      try {
        const res = stateEngine.patchState(task_id, patch);
        if (format === 'json') {
          return { content: [{ type: 'text', text: j(res.state) }] };
        }
        return {
          content: [
            {
              type: 'text',
              text: j({
                success: true,
                version: res.version,
                active_step_id: res.active_step_id,
                status: res.status,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: j({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );

  // --- Tool: trace_state_get ---
  server.tool(
    'trace_state_get',
    'Retrieve current execution state for a task in compact markdown (~150 tokens) or full JSON.',
    {
      task_id: z.string().describe('Task identifier'),
      format: z
        .enum(['compact', 'json', 'markdown'])
        .optional()
        .describe('Format: "compact" (default markdown), "markdown", or "json"'),
    },
    async ({ task_id, format }) => {
      const entry = stateEngine.getState(task_id);
      if (!entry) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                error: `Task state not found for task_id "${task_id}". Use trace_state_init first.`,
              }),
            },
          ],
          isError: true,
        };
      }

      if (format === 'json') {
        return { content: [{ type: 'text', text: j(entry.state) }] };
      }

      const md = serializeStateToMarkdown(entry.state, entry.version);
      return { content: [{ type: 'text', text: md }] };
    },
  );

  // --- Tool: trace_state_checkpoint ---
  server.tool(
    'trace_state_checkpoint',
    'Save a named state checkpoint snapshot for safe rollback if a future exploration path fails.',
    {
      task_id: z.string().describe('Task identifier'),
      label: z.string().describe('Checkpoint name (e.g. "before-refactor")'),
    },
    async ({ task_id, label }) => {
      try {
        const cp = stateEngine.createCheckpoint(task_id, label);
        return {
          content: [
            {
              type: 'text',
              text: j({
                success: true,
                checkpoint_id: cp.id,
                label: cp.label,
                version: cp.version,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: j({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );

  // --- Tool: trace_state_rollback ---
  server.tool(
    'trace_state_rollback',
    'Rollback task execution state to a previously saved checkpoint snapshot by label or ID.',
    {
      task_id: z.string().describe('Task identifier'),
      checkpoint: z.string().describe('Checkpoint label or numeric ID to restore'),
      format: z.enum(['compact', 'json']).optional().describe('Output format (default: compact)'),
    },
    async ({ task_id, checkpoint, format }) => {
      try {
        const res = stateEngine.rollbackToCheckpoint(task_id, checkpoint);
        if (format === 'json') {
          return { content: [{ type: 'text', text: j(res.state) }] };
        }
        return {
          content: [
            {
              type: 'text',
              text: j({
                success: true,
                version: res.version,
                rolled_back_to: res.rolledBackTo,
                active_step_id: res.state.plan.active_step_id,
                status: res.state.status,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: j({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );

  // --- Tool: trace_state_add_dead_end ---
  server.tool(
    'trace_state_add_dead_end',
    'Shortcut to record a failed approach or dead end into task state without a full patch.',
    {
      task_id: z.string().describe('Task identifier'),
      reason: z.string().describe('Why this approach failed or should not be retried'),
      approach: z.string().optional().describe('The attempted approach (defaults to current next_action)'),
    },
    async ({ task_id, reason, approach }) => {
      try {
        const res = stateEngine.addDeadEnd(task_id, reason, approach);
        return {
          content: [
            {
              type: 'text',
              text: j({
                success: true,
                version: res.version,
                dead_ends_count: res.state.blockers_and_dead_ends.dead_ends?.length ?? 0,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: j({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );

  // --- Tool: trace_state_list ---
  server.tool(
    'trace_state_list',
    'List recent agent execution task states and their status in storage.',
    {
      limit: z.number().optional().describe('Maximum task states to list (default: 30)'),
    },
    async ({ limit }) => {
      try {
        const list = stateEngine.listStates(limit ?? 30);
        return {
          content: [{ type: 'text', text: j({ states: list, total: list.length }) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: j({ error: (err as Error).message }) }],
          isError: true,
        };
      }
    },
  );
}
