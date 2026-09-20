import path from 'node:path';

/** A contained repo can already be indexed by its parent. Give both copies the
 * same ID before computing communities, degrees, or counts. External repos keep
 * their existing namespaced IDs; this changes no persisted identity or schema. */
export function canonicalRepoNodeId(
  projectRoot: string,
  repoRoot: string,
  repoName: string,
  id: string,
): string {
  const relative = path.relative(projectRoot, repoRoot);
  if (relative === '') return id;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return `${repoName}:${id}`;
  const prefix = relative.split(path.sep).join('/');
  if (id.startsWith('__external__/')) {
    return `__external__/${prefix}/${id.slice('__external__/'.length).replace(/^_root\//, '')}`;
  }
  return `${prefix}/${id}`;
}

export function deduplicateGraph<
  N extends { id: string },
  E extends { source: string; target: string; type: string; weight: number },
>(nodes: N[], edges: E[]): { nodes: N[]; edges: E[] } {
  const byId = new Map<string, N>();
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const byEdge = new Map<string, E>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const key = JSON.stringify([edge.source, edge.target, edge.type]);
    const previous = byEdge.get(key);
    // Two indexes describing the same relationship are not two occurrences.
    if (!previous || edge.weight > previous.weight) byEdge.set(key, edge);
  }
  return { nodes: [...byId.values()], edges: [...byEdge.values()] };
}
