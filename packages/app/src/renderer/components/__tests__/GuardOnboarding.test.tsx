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

it('closes silently without a dialog when Claude Code is not installed', async () => {
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

it('exposes the panel as a labelled modal dialog and focuses its primary action', async () => {
  stubGuard({ checkCliVersion: { notInstalled: true } });
  render(<GuardOnboarding onClose={() => {}} />);

  const dialog = await screen.findByRole('dialog');
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  const labelId = dialog.getAttribute('aria-labelledby');
  expect(labelId).toBeTruthy();
  expect(document.getElementById(labelId as string)?.textContent).toBe('Set up trace-mcp guard');
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Got it' })),
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

it('dismisses on backdrop click but not on a click inside the panel', async () => {
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

  fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
  await screen.findByText('Installing hook…');

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

  const install = await screen.findByRole('button', { name: 'Install' });
  expect(install.className).toContain('ws-primary');
  expect(screen.getByRole('button', { name: 'Skip' }).className).toContain('ws-chipbtn');
});
