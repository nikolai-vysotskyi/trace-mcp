/**
 * Behavioral tests for src/cli/clients.ts — `trace-mcp clients status`.
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
}));

vi.mock('../../src/project-root.js', () => ({
  findProjectRoot: vi.fn(() => '/proj/current'),
}));

const { clientsCommand } = await import('../../src/cli/clients.js');
const { configureMcpClients, getMcpClientStatuses } = await import('../../src/init/mcp-client.js');
const { findProjectRoot } = await import('../../src/project-root.js');

const mockGetMcpClientStatuses = vi.mocked(getMcpClientStatuses);
const mockConfigureMcpClients = vi.mocked(configureMcpClients);
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
  mockConfigureMcpClients.mockReturnValue([]);
  process.exitCode = undefined;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

const SAMPLE_STATUSES: McpClientStatus[] = [
  { client: 'claude-code', configPath: '/home/.claude.json', status: 'up_to_date' },
  { client: 'cursor', configPath: null, status: 'missing' },
  {
    client: 'windsurf',
    configPath: '/home/.windsurf/config.json',
    status: 'stale',
    staleReason: 'alwaysLoad',
  },
  { client: 'jetbrains-ai', configPath: '/home/.jetbrains/mcp.json', status: 'unmanageable' },
  { client: 'codex', configPath: '/home/.codex/config.toml', status: 'unknown' },
];

describe('clients status — human output', () => {
  it('prints a per-client status tag for every status kind', async () => {
    mockGetMcpClientStatuses.mockReturnValue(SAMPLE_STATUSES);

    await run(['status']);

    const out = printed();
    expect(out).toContain('scope: global');
    expect(out).toMatch(/claude-code\s+\[ok\]/);
    expect(out).toMatch(/cursor\s+\[install\]/);
    expect(out).toMatch(/windsurf\s+\[update\]/);
    expect(out).toContain('(drift: alwaysLoad)');
    expect(out).toMatch(/jetbrains-ai\s+\[manual\]/);
    expect(out).toMatch(/codex\s+\[present\]/);
  });

  it('renders "—" for a missing configPath', async () => {
    mockGetMcpClientStatuses.mockReturnValue([
      { client: 'cursor', configPath: null, status: 'missing' },
    ]);

    await run(['status']);

    expect(printed()).toContain('—');
  });

  it('defaults to global scope and passes it through', async () => {
    mockGetMcpClientStatuses.mockReturnValue([]);

    await run(['status']);

    expect(mockGetMcpClientStatuses).toHaveBeenCalledWith('/proj/current', 'global', undefined);
  });

  it('passes project scope through when --scope project is given', async () => {
    mockGetMcpClientStatuses.mockReturnValue([]);

    await run(['status', '--scope', 'project']);

    expect(mockGetMcpClientStatuses).toHaveBeenCalledWith('/proj/current', 'project', undefined);
  });

  it('treats an unrecognized --scope value as global', async () => {
    mockGetMcpClientStatuses.mockReturnValue([]);

    await run(['status', '--scope', 'bogus']);

    expect(mockGetMcpClientStatuses).toHaveBeenCalledWith('/proj/current', 'global', undefined);
  });

  /* A packaged desktop app shells out from inside its bundle, where no root
     marker exists and findProjectRoot throws. Global scope no longer needs a
     project root (TRA-501), so that must not take the command down. */
  it('falls back to cwd when no project root can be found', async () => {
    mockFindProjectRoot.mockImplementation(() => {
      throw new Error('Could not find project root');
    });
    mockGetMcpClientStatuses.mockReturnValue([]);

    await run(['status']);

    expect(mockGetMcpClientStatuses).toHaveBeenCalledWith(process.cwd(), 'global', undefined);
  });

  it('parses --client into a trimmed, filtered array', async () => {
    mockGetMcpClientStatuses.mockReturnValue([]);

    await run(['status', '--client', 'claude-code, cursor ,,windsurf']);

    expect(mockGetMcpClientStatuses).toHaveBeenCalledWith('/proj/current', 'global', [
      'claude-code',
      'cursor',
      'windsurf',
    ]);
  });
});

describe('clients update', () => {
  it('repairs every stale client when no names are given', async () => {
    mockGetMcpClientStatuses.mockReturnValue(SAMPLE_STATUSES);

    await run(['update']);

    expect(mockConfigureMcpClients).toHaveBeenCalledWith(['windsurf'], '/proj/current', {
      scope: 'global',
      dryRun: undefined,
    });
  });

  it('repairs exactly the named clients, drifted or not', async () => {
    await run(['update', 'cursor', 'amp']);

    expect(mockGetMcpClientStatuses).not.toHaveBeenCalled();
    expect(mockConfigureMcpClients).toHaveBeenCalledWith(['cursor', 'amp'], '/proj/current', {
      scope: 'global',
      dryRun: undefined,
    });
  });

  /* The whole reason this command exists rather than another `init` flag: an
     update must not re-open the enforcement-level question the user already
     answered. configureMcpClients writes the MCP entry and nothing else. */
  it('does not write hooks, tweakcc or agent_behavior', async () => {
    await run(['update', 'cursor']);

    const [, , opts] = mockConfigureMcpClients.mock.calls[0];
    expect(Object.keys(opts).sort()).toEqual(['dryRun', 'scope']);
  });

  it('says so and calls nothing when every config already matches', async () => {
    mockGetMcpClientStatuses.mockReturnValue([
      { client: 'cursor', configPath: '/home/.cursor/mcp.json', status: 'up_to_date' },
    ]);

    await run(['update']);

    expect(mockConfigureMcpClients).not.toHaveBeenCalled();
    expect(printed()).toContain('already matches');
    expect(process.exitCode).toBeUndefined();
  });

  it('passes project scope and --dry-run through', async () => {
    await run(['update', 'cursor', '--scope', 'project', '--dry-run']);

    expect(mockConfigureMcpClients).toHaveBeenCalledWith(['cursor'], '/proj/current', {
      scope: 'project',
      dryRun: true,
    });
  });

  it('exits non-zero when a write failed', async () => {
    mockConfigureMcpClients.mockReturnValue([
      { target: '/home/.cursor/mcp.json', action: 'skipped', detail: 'Error: EACCES' },
    ]);

    await run(['update', 'cursor']);

    expect(process.exitCode).toBe(1);
  });

  it('stays zero for a dry run, which also reports every row as skipped', async () => {
    mockConfigureMcpClients.mockReturnValue([
      { target: '/home/.cursor/mcp.json', action: 'skipped', detail: 'Would configure cursor' },
    ]);

    await run(['update', 'cursor', '--dry-run']);

    expect(process.exitCode).toBeUndefined();
  });

  it('emits scope, projectRoot, clients and steps as JSON', async () => {
    mockConfigureMcpClients.mockReturnValue([
      { target: '/home/.cursor/mcp.json', action: 'updated', detail: 'cursor (global)' },
    ]);

    await run(['update', 'cursor', '--json']);

    const parsed = JSON.parse(printed());
    expect(parsed).toMatchObject({
      scope: 'global',
      projectRoot: '/proj/current',
      clients: ['cursor'],
    });
    expect(parsed.steps[0].action).toBe('updated');
  });
});

describe('clients status --json', () => {
  it('emits a JSON payload with scope, projectRoot, and statuses', async () => {
    mockGetMcpClientStatuses.mockReturnValue(SAMPLE_STATUSES);

    await run(['status', '--json']);

    const parsed = JSON.parse(printed());
    expect(parsed.scope).toBe('global');
    expect(parsed.projectRoot).toBe('/proj/current');
    expect(parsed.statuses).toHaveLength(5);
    expect(parsed.statuses[0]).toEqual(SAMPLE_STATUSES[0]);
  });
});
