// @vitest-environment jsdom
/**
 * Clients — TRA-1933 per-file visibility, project prompts, Multica agents.
 *
 * The global-only view keeps today's exact behaviour (covered by
 * Clients.test.tsx); these assert the new layers: a project picker fed by
 * the daemon's registered projects, expandable rows with independent
 * per-file statuses and file-level actions, the read-only prompts card,
 * and the read-only Multica section.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { Clients } from '../Clients';

const GLOBAL_STATUSES = [
  { client: 'claude-code', configPath: '/Users/x/.claude.json', status: 'up_to_date' },
  { client: 'cursor', configPath: '/Users/x/.cursor/mcp.json', status: 'up_to_date' },
  { client: 'claude-desktop', configPath: '/Users/x/claude.json', status: 'up_to_date' },
  { client: 'continue', configPath: null, status: 'missing' },
  { client: 'jetbrains-ai', configPath: null, status: 'unmanageable' },
];

const PROJECT_STATUSES = [
  { client: 'claude-code', configPath: '/proj/a/.mcp.json', status: 'stale', staleReason: 'cwd' },
  { client: 'cursor', configPath: '/proj/a/.cursor/mcp.json', status: 'missing' },
  // Same path in both scopes — claude-desktop has no project layer.
  { client: 'claude-desktop', configPath: '/Users/x/claude.json', status: 'up_to_date' },
  { client: 'continue', configPath: '/proj/a/.continue/mcpServers/mcp.json', status: 'missing' },
  { client: 'jetbrains-ai', configPath: null, status: 'unmanageable' },
];

const PROMPTS = {
  projectRoot: '/proj/a',
  claudeMdExists: true,
  claudeMdHasTraceBlock: true,
  agentsMdExists: false,
  agentsMdHasTraceBlock: false,
  projectHook: 'missing',
  projectHookPath: null,
  tweakccPrompts: true,
};

const MULTICA = {
  ok: true,
  available: true,
  agents: [
    {
      id: 'a1',
      name: 'Lead',
      status: 'idle',
      traceAssigned: true,
      traceEnabled: true,
      customConfig: 'present',
      preset: 'review',
    },
    {
      id: 'a2',
      name: 'Nope',
      status: 'idle',
      traceAssigned: false,
      traceEnabled: false,
      customConfig: 'none',
      preset: null,
    },
  ],
};

vi.mock('../../hooks/useDaemon', () => ({
  useDaemon: () => ({
    clients: [],
    loading: false,
    connected: true,
    restarting: false,
    restartDaemon: vi.fn(),
    fetchClients: vi.fn(),
    projects: [
      { root: '/proj/a', status: 'ready' },
      { root: '/x/trace-mcp', status: 'ready' },
      { root: '/y/trace-mcp', status: 'ready' },
      { root: '/m/sub/workdir', status: 'ready' },
      { root: '/n/sub/workdir', status: 'ready' },
    ],
  }),
}));

type ApiMock = {
  getMcpClientStatuses: ReturnType<typeof vi.fn>;
  configureMcpClient: ReturnType<typeof vi.fn>;
  updateMcpClients: ReturnType<typeof vi.fn>;
  disconnectMcpClients: ReturnType<typeof vi.fn>;
  getProjectPrompts: ReturnType<typeof vi.fn>;
  getMulticaAgents: ReturnType<typeof vi.fn>;
};

function api(): ApiMock {
  return (window as unknown as { electronAPI: ApiMock }).electronAPI;
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getMcpClientStatuses: vi.fn(async (scope?: string) =>
      scope === 'project' ? { ok: true, statuses: PROJECT_STATUSES } : { ok: true, statuses: GLOBAL_STATUSES },
    ),
    detectMcpClients: vi.fn().mockResolvedValue([]),
    configureMcpClient: vi.fn().mockResolvedValue({ ok: true }),
    updateMcpClients: vi.fn().mockResolvedValue({ ok: true }),
    disconnectMcpClients: vi.fn().mockResolvedValue({ ok: true }),
    getProjectPrompts: vi.fn().mockResolvedValue({ ok: true, prompts: PROMPTS }),
    getMulticaAgents: vi.fn().mockResolvedValue(MULTICA),
  };
});

async function selectProject(): Promise<void> {
  render(<Clients />);
  // Global-only first: no project probe, no disclosure.
  await waitFor(() => expect(api().getMcpClientStatuses).toHaveBeenCalledWith('global'));
  const picker = screen.getByLabelText('Project files for');
  fireEvent.change(picker, { target: { value: '/proj/a' } });
  await waitFor(() =>
    expect(api().getMcpClientStatuses).toHaveBeenCalledWith('project', '/proj/a'),
  );
}

/** The outer wrapper holding a client's main row and its project disclosure. */
function rowWrapper(label: string): HTMLElement {
  const labelBox = screen.getByText(label).closest('div.flex-1');
  expect(labelBox?.parentElement?.parentElement).toBeTruthy();
  return labelBox?.parentElement?.parentElement as HTMLElement;
}

function toggleFor(label: string): HTMLElement {
  const mainRow = screen.getByText(label).closest('div.flex-1')?.parentElement as HTMLElement;
  return within(mainRow).getByRole('button', { name: 'Show config files' });
}

/** A file-level (small) button inside an expanded disclosure. */
function projectButtonFor(label: string, btnName: string): HTMLElement {
  const buttons = within(rowWrapper(label)).getAllByRole('button', { name: btnName });
  const small = buttons.filter((b) => b.className.includes('sz-small'));
  expect(small).toHaveLength(1);
  return small[0];
}

it('offers the daemon projects and probes the selected one explicitly', async () => {
  await selectProject();

  expect(api().getProjectPrompts).toHaveBeenCalledWith('/proj/a');
  // Independent statuses: the project layer is a second call, not a guess.
  const calls = api().getMcpClientStatuses.mock.calls;
  expect(calls).toContainEqual(['global']);
  expect(calls).toContainEqual(['project', '/proj/a']);
});

it('expands a row to a project file with its own actions', async () => {
  await selectProject();

  // Cursor's project file is missing while its global entry is connected:
  // the disclosure carries the project Connect, not the global state.
  fireEvent.click(toggleFor('Cursor'));

  const connect = projectButtonFor('Cursor', 'Connect');
  fireEvent.click(connect);
  await waitFor(() =>
    expect(api().updateMcpClients).toHaveBeenCalledWith(['cursor'], 'project', '/proj/a'),
  );
  // Global configure path untouched by a project click.
  expect(api().configureMcpClient).not.toHaveBeenCalled();
});

it('updates a drifted project file through the project scope', async () => {
  await selectProject();

  fireEvent.click(toggleFor('Claude Code'));

  expect(within(rowWrapper('Claude Code')).getByText(/\.mcp\.json/)).toBeTruthy();
  fireEvent.click(projectButtonFor('Claude Code', 'Update'));
  await waitFor(() =>
    expect(api().updateMcpClients).toHaveBeenCalledWith(['claude-code'], 'project', '/proj/a'),
  );
});

it('names the global-only case instead of offering a second entry', async () => {
  await selectProject();

  fireEvent.click(toggleFor('Claude Desktop'));

  expect(
    within(rowWrapper('Claude Desktop')).getByText(/Global config only — no project layer/),
  ).toBeTruthy();
});

/* TRA-1974 fix 1: duplicate basenames are unusable in a native select, so the
   label disambiguates (base · parent, full path on second collision) and the
   control carries the full root as its title. */
it('disambiguates duplicate project basenames in the picker', async () => {
  render(<Clients />);
  await screen.findByLabelText('Project files for');

  const options = within(screen.getByLabelText('Project files for')).getAllByRole(
    'option',
  ) as HTMLOptionElement[];
  const labels = options.map((o) => o.textContent);
  expect(labels).toContain('a');
  expect(labels).toContain('trace-mcp · x');
  expect(labels).toContain('trace-mcp · y');
  expect(labels).toContain('/m/sub/workdir');
  expect(labels).toContain('/n/sub/workdir');
});

/* TRA-1974 fix 2: no disclosure when both scopes are empty — it would open
   onto a note that is wrong there. A globally-connected row with a missing
   project file keeps its chevron (the project Connect matters). */
it('hides the disclosure where both scopes hold nothing', async () => {
  await selectProject();

  const continueRow = rowWrapper('Continue');
  expect(
    within(continueRow).queryByRole('button', { name: 'Show config files' }),
  ).toBeNull();
  const jbRow = rowWrapper('JetBrains AI Assistant');
  expect(
    within(jbRow).queryByRole('button', { name: 'Show config files' }),
  ).toBeNull();
  // Positive control: Cursor (global connected, project missing) keeps it.
  expect(
    within(rowWrapper('Cursor')).getByRole('button', { name: 'Show config files' }),
  ).toBeTruthy();
});

it('shows the read-only prompts card for the selected project', async () => {
  await selectProject();

  expect(await screen.findByText('Project setup')).toBeTruthy();
  expect(screen.getByText('trace block present')).toBeTruthy();
  // No writer in the card: the only buttons on screen belong to client rows.
  const card = screen.getByText('Project setup').closest('section');
  expect(within(card as HTMLElement).queryAllByRole('button').length).toBe(0);
});

it('lists Multica agents with their trace wiring, read-only', async () => {
  render(<Clients />);

  expect(await screen.findByText('Multica agents')).toBeTruthy();
  expect(screen.getByText('Lead')).toBeTruthy();
  expect(screen.getByText('trace enabled')).toBeTruthy();
  expect(screen.getByText('no trace entry')).toBeTruthy();
  expect(screen.getByText('preset review')).toBeTruthy();
  const section = screen.getByText('Multica agents').closest('section');
  expect(within(section as HTMLElement).queryAllByRole('button').length).toBe(0);
});

it('says so when the multica CLI is absent, without failing the screen', async () => {
  api().getMulticaAgents.mockResolvedValue({ ok: false, available: false });
  render(<Clients />);

  expect(await screen.findByText(/multica CLI not found/)).toBeTruthy();
  // The rest of the screen still works.
  expect(screen.getByText('Supported clients')).toBeTruthy();
});
