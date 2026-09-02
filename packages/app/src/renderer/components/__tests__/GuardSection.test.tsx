// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GuardSection, promotionLabel, untilLabel } from '../GuardSection';

const ROOT = '/tmp/project';

interface StatusShape {
  health: 'ok' | 'stalled' | 'down' | 'unknown';
  mode: 'strict' | 'coach' | 'off';
  bypassUntil?: number;
  reason?: 'heartbeat_stale' | 'channel_quiet' | 'never_started';
  reasonSeconds?: number;
  coachExpiresAt?: number;
  autoPromoted?: boolean;
}

function stubGuard(status: StatusShape, calls: string[] = []) {
  const guard = {
    initialize: vi.fn(async () => {
      calls.push('initialize');
      return { initialized: true, mode: status.mode };
    }),
    status: vi.fn(async () => {
      calls.push('status');
      return status;
    }),
    setMode: vi.fn(async () => ({ ok: true })),
    setBypass: vi.fn(async () => ({ ok: true })),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { guard };
  return guard;
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

/* ── The functional half: nothing has called `initialize` since the workspace
      rebuild, so a project never got its coach grace period. ─────────────── */

it('initializes the project before reading its status', async () => {
  const calls: string[] = [];
  const guard = stubGuard({ health: 'ok', mode: 'coach' }, calls);
  render(<GuardSection root={ROOT} />);

  await waitFor(() => expect(guard.status).toHaveBeenCalled());
  expect(guard.initialize).toHaveBeenCalledWith(ROOT);
  expect(calls[0]).toBe('initialize');
});

it('still reports status when initialization throws', async () => {
  const guard = stubGuard({ health: 'down', mode: 'strict', reason: 'never_started' });
  guard.initialize.mockRejectedValueOnce(new Error('read-only volume'));
  render(<GuardSection root={ROOT} />);

  expect(await screen.findByText('Not running')).toBeTruthy();
});

/* ── Status is a tone AND a glyph AND a word ──────────────────────────────── */

it.each([
  ['ok', 'Active'],
  ['stalled', 'Stalled'],
  ['down', 'Not running'],
  ['unknown', 'Unknown'],
] as const)('spells %s out as "%s" with a glyph, not a colour alone', async (health, label) => {
  stubGuard({ health, mode: 'strict' });
  const { container } = render(<GuardSection root={ROOT} />);

  const badge = await screen.findByText(label);
  expect(badge.closest('.lx-badge')?.querySelector('svg')).toBeTruthy();
  expect(container.querySelector('.lx-badge')).toBeTruthy();
});

/* The badge names the condition; the line names the cause and the next step.
   Restating "not running" under a red badge that already says it is what
   TRA-490 filed, so the assertion is on the advice, not on any sentence. */
it('follows the badge with the cause and the one thing to do next', async () => {
  stubGuard({ health: 'down', mode: 'strict', reason: 'never_started' });
  render(<GuardSection root={ROOT} />);

  const line = await screen.findByText(/hasn't started trace-mcp in this project yet/);
  expect(line.textContent).toContain('Restart it');
  expect(screen.getAllByText(/Not running/)).toHaveLength(1);
});

it('dates a stopped server instead of printing a raw second count', async () => {
  stubGuard({ health: 'down', mode: 'strict', reason: 'heartbeat_stale', reasonSeconds: 412 });
  render(<GuardSection root={ROOT} />);

  expect(await screen.findByText(/trace-mcp last checked in 6 minutes ago/)).toBeTruthy();
});

it('says nothing under the card when the cause carries no advice', async () => {
  stubGuard({ health: 'down', mode: 'strict' });
  const { container } = render(<GuardSection root={ROOT} />);

  await screen.findByText('Not running');
  expect(container.querySelectorAll('p')).toHaveLength(0);
});

/* ── Mode ─────────────────────────────────────────────────────────────────── */

it('offers the three modes as one segmented control and writes the chosen one', async () => {
  const guard = stubGuard({ health: 'ok', mode: 'coach' });
  render(<GuardSection root={ROOT} />);

  const group = await screen.findByRole('group', { name: 'Guard mode' });
  expect(group.className).toContain('lx-seg');
  expect(screen.getByRole('button', { name: 'Coach' }).getAttribute('aria-pressed')).toBe('true');

  fireEvent.click(screen.getByRole('button', { name: 'Off' }));
  await waitFor(() => expect(guard.setMode).toHaveBeenCalledWith(ROOT, 'off'));
});

it('shows when coach auto-promotes instead of announcing it in a toast', async () => {
  const in6Days = Math.floor(Date.now() / 1000) + 6 * 86_400;
  stubGuard({ health: 'ok', mode: 'coach', coachExpiresAt: in6Days });
  render(<GuardSection root={ROOT} />);

  expect(await screen.findByText('Switches to strict')).toBeTruthy();
  expect(screen.getByText(promotionLabel(in6Days, Date.now()))).toBeTruthy();
});

/* ── Bypass ───────────────────────────────────────────────────────────────── */

it('offers a ten-minute pause when enforcement is running', async () => {
  const guard = stubGuard({ health: 'ok', mode: 'strict' });
  render(<GuardSection root={ROOT} />);

  fireEvent.click(await screen.findByRole('button', { name: /Pause for 10 minutes/ }));
  await waitFor(() => expect(guard.setBypass).toHaveBeenCalledWith(ROOT, 10));
});

it('reads out an active bypass with its end and a way back', async () => {
  const in9Min = Math.floor(Date.now() / 1000) + 9 * 60;
  const guard = stubGuard({ health: 'ok', mode: 'strict', bypassUntil: in9Min });
  render(<GuardSection root={ROOT} />);

  expect(await screen.findByText(/Resumes in 9 minutes/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Resume now/ }));
  await waitFor(() => expect(guard.setBypass).toHaveBeenCalledWith(ROOT, 0));
});

it('renders nothing rather than a reassuring row when the bridge is missing', () => {
  const { container } = render(<GuardSection root={ROOT} />);
  expect(container.innerHTML).toBe('');
});

/* ── Time wording ─────────────────────────────────────────────────────────── */

it('words a future instant in the future tense', () => {
  const now = 1_700_000_000_000;
  const s = now / 1000;
  expect(untilLabel(s + 30, now)).toBe('in under a minute');
  expect(untilLabel(s + 60, now)).toBe('in 1 minute');
  expect(untilLabel(s + 9 * 60, now)).toBe('in 9 minutes');
  expect(untilLabel(s + 3 * 3600, now)).toBe('in 3 hours');
  expect(untilLabel(s + 6 * 86_400, now)).toBe('in 6 days');
  // A bypass that has already lapsed reads as over, never as a negative.
  expect(untilLabel(s - 500, now)).toBe('in under a minute');
});
