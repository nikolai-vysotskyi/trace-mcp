// Edge processing worker for GraphExplorerGPU.
//
// Moves O(E) dedup + O(E log E) top-K sort off the main thread so the UI
// stays responsive while cosmos.gl boots up. Only edges are processed
// here — positions/colors/sizes remain on the main thread (cheap).
//
// Protocol:
//   main → worker: { type: 'build-edges', nodes: string[],
//                    edges: {source, target}[],
//                    importance: Float32Array,
//                    edgeBudget: number }
//   worker → main: { type: 'edges', links: Float32Array,
//                    uniquePairs: number, keptPairs: number }
//
// The Float32Array buffer is transferred (not copied) — zero-copy hand-off.

interface BuildEdgesRequest {
  type: 'build-edges';
  nodes: string[];
  edges: { source: string; target: string }[];
  importance: Float32Array; // per-node importance
  edgeBudget: number;
}

type WorkerRequest = BuildEdgesRequest;

self.addEventListener('message', (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'build-edges') {
    const { nodes, edges, importance, edgeBudget } = msg;

    // Build id → index map
    const indexById = new Map<string, number>();
    for (let i = 0; i < nodes.length; i++) indexById.set(nodes[i], i);

    // Dedup parallel edges — same directed pair collapsed
    const seen = new Set<number>();
    const pairA: number[] = [];
    const pairB: number[] = [];
    const pairWeight: number[] = [];
    for (const e of edges) {
      const s = indexById.get(e.source);
      const t = indexById.get(e.target);
      if (s == null || t == null) continue;
      const key = s * 0x100000 + t;
      if (seen.has(key)) continue;
      seen.add(key);
      pairA.push(s);
      pairB.push(t);
      pairWeight.push((importance[s] ?? 0) + (importance[t] ?? 0));
    }
    const uniquePairs = pairA.length;

    // Top-K filter when over budget
    let keepIdx: Uint32Array;
    if (uniquePairs > edgeBudget) {
      const order = new Uint32Array(uniquePairs);
      for (let i = 0; i < order.length; i++) order[i] = i;
      const sorted = Array.from(order).sort((a, b) => pairWeight[b] - pairWeight[a]);
      keepIdx = Uint32Array.from(sorted.slice(0, edgeBudget));
    } else {
      keepIdx = new Uint32Array(uniquePairs);
      for (let i = 0; i < keepIdx.length; i++) keepIdx[i] = i;
    }

    const links = new Float32Array(keepIdx.length * 2);
    for (let i = 0; i < keepIdx.length; i++) {
      const k = keepIdx[i];
      links[i * 2] = pairA[k];
      links[i * 2 + 1] = pairB[k];
    }

    // Transfer the buffer — no copy
    (self as unknown as Worker).postMessage(
      { type: 'edges', links, uniquePairs, keptPairs: keepIdx.length },
      [links.buffer],
    );
  }
});
