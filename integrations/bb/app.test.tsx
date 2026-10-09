// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';

const app = await loadPluginApp(() => import('./app.js'));

afterEach(cleanup);

function overview() {
  return {
    index: { status: 'ready', files: 23, symbols: 80, warnings: [] },
    indexError: null,
    context: { usedTokens: 1200, modelContextWindow: 8000, estimated: false },
    decisions: [{ id: 'd1', title: 'Use SQLite', type: 'tech_choice', summary: 'Local storage' }],
    decisionsError: null,
  };
}

describe('Trace context panel', () => {
  it('shows index, bb context usage, and project decisions, then saves a new decision', async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: 'thread-1', params: null },
      {
        rpc: {
          readOverview: () => overview(),
          saveDecision: () => ({ id: 'd2' }),
        },
      },
    );
    expect(await slot.findByText('Use SQLite')).toBeTruthy();
    expect(slot.getByText('23')).toBeTruthy();
    expect(slot.getByText('1,200 of 8,000 tokens used')).toBeTruthy();
    expect(
      slot.getByRole('progressbar', { name: 'Context window usage' }).getAttribute('aria-valuenow'),
    ).toBe('1200');

    fireEvent.click(slot.getByRole('button', { name: 'Record decision' }));
    fireEvent.change(slot.getByRole('textbox', { name: 'Decision title' }), {
      target: { value: 'Use graph' },
    });
    fireEvent.change(slot.getByRole('textbox', { name: 'Reason and tradeoffs' }), {
      target: { value: 'Local code navigation' },
    });
    fireEvent.click(slot.getByRole('button', { name: 'Save decision' }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: 'saveDecision',
        input: {
          threadId: 'thread-1',
          title: 'Use graph',
          content: 'Local code navigation',
          type: 'tech_choice',
        },
      }),
    );
    expect(await slot.findByRole('status')).toHaveProperty('textContent', 'Decision recorded.');
  });

  it('shows a truthful empty context state and lets the user index an empty repository', async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: 'thread-2', params: null },
      {
        rpc: {
          readOverview: () => ({
            ...overview(),
            index: { status: 'empty', files: 0, symbols: 0, warnings: [] },
            context: null,
            decisions: [],
          }),
          reindex: () => ({ status: 'ok', indexed: 12, errors: 0 }),
        },
      },
    );
    expect(await slot.findByText('This provider has not reported context usage yet.')).toBeTruthy();
    expect(slot.queryByRole('progressbar')).toBeNull();
    fireEvent.click(slot.getByRole('button', { name: 'Index repository' }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: 'reindex', input: { threadId: 'thread-2' } }),
    );
    expect(await slot.findByRole('status')).toHaveProperty('textContent', 'Indexed 12 files.');
  });
});
