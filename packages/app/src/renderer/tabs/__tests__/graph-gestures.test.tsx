// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GraphExplorerGPU, DEFAULT_GRAPH_GPU_SETTINGS } from '../GraphExplorerGPU';

const mock = vi.hoisted(() => ({
  graph: null as any,
  config: null as any,
  t: (key: string) => key,
}));
vi.mock('@cosmos.gl/graph', () => ({
  Graph: class {
    constructor(_container: HTMLElement, config: unknown) {
      mock.config = config;
      const graph = {
        isSimulationRunning: true,
        getZoomLevel: vi.fn(() => 20),
        spaceToScreenPosition: vi.fn((p: number[]) => p),
        getPointPositions: vi.fn(() => new Float32Array([150, 150, 350, 350])),
        getTrackedPointPositionsMap: () => new Map(),
        pause: vi.fn(() => {
          graph.isSimulationRunning = false;
        }),
        unpause: vi.fn(() => {
          graph.isSimulationRunning = true;
        }),
        start: vi.fn(() => {
          graph.isSimulationRunning = true;
        }),
      };
      mock.graph = new Proxy(graph, {
        get: (target, key) => (key in target ? target[key as keyof typeof target] : vi.fn()),
      });
      return mock.graph;
    }
  },
}));
vi.mock('../../daemon-fetch', () => ({
  daemonFetchProject: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      nodes: [
        {
          id: 'app/CryptoCurrency.php',
          label: 'CryptoCurrency.php',
          type: 'file',
          language: 'php',
          community: 0,
          importance: 1,
        },
        {
          id: 'app/ForexController.php',
          label: 'ForexController.php',
          type: 'file',
          language: 'php',
          community: 0,
          importance: 0.5,
        },
      ],
      edges: [
        { source: 'app/CryptoCurrency.php', target: 'app/ForexController.php', type: 'imports' },
      ],
      communities: [{ id: 0, label: 'app', size: 2 }],
    }),
  })),
}));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: mock.t }),
}));

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let now: number;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  frames = new Map();
  nextFrame = 0;
  now = 0;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.set(++nextFrame, fn);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(showLabels = true) {
  let view: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <GraphExplorerGPU
        root="/project"
        settings={{ ...DEFAULT_GRAPH_GPU_SETTINGS, showLabels }}
        onSettingsChange={vi.fn()}
      />,
    );
  });
  frame();
  expect(mock.graph).toBeTruthy();
  return view!;
}
function frame() {
  act(() => {
    now += 40;
    const pending = [...frames.values()];
    frames.clear();
    for (const fn of pending) fn(now);
  });
}
function labels() {
  return [...document.querySelectorAll('.cosmos-gpu-label')].map((el) => el.textContent);
}

it('keeps Live on through a user zoom gesture and resumes motion on release (TRA-1783)', async () => {
  await mount();
  act(() => mock.config.onZoomStart({}, true));
  // A drag/pan/zoom must NOT flip the Live toggle to Paused ...
  expect(screen.queryByTitle('resumeSimulation')).toBeNull();
  expect(screen.getByTitle('pauseSimulation')).toBeTruthy();
  mock.graph.getPointPositions.mockClear();
  for (let zoom = 21; zoom < 25; zoom++) {
    mock.graph.getZoomLevel.mockReturnValue(zoom);
    frame();
  }
  // ... label passes stay skipped throughout the gesture ...
  expect(mock.graph.getPointPositions).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(3000));
  // ... and mouse-up continues the motion instead of staying paused.
  act(() => mock.config.onZoomEnd({}, true));
  expect(mock.graph.isSimulationRunning).toBe(true);
  expect(screen.queryByTitle('resumeSimulation')).toBeNull();
  frame();
  expect(mock.graph.getPointPositions).toHaveBeenCalledTimes(1);
  frame();
  // Solver is running again, so the label pass keeps tracking (no idle
  // short-circuit while isSimulationRunning).
  expect(mock.graph.getPointPositions).toHaveBeenCalledTimes(2);
});

it('stays paused through a gesture when the user explicitly paused (TRA-1783)', async () => {
  await mount();
  fireEvent.click(screen.getByTitle('pauseSimulation'));
  expect(screen.getByTitle('resumeSimulation')).toBeTruthy();
  mock.graph.isSimulationRunning = false;
  act(() => mock.config.onZoomStart({}, true));
  act(() => mock.config.onZoomEnd({}, true));
  // Manual Paused toggle is respected — a drag must not auto-resume it.
  expect(mock.graph.isSimulationRunning).toBe(false);
  expect(screen.getByTitle('resumeSimulation')).toBeTruthy();
});

it('does not auto-pause on the initial settle tick after a released drag (TRA-1783 review)', async () => {
  // performance.now is stubbed explicitly — not via fake timers — so the
  // 6 s settle window below is deterministic and the test cannot pass
  // vacuously on a real-clock reading.
  let nowMs = 1000;
  const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  try {
    await mount();
    // Settle window elapses while Live, then a drag starts and ends.
    act(() => {
      nowMs = 7500;
    });
    act(() => mock.config.onZoomStart({}, true));
    act(() => mock.config.onZoomEnd({}, true));
    expect(mock.graph.isSimulationRunning).toBe(true);
    // First real solver tick after release: alpha already decayed (< 0.2),
    // so the initial-settle one-shot fires here — it must mark frozen
    // without flipping the Live toggle or pausing the solver.
    act(() => mock.config.onSimulationTick(0.15));
    expect(mock.graph.isSimulationRunning).toBe(true);
    expect(screen.getByTitle('pauseSimulation')).toBeTruthy();
    expect(screen.queryByTitle('resumeSimulation')).toBeNull();
    // And the one-shot is one-shot: a second tick changes nothing either.
    act(() => mock.config.onSimulationTick(0.1));
    expect(mock.graph.isSimulationRunning).toBe(true);
    expect(screen.queryByTitle('resumeSimulation')).toBeNull();
  } finally {
    nowSpy.mockRestore();
  }
});

it('does not re-heat the solver from a deferred zoom-end while offscreen (TRA-1783 review)', async () => {
  await mount();
  act(() => mock.config.onZoomStart({}, true));
  // Hide the pane mid-gesture: visibilitychange → solver paused + flagged.
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  try {
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(mock.graph.isSimulationRunning).toBe(false);
    // The deferred gesture end must NOT restart the solver on a hidden pane.
    act(() => mock.config.onZoomEnd({}, true));
    expect(mock.graph.isSimulationRunning).toBe(false);
    expect(screen.getByTitle('pauseSimulation')).toBeTruthy();
    // Showing the pane again resumes via the visibility effect (Live is on).
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(mock.graph.isSimulationRunning).toBe(true);
  } finally {
    // Restore the prototype getter so later tests see the real value.
    // biome-ignore lint/performance/noDelete: test-only jsdom cleanup
    delete (document as unknown as Record<string, unknown>).hidden;
  }
});

it('does not pause the initial programmatic camera fit', async () => {
  await mount();
  act(() => mock.config.onZoomStart({}, false));
  expect(mock.graph.isSimulationRunning).toBe(true);
});

it('recovers overlays and hover when the graph reloads before a gesture ends', async () => {
  const view = await mount();
  const previous = mock.graph;
  act(() => mock.config.onZoomStart({}, true));
  await act(async () => {
    view.rerender(
      <GraphExplorerGPU
        root="/other-project"
        settings={DEFAULT_GRAPH_GPU_SETTINGS}
        onSettingsChange={vi.fn()}
      />,
    );
  });
  expect(mock.graph).not.toBe(previous);
  frame();
  const label = document.querySelector<HTMLElement>('.cosmos-gpu-label')!;
  expect(label.parentElement!.style.visibility).not.toBe('hidden');
  act(() => mock.config.onPointMouseOver(0));
  frame();
  expect(screen.getByRole('tooltip').textContent).toContain('CryptoCurrency.php');
});

it.each([0, 1])(
  'suppresses hovered node %i in every canvas label candidate path',
  async (index) => {
    await mount();
    const name = index === 0 ? 'CryptoCurrency.php' : 'ForexController.php';
    act(() => mock.config.onPointMouseOver(index));
    frame();
    expect(screen.getByRole('tooltip').textContent).toContain(name);
    expect(labels()).not.toContain(name);
    act(() => mock.config.onPointMouseOut());
    frame();
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(labels()).toContain(index === 0 ? 'app' : name);
  },
);

it('retains selected and neighbor labels when selection hides the hover card', async () => {
  await mount();
  act(() => {
    mock.config.onClick(0);
    mock.config.onPointMouseOver(1);
  });
  frame();
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(labels()).toContain('CryptoCurrency.php');
  expect(labels()).toContain('ForexController.php');
});

it('keeps labels off while the hover card remains useful', async () => {
  await mount(false);
  act(() => mock.config.onPointMouseOver(0));
  frame();
  expect(screen.getByRole('tooltip').textContent).toContain('app/CryptoCurrency.php');
  expect(labels()).toEqual([]);
});
