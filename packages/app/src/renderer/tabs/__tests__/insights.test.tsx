/**
 * @vitest-environment jsdom
 */
/* Insights surface invariants (TRA-296).
 *
 * The old shape put a Run button on each of three cards PLUS one in the detail
 * pane — four accent-filled buttons competing at once — and printed the MCP
 * tool id (`tool: check_claudemd_drift`) next to the report title. Both are
 * locked out here. */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { INSIGHT_REPORTS, Insights, type InsightsClient, pickerFits } from '../Insights';

const client = (rows = [{ primary: 'app/Models/User.php', badge: '12' }]): InsightsClient => ({
  runReport: vi.fn().mockResolvedValue({ rows }),
});

describe('Insights', () => {
  it('shows exactly one Run action, whatever the state', async () => {
    const c = client();
    render(<Insights root="/tmp/p" client={c} />);

    const prominent = () =>
      document.querySelectorAll('.lx-btn.v-prominent') as NodeListOf<HTMLButtonElement>;

    // Idle: the empty state carries the command, and it is the only one.
    expect(prominent()).toHaveLength(1);
    expect(prominent()[0].textContent).toBe('Run');

    prominent()[0].click();
    await waitFor(() => expect(c.runReport).toHaveBeenCalledTimes(1));
    // With data on screen the empty state is gone and the toolbar takes over.
    await waitFor(() => expect(prominent()[0].textContent).toBe('Refresh'));
    expect(prominent()).toHaveLength(1);
  });

  it('never renders an MCP tool identifier', async () => {
    const c = client();
    render(<Insights root="/tmp/p" client={c} />);
    for (const r of INSIGHT_REPORTS) {
      expect(document.body.textContent).not.toContain(r.mcpTool);
    }
    expect(document.body.textContent).not.toContain('tool:');
  });

  it('picks the report with a segmented control rather than a card list', () => {
    render(<Insights root="/tmp/p" client={client()} />);
    const picker = screen.getByRole('group', { name: 'Report' });
    expect(picker.classList.contains('lx-seg')).toBe(true);
    expect(picker.querySelectorAll('.lx-seg-item')).toHaveLength(INSIGHT_REPORTS.length);
  });

  it('renders an empty report as a real empty state, not a bare sentence', async () => {
    const c = client([]);
    render(<Insights root="/tmp/p" client={c} />);
    (document.querySelector('.lx-btn.v-prominent') as HTMLButtonElement).click();
    await waitFor(() => expect(screen.getByText('Nothing to report')).toBeTruthy());
    expect(document.querySelector('.ws-center-empty .gi')).toBeTruthy();
  });
});

/* The picker outgrew its row at supported settings: at the 640px window minimum
   with the sidebar at SIDEBAR_MAX (320) the 371px segmented control ran 96.6px
   past the window's right edge, leaving "Risk hotspots" 14 of its 108px — that
   report could not be selected at all. Below the width where the segments fit,
   the picker becomes a pop-up button.

   jsdom does no layout and has no ResizeObserver, so the swap itself cannot be
   rendered here; the decision is a pure function and that is what is pinned.
   The measured widths above are what make the numbers here real. */
describe('pickerFits', () => {
  const SEGMENTS_W = 371; // measured on the running renderer, regular tier

  it('keeps the segments while the toolbar can hold them', () => {
    expect(pickerFits(402, SEGMENTS_W)).toBe(true); // sidebar 180 @ 640
    expect(pickerFits(SEGMENTS_W, SEGMENTS_W)).toBe(true); // exactly enough
    expect(pickerFits(642, SEGMENTS_W)).toBe(true); // 960 window
  });

  it('falls back to the pop-up once they cannot fit', () => {
    expect(pickerFits(SEGMENTS_W - 1, SEGMENTS_W)).toBe(false);
    expect(pickerFits(362, SEGMENTS_W)).toBe(false); // sidebar 220 @ 640
    expect(pickerFits(262, SEGMENTS_W)).toBe(false); // sidebar 320 @ 640
  });

  it('shows the segments until something has actually been measured', () => {
    // The pop-up is the fallback, never what a first paint drops to.
    expect(pickerFits(0, 0)).toBe(true);
    expect(pickerFits(0, SEGMENTS_W)).toBe(true);
    expect(pickerFits(262, 0)).toBe(true);
  });

  it('is decided by one width, so the same size always renders the same control', () => {
    // Guards the bistable version this replaced: the picker's own slot is
    // narrower beside the title than on a wrapped line of its own, so a
    // slot-based threshold settled into either control depending on which way
    // the user had resized. Widening then narrowing must land where it started.
    const widths = [402, 362, 262, 362, 402];
    const seen = widths.map((w) => pickerFits(w, SEGMENTS_W));
    expect(seen).toEqual([true, false, false, false, true]);
  });
});
