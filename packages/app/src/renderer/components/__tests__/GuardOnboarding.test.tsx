// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GuardOnboarding, isOnboardingDone } from '../GuardOnboarding';

function stubApi() {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    daemonSetupState: vi.fn().mockResolvedValue({ phase: 'ready' }),
    daemonProcessAlive: vi.fn().mockResolvedValue(true),
    detectMcpClients: vi.fn().mockResolvedValue([
      { name: 'cursor', configPath: '/Users/test/.cursor/mcp.json', hasTraceMcp: false },
    ]),
    configureMcpClient: vi.fn().mockResolvedValue({ ok: true }),
    guessFirstProject: vi.fn().mockResolvedValue({ path: '/Users/test/Projects/my-app', name: 'my-app' }),
    openProjectTab: vi.fn().mockResolvedValue({ ok: true }),
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

it('renders the setup wizard inside GuardOnboarding', async () => {
  stubApi();
  render(<GuardOnboarding onClose={() => {}} />);

  const dialog = await screen.findByRole('dialog');
  expect(dialog).toBeTruthy();
  expect(dialog.className).toContain('lx-sheet');
  await screen.findByText('Connect coding assistants');
});

it('dismisses on backdrop press and marks onboarding done', async () => {
  stubApi();
  const onClose = vi.fn();
  render(<GuardOnboarding onClose={onClose} />);

  const dialog = await screen.findByRole('dialog');
  fireEvent.click(dialog.parentElement as HTMLElement);

  expect(onClose).toHaveBeenCalled();
  expect(isOnboardingDone()).toBe(true);
});
