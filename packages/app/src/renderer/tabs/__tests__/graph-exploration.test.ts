import { describe, expect, it } from 'vitest';
import { buildConnections, neighborhood, placeTooltip } from '../graph-exploration';

describe('graph exploration uses indexed relationships, independent of drawing limits', () => {
  const nodes = ['a', 'b', 'c', 'isolated'].map((id) => ({ id }));
  const edges = [
    { source: 'a', target: 'b', type: 'imports' },
    { source: 'a', target: 'b', type: 'calls' },
    { source: 'c', target: 'a', type: 'imports' },
    { source: 'b', target: 'c', type: 'calls' },
    { source: 'missing', target: 'a', type: 'imports' },
  ];
  it('counts unique neighbors and preserves direction and relationship types', () => {
    const index = buildConnections(nodes, edges);
    expect([...index.outgoing.get('a')!.keys()]).toEqual(['b']);
    expect([...index.outgoing.get('a')!.get('b')!]).toEqual(['imports', 'calls']);
    expect([...index.incoming.get('a')!.keys()]).toEqual(['c']);
    expect(index.degree.get('a')).toBe(2);
    expect(index.degree.get('isolated')).toBe(0);
  });
  it('changes depth and direction without losing cycles or disconnected nodes', () => {
    const index = buildConnections(nodes, edges);
    expect([...neighborhood(index, ['a'], 1, 'outgoing').keys()]).toEqual(['a', 'b']);
    expect([...neighborhood(index, ['a'], 2, 'outgoing').entries()]).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
    expect([...neighborhood(index, ['a'], 1, 'incoming').keys()]).toEqual(['a', 'c']);
    expect(neighborhood(index, ['a'], 6, 'both').size).toBe(3);
  });
});

describe('hover placement', () => {
  const bounds = { left: 250, top: 90, right: 1000, bottom: 700 };
  const legend = { left: 262, top: 540, right: 490, bottom: 688 };
  it('flips and shifts inside the graph and stays clear of the bottom-left legend', () => {
    const pos = placeTooltip({ x: 270, y: 675 }, { width: 340, height: 90 }, bounds, [legend]);
    expect(pos.left).toBeGreaterThanOrEqual(bounds.left + 8);
    expect(pos.top).toBeGreaterThanOrEqual(bounds.top + 8);
    expect(pos.left + 340).toBeLessThanOrEqual(bounds.right - 8);
    expect(pos.top + 90).toBeLessThanOrEqual(bounds.bottom - 8);
    expect(pos.top + 90 <= legend.top || pos.left >= legend.right).toBe(true);
  });
  it('keeps a long tooltip within a resized pane', () => {
    const pos = placeTooltip({ x: 995, y: 698 }, { width: 340, height: 160 }, bounds, []);
    expect(pos.left + 340).toBeLessThanOrEqual(992);
    expect(pos.top + 160).toBeLessThanOrEqual(692);
  });
});
