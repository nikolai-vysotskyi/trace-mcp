export type EdgeResolution = 'lsp_resolved' | 'ast_resolved' | 'ast_inferred' | 'text_matched';

export interface ResolutionTiers {
  lsp_resolved: number;
  ast_resolved: number;
  ast_inferred: number;
  text_matched: number;
}

export function emptyResolutionTiers(): ResolutionTiers {
  return { lsp_resolved: 0, ast_resolved: 0, ast_inferred: 0, text_matched: 0 };
}

/**
 * Classify an edge into a resolution tier so callers can prefer compiler-grade results
 * (lsp_resolved/ast_resolved) over fuzzy ones (text_matched). The DB column is the source
 * of truth; the fallback exists for edges indexed before the column was introduced.
 */
export function inferResolution(edge: {
  resolved: number;
  resolution_tier?: string;
  edge_type_name: string;
}): EdgeResolution {
  const tier = edge.resolution_tier;
  if (
    tier === 'lsp_resolved' ||
    tier === 'ast_resolved' ||
    tier === 'ast_inferred' ||
    tier === 'text_matched'
  )
    return tier;

  if (!edge.resolved) return 'text_matched';
  if (edge.edge_type_name === 'imports' || edge.edge_type_name === 'esm_imports')
    return 'ast_inferred';
  return 'ast_resolved';
}
