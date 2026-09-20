// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphConnections, GraphHubs } from '../GraphConnections';
import { buildConnections } from '../graph-exploration';
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../lattice/ui', () => ({
  Button: ({
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string }) => <button {...props} />,
}));
afterEach(cleanup);

const nodes = [
  { id: 'src/controller.ts', label: 'controller.ts' },
  { id: 'src/service.ts', label: 'service.ts' },
  { id: 'src/router.ts', label: 'router.ts' },
];
const map = new Map(nodes.map((n) => [n.id, n]));
const index = buildConnections(nodes, [
  { source: nodes[0].id, target: nodes[1].id, type: 'imports' },
  { source: nodes[2].id, target: nodes[0].id, type: 'calls' },
]);
describe('connection inspector', () => {
  it('navigates real IDs and filters incoming versus outgoing neighbors', () => {
    const onSelect = vi.fn();
    const props = {
      selected: nodes[0],
      nodes: map,
      index,
      direction: 'outgoing' as const,
      onDirection: vi.fn(),
      depth: 1,
      onDepth: vi.fn(),
      onSelect,
      onClear: vi.fn(),
    };
    const { rerender } = render(<GraphConnections {...props} />);
    expect(screen.queryByText('← router.ts')).toBeNull();
    fireEvent.click(screen.getByText('→ service.ts'));
    expect(onSelect).toHaveBeenCalledWith('src/service.ts');
    rerender(<GraphConnections {...props} direction="incoming" />);
    expect(screen.queryByText('→ service.ts')).toBeNull();
    expect(screen.getByText('← router.ts')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'absent' } });
    expect(screen.getByText('noConnections')).toBeTruthy();
  });
  it('opens a ranked hub and can collapse the discovery panel', () => {
    const onSelect = vi.fn();
    render(<GraphHubs nodes={map} index={index} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('controller.ts'));
    expect(onSelect).toHaveBeenCalledWith('src/controller.ts');
    fireEvent.click(screen.getByRole('button', { name: /mostConnected/ }));
    expect(screen.queryByText('controller.ts')).toBeNull();
  });
});
