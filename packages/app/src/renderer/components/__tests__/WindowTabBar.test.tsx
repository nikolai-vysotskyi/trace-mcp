// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOP_BAND_H, trafficLightCentreY } from '../../../shared/chrome-metrics.js';
import { type TabInfo, WindowTabBar } from '../WindowTabBar';

function stubElectronAPI(platform = 'darwin') {
  const api = {
    getPlatform: vi.fn(async () => platform),
  };
  (window as unknown as { electronAPI: typeof api }).electronAPI = api;
  return { api };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

describe('WindowTabBar', () => {
  it('renders nothing when only 1 tab exists', async () => {
    stubElectronAPI();
    const { container } = render(
      <WindowTabBar
        tabs={[{ id: 'menu', kind: 'menu', title: 'Workspace', active: true }]}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders tab strip on macOS with 78px padding for traffic lights', async () => {
    stubElectronAPI('darwin');
    const tabs: TabInfo[] = [
      { id: 'menu', kind: 'menu', title: 'Workspace', active: true },
      { id: '/projects/assetfeed', kind: 'project', root: '/projects/assetfeed', title: 'assetfeed', active: false },
    ];

    const { container } = render(<WindowTabBar tabs={tabs} onSelect={() => {}} onClose={() => {}} />);

    await screen.findByText('Workspace');
    expect(screen.getByText('assetfeed')).toBeTruthy();

    const bar = container.firstChild as HTMLElement;
    expect(bar.style.paddingLeft).toBe('78px');
  });

  /* TRA-370 / PR 716. Under `hiddenInset` this strip is the topmost band, so the
     system draws the traffic lights inside it. The first version hard-coded
     36px while `trafficLightPosition.y` stayed derived from the 44px
     TOP_BAND_H — lights centred at 22 in a strip centred at 18. Assert the tie,
     not the number: if either side moves alone, this fails. */
  it('sizes the strip so the traffic lights land on its centre line', async () => {
    stubElectronAPI('darwin');
    const tabs: TabInfo[] = [
      { id: 'menu', kind: 'menu', title: 'Workspace', active: true },
      { id: '/projects/assetfeed', kind: 'project', root: '/projects/assetfeed', title: 'assetfeed', active: false },
    ];

    const { container } = render(<WindowTabBar tabs={tabs} onSelect={() => {}} onClose={() => {}} />);
    await screen.findByText('Workspace');

    const bar = container.firstChild as HTMLElement;
    expect(bar.style.height).toBe(`${TOP_BAND_H}px`);
    expect(trafficLightCentreY()).toBe(Number.parseFloat(bar.style.height) / 2);
  });

  it('renders tab strip on Windows/Linux with 4px padding', async () => {
    stubElectronAPI('win32');
    const tabs: TabInfo[] = [
      { id: 'menu', kind: 'menu', title: 'Workspace', active: true },
      { id: '/projects/thewed', kind: 'project', root: '/projects/thewed', title: 'thewed', active: false },
    ];

    const { container } = render(<WindowTabBar tabs={tabs} onSelect={() => {}} onClose={() => {}} />);

    await screen.findByText('Workspace');
    const bar = container.firstChild as HTMLElement;
    expect(bar.style.paddingLeft).toBe('4px');
  });

  it('calls onSelect with the clicked tab id — no IPC, purely local', async () => {
    stubElectronAPI('darwin');
    const tabs: TabInfo[] = [
      { id: 'menu', kind: 'menu', title: 'Workspace', active: true },
      { id: '/projects/assetfeed', kind: 'project', root: '/projects/assetfeed', title: 'assetfeed', active: false },
    ];
    const onSelect = vi.fn();

    render(<WindowTabBar tabs={tabs} onSelect={onSelect} onClose={() => {}} />);

    const projectTab = await screen.findByText('assetfeed');
    fireEvent.click(projectTab);

    expect(onSelect).toHaveBeenCalledWith('/projects/assetfeed');
  });

  it('calls onClose with the tab id when its close button is clicked', async () => {
    stubElectronAPI('darwin');
    const tabs: TabInfo[] = [
      { id: 'menu', kind: 'menu', title: 'Workspace', active: true },
      { id: '/projects/assetfeed', kind: 'project', root: '/projects/assetfeed', title: 'assetfeed', active: false },
    ];
    const onClose = vi.fn();
    const onSelect = vi.fn();

    render(<WindowTabBar tabs={tabs} onSelect={onSelect} onClose={onClose} />);

    const closeBtn = await screen.findByRole('button', { name: /close/i });
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledWith('/projects/assetfeed');
    // The close (×) click must not also select the tab it's closing.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('never offers a close button on the menu tab', async () => {
    stubElectronAPI('darwin');
    const tabs: TabInfo[] = [
      { id: 'menu', kind: 'menu', title: 'Workspace', active: true },
      { id: '/projects/assetfeed', kind: 'project', root: '/projects/assetfeed', title: 'assetfeed', active: false },
    ];

    render(<WindowTabBar tabs={tabs} onSelect={() => {}} onClose={() => {}} />);
    await screen.findByText('Workspace');

    expect(screen.getAllByRole('button', { name: /close/i })).toHaveLength(1);
  });
});
