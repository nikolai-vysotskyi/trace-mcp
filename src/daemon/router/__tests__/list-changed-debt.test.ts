/**
 * One `tools/list_changed` per profile reinstatement, never two (TRA-796).
 *
 * A profile-suppressed tool is registered on the server and hidden only on the
 * wire, so `load_tools` answers `already_loaded` and notifies nothing — the
 * session has to. But the same call can also load a preset-deferred tool, and
 * that path notifies on its own. Two notifications means a compliant host
 * re-reads the whole advertised surface twice, which is the cost this layer
 * exists to avoid.
 *
 * The three cases below are the shapes actually seen in the field: the
 * `search_text` escalation the suppression notice provokes, a suppressed tool
 * that is also outside the preset (`discover_hermes_sessions`), and a blanket
 * `preset: "full"`.
 */
import { describe, expect, it } from 'vitest';
import { ListChangedDebt } from '../session.js';

const LIST_CHANGED = 'notifications/tools/list_changed';

/** Frames the session sends back for one request, in order. */
function emissions(owedId: string | number | undefined, outbound: object[]): number {
  const debt = new ListChangedDebt();
  debt.owe(owedId);
  return outbound.filter((f) => debt.settle(f)).length;
}

describe('ListChangedDebt', () => {
  it('pays for a reinstatement the backend did not notify about', () => {
    // `search_text` is inside every role preset, so load_tools has nothing to
    // load and sends only its result.
    expect(emissions(7, [{ id: 7, result: { content: [] } }])).toBe(1);
  });

  it('does not pay when the backend already notified', () => {
    // `discover_hermes_sessions` is suppressed *and* outside the preset, so
    // load_tools loads it and fires its own notification before answering.
    expect(emissions(7, [{ method: LIST_CHANGED }, { id: 7, result: { content: [] } }])).toBe(0);
  });

  it('does not pay for preset: "full", which always loads something', () => {
    expect(emissions(9, [{ method: LIST_CHANGED }, { id: 9, result: { content: [] } }])).toBe(0);
  });

  it('pays once, for the request that owed it', () => {
    const debt = new ListChangedDebt();
    debt.owe(1);
    expect(debt.settle({ id: 2 })).toBe(false);
    expect(debt.settle({ id: 1 })).toBe(true);
    expect(debt.settle({ id: 1 })).toBe(false);
  });

  it('owes nothing until a reinstatement happens', () => {
    const debt = new ListChangedDebt();
    expect(debt.settle({ id: 1 })).toBe(false);
    debt.owe(undefined);
    expect(debt.settle({ id: 1 })).toBe(false);
  });
});
