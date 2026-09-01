// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowTabBar } from '../WindowTabBar';

interface TabInfo {
  id: string;
  title: string;
  type: string;
  active: boolean;
}

function stubElectronAPI(platform = 'darwin', initialTabs: TabInfo[] = []) {
  let tabCallback: ((tabs: TabInfo[]) => void) | null = null;

  const api = {
    getPlatform: vi.fn(async () => platform),
    onTabListChanged: vi.fn((cb: (tabs: TabInfo[]) => void) => {
      tabCallback = cb;
      cb(initialTabs);
      return () => {
        tabCallback = null;
      };
    }),
    focusTab: vi.fn(async (_id: string) => ({ ok: true })),
    closeCurrentTab: vi.fn(async () => ({ ok: true })),
  };

  (window as unknown as { electronAPI: typeof api }).electronAPI = api;
  return {
    api,
    emitTabs: (tabs: TabInfo[]) => tabCallback?.(tabs),
  };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

describe('WindowTabBar', () => {
  it('renders nothing when only 1 tab exists', async () => {
    const { container } = render(<WindowTabBar />);
    stubElectronAPI('darwin', [
      { id: 'menu', title: 'Workspace', type: 'menu', active: true },
    ]);

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it('renders tab strip on macOS with 78px padding for traffic lights', async () => {
    const tabs: TabInfo[] = [
      { id: 'menu', title: 'Workspace', type: 'menu', active: true },
      { id: '/projects/assetfeed', title: 'assetfeed', type: 'project', active: false },
    ];
    stubElectronAPI('darwin', tabs);

    const { container } = render(<WindowTabBar />);

    await screen.findByText('Workspace');
    expect(screen.getByText('assetfeed')).toBeTruthy();

    const bar = container.firstChild as HTMLElement;
    expect(bar.style.paddingLeft).toBe('78px');
  });

  it('renders tab strip on Windows/Linux with 4px padding', async () => {
    const tabs: TabInfo[] = [
      { id: 'menu', title: 'Workspace', type: 'menu', active: true },
      { id: '/projects/thewed', title: 'thewed', type: 'project', active: false },
    ];
    stubElectronAPI('win32', tabs);

    const { container } = render(<WindowTabBar />);

    await screen.findByText('Workspace');
    const bar = container.firstChild as HTMLElement;
    expect(bar.style.paddingLeft).toBe('4px');
  });

  it('switches tab on click', async () => {
    const tabs: TabInfo[] = [
      { id: 'menu', title: 'Workspace', type: 'menu', active: true },
      { id: '/projects/assetfeed', title: 'assetfeed', type: 'project', active: false },
    ];
    const { api } = stubElectronAPI('darwin', tabs);

    render(<WindowTabBar />);

    const projectTab = await screen.findByText('assetfeed');
    fireEvent.click(projectTab);

    expect(api.focusTab).toHaveBeenCalledWith('/projects/assetfeed');
  });

  it('closes a project tab on close button click', async () => {
    const tabs: TabInfo[] = [
      { id: 'menu', title: 'Workspace', type: 'menu', active: true },
      { id: '/projects/assetfeed', title: 'assetfeed', type: 'project', active: false },
    ];
    const { api } = stubElectronAPI('darwin', tabs);

    render(<WindowTabBar />);

    const closeBtn = await screen.findByRole('button', { name: /close/i });
    fireEvent.click(closeBtn);

    expect(api.focusTab).toHaveBeenCalledWith('/projects/assetfeed');
    await waitFor(() => {
      expect(api.closeCurrentTab).toHaveBeenCalled();
    });
  });
});
