// @vitest-environment jsdom
/* The updater's honest states, in the two places that report them: the sidebar
   card and the app menu's header (TRA-363).

   The stuck-bundle cases this file was written for (TRA-357/TRA-431) are gone
   with the updater that produced them — macOS installs its own updates now, so
   "the CLI moved and the bundle did not" is no longer a state that exists
   (TRA-437). What is left is what still can go wrong: a stale npm root MCP
   clients launch from, and the download itself. */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateCard } from '../App';
import { AppMenu } from '../components/AppMenu';
import { useUpdateCheck } from '../update-check';

type CheckResult = {
  available: boolean;
  current?: string;
  latest?: string;
  lastChecked?: number;
  staleRoots?: { root: string; version: string }[];
};

/** Set by mockApi so a test can drive electron-updater's progress events. */
let emitProgress: ((percent: number) => void) | null = null;

function mockApi(check: CheckResult, openExternal = vi.fn(), applyUpdate = vi.fn()) {
  emitProgress = null;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    checkForUpdate: vi.fn().mockResolvedValue(check),
    checkPendingUpdate: vi.fn().mockResolvedValue({ pending: false }),
    applyUpdate,
    restartApp: vi.fn(),
    openExternal,
    onUpdateProgress: (cb: (p: { percent: number }) => void) => {
      emitProgress = (percent) => cb({ percent });
      return () => {
        emitProgress = null;
      };
    },
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

/* TRA-429: the visual layer. The card was the last tile in the window still
   hand-rolling its own material and its own button class; `Updating…` was a
   0.4-opacity capsule with nothing moving behind it, which is what a hung app
   looks like. */
describe('update card presentation', () => {
  it('is built from the Lattice primitives, not a private button class', async () => {
    mockApi({ available: true, current: '3.1.1', latest: '3.2.0', lastChecked: Date.now() });

    const { container } = render(<Card />);

    await screen.findByText(/v3\.2\.0 available/);
    expect(container.querySelector('.btn-prominent')).toBeNull();
    // The one action is the shared prominent capsule.
    const button = screen.getByRole('button', { name: 'Update' });
    expect(button.className).toContain('lx-btn');
    expect(button.className).toContain('v-prominent');
  });

  it('keeps the updating capsule readable and reports real progress', async () => {
    // A download that never settles — that IS the state under test.
    mockApi({ available: true, current: '3.1.1', latest: '3.2.0' }, vi.fn(), () => new Promise(() => {}));

    const { container } = render(<Card />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

    const button = await screen.findByRole('button', { name: 'Updating…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // `is-status` is what keeps the label at full opacity — a 0.4 capsule is
    // the thing this state is not allowed to be any more.
    expect(button.className).toContain('is-status');

    // electron-updater reports transferred bytes, so the bar is determinate
    // and starts honest rather than at an invented position (TRA-437).
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('aria-valuenow')).toBe('0');

    await act(async () => emitProgress?.(42.4));
    await waitFor(() =>
      expect(
        container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),
      ).toBe('42'),
    );
    expect(
      (container.querySelector('[role="progressbar"]') as HTMLElement).style.getPropertyValue(
        '--update-progress',
      ),
    ).toBe('42.4%');
  });

  it('shows no progress bar until the update is actually running', async () => {
    mockApi({ available: true, current: '3.1.1', latest: '3.2.0' });

    const { container } = render(<Card />);

    await screen.findByRole('button', { name: 'Update' });
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });
});
