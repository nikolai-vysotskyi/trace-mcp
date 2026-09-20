export type Direction = 'both' | 'incoming' | 'outgoing';
export interface ConnectionEdge {
  source: string;
  target: string;
  type: string;
}
export function isExternalNode(id: string): boolean {
  return (
    id.includes('__external__/') ||
    id.split('::')[0].endsWith('.synthetic') ||
    id.startsWith('node:')
  );
}
export interface Connections {
  incoming: Map<string, Map<string, Set<string>>>;
  outgoing: Map<string, Map<string, Set<string>>>;
  degree: Map<string, number>;
}

/** The semantic graph must never depend on the GPU's link budget. */
export function buildConnections(nodes: { id: string }[], edges: ConnectionEdge[]): Connections {
  const incoming: Connections['incoming'] = new Map(nodes.map((n) => [n.id, new Map()]));
  const outgoing: Connections['outgoing'] = new Map(nodes.map((n) => [n.id, new Map()]));
  for (const e of edges) {
    if (!outgoing.has(e.source) || !incoming.has(e.target) || e.source === e.target) continue;
    for (const [map, from, to] of [
      [outgoing, e.source, e.target],
      [incoming, e.target, e.source],
    ] as const) {
      const neighbors = map.get(from)!;
      if (!neighbors.has(to)) neighbors.set(to, new Set());
      neighbors.get(to)!.add(e.type);
    }
  }
  const degree = new Map(
    nodes.map((n) => [
      n.id,
      new Set([...incoming.get(n.id)!.keys(), ...outgoing.get(n.id)!.keys()]).size,
    ]),
  );
  return { incoming, outgoing, degree };
}

export function neighborhood(
  index: Connections,
  seeds: string[],
  depth: number,
  direction: Direction,
): Map<string, number> {
  const visited = new Map(seeds.filter((id) => index.degree.has(id)).map((id) => [id, 0]));
  let frontier = [...visited.keys()];
  for (let hop = 1; hop <= depth && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      const neighbors = [
        ...(direction !== 'incoming' ? (index.outgoing.get(id)?.keys() ?? []) : []),
        ...(direction !== 'outgoing' ? (index.incoming.get(id)?.keys() ?? []) : []),
      ];
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.set(neighbor, hop);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return visited;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/** Try cursor quadrants, then obstacle edges, with a bounded least-overlap fallback. */
export function placeTooltip(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  bounds: Rect,
  obstacles: Rect[],
) {
  const gap = 16;
  const clamp = (left: number, top: number) => ({
    left: Math.max(bounds.left + 8, Math.min(left, bounds.right - size.width - 8)),
    top: Math.max(bounds.top + 8, Math.min(top, bounds.bottom - size.height - 8)),
  });
  const candidates = [
    clamp(anchor.x + gap, anchor.y + gap),
    clamp(anchor.x + gap, anchor.y - size.height - gap),
    clamp(anchor.x - size.width - gap, anchor.y - size.height - gap),
    clamp(anchor.x - size.width - gap, anchor.y + gap),
    ...obstacles.flatMap((o) => [
      clamp(anchor.x, o.top - size.height - 8),
      clamp(o.right + 8, anchor.y),
      clamp(o.left - size.width - 8, anchor.y),
    ]),
  ];
  const overlap = (p: { left: number; top: number }) =>
    obstacles.reduce(
      (sum, o) =>
        sum +
        Math.max(0, Math.min(p.left + size.width, o.right) - Math.max(p.left, o.left)) *
          Math.max(0, Math.min(p.top + size.height, o.bottom) - Math.max(p.top, o.top)),
      0,
    );
  return candidates.reduce((best, p) => (overlap(p) < overlap(best) ? p : best));
}
