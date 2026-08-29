// @vitest-environment jsdom
/* TRA-357: the updater's honest states. The bug that made this file necessary
   was not the suppression logic — clicking Update again really would do
   nothing — but its presentation: a bundle three majors behind rendered as a
   green "Up to date".

   TRA-363 moved "up to date" out of the sidebar and into the app menu's
   header, so the same promise now has two places to be broken and both are
   checked here: the card must name the stuck state, and the header must never
   call it current. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateCard } from '../App';
import { AppMenu } from '../components/AppMenu';
import { useUpdateCheck } from '../update-check';

type CheckResult = {
  available: boolean;
  current?: string;
  latest?: string;
  stuck?: boolean;
  lastChecked?: number;
  staleRoots?: { root: string; version: string }[];
};

function mockApi(check: CheckResult, openExternal = vi.fn()) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    checkForUpdate: vi.fn().mockResolvedValue(check),
    checkPendingUpdate: vi.fn().mockResolvedValue({ pending: false }),
    applyUpdate: vi.fn(),
    restartApp: vi.fn(),
    openExternal,
  };
  return openExternal;
}

/** The sidebar card, on the real hook — same wiring App uses. */
function Card() {
  return <UpdateCard update={useUpdateCheck()} />;
}

/** The app menu, on the same hook — the other reader of that state. */
function Menu() {
  const update = useUpdateCheck();
  return (
    <AppMenu
      update={update.state}
      checking={update.checking}
      onCheckForUpdate={update.check}
      appearance="auto"
      onAppearanceChange={() => {}}
      onSettings={() => {}}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe('update states', () => {
  it('never renders a stuck bundle as "Up to date"', async () => {
    mockApi({ available: false, current: '1.50.0', latest: '3.1.1', stuck: true });

    render(<Card />);

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.queryByText(/Up to date/)).toBeNull();
    expect(screen.getByText(/needs a manual install/)).toBeTruthy();
    // Both versions have to be visible: the one they have and the one they don't.
    expect(screen.getByText(/still v1\.50\.0/)).toBeTruthy();
    expect(screen.getByText(/Download v3\.1\.1/)).toBeTruthy();
  });

  it('offers the release download as the way out', async () => {
    const openExternal = mockApi({
      available: false,
      current: '1.50.0',
      latest: '3.1.1',
      stuck: true,
    });

    render(<Card />);

    const button = await screen.findByText(/Download v3\.1\.1/);
    button.click();
    expect(openExternal).toHaveBeenCalledWith(
      expect.stringContaining('github.com/nikolai-vysotskyi/trace-mcp/releases'),
    );
  });

  it('does not call a stuck bundle current in the app menu either', async () => {
    mockApi({ available: false, current: '1.50.0', latest: '3.1.1', stuck: true });

    render(<Menu />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /trace-mcp/ }).textContent).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: /trace-mcp/ }));
    const status = document.querySelector('.ws-ctx-header .status');
    await waitFor(() => expect(status?.textContent).toContain('needs a manual install'));
    expect(status?.className).toContain('is-warn');
  });

  /* TRA-364, re-homed by TRA-363: the stale-root warning used to live on the
     sidebar status row. That row is gone, so the same signal has to reach the
     menu header — otherwise a machine with an out-of-date sibling npm root
     reads as fully current again, which is the bug TRA-364 fixed.

     TRA-377 narrowed what `staleRoots` means: the main process now sends only
     the root MCP clients actually launch from, so this line always describes a
     consequence the user has, and always comes with the command that ends it. */
  it('names the consequence and the fix when clients run a stale root', async () => {
    mockApi({
      available: false,
      current: '3.1.1',
      latest: '3.1.1',
      staleRoots: [{ root: '/opt/homebrew/lib/node_modules', version: '2.9.0' }],
    });

    render(<Menu />);
    fireEvent.click(screen.getByRole('button', { name: /trace-mcp/ }));
    const status = document.querySelector('.ws-ctx-header .status');
    await waitFor(() => expect(status?.textContent).toContain('MCP clients still run v2.9.0'));
    expect(status?.className).toContain('is-warn');
    const title = status?.querySelector('.text')?.getAttribute('title') ?? '';
    expect(title).toContain('/opt/homebrew/lib/node_modules/trace-mcp');
    expect(title).toContain('npm install -g trace-mcp@latest');
  });

  it('offers the exact command to copy, and only in that state', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    mockApi({
      available: false,
      current: '3.1.1',
      latest: '3.1.1',
      staleRoots: [{ root: '/opt/homebrew/lib/node_modules', version: '2.9.0' }],
    });
    const { unmount } = render(<Menu />);
    fireEvent.click(screen.getByRole('button', { name: /trace-mcp/ }));
    fireEvent.click(await screen.findByText('Copy update command'));
    expect(writeText).toHaveBeenCalledWith(
      '/opt/homebrew/lib/node_modules/../../bin/npm install -g trace-mcp@latest',
    );
    unmount();

    // A machine whose clients run the current root gets no warning and no item.
    mockApi({ available: false, current: '3.1.1', latest: '3.1.1', lastChecked: Date.now() });
    render(<Menu />);
    fireEvent.click(screen.getByRole('button', { name: /trace-mcp/ }));
    await waitFor(() =>
      expect(document.querySelector('.ws-ctx-header .status')?.className).toContain('is-ok'),
    );
    expect(screen.queryByText('Copy update command')).toBeNull();
  });

  it('a genuinely current bundle says so in the menu, and nowhere else', async () => {
    mockApi({ available: false, current: '3.1.1', latest: '3.1.1', lastChecked: Date.now() });

    const { container } = render(<Card />);
    render(<Menu />);

    fireEvent.click(screen.getByRole('button', { name: /trace-mcp/ }));
    await waitFor(() =>
      expect(document.querySelector('.ws-ctx-header .name')?.textContent).toBe('Version 3.1.1'),
    );
    expect(document.querySelector('.ws-ctx-header .status')?.textContent).toContain('Up to date');
    // No card in the sidebar when there is nothing to do about it.
    expect(container.querySelector('.update-card')).toBeNull();
  });
});
