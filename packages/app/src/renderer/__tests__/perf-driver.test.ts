// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs helper shared by the perf scripts, no types.
import { MEASURE_SRC } from '../../../scripts/perf-lib.mjs';

/**
 * The completion detector behind `ui_p95_ms` (TRA-835).
 *
 * It measured 0 ms for 42.5% of the search actions in the 2026-09-04 run,
 * because it armed its MutationObserver *after* firing the action and React
 * commits discrete events synchronously — the whole render was already on the
 * page before anything was watching. p95 came out ~20% low. The harness runs
 * for 55 minutes on a developer machine and never in CI, so this is the only
 * thing standing between that ordering and a silently wrong baseline.
 */
function loadMeasure(): (act: () => void) => Promise<number> {
  // The driver is injected as text, so it is exercised as text.
  const factory = new Function(`${MEASURE_SRC}\n return measure;`);
  return factory();
}

describe('perf driver: measure()', () => {
  it('times a synchronous DOM commit instead of reporting zero', async () => {
    const ms = await loadMeasure()(() => {
      // Exactly what React does for a discrete event: mutate before returning.
      document.body.appendChild(document.createElement('div'));
    });
    expect(ms).toBeGreaterThan(0);
  });

  it('keeps timing while the DOM is still changing', async () => {
    const measure = loadMeasure();
    const ms = await measure(() => {
      let n = 0;
      const id = setInterval(() => {
        document.body.appendChild(document.createElement('span'));
        if (++n === 4) clearInterval(id);
      }, 40);
    });
    // Four mutations 40 ms apart, then 120 ms of quiet before it resolves.
    expect(ms).toBeGreaterThanOrEqual(120);
    expect(ms).toBeLessThan(5000);
  });

  it('does not treat the never-quiet graph label layer as progress', async () => {
    const layer = document.createElement('div');
    layer.className = 'cosmos-gpu-label';
    document.body.appendChild(layer);
    let id: ReturnType<typeof setInterval> | undefined;
    const ms = await loadMeasure()(() => {
      id = setInterval(() => layer.appendChild(document.createElement('i')), 16);
    });
    clearInterval(id);
    // The ignored layer alone must not hold the measurement open to the 5 s cap.
    expect(ms).toBeLessThan(1000);
  });
});
