import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  canonicalRepoNodeId,
  deduplicateGraph,
} from '../../src/tools/analysis/visualize-federation.js';

describe('a monorepo indexed both as parent and child', () => {
  it('preserves same-root, sibling-repo and distinct symbol identities on the host platform', () => {
    const root = path.resolve('audit-root');
    expect(canonicalRepoNodeId(root, root, 'root', 'a.ts')).toBe('a.ts');
    expect(canonicalRepoNodeId(root, `${root}-other`, 'other', 'a.ts')).toBe('other:a.ts');
    expect(canonicalRepoNodeId(root, path.dirname(root), 'parent', 'a.ts')).toBe('parent:a.ts');
    expect(
      canonicalRepoNodeId(root, path.join(root, 'apps', 'web'), 'web', 'src/a.ts::run#function'),
    ).toBe('apps/web/src/a.ts::run#function');
    expect(
      canonicalRepoNodeId(root, path.join(root, 'apps', 'api'), 'api', 'src/a.ts::run#function'),
    ).toBe('apps/api/src/a.ts::run#function');
    expect(
      canonicalRepoNodeId(
        root,
        path.join(root, 'apps', 'web'),
        'web',
        '__external__/nested/pkg/vue.synthetic',
      ),
    ).toBe('__external__/apps/web/nested/pkg/vue.synthetic');
  });
  it('retains the strongest typed observation, reverse edges and delimiter-bearing IDs', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'a→b' }, { id: 'c' }, { id: 'b→c' }];
    const edges = [
      { source: 'a', target: 'b', type: 'imports', weight: 1 },
      { source: 'a', target: 'b', type: 'imports', weight: 3 },
      { source: 'b', target: 'a', type: 'imports', weight: 1 },
      { source: 'a', target: 'b', type: 'calls', weight: 2 },
      { source: 'a→b', target: 'c', type: 'calls', weight: 1 },
      { source: 'a', target: 'b→c', type: 'calls', weight: 1 },
      { source: 'missing', target: 'a', type: 'calls', weight: 1 },
    ];
    const result = deduplicateGraph(nodes, edges);
    expect(result.edges).toHaveLength(5);
    expect(result.edges[0].weight).toBe(3);
    expect(result.edges).toContainEqual(edges[2]);
    expect(result.edges).toContainEqual(edges[4]);
    expect(result.edges).toContainEqual(edges[5]);
    expect(deduplicateGraph(result.nodes, result.edges)).toEqual(result);
  });
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
