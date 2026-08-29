// @vitest-environment jsdom
/**
 * Notebook — the macOS 26 layer (TRA-310).
 *
 * These assert the rules the surface used to break, not its markup: it names
 * the project it queries, every control comes from lattice/ui, the reading
 * text is on the type scale, and there is no second accent capsule per cell.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Notebook } from '../Notebook';

const root = '/Users/someone/code/my-project';

function renderNotebook(callTool = vi.fn().mockResolvedValue({ items: [] })) {
  const utils = render(<Notebook root={root} client={{ callTool }} />);
  return { ...utils, callTool };
}

describe('Notebook', () => {
  it('names the project the cells query', () => {
    renderNotebook();
    // The surface used to have no toolbar at all, so nothing on screen said
    // which project a run would hit.
    expect(screen.getByRole('toolbar')).toBeTruthy();
    expect(screen.getByText('my-project')).toBeTruthy();
  });

  it('counts cells in the toolbar, in singular and plural', () => {
    renderNotebook();
    expect(screen.getByText('1 cell')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add cell' }));
    expect(screen.getByText('2 cells')).toBeTruthy();
  });

  it('uses lattice controls, not hand-rolled ones', () => {
    const { container } = renderNotebook();
    // Tool picker is a PopUpButton (a bare <select> was the old chrome).
    expect(container.querySelector('.lx-popup select')).toBeTruthy();
    // Every button is .lx-btn.
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.classList.contains('lx-btn')).toBe(true);
    // Every text field is .lx-input.
    const inputs = [...container.querySelectorAll('input[type="text"]')];
    expect(inputs.length).toBeGreaterThan(0);
    for (const i of inputs) expect(i.classList.contains('lx-input')).toBe(true);
  });

  it('keeps Run off the prominent variant so N cells are not N accent capsules', () => {
    const { container } = renderNotebook();
    fireEvent.click(screen.getByRole('button', { name: 'Add cell' }));
    expect(container.querySelectorAll('.lx-btn.v-prominent').length).toBe(0);
  });

  it('gives the remove button both a label and a tooltip', () => {
    renderNotebook();
    fireEvent.click(screen.getByRole('button', { name: 'Add cell' }));
    const remove = screen.getByRole('button', { name: 'Remove cell 1' });
    expect(remove.getAttribute('title')).toBe('Remove cell');
  });

  it('labels fields with the human label, not the raw arg key', () => {
    renderNotebook();
    expect(screen.getByText('Query')).toBeTruthy();
    expect(screen.queryByText('query')).toBeNull();
  });

  it('tells the user what to do instead of naming the failed field', () => {
    renderNotebook();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Enter a query to run this cell.');
  });

  it('shows a skeleton while a cell runs, never the word "Loading"', async () => {
    let release: (v: unknown) => void = () => {};
    const callTool = vi.fn(() => new Promise((r) => { release = r; }));
    const { container } = renderNotebook(callTool);
    fireEvent.change(screen.getByPlaceholderText('e.g. registerTool'), {
      target: { value: 'registerTool' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByRole('status', { name: 'Running' })).toBeTruthy());
    expect(container.querySelectorAll('.ws-skel').length).toBe(3);
    expect(container.textContent).not.toMatch(/Loading/i);

    release({ items: [] });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Running' })).toBeNull());
  });

  it('runs the selected tool against the project root', async () => {
    const { callTool } = renderNotebook();
    fireEvent.change(screen.getByPlaceholderText('e.g. registerTool'), {
      target: { value: 'registerTool' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(callTool).toHaveBeenCalledWith('search', { query: 'registerTool' }, root),
    );
  });

  it('resets args when the tool changes', () => {
    renderNotebook();
    fireEvent.change(screen.getByPlaceholderText('e.g. registerTool'), {
      target: { value: 'stale' },
    });
    fireEvent.change(screen.getByLabelText('Tool'), { target: { value: 'get_outline' } });
    expect(screen.getByPlaceholderText('src/server/server.ts')).toHaveProperty('value', '');
    expect(screen.queryByPlaceholderText('e.g. registerTool')).toBeNull();
  });
});
