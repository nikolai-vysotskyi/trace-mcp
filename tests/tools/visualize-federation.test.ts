import { describe, expect, it } from 'vitest';
import {
  canonicalRepoNodeId,
  deduplicateGraph,
} from '../../src/tools/analysis/visualize-federation.js';

describe('a monorepo indexed both as parent and child', () => {
  it('uses the parent-relative identity for the same physical source file', () => {
    expect(canonicalRepoNodeId('/repo', '/repo/frontend', 'front', 'app/index.vue')).toBe(
      'frontend/app/index.vue',
    );
    expect(
      canonicalRepoNodeId('/repo', '/repo/frontend', 'front', 'app/index.vue::render#function'),
    ).toBe('frontend/app/index.vue::render#function');
    expect(canonicalRepoNodeId('/repo', '/elsewhere/front', 'front', 'app/index.vue')).toBe(
      'front:app/index.vue',
    );
  });
  it('keeps external packages virtual and shares their parent workspace identity', () => {
    expect(
      canonicalRepoNodeId(
        '/repo',
        '/repo/frontend',
        'front',
        '__external__/_root/pkg/vue.synthetic',
      ),
    ).toBe('__external__/frontend/pkg/vue.synthetic');
  });
  it('deduplicates repeated nodes and typed relationships without doubling weights', () => {
    const graph = deduplicateGraph(
      [{ id: 'frontend/a.ts' }, { id: 'frontend/b.ts' }, { id: 'frontend/a.ts' }],
      [
        { source: 'frontend/a.ts', target: 'frontend/b.ts', type: 'imports', weight: 2 },
        { source: 'frontend/a.ts', target: 'frontend/b.ts', type: 'imports', weight: 2 },
        { source: 'frontend/a.ts', target: 'frontend/b.ts', type: 'calls', weight: 1 },
      ],
    );
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges[0].weight).toBe(2);
  });
});
