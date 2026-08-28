// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GuardOnboarding, isOnboardingDone } from '../GuardOnboarding';

interface GuardStubs {
  checkCliVersion?: unknown;
  installStatus?: unknown;
}

function stubGuard({ checkCliVersion, installStatus }: GuardStubs) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    guard: {
      checkCliVersion: vi.fn().mockResolvedValue(checkCliVersion),
      installStatus: vi.fn().mockResolvedValue(installStatus),
      install: vi.fn().mockResolvedValue({ ok: true, scriptPath: '/tmp/hook.mjs' }),
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

it('renders nothing while detection is still in flight', () => {
  stubGuard({ checkCliVersion: new Promise(() => {}) });
  const { container } = render(<GuardOnboarding onClose={() => {}} />);
  expect(container.innerHTML).toBe('');
});

it('closes silently without a sheet when Claude Code is not installed', async () => {
  stubGuard({
    checkCliVersion: { current: '1.51.1', required: '1.51.0' },
    installStatus: { installed: false, claudeDetected: false },
  });
  const onClose = vi.fn();
  render(<GuardOnboarding onClose={onClose} />);

  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(isOnboardingDone()).toBe(true);
});

it('exposes the panel as a labelled modal sheet and focuses its primary action', async () => {
  stubGuard({ checkCliVersion: { notInstalled: true } });
  render(<GuardOnboarding onClose={() => {}} />);

  const dialog = await screen.findByRole('dialog');
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.className).toContain('lx-sheet');
  const labelId = dialog.getAttribute('aria-labelledby');
  expect(labelId).toBeTruthy();
  expect(document.getElementById(labelId as string)?.textContent).toBe(
    'Install the trace-mcp CLI',
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Done' })),
  );
});

it('dismisses on Escape and remembers the acknowledgement', async () => {
  stubGuard({ checkCliVersion: { notInstalled: true } });
  const onClose = vi.fn();
  render(<GuardOnboarding onClose={onClose} />);
  await screen.findByRole('dialog');

  fireEvent.keyDown(window, { key: 'Escape' });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(isOnboardingDone()).toBe(true);
});

it('dismisses on backdrop click but not on a click inside the sheet', async () => {
  stubGuard({ checkCliVersion: { notInstalled: true } });
  const onClose = vi.fn();
  render(<GuardOnboarding onClose={onClose} />);
  const dialog = await screen.findByRole('dialog');

  fireEvent.click(dialog);
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(dialog.parentElement as HTMLElement);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('does not dismiss while the hook install is in flight', async () => {
  stubGuard({
    checkCliVersion: { current: '1.51.1', required: '1.51.0' },
    installStatus: { installed: false, claudeDetected: true },
  });
  const onClose = vi.fn();
  const api = (window as unknown as { electronAPI: { guard: { install: unknown } } }).electronAPI;
  api.guard.install = vi.fn(() => new Promise(() => {}));
  render(<GuardOnboarding onClose={onClose} />);

  fireEvent.click(await screen.findByRole('button', { name: 'Install guard' }));
  await screen.findByText("Writing the hook into Claude Code's settings…");

  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);

  expect(onClose).not.toHaveBeenCalled();
});

it('uses the Lattice Button primitive for its actions', async () => {
  stubGuard({
    checkCliVersion: { current: '1.51.1', required: '1.51.0' },
    installStatus: { installed: false, claudeDetected: true },
  });
  render(<GuardOnboarding onClose={() => {}} />);

  const install = await screen.findByRole('button', { name: 'Install guard' });
  expect(install.className).toContain('v-prominent');
  expect(screen.getByRole('button', { name: 'Not now' }).className).toContain('v-bordered');
});

/* TRA-295: `user-select: none` is set globally on body, so before this the one
   thing the sheet exists to communicate could not be selected, let alone
   copied. The command is a selectable field with a copy button. */
it('renders the install command as a selectable, copyable field', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  stubGuard({ checkCliVersion: { notInstalled: true } });
  render(<GuardOnboarding onClose={() => {}} />);

  const code = await screen.findByText('npm install -g trace-mcp');
  expect(code.closest('.lx-sheet-command')).not.toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('npm install -g trace-mcp'));
});

/* A modal that leaks Tab to the Workspace behind it is a trap on the very
   first screen of the app. */
it('traps Tab inside the sheet', async () => {
  stubGuard({
    checkCliVersion: { current: '1.51.1', required: '1.51.0' },
    installStatus: { installed: false, claudeDetected: true },
  });
  const outside = document.createElement('button');
  outside.textContent = 'behind the sheet';
  document.body.appendChild(outside);

  render(<GuardOnboarding onClose={() => {}} />);
  const dialog = await screen.findByRole('dialog');
  const focusables = [...dialog.querySelectorAll('button')];
  expect(focusables.length).toBeGreaterThan(1);

  // Tab off the last control wraps to the first, rather than reaching `outside`.
  focusables[focusables.length - 1].focus();
  fireEvent.keyDown(window, { key: 'Tab' });
  expect(document.activeElement).toBe(focusables[0]);

  // Shift-Tab off the first wraps to the last.
  fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(focusables[focusables.length - 1]);

  outside.remove();
});
