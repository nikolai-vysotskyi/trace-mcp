/* TRA-683 — the Graph tab used to breathe forever: a wall-clock interval
   re-heated the solver every 2.5 s whether or not anyone was watching, which
   measured at 27.7% of a core on an idle tab (Overview: 0.2%). Breathing is
   for a user who is looking at it, so after this long without pointer, wheel
   or click input we stop the solver and let cosmos.gl's frame loop end; the
   next interaction unpauses and re-heats it. */

/** How long the view may sit untouched before the solver is allowed to stop. */
export const IDLE_BREATH_MS = 10_000;

export type BreathAction =
  /** Re-heat alpha — someone is (or just was) watching. */
  | 'breathe'
  /** Nobody has touched the view in a while — stop the solver. */
  | 'pause'
  /** Already stopped; nothing to do until the next interaction. */
  | 'stay-paused';

export function breathAction(
  msSinceInteraction: number,
  paused: boolean,
  idleMs: number = IDLE_BREATH_MS,
): BreathAction {
  if (msSinceInteraction <= idleMs) return 'breathe';
  return paused ? 'stay-paused' : 'pause';
}
