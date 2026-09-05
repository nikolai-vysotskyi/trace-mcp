import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listProjects } from '../../registry.js';
import type { ServerContext } from '../../server/types.js';

/**
 * Cross-project tools: `list_projects` (discover registered roots) and
 * `call_project_tool` (relay a normal trace-mcp tool call to a DIFFERENT
 * registered project than the one this session is attached to). See
 * src/daemon/project-relay.ts for how `ctx.projectRelay` is wired per runtime
 * (daemon vs stdio) and src/server/types.ts for the ProjectRelay contract.
 *
 * Design note (TRA-93 Option B): this is deliberately NOT a `project` param
 * threaded onto all ~170 existing tools (Option A, out of scope) — every
 * existing tool's schema is untouched. `call_project_tool` dispatches to the
 * target project's own already-registered handler for `tool` and returns its
 * response verbatim, so the target tool's contract never changes either.
 */
export function registerProjectsTools(server: McpServer, ctx: ServerContext): void {
  const { j, topoStore } = ctx;

  server.tool(
    'list_projects',
    'List projects registered with trace-mcp (~/.trace/registry.json) — the roots call_project_tool accepts. Use to query a project other than the one this session is attached to. Subprojects nested inside those roots are not valid targets, so they are opt-in via include_subprojects. Read-only. Returns JSON: { projects: [{ root, name, type, lastIndexed }], subprojects?: [{ name, repo_root, project_root }], total }.',
    {
      include_subprojects: z
        .boolean()
        .optional()
        .describe('Also list subprojects nested in registered roots (default false).'),
    },
    async ({ include_subprojects }) => {
      const projects = listProjects().map((p) => ({
        root: p.root,
        name: p.name,
        type: p.type ?? 'single',
        lastIndexed: p.lastIndexed,
      }));
      const result: Record<string, unknown> = { projects, total: projects.length };

      // TRA-952: subprojects used to ride along unconditionally, and they are
      // the whole cost of this tool — 98 rows of three absolute paths each,
      // 4 000 of the 5 240 measured tokens on the measurement machine. They
      // also answer nothing the caller asked: call_project_tool only accepts
      // registered roots, so a subproject is never a valid next call. Opt-in.
      if (include_subprojects && topoStore) {
        const subprojects = topoStore.getAllSubprojects().map((s) => ({
          name: s.name,
          repo_root: s.repo_root,
          project_root: s.project_root,
        }));
        if (subprojects.length > 0) result.subprojects = subprojects;
      }

      return { content: [{ type: 'text', text: j(result) }] };
    },
  );

  server.tool(
    'call_project_tool',
    "Relay a trace-mcp tool call to a DIFFERENT registered project than this session's own (cross-project dispatch). Use list_projects first to find valid `project` roots. The named `tool` runs with its normal schema/contract against the target project's already-indexed data — no new indexing or file watching is started for it. Read-only relay (mutating tools still run their own normal effects on the TARGET project). Returns JSON: the target tool's own response verbatim, or `{ error: { code, message, data } }` when `project` isn't registered or `tool` isn't a known tool name.",
    {
      project: z
        .string()
        .min(1)
        .max(1024)
        .describe('Absolute root path of a registered project (see list_projects)'),
      tool: z
        .string()
        .min(1)
        .max(128)
        .describe(
          'Name of a trace-mcp tool to run against that project (e.g. "search", "get_symbol")',
        ),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Arguments to pass to the target tool (default: {})'),
    },
    async ({ project, tool, args }) => {
      const relay = ctx.projectRelay;
      if (!relay) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                error: {
                  code: 'relay_unavailable',
                  message: 'Cross-project relay is not available in this runtime.',
                  data: { reason: 'relay_unavailable' },
                },
              }),
            },
          ],
          isError: true,
        };
      }

      const registered = relay.listRelayTargets();
      const resolvedRoot = path.resolve(project);

      // Mirrors the daemon's "ambiguous project" 400 shape (buildAmbiguousProjectError
      // in src/daemon/mcp-error-response.ts) — same `reason`/`registered` fields,
      // adapted to a tool-result payload rather than a JSON-RPC transport error.
      if (!registered.includes(resolvedRoot)) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                error: {
                  code: 'unknown_project',
                  message:
                    `Project not registered with trace-mcp: ${project}. ` +
                    `Registered roots: ${registered.length > 0 ? registered.join(', ') : '(none)'}`,
                  data: { reason: 'unknown_project', requested: project, registered },
                },
              }),
            },
          ],
          isError: true,
        };
      }

      const opened = await relay.openProject(resolvedRoot);
      if (!opened) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                error: {
                  code: 'unknown_project',
                  message: `Project is registered but could not be opened (never indexed?): ${resolvedRoot}`,
                  data: { reason: 'project_not_opened', requested: project, registered },
                },
              }),
            },
          ],
          isError: true,
        };
      }

      const handler = opened.toolHandlers.get(tool);
      if (!handler) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                error: {
                  code: 'unknown_tool',
                  message: `Tool "${tool}" is not registered on project ${resolvedRoot}.`,
                  data: { reason: 'unknown_tool', tool },
                },
              }),
            },
          ],
          isError: true,
        };
      }

      return handler(args ?? {});
    },
  );
}
