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
}));

vi.mock('../../src/project-root.js', () => ({
  findProjectRoot: vi.fn(() => '/proj/current'),
}));

const { clientsCommand } = await import('../../src/cli/clients.js');
const { getMcpClientStatuses } = await import('../../src/init/mcp-client.js');
const { findProjectRoot } = await import('../../src/project-root.js');

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
