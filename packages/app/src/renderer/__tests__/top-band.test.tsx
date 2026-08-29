/**
 * @vitest-environment jsdom
 */
/* TRA-354 — the window has ONE top band.
 *
 * Before this, the content pane drew a 44px strip holding nothing but the
 * sidebar toggle, and every surface stacked its own 52px control row directly
 * underneath: 96px of chrome, the top 44 of it empty. Measured in the Electron
 * window, the surface's first control row sat at y=44 (Overview, Activity,
 * Memory), y=52 (Ask), y=60 (Notebook, Insights) — always below a band with one
 * glyph in it.
 *
 * And the strip itself was gated on `navigator.userAgent`, which says "Mac" in
 * a browser on macOS too — so `vite dev` reserved room for traffic lights that
 * were not there, and every design review taken against localhost was measuring
 * a window the app does not have.
 */
import { useState } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { HeaderSlotProvider, Toolbar } from '../lattice/ui';

type Chrome = { insetTitleBar: boolean } | undefined;
const setChrome = (v: Chrome) => {
  (window as unknown as { electronChrome: Chrome }).electronChrome = v;
};

/** A band that publishes itself, the way App.tsx does. */
function Band({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <>
      <div data-testid="band" ref={setSlot} />
      <HeaderSlotProvider value={slot}>{children}</HeaderSlotProvider>
    </>
  );
}

describe('Toolbar', () => {
  it('renders into the window band when there is one, and only there', () => {
    const { container } = render(
      <Band>
        <Toolbar>controls</Toolbar>
      </Band>,
    );
    const band = container.querySelector('[data-testid="band"]')!;
    expect(band.querySelector('[role="toolbar"]')).toBeTruthy();
    expect(container.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
  });

  it('draws its own 52px row when there is no band to render into', () => {
    const { container } = render(<Toolbar>controls</Toolbar>);
    const bar = container.querySelector('[role="toolbar"]') as HTMLElement;
    // A floor, not a fixed height — a wrapped second line has to grow the row.
    expect(bar.style.minHeight).toBe('52px');
    expect(bar.style.height).toBe('');
    expect(bar.className).toContain('glass');
  });
});

describe('the app shell', () => {
  beforeEach(() => {
    /* Same shape as launch-smoke: a callable proxy for the preload bridge, so a
       missing Electron API cannot masquerade as the behaviour under test. */
    const makeApiProxy = (name = ''): unknown =>
      new Proxy(function () {} as object, {
        get: (_t, prop) => makeApiProxy(typeof prop === 'string' ? prop : ''),
        apply: () => (name.startsWith('on') ? () => undefined : Promise.resolve(undefined)),
      });
    (window as unknown as { electronAPI: unknown }).electronAPI = makeApiProxy();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.includes('client') ? [] : { projects: [], files: [] };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    );
    vi.stubGlobal(
      'EventSource',
      class {
        close() {}
      },
    );
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })),
    );
    localStorage.setItem('trace-mcp.onboarded.v1', '1');
    /* MCP clients rather than Workspace: its toolbar owns the pane and renders
       whatever the daemon says, so the assertion is about layout, not data. */
    window.history.replaceState({}, '', '/?view=menu&tab=clients');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setChrome(undefined);
    localStorage.clear();
  });

  it('puts the surface toolbar in the top band, with nothing stacked under it', async () => {
    /* The band publishes its element with a callback ref, so the surface only
       has somewhere to portal to on the pass after mount. */
    const { container } = render(<App />);
    await act(async () => {});
    const head = container.querySelector('.ws-content-head')!;
    expect(head.querySelector('[role="toolbar"]')).toBeTruthy();
    // Nothing draws a second control row underneath.
    expect(container.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
  });

  it('hands the whole band to the surface once the sidebar has a strip for the toggle', async () => {
    /* Carrying the toggle in the band cost the surface 46px of row and wrapped
       Memory's toolbar onto a second line at the default 960px window. With
       inset lights the toggle belongs over the sidebar, past them. */
    setChrome({ insetTitleBar: true });
    const { container } = render(<App />);
    await act(async () => {});
    expect(container.querySelector('.ws-sidebar-titlebar .ws-chrome-toggle')).toBeTruthy();
    expect(container.querySelector('.ws-content-head .ws-chrome-toggle')).toBeNull();
    expect(container.querySelectorAll('.ws-chrome-toggle')).toHaveLength(1);
  });

  it('keeps the toggle in the band where there is no sidebar strip', async () => {
    setChrome(undefined);
    const { container } = render(<App />);
    await act(async () => {});
    expect(container.querySelector('.ws-content-head .ws-chrome-toggle')).toBeTruthy();
  });

  it('draws no traffic-light strip in a browser, whatever the user agent claims', () => {
    setChrome(undefined);
    const { container } = render(<App />);
    expect(container.querySelector('.ws-sidebar-titlebar')).toBeNull();
    expect(container.querySelector('.ws-stage')?.getAttribute('data-platform')).toBe('other');
  });

  it('draws it when the main process says the window has inset lights', () => {
    setChrome({ insetTitleBar: true });
    const { container } = render(<App />);
    expect(container.querySelector('.ws-sidebar-titlebar')).toBeTruthy();
    expect(container.querySelector('.ws-stage')?.getAttribute('data-platform')).toBe('mac');
  });
});
