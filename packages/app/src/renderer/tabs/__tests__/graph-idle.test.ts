/* TRA-683 — the Graph tab burned 27.7% of a core with no user input because
   the breathing interval re-heated the solver unconditionally. */

import { describe, expect, it } from 'vitest';
import { breathAction, IDLE_BREATH_MS } from '../graph-idle';

describe('breathAction', () => {
  it('breathes while the pane is being used', () => {
    expect(breathAction(0, false)).toBe('breathe');
    expect(breathAction(IDLE_BREATH_MS, false)).toBe('breathe');
  });

  it('stops the solver once the pane goes untouched', () => {
    expect(breathAction(IDLE_BREATH_MS + 1, false)).toBe('pause');
  });

  it('does not re-pause an already stopped solver', () => {
    expect(breathAction(IDLE_BREATH_MS + 60_000, true)).toBe('stay-paused');
  });

  it('breathes again as soon as an interaction resets the clock', () => {
    expect(breathAction(0, true)).toBe('breathe');
  });
});
