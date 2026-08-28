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
import { INSIGHT_REPORTS, Insights, type InsightsClient } from '../Insights';

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
