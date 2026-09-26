/**
 * Behavioral tests for src/cli/clients.ts — `trace-mcp clients disconnect`.
 *
 * Drives the real `clientsCommand` through `.parseAsync` with
 * `../init/mcp-client.js` and `../project-root.js` mocked. No real MCP
 * client config files are read or written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpClientStatus } from '../../src/init/mcp-client.js';

vi.mock('../../src/init/mcp-client.js', () => ({
  getMcpClientStatuses: vi.fn(),
  configureMcpClients: vi.fn(() => []),
  removeMcpClients: vi.fn(() => []),
  MCP_CLIENT_PICKUP: { cursor: 'restart-app', cline: 'hot-reload' },
}));

vi.mock('../../src/project-root.js', () => ({
  findProjectRoot: vi.fn(() => '/proj/current'),
}));

const { clientsCommand } = await import('../../src/cli/clients.js');
const { removeMcpClients, getMcpClientStatuses } = await import('../../src/init/mcp-client.js');
const { findProjectRoot } = await import('../../src/project-root.js');

const mockRemoveMcpClients = vi.mocked(removeMcpClients);
const mockGetMcpClientStatuses = vi.mocked(getMcpClientStatuses);
const mockFindProjectRoot = vi.mocked(findProjectRoot);

async function run(args: string[]): Promise<void> {
  await clientsCommand.parseAsync(['node', 'trace-mcp-clients', ...args]);
}

let logSpy: ReturnType<typeof vi.spyOn>;

function printed(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindProjectRoot.mockReturnValue('/proj/current');
  mockRemoveMcpClients.mockReturnValue([]);
  process.exitCode = undefined;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

const SAMPLE_STATUSES: McpClientStatus[] = [
  {
    client: 'cursor',
    configPath: '/home/.cursor/mcp.json',
    status: 'up_to_date',
    pickup: 'restart-app',
  },
  {
    client: 'windsurf',
    configPath: '/home/.windsurf/mcp.json',
    status: 'stale',
    staleReason: 'command',
    pickup: 'reload-window',
  },
  { client: 'amp', configPath: null, status: 'missing', pickup: 'restart-session' },
];

describe('clients disconnect', () => {
  it('disconnects every configured client when no names are given', async () => {
    mockGetMcpClientStatuses.mockReturnValue(SAMPLE_STATUSES);

    await run(['disconnect']);

    expect(mockRemoveMcpClients).toHaveBeenCalledWith(['cursor', 'windsurf'], '/proj/current', {
      scope: 'global',
      dryRun: undefined,
    });
  });

  it('disconnects exactly the named clients, configured or not', async () => {
    await run(['disconnect', 'cursor', 'amp']);

    expect(mockGetMcpClientStatuses).not.toHaveBeenCalled();
    expect(mockRemoveMcpClients).toHaveBeenCalledWith(['cursor', 'amp'], '/proj/current', {
      scope: 'global',
      dryRun: undefined,
    });
  });

  it('says so and calls nothing when no entry exists anywhere', async () => {
    mockGetMcpClientStatuses.mockReturnValue([
      { client: 'amp', configPath: null, status: 'missing', pickup: 'restart-session' },
    ]);

    await run(['disconnect']);

    expect(mockRemoveMcpClients).not.toHaveBeenCalled();
    expect(printed()).toContain('No client config holds a trace-mcp entry.');
    expect(process.exitCode).toBeUndefined();
  });

  it('passes project scope and --dry-run through', async () => {
    await run(['disconnect', 'cursor', '--scope', 'project', '--dry-run']);

    expect(mockRemoveMcpClients).toHaveBeenCalledWith(['cursor'], '/proj/current', {
      scope: 'project',
      dryRun: true,
    });
  });

  /* TRA-1933: per-file Disconnect from the app names the project root
     explicitly — the bundled cwd is never the project on screen. */
  it('passes an explicit --project root through to the remover', async () => {
    await run(['disconnect', 'cursor', '--scope', 'project', '--project', '/proj/other']);

    expect(mockFindProjectRoot).not.toHaveBeenCalled();
    expect(mockRemoveMcpClients).toHaveBeenCalledWith(['cursor'], '/proj/other', {
      scope: 'project',
      dryRun: undefined,
    });
  });

  it('stays zero on already_absent — the idempotent second run', async () => {
    mockRemoveMcpClients.mockReturnValue([
      { target: '/home/.cursor/mcp.json', action: 'already_absent', detail: 'cursor (global)' },
    ]);

    await run(['disconnect', 'cursor']);

    expect(printed()).toContain('already_absent');
    expect(process.exitCode).toBeUndefined();
  });

  it('exits non-zero when a removal failed', async () => {
    mockRemoveMcpClients.mockReturnValue([
      { target: '/home/.cursor/mcp.json', action: 'skipped', detail: 'Error: EACCES' },
    ]);

    await run(['disconnect', 'cursor']);

    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero when Claude.app refused the removal', async () => {
    mockRemoveMcpClients.mockReturnValue([
      {
        target: '/home/Library/Application Support/Claude/claude_desktop_config.json',
        action: 'skipped',
        detail: 'Error: Claude.app is running — it will overwrite mcpServers.',
      },
    ]);

    await run(['disconnect', 'claude-desktop']);

    expect(process.exitCode).toBe(1);
  });

  it('stays zero for a dry run, which also reports every row as skipped', async () => {
    mockRemoveMcpClients.mockReturnValue([
      { target: '/home/.cursor/mcp.json', action: 'skipped', detail: 'Would disconnect cursor' },
    ]);

    await run(['disconnect', 'cursor', '--dry-run']);

    expect(process.exitCode).toBeUndefined();
  });

  it('emits scope, projectRoot, clients and steps as JSON', async () => {
    mockRemoveMcpClients.mockReturnValue([
      { target: '/home/.cursor/mcp.json', action: 'removed', detail: 'cursor (global)' },
    ]);

    await run(['disconnect', 'cursor', '--json']);

    const parsed = JSON.parse(printed());
    expect(parsed).toMatchObject({
      scope: 'global',
      projectRoot: '/proj/current',
      clients: ['cursor'],
    });
    expect(parsed.steps[0].action).toBe('removed');
  });

  /* Removal side of TRA-1647: the entry is gone but the running server lingers
     until restart — without the hint the row reads as "disconnect did nothing". */
  it('names the unload step after a successful removal', async () => {
    mockRemoveMcpClients.mockReturnValue([
      { target: '/home/.cursor/mcp.json', action: 'removed', detail: 'cursor (global)' },
    ]);

    await run(['disconnect', 'cursor']);

    expect(printed()).toContain('→ Restart Cursor to unload the server.');
  });

  it('says nothing about restart when the client hot-reloads', async () => {
    mockRemoveMcpClients.mockReturnValue([
      { target: '/home/cline.json', action: 'removed', detail: 'cline (global)' },
    ]);

    await run(['disconnect', 'cline']);

    expect(printed()).not.toContain('→');
  });

  it('says nothing about restart when nothing was removed', async () => {
    mockRemoveMcpClients.mockReturnValue([
      { target: '/home/.cursor/mcp.json', action: 'already_absent', detail: 'cursor (global)' },
    ]);

    await run(['disconnect', 'cursor']);

    expect(printed()).not.toContain('→');
  });
});
