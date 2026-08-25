/**
 * TRA-93 (Option B): `list_projects` + `call_project_tool`.
 *
 * Handlers are captured via a fake `server.tool(...)` (same convention as
 * wave2-toon.test.ts) so these are pure unit tests of the tool logic against
 * a stubbed `ctx.projectRelay` — no real McpServer, no real second project.
 * Cross-project dispatch against a REAL second project (and the stdio
 * lazy-load path) is covered by src/daemon/__tests__/project-relay.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ProjectRelay, ServerContext, ToolResponse } from '../../../server/types.js';
import { registerProjectsTools } from '../projects.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResponse>;

interface CapturedTool {
  name: string;
  schemaShape: Record<string, z.ZodTypeAny>;
  handler: Handler;
}

function makeCapturingServer(): { server: unknown; captured: CapturedTool[] } {
  const captured: CapturedTool[] = [];
  const server = {
    tool: (
      name: string,
      _description: string,
      schemaShape: Record<string, z.ZodTypeAny>,
      handler: Handler,
    ) => {
      captured.push({ name, schemaShape, handler });
    },
  };
  return { server, captured };
}

function findTool(captured: CapturedTool[], name: string): CapturedTool {
  const tool = captured.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} was not registered`);
  return tool;
}

function ctxStub(overrides: Record<string, unknown> = {}): ServerContext {
  const stub = {
    projectRoot: '/tmp/fake-project',
    config: {},
    registry: { getActiveFrameworkPlugins: () => ({ isErr: () => true }) },
    topoStore: null,
    projectRelay: null,
    j: (v: unknown) => JSON.stringify(v),
    ...overrides,
  };
  return stub as unknown as ServerContext;
}

function parseText(response: ToolResponse): unknown {
  return JSON.parse(response.content[0]!.text);
}

describe('list_projects', () => {
  it('reports registered projects from the registry', async () => {
    vi.doMock('../../../registry.js', () => ({
      listProjects: () => [
        { root: '/repo/a', name: 'a', type: 'single', lastIndexed: '2026-01-01T00:00:00.000Z' },
        { root: '/repo/b', name: 'b', type: 'single', lastIndexed: null },
      ],
    }));
    vi.resetModules();
    const { registerProjectsTools: register } = await import('../projects.js');

    const { server, captured } = makeCapturingServer();
    register(server as never, ctxStub());
    const { handler } = findTool(captured, 'list_projects');

    const result = parseText(await handler({})) as { projects: unknown[]; total: number };
    expect(result.total).toBe(2);
    expect(result.projects).toEqual([
      { root: '/repo/a', name: 'a', type: 'single', lastIndexed: '2026-01-01T00:00:00.000Z' },
      { root: '/repo/b', name: 'b', type: 'single', lastIndexed: null },
    ]);

    vi.doUnmock('../../../registry.js');
    vi.resetModules();
  });

  it('includes subprojects when ctx.topoStore is available, omits the key otherwise', async () => {
    const { server, captured } = makeCapturingServer();
    const topoStore = {
      getAllSubprojects: () => [{ name: 'sub', repo_root: '/repo/sub', project_root: '/repo' }],
    };
    registerProjectsTools(server as never, ctxStub({ topoStore }));
    const { handler } = findTool(captured, 'list_projects');

    const result = parseText(await handler({})) as { subprojects?: unknown[] };
    expect(result.subprojects).toEqual([
      { name: 'sub', repo_root: '/repo/sub', project_root: '/repo' },
    ]);

    const { server: server2, captured: captured2 } = makeCapturingServer();
    registerProjectsTools(server2 as never, ctxStub({ topoStore: null }));
    const { handler: handler2 } = findTool(captured2, 'list_projects');
    const result2 = parseText(await handler2({})) as { subprojects?: unknown[] };
    expect(result2.subprojects).toBeUndefined();
  });
});

describe('call_project_tool', () => {
  it('reports relay_unavailable when ctx.projectRelay is not wired', async () => {
    const { server, captured } = makeCapturingServer();
    registerProjectsTools(server as never, ctxStub({ projectRelay: null }));
    const { handler } = findTool(captured, 'call_project_tool');

    const response = await handler({ project: '/repo/a', tool: 'get_project_map', args: {} });
    expect(response.isError).toBe(true);
    const body = parseText(response) as { error: { code: string } };
    expect(body.error.code).toBe('relay_unavailable');
  });

  it('returns a structured unknown_project error listing what IS registered', async () => {
    const relay: ProjectRelay = {
      listRelayTargets: () => ['/repo/a', '/repo/b'],
      openProject: vi.fn(async () => null),
      dispose: () => undefined,
    };
    const { server, captured } = makeCapturingServer();
    registerProjectsTools(server as never, ctxStub({ projectRelay: relay }));
    const { handler } = findTool(captured, 'call_project_tool');

    const response = await handler({ project: '/repo/unknown', tool: 'get_project_map', args: {} });
    expect(response.isError).toBe(true);
    const body = parseText(response) as {
      error: { code: string; data: { reason: string; registered: string[]; requested: string } };
    };
    expect(body.error.code).toBe('unknown_project');
    expect(body.error.data.reason).toBe('unknown_project');
    expect(body.error.data.registered).toEqual(['/repo/a', '/repo/b']);
    expect(body.error.data.requested).toBe('/repo/unknown');
    // openProject must not even be attempted for a root that isn't registered.
    expect(relay.openProject).not.toHaveBeenCalled();
  });

  it('returns unknown_project when the project is registered but openProject() cannot open it', async () => {
    const relay: ProjectRelay = {
      listRelayTargets: () => ['/repo/a'],
      openProject: vi.fn(async () => null),
      dispose: () => undefined,
    };
    const { server, captured } = makeCapturingServer();
    registerProjectsTools(server as never, ctxStub({ projectRelay: relay }));
    const { handler } = findTool(captured, 'call_project_tool');

    const response = await handler({ project: '/repo/a', tool: 'get_project_map', args: {} });
    expect(response.isError).toBe(true);
    const body = parseText(response) as { error: { code: string; data: { reason: string } } };
    expect(body.error.code).toBe('unknown_project');
    expect(body.error.data.reason).toBe('project_not_opened');
  });

  it('returns a structured unknown_tool error for a tool name not registered on the target project', async () => {
    const relay: ProjectRelay = {
      listRelayTargets: () => ['/repo/a'],
      openProject: vi.fn(async () => ({ toolHandlers: new Map() })),
      dispose: () => undefined,
    };
    const { server, captured } = makeCapturingServer();
    registerProjectsTools(server as never, ctxStub({ projectRelay: relay }));
    const { handler } = findTool(captured, 'call_project_tool');

    const response = await handler({ project: '/repo/a', tool: 'not_a_real_tool', args: {} });
    expect(response.isError).toBe(true);
    const body = parseText(response) as { error: { code: string; data: { tool: string } } };
    expect(body.error.code).toBe('unknown_tool');
    expect(body.error.data.tool).toBe('not_a_real_tool');
  });

  it('dispatches to the target project handler and returns its response verbatim, forwarding args', async () => {
    const targetHandler = vi.fn(
      async (args: Record<string, unknown>): Promise<ToolResponse> => ({
        content: [{ type: 'text', text: JSON.stringify({ echoed: args }) }],
      }),
    );
    const relay: ProjectRelay = {
      listRelayTargets: () => ['/repo/a'],
      openProject: vi.fn(async () => ({ toolHandlers: new Map([['get_symbol', targetHandler]]) })),
      dispose: () => undefined,
    };
    const { server, captured } = makeCapturingServer();
    registerProjectsTools(server as never, ctxStub({ projectRelay: relay }));
    const { handler } = findTool(captured, 'call_project_tool');

    const response = await handler({
      project: '/repo/a',
      tool: 'get_symbol',
      args: { fqn: 'Foo.bar' },
    });

    expect(response.isError).toBeUndefined();
    expect(targetHandler).toHaveBeenCalledWith({ fqn: 'Foo.bar' });
    expect(parseText(response)).toEqual({ echoed: { fqn: 'Foo.bar' } });
  });

  it('resolves relative-looking project paths before checking membership (path.resolve)', async () => {
    const mapHandler = vi.fn(
      async (): Promise<ToolResponse> => ({
        content: [{ type: 'text', text: '{}' }],
      }),
    );
    const relay: ProjectRelay = {
      listRelayTargets: () => [process.cwd()],
      openProject: vi.fn(async () => ({
        toolHandlers: new Map([['get_project_map', mapHandler]]),
      })),
      dispose: () => undefined,
    };
    const { server, captured } = makeCapturingServer();
    registerProjectsTools(server as never, ctxStub({ projectRelay: relay }));
    const { handler } = findTool(captured, 'call_project_tool');

    const response = await handler({ project: '.', tool: 'get_project_map', args: {} });
    expect(response.isError).toBeUndefined();
  });
});
