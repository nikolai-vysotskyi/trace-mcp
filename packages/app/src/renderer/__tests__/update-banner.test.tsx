// @vitest-environment jsdom
/* TRA-357: the updater's honest states. The bug that made this file necessary
   was not the suppression logic — clicking Update again really would do
   nothing — but its presentation: a bundle three majors behind rendered as a
   green "Up to date". */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from '../App';

type CheckResult = {
  available: boolean;
  current?: string;
  latest?: string;
  stuck?: boolean;
  lastChecked?: number;
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

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe('UpdateBanner', () => {
  it('never renders a stuck bundle as "Up to date"', async () => {
    mockApi({ available: false, current: '1.50.0', latest: '3.1.1', stuck: true });

    render(<UpdateBanner />);

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

    render(<UpdateBanner />);

    const button = await screen.findByText(/Download v3\.1\.1/);
    button.click();
    expect(openExternal).toHaveBeenCalledWith(
      expect.stringContaining('github.com/nikolai-vysotskyi/trace-mcp/releases'),
    );
  });

  it('still reports a genuinely current bundle as up to date', async () => {
    mockApi({ available: false, current: '3.1.1', latest: '3.1.1' });

    render(<UpdateBanner />);

    await waitFor(() => expect(screen.getByText(/Up to date · v3\.1\.1/)).toBeTruthy());
  });
});
