/**
 * Behavioral tests for src/cli/clients.ts — `trace-mcp clients status`.
 *
 * Drives the real `clientsCommand` through `.parseAsync` with
 * `../init/mcp-client.js` and `../project-root.js` mocked. No real MCP
 * client config files are read or written.
 */
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpClientStatus } from '../../src/init/mcp-client.js';

vi.mock('../../src/init/mcp-client.js', () => ({
  getMcpClientStatuses: vi.fn(),
  configureMcpClients: vi.fn(() => []),
  getProjectPromptsStatus: vi.fn(),
  MCP_CLIENT_PICKUP: { cursor: 'restart-app', cline: 'hot-reload' },
}));

vi.mock('../../src/project-root.js', () => ({
  findProjectRoot: vi.fn(() => '/proj/current'),
}));

const { clientsCommand } = await import('../../src/cli/clients.js');
const { configureMcpClients, getMcpClientStatuses, getProjectPromptsStatus } = await import(
  '../../src/init/mcp-client.js'
);
const { findProjectRoot } = await import('../../src/project-root.js');

const mockGetMcpClientStatuses = vi.mocked(getMcpClientStatuses);
const mockConfigureMcpClients = vi.mocked(configureMcpClients);
const mockGetProjectPromptsStatus = vi.mocked(getProjectPromptsStatus);
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
  mockGetProjectPromptsStatus.mockReturnValue({
    projectRoot: '/proj/current',
    claudeMdExists: true,
    claudeMdHasTraceBlock: true,
    agentsMdExists: false,
    agentsMdHasTraceBlock: false,
    projectHook: 'missing',
    projectHookPath: null,
    tweakccPrompts: false,
  });
  process.exitCode = undefined;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

// OTHER_ROOT is POSIX-only as a literal: on Windows path.resolve() yields
// a drive-qualified path, so resolve once and assert against that.
const OTHER_ROOT = path.resolve('/proj/other');

const SAMPLE_STATUSES: McpClientStatus[] = [
  {
    client: 'claude-code',
    configPath: '/home/.claude.json',
    status: 'up_to_date',
    pickup: 'restart-session',
  },
  { client: 'cursor', configPath: null, status: 'missing', pickup: 'restart-app' },
  {
    client: 'windsurf',
    configPath: '/home/.windsurf/config.json',
    status: 'stale',
    staleReason: 'alwaysLoad',
    pickup: 'reload-window',
  },
  {
    client: 'jetbrains-ai',
    configPath: '/home/.jetbrains/mcp.json',
    status: 'unmanageable',
    pickup: null,
  },
  {
    client: 'codex',
    configPath: '/home/.codex/config.toml',
    status: 'unknown',
    pickup: 'restart-session',
  },
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
      { client: 'cursor', configPath: null, status: 'missing', pickup: 'restart-app' },
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
      {
        client: 'cursor',
        configPath: '/home/.cursor/mcp.json',
        status: 'up_to_date',
        pickup: 'restart-app',
      },
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

  /* TRA-1933: per-file Update from the app names the project root explicitly
     (see the status --project test above for why the cwd cannot be trusted). */
  it('passes an explicit --project root through to the writer', async () => {
    await run(['update', 'cursor', '--scope', 'project', '--project', OTHER_ROOT]);

    expect(mockFindProjectRoot).not.toHaveBeenCalled();
    expect(mockConfigureMcpClients).toHaveBeenCalledWith(['cursor'], OTHER_ROOT, {
      scope: 'project',
      dryRun: undefined,
    });
  });

  it('exits non-zero when a write failed', async () => {
    mockConfigureMcpClients.mockReturnValue([
      { target: '/home/.cursor/mcp.json', action: 'skipped', detail: 'Error: EACCES' },
    ]);

    await run(['update', 'cursor']);

    expect(process.exitCode).toBe(1);
  });

  /* TRA-1645: refusing the write while Claude.app runs is a failure, not a
     quiet no-op — the detail carries the `Error:` marker this exit code (and
     the desktop app's blocked sheet) keys on. */
  it('exits non-zero when Claude.app refused the write', async () => {
    mockConfigureMcpClients.mockReturnValue([
      {
        target: '/home/Library/Application Support/Claude/claude_desktop_config.json',
        action: 'skipped',
        detail:
          'Error: Claude.app is running — it will overwrite mcpServers. Quit Claude.app completely (Cmd+Q on macOS), then re-run `trace-mcp init`.',
      },
    ]);

    await run(['update', 'claude-desktop']);

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

  /* TRA-1647: a write that landed but isn't picked up until restart reads as
     "Update did nothing" — the human report names the next step per client. */
  it('names the restart step after a successful write', async () => {
    mockConfigureMcpClients.mockReturnValue([
      { target: '/home/.cursor/mcp.json', action: 'updated', detail: 'cursor (global)' },
    ]);

    await run(['update', 'cursor']);

    expect(printed()).toContain('→ Restart Cursor to apply the update.');
  });

  it('says nothing about restart when the client hot-reloads', async () => {
    mockConfigureMcpClients.mockReturnValue([
      { target: '/home/cline.json', action: 'updated', detail: 'cline (global)' },
    ]);

    await run(['update', 'cline']);

    expect(printed()).not.toContain('→');
  });

  it('says nothing about restart when nothing was written', async () => {
    mockConfigureMcpClients.mockReturnValue([
      { target: '/home/.cursor/mcp.json', action: 'skipped', detail: 'Would configure cursor' },
    ]);

    await run(['update', 'cursor', '--dry-run']);

    expect(printed()).not.toContain('→');
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

  /* TRA-1933: the desktop app shells out from inside its bundle, whose cwd is
     never the project on screen — an explicit `--project` must win over the
     cwd auto-detect, and the app must not depend on markers existing there. */
  it('prefers --project over the cwd auto-detect', async () => {
    mockGetMcpClientStatuses.mockReturnValue(SAMPLE_STATUSES);

    await run(['status', '--json', '--project', OTHER_ROOT]);

    expect(mockFindProjectRoot).not.toHaveBeenCalled();
    expect(mockGetMcpClientStatuses).toHaveBeenCalledWith(OTHER_ROOT, 'global', undefined);
    expect(JSON.parse(printed()).projectRoot).toBe(OTHER_ROOT);
  });
});

describe('clients prompts', () => {
  it('emits the project probe as JSON', async () => {
    await run(['prompts', '--json', '--project', OTHER_ROOT]);

    expect(mockGetProjectPromptsStatus).toHaveBeenCalledWith(OTHER_ROOT);
    const parsed = JSON.parse(printed());
    expect(parsed).toMatchObject({
      projectRoot: '/proj/current',
      claudeMdExists: true,
      claudeMdHasTraceBlock: true,
      projectHook: 'missing',
      tweakccPrompts: false,
    });
  });

  it('auto-detects the project root when --project is omitted', async () => {
    await run(['prompts', '--json']);

    expect(mockGetProjectPromptsStatus).toHaveBeenCalledWith('/proj/current');
  });

  it('prints one line per prompt surface for humans', async () => {
    await run(['prompts', '--project', OTHER_ROOT]);

    const out = printed();
    expect(out).toContain('CLAUDE.md');
    expect(out).toContain('AGENTS.md');
    expect(out).toContain('hook');
    expect(out).toContain('tweakcc');
  });
});
