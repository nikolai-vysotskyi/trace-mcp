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

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getMcpClientStatuses: vi.fn().mockResolvedValue({ ok: true, statuses: STATUSES }),
    detectMcpClients: vi.fn().mockResolvedValue([]),
    configureMcpClient: vi.fn().mockResolvedValue({ ok: true }),
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
  expect(screen.getByText('Update available')).toBeTruthy();
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
