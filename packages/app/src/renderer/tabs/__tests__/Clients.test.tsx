// @vitest-environment jsdom
/**
 * Clients — the design invariants the TRA-295 rebuild has to keep.
 *
 * These assert the things that were wrong on the running app, not the
 * implementation: a wall of accent-filled Connect buttons, a right-aligned
 * grey word "Manual" as the only affordance, and a raw session id where the
 * project name belongs.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Clients } from '../Clients';

const STATUSES = [
  { client: 'claude-code', configPath: '/Users/x/.claude.json', status: 'up_to_date' },
  { client: 'cursor', configPath: null, status: 'missing' },
  { client: 'warp', configPath: null, status: 'unmanageable' },
  {
    client: 'windsurf',
    configPath: '/Users/x/.codeium/mcp.json',
    status: 'stale',
    staleReason: 'alwaysLoad',
  },
];

/* What every configured client looks like the moment after a trace-mcp
   upgrade — the entry that drifted is the one trace-mcp writes, so drift is
   never one row. This is the common state of this screen, not an edge case. */
const ALL_DRIFTED = [
  { client: 'claude-code', configPath: '/Users/x/.claude.json', status: 'stale', staleReason: 'cwd' },
  { client: 'cursor', configPath: '/Users/x/.cursor/mcp.json', status: 'stale', staleReason: 'cwd' },
  { client: 'amp', configPath: '/Users/x/.config/amp/settings.json', status: 'stale', staleReason: 'fields' },
];

/* TRA-614. What the CLI reports once the server key is renamed `trace-mcp` →
   `trace` (TRA-610): the entry still works, so it is not `stale`, and it is not
   `missing` either. Exactly like an upgrade, it lands on every configured
   client at once. */
const ALL_LEGACY = [
  { client: 'claude-code', configPath: '/Users/x/.claude.json', status: 'legacy' },
  { client: 'cursor', configPath: '/Users/x/.cursor/mcp.json', status: 'legacy' },
];

const CLIENTS = [
  {
    id: '401b97c5aaaa',
    name: 'claude-code',
    transport: 'http',
    project: '/Users/x/projects/workdir',
    connectedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  },
];

vi.mock('../../hooks/useDaemon', () => ({
  useDaemon: () => ({
    clients: CLIENTS,
    loading: false,
    connected: true,
    restarting: false,
    restartDaemon: vi.fn(),
    fetchClients: vi.fn(),
  }),
}));

function api(): {
  getMcpClientStatuses: ReturnType<typeof vi.fn>;
  configureMcpClient: ReturnType<typeof vi.fn>;
  updateMcpClients: ReturnType<typeof vi.fn>;
} {
  return (window as unknown as { electronAPI: never }).electronAPI;
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getMcpClientStatuses: vi.fn().mockResolvedValue({ ok: true, statuses: STATUSES }),
    detectMcpClients: vi.fn().mockResolvedValue([]),
    configureMcpClient: vi.fn().mockResolvedValue({ ok: true }),
    updateMcpClients: vi.fn().mockResolvedValue({ ok: true }),
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

it('renders one toolbar with a title and a labelled refresh button', async () => {
  render(<Clients />);
  expect(await screen.findByRole('heading', { name: 'MCP clients', level: 2 })).toBeTruthy();
  // Icon-only, so it needs both an accessible name and a tooltip.
  const refresh = screen.getByRole('button', { name: 'Refresh clients' });
  expect(refresh.getAttribute('title')).toBe('Refresh clients');
});

/* The screen shipped ten accent-filled Connect buttons stacked vertically —
   far past the ~5% accent budget, and HIG reserves prominence for one action
   per region. Nothing on this screen is prominent now. */
it('has no prominent (accent-filled) control anywhere', async () => {
  const { container } = render(<Clients />);
  await screen.findAllByRole('button', { name: 'Connect' });
  expect(container.querySelectorAll('.v-prominent').length).toBe(0);
  for (const b of screen.getAllByRole('button', { name: 'Connect' })) {
    expect(b.className).toContain('v-bordered');
  }
});

/* "Manual" was a right-aligned grey word — an undocumented convention with no
   affordance. It is a button that discloses the actual steps. */
it('offers manual clients a real button that discloses the steps', async () => {
  render(<Clients />);
  // JetBrains AI Assistant and Warp, in declaration order.
  const buttons = await screen.findAllByRole('button', { name: 'Set up manually…' });
  expect(buttons).toHaveLength(2);
  const btn = buttons[1];
  expect(btn.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText(/Settings → Agents/)).toBeNull();

  fireEvent.click(btn);
  expect(btn.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText(/Settings → Agents/)).toBeTruthy();
});

/* Connection state was a grey dot that looked identical for every supported
   client. State is now a word; colour never carries it alone. */
it('states connection with a word, not only a colour', async () => {
  render(<Clients />);
  expect(await screen.findByText('Connected')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Update' }).length).toBeGreaterThan(0);
});

/* `401b97c5 http` was the session row's primary label: a raw id where the name
   goes. The project leads; the id is a monospace caption. */
it('leads a session row with the project, not the session id', async () => {
  render(<Clients />);
  const title = await screen.findByText('workdir');
  expect(title.className).toContain('text-[13px]');

  const caption = screen.getByText(/401b97c5/);
  expect(caption.textContent).toContain('http');
  expect(caption.getAttribute('style')).toContain('--font-mono');
});

it('titles its sections in sentence case', async () => {
  render(<Clients />);
  await waitFor(() => expect(screen.getByText('Supported clients')).toBeTruthy());
  expect(screen.getByText('Active sessions')).toBeTruthy();
  expect(screen.queryByText('Supported Clients')).toBeNull();
  expect(screen.queryByText('Active Sessions')).toBeNull();
});

/* The Claude family takes an enforcement level, which used to be a hand-rolled
   popover. It is the shared Menu, opened from the row's own button. */
it('opens the enforcement-level menu from the Claude row', async () => {
  render(<Clients />);
  const connects = await screen.findAllByRole('button', { name: 'Connect' });
  const claude = connects.find((b) => b.getAttribute('aria-haspopup') === 'menu');
  expect(claude).toBeTruthy();

  fireEvent.click(claude as HTMLElement);
  const menu = await screen.findByRole('menu');
  expect(within(menu).getByRole('menuitem', { name: 'Max' })).toBeTruthy();
});

// ── TRA-497 ──────────────────────────────────────────────────────────────

/* Connect asks which enforcement level to set up at. Update repairs an entry
   that drifted on an upgrade — the level is already in the file, and the only
   thing re-asking can do is overwrite the user's answer with a fresh guess. */
it('repairs a drifted config without asking for an enforcement level', async () => {
  render(<Clients />);
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

  await waitFor(() => expect(api().updateMcpClients).toHaveBeenCalledWith(['windsurf']));
  expect(api().configureMcpClient).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
});

/* Six identical clicks is what this screen costs after every upgrade, and the
   list already sorts the drifted rows into one bucket at the top of it. */
it('offers one action for the whole drifted bucket, and names its size', async () => {
  api().getMcpClientStatuses.mockResolvedValue({ ok: true, statuses: ALL_DRIFTED });
  render(<Clients />);

  const all = await screen.findByRole('button', { name: 'Update all · 3' });
  fireEvent.click(all);

  await waitFor(() => expect(api().updateMcpClients).toHaveBeenCalledTimes(3));
  expect(api().updateMcpClients.mock.calls.map(([names]) => names[0])).toEqual([
    'claude-code',
    'cursor',
    'amp',
  ]);
});

/* One drifted row is not a bucket — the row's own button is the shorter path,
   and a second control that does the same thing is just more to read. */
it('offers no bulk action when a single row has drifted', async () => {
  render(<Clients />);
  await screen.findByRole('button', { name: 'Update' });
  expect(screen.queryByRole('button', { name: /Update all/ })).toBeNull();
});

/* The whole defect this screen shipped with: `configureMcpClient` returned
   `{ ok: false }` for four months and the renderer dropped it on the floor, so
   a button that could not run looked exactly like one with nothing to do. */
it('says on the row when a write failed, and keeps the row actionable', async () => {
  api().updateMcpClients.mockResolvedValue({ ok: false, error: 'Error: EACCES' });
  render(<Clients />);
  fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

  expect(await screen.findByText('Error: EACCES')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
});

// ── TRA-614 ──────────────────────────────────────────────────────────────

/* A legacy entry is not a broken one, and the row has to say which it is. The
   verb does that on its own — calling a rename an "Update" would have called it
   a drift, and a badge beside the button would have said it twice (TRA-479). */
it('flags a legacy entry as legacy, and offers Migrate rather than Update', async () => {
  api().getMcpClientStatuses.mockResolvedValue({ ok: true, statuses: ALL_LEGACY });
  render(<Clients />);

  const buttons = await screen.findAllByRole('button', { name: 'Migrate' });
  expect(buttons).toHaveLength(2);
  expect(buttons[0].getAttribute('title')).toBe('Registered as trace-mcp; init now writes trace');
  expect(screen.queryByText('Update available')).toBeNull();
  expect(screen.queryByText('Legacy')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
});

/* Migrate is `clients update` — the entry gets rewritten under the new key.
   It must not re-run setup, for the same reason Update must not (TRA-497): the
   enforcement level is already in the file and re-asking can only overwrite it. */
it('migrates a legacy entry without re-asking for an enforcement level', async () => {
  api().getMcpClientStatuses.mockResolvedValue({ ok: true, statuses: ALL_LEGACY });
  render(<Clients />);
  fireEvent.click((await screen.findAllByRole('button', { name: 'Migrate' }))[1]);

  await waitFor(() => expect(api().updateMcpClients).toHaveBeenCalledWith(['cursor']));
  expect(api().configureMcpClient).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
});

/* The rename hits every configured client at once, so the bucket action the
   drifted rows already have applies here too — under the row's own verb. */
it('offers one action for the whole legacy bucket, named Migrate all', async () => {
  api().getMcpClientStatuses.mockResolvedValue({ ok: true, statuses: ALL_LEGACY });
  render(<Clients />);

  fireEvent.click(await screen.findByRole('button', { name: 'Migrate all · 2' }));

  await waitFor(() => expect(api().updateMcpClients).toHaveBeenCalledTimes(2));
  expect(api().updateMcpClients.mock.calls.map(([names]) => names[0])).toEqual([
    'claude-code',
    'cursor',
  ]);
});

/* Repairing a drifted entry is the more urgent of the two, so when both are on
   screen the bucket action stays the drifted one rather than silently changing
   what the button does. */
it('keeps the bucket action on the drifted rows when both kinds are present', async () => {
  api().getMcpClientStatuses.mockResolvedValue({
    ok: true,
    statuses: [...ALL_DRIFTED, ...ALL_LEGACY.map((s) => ({ ...s, client: 'windsurf' }))],
  });
  render(<Clients />);

  expect(await screen.findByRole('button', { name: 'Update all · 3' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Migrate all/ })).toBeNull();
});

/* One condition gets one sentence (DESIGN.md §5): this screen used to phrase
   the dead daemon in its own words, two tabs from Workspace phrasing it in
   Workspace's. Both read DaemonDownPane now. */
it('states an unreachable daemon in the same words as every other surface', async () => {
  vi.resetModules();
  vi.doMock('../../hooks/useDaemon', () => ({
    useDaemon: () => ({
      clients: [],
      loading: false,
      connected: false,
      restarting: false,
      restartDaemon: vi.fn(),
      fetchClients: vi.fn(),
    }),
  }));
  const { Clients: Down } = await import('../Clients');
  render(<Down />);

  expect(await screen.findByText("The daemon isn't running")).toBeTruthy();
  expect(screen.queryByText('Daemon not reachable')).toBeNull();
});

// ── TRA-479 ──────────────────────────────────────────────────────────────

/* "Windsurf · Connect" was the one row on this screen that said nothing: it
   could not tell a client whose config sits right there, one click from
   working, apart from one that is not on the machine at all — while every row
   above it carried a path. The daemon knew the difference and did not report
   it. */
it('says whether an unconfigured client has a config file at all', async () => {
  api().getMcpClientStatuses.mockResolvedValue({
    ok: true,
    statuses: [
      {
        client: 'windsurf',
        configPath: '/Users/x/.windsurf/mcp.json',
        status: 'missing',
        configExists: true,
      },
      {
        client: 'continue',
        configPath: '/Users/x/.continue/config.json',
        status: 'missing',
        configExists: false,
      },
    ],
  });
  render(<Clients />);

  expect(await screen.findByText('~/.windsurf/mcp.json')).toBeTruthy();
  expect(screen.getAllByText('No config file found')).toHaveLength(1);
});

/* A daemon older than the field reports neither fact, and inventing one is
   worse than the bare row this replaces. */
it('claims nothing about a config file when the daemon does not report one', async () => {
  api().getMcpClientStatuses.mockResolvedValue({
    ok: true,
    statuses: [{ client: 'windsurf', configPath: '/Users/x/.windsurf/mcp.json', status: 'missing' }],
  });
  render(<Clients />);

  await screen.findAllByRole('button', { name: 'Connect' });
  expect(screen.queryByText('No config file found')).toBeNull();
  expect(screen.queryByText('~/.windsurf/mcp.json')).toBeNull();
});

/* Six rows saying "Update available" beside six buttons saying "Update", under
   a header already counting them, is one condition said three ways (DESIGN.md
   §5). The verb says it once. */
it('does not repeat the row action back as a badge', async () => {
  api().getMcpClientStatuses.mockResolvedValue({ ok: true, statuses: ALL_DRIFTED });
  render(<Clients />);

  const buttons = await screen.findAllByRole('button', { name: 'Update' });
  expect(buttons).toHaveLength(3);
  expect(screen.queryByText('Update available')).toBeNull();
  /* The reason the row drifted survives the badge, on the button itself. */
  expect(buttons[0].getAttribute('title')).toBe('Drifted field: cwd');
});

/* Codex config is TOML: we detect the entry and cannot compare it. Rendering
   that as the same green "Connected" as a config we verified claims a check we
   never ran. */
it('does not report presence-only detection as a verified connection', async () => {
  api().getMcpClientStatuses.mockResolvedValue({
    ok: true,
    statuses: [
      { client: 'claude-code', configPath: '/Users/x/.claude.json', status: 'up_to_date' },
      { client: 'codex', configPath: '/Users/x/.codex/config.toml', status: 'unknown' },
    ],
  });
  render(<Clients />);

  expect(await screen.findByText('Configured')).toBeTruthy();
  expect(screen.getAllByText('Connected')).toHaveLength(1);
});

// ── TRA-1645 ──────────────────────────────────────────────────────────────

/* A write Claude.app refuses must say what to do: the row's red caption
   truncates to one 11px line, so the refusal opens a sheet with the steps. */
const DESKTOP_STALE = [
  {
    client: 'claude-desktop',
    configPath: '/Users/x/Library/Application Support/Claude/claude_desktop_config.json',
    status: 'stale',
    staleReason: 'legacy-key',
  },
];

const RUNNING_ERROR =
  'Error: Claude.app is running — it will overwrite mcpServers. Quit Claude.app completely (Cmd+Q on macOS), then re-run `trace-mcp init`.';

it('opens a blocking sheet when Claude.app refuses the update', async () => {
  api().getMcpClientStatuses.mockResolvedValue({ ok: true, statuses: DESKTOP_STALE });
  api().updateMcpClients.mockResolvedValue({ ok: false, error: RUNNING_ERROR });
  render(<Clients />);

  fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

  expect(await screen.findByRole('dialog')).toBeTruthy();
  expect(screen.getByText('Quit Claude.app first')).toBeTruthy();
  expect(
    screen.getByText(
      '1. Quit Claude.app completely (Cmd+Q on macOS) — closing the window is not enough.',
    ),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Retry update' })).toBeTruthy();
});

it('retries the update from the sheet and closes it', async () => {
  api().getMcpClientStatuses.mockResolvedValue({ ok: true, statuses: DESKTOP_STALE });
  api().updateMcpClients.mockResolvedValue({ ok: false, error: RUNNING_ERROR });
  render(<Clients />);

  fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
  await screen.findByRole('dialog');

  api().updateMcpClients.mockResolvedValue({ ok: true });
  fireEvent.click(screen.getByRole('button', { name: 'Retry update' }));

  await waitFor(() => expect(api().updateMcpClients).toHaveBeenCalledTimes(2));
  expect(api().updateMcpClients.mock.calls[1]).toEqual([['claude-desktop']]);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('dismisses the sheet without retrying', async () => {
  api().getMcpClientStatuses.mockResolvedValue({ ok: true, statuses: DESKTOP_STALE });
  api().updateMcpClients.mockResolvedValue({ ok: false, error: RUNNING_ERROR });
  render(<Clients />);

  fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
  await screen.findByRole('dialog');

  fireEvent.click(screen.getByRole('button', { name: 'Got it' }));

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api().updateMcpClients).toHaveBeenCalledTimes(1);
});

it('closes the sheet on Escape', async () => {
  api().getMcpClientStatuses.mockResolvedValue({ ok: true, statuses: DESKTOP_STALE });
  api().updateMcpClients.mockResolvedValue({ ok: false, error: RUNNING_ERROR });
  render(<Clients />);

  fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
  await screen.findByRole('dialog');

  fireEvent.keyDown(document, { key: 'Escape' });

  expect(screen.queryByRole('dialog')).toBeNull();
});

it('opens no sheet for other write errors', async () => {
  api().getMcpClientStatuses.mockResolvedValue({ ok: true, statuses: DESKTOP_STALE });
  api().updateMcpClients.mockResolvedValue({ ok: false, error: 'Error: EACCES' });
  render(<Clients />);

  fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

  expect(await screen.findByText('Error: EACCES')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});

// ── TRA-1647 ──────────────────────────────────────────────────────────────

/* A write that landed but isn't picked up until restart reads as "Update did
   nothing". Right after a successful Update the row names the next step in
   its caption — outranking the path the way a failure does. */
it('names the restart step in the caption right after a successful update', async () => {
  const stale = {
    client: 'windsurf',
    configPath: '/Users/x/.windsurf/mcp.json',
    status: 'stale',
    staleReason: 'fields',
    pickup: 'reload-window',
  };
  const fresh = { ...stale, status: 'up_to_date', staleReason: undefined };
  api().getMcpClientStatuses
    .mockResolvedValueOnce({ ok: true, statuses: [stale] })
    .mockResolvedValue({ ok: true, statuses: [fresh] });
  api().updateMcpClients.mockResolvedValue({ ok: true });
  render(<Clients />);

  fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

  expect(
    await screen.findByText('Reload the Windsurf window to apply the update'),
  ).toBeTruthy();
});

/* The caption hint is transient (it clears on manual refresh); the Connected
   indicator keeps the pickup step on its tooltip afterwards. */
it('keeps the pickup step on the Connected tooltip', async () => {
  api().getMcpClientStatuses.mockResolvedValue({
    ok: true,
    statuses: [
      {
        client: 'claude-code',
        configPath: '/Users/x/.claude.json',
        status: 'up_to_date',
        pickup: 'restart-session',
      },
    ],
  });
  render(<Clients />);

  const connected = await screen.findByText('Connected');
  expect(connected.getAttribute('title')).toBe(
    'Restart the Claude Code session to apply the update',
  );
});

/* Cline reconnects itself (McpHub watches its own settings file) — no next
   step to name, so the row keeps its path caption and the indicator no
   tooltip. */
it('says nothing about restart for a hot-reload client', async () => {
  api().getMcpClientStatuses.mockResolvedValue({
    ok: true,
    statuses: [
      {
        client: 'cline',
        configPath: '/Users/x/cline_mcp_settings.json',
        status: 'up_to_date',
        pickup: 'hot-reload',
      },
    ],
  });
  render(<Clients />);

  const connected = await screen.findByText('Connected');
  expect(connected.getAttribute('title')).toBeNull();
  expect(screen.getByText('~/cline_mcp_settings.json')).toBeTruthy();
  expect(screen.queryByText(/to apply the update/)).toBeNull();
});

/* The to-verify half of the matrix (cline, kilocode, antigravity, gemini-cli,
   kimi, opencode, hermes) had no rows at all — a hint for them had nowhere to
   land. All nineteen clients render; only the two manual ones skip Connect. */
it('renders every known client row', async () => {
  api().getMcpClientStatuses.mockResolvedValue({ ok: true, statuses: [] });
  render(<Clients />);

  for (const label of [
    'Cline',
    'KiloCode',
    'Antigravity',
    'Gemini CLI',
    'Kimi Code CLI',
    'OpenCode',
    'Hermes Agent',
  ]) {
    expect(await screen.findByText(label)).toBeTruthy();
  }
  expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(17);
});
