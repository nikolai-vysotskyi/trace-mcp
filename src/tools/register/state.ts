import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../../server/types.js';
import { serializeStateCompact } from '../../state/compact-serializer.js';
import { StateEngine } from '../../state/state-engine.js';

function getStateEngine(ctx: ServerContext): StateEngine | null {
  if (ctx.stateEngine) return ctx.stateEngine;
  if (ctx.store?.db) {
    return new StateEngine(ctx.store.db);
  }
  return null;
}

/**
 * Register SKILL.state execution state tools for agents:
 * - trace_state_init: Initialize task execution state
 * - trace_state_patch: RFC 7396 JSON merge patch with validation
 * - trace_state_get: Get state in JSON or compact markdown format
 * - trace_state_checkpoint: Save named checkpoint
 * - trace_state_rollback: Roll back to checkpoint
 * - trace_state_add_dead_end: Record dead end shortcut
 */
export function registerStateTools(server: McpServer, ctx: ServerContext): void {
  const { j } = ctx;

  server.tool(
    'trace_state_init',
    'Initialize a new agent execution state in SQLite for tracking task progress, structured plan, working context, and blockers. Returns initial state JSON.',
    {
      task_id: z
        .string()
        .min(1)
        .max(256)
        .describe('Unique task or issue identifier (e.g. TRA-123 or UUID)'),
      goal: z.string().min(1).max(4096).describe('Primary objective or task description'),
      initial_plan: z
        .array(z.string().min(1).max(1024))
        .optional()
        .describe('Optional list of initial step descriptions'),
    },
    async ({ task_id, goal, initial_plan }) => {
      const engine = getStateEngine(ctx);
      if (!engine) {
        return {
          content: [
            {
              type: 'text',
              text: j({ error: { message: 'StateEngine is not available in this context' } }),
            },
          ],
          isError: true,
        };
      }

      try {
        const state = engine.init({ task_id, goal, initial_plan });
        return {
          content: [{ type: 'text', text: j(state) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                error: { message: err instanceof Error ? err.message : String(err) },
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'trace_state_patch',
    'Apply an RFC 7396 JSON Merge Patch to update the agent execution state. Validates schema and records revision history. Returns compact status.',
    {
      task_id: z.string().min(1).max(256).describe('Task identifier'),
      patch: z
        .record(z.string(), z.unknown())
        .describe('RFC 7396 JSON merge patch object with partial state changes'),
    },
    async ({ task_id, patch }) => {
      const engine = getStateEngine(ctx);
      if (!engine) {
        return {
          content: [
            {
              type: 'text',
              text: j({ error: { message: 'StateEngine is not available in this context' } }),
            },
          ],
          isError: true,
        };
      }

      try {
        const result = engine.patch({ task_id, patch });
        return {
          content: [
            {
              type: 'text',
              text: j({
                success: true,
                version: result.version,
                active_step_id: result.active_step_id,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                error: { message: err instanceof Error ? err.message : String(err) },
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'trace_state_get',
    'Retrieve the current agent execution state for a task in full JSON or compact Markdown format.',
    {
      task_id: z.string().min(1).max(256).describe('Task identifier'),
      format: z
        .enum(['json', 'compact'])
        .optional()
        .describe(
          'Output format: "json" (full JSON) or "compact" (token-efficient markdown, default: "json")',
        ),
    },
    async ({ task_id, format }) => {
      const engine = getStateEngine(ctx);
      if (!engine) {
        return {
          content: [
            {
              type: 'text',
              text: j({ error: { message: 'StateEngine is not available in this context' } }),
            },
          ],
          isError: true,
        };
      }

      const state = engine.get(task_id);
      if (!state) {
        return {
          content: [
            {
              type: 'text',
              text: j({ error: { message: `State for task "${task_id}" not found` } }),
            },
          ],
          isError: true,
        };
      }

      if (format === 'compact') {
        const markdown = serializeStateCompact(state);
        return {
          content: [{ type: 'text', text: markdown }],
        };
      }

      return {
        content: [{ type: 'text', text: j(state) }],
      };
    },
  );

  server.tool(
    'trace_state_checkpoint',
    'Save a snapshot checkpoint of the current execution state with a named label for rollback.',
    {
      task_id: z.string().min(1).max(256).describe('Task identifier'),
      label: z
        .string()
        .min(1)
        .max(256)
        .describe('Human-readable label for this checkpoint (e.g. "before_refactoring")'),
    },
    async ({ task_id, label }) => {
      const engine = getStateEngine(ctx);
      if (!engine) {
        return {
          content: [
            {
              type: 'text',
              text: j({ error: { message: 'StateEngine is not available in this context' } }),
            },
          ],
          isError: true,
        };
      }

      try {
        const result = engine.checkpoint({ task_id, label });
        return {
          content: [{ type: 'text', text: j(result) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                error: { message: err instanceof Error ? err.message : String(err) },
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'trace_state_rollback',
    'Roll back execution state to a previously saved checkpoint by label or checkpoint ID.',
    {
      task_id: z.string().min(1).max(256).describe('Task identifier'),
      checkpoint_id_or_label: z
        .string()
        .min(1)
        .max(256)
        .describe('Checkpoint ID or label to restore'),
    },
    async ({ task_id, checkpoint_id_or_label }) => {
      const engine = getStateEngine(ctx);
      if (!engine) {
        return {
          content: [
            {
              type: 'text',
              text: j({ error: { message: 'StateEngine is not available in this context' } }),
            },
          ],
          isError: true,
        };
      }

      try {
        const result = engine.rollback({ task_id, checkpoint_id_or_label });
        return {
          content: [{ type: 'text', text: j(result) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                error: { message: err instanceof Error ? err.message : String(err) },
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'trace_state_add_dead_end',
    'Record an exploration dead-end or failed hypothesis in the task state without sending a full merge patch.',
    {
      task_id: z.string().min(1).max(256).describe('Task identifier'),
      reason: z
        .string()
        .min(1)
        .max(4096)
        .describe('Explanation of why this path or hypothesis was abandoned'),
    },
    async ({ task_id, reason }) => {
      const engine = getStateEngine(ctx);
      if (!engine) {
        return {
          content: [
            {
              type: 'text',
              text: j({ error: { message: 'StateEngine is not available in this context' } }),
            },
          ],
          isError: true,
        };
      }

      try {
        const result = engine.addDeadEnd({ task_id, reason });
        return {
          content: [
            {
              type: 'text',
              text: j({
                success: true,
                version: result.version,
                dead_ends_count: result.dead_ends_count,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                error: { message: err instanceof Error ? err.message : String(err) },
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
