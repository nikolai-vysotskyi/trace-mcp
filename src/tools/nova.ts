/**
 * get_nova_resource — assembles full context for a Laravel Nova resource.
 * Returns: model mapping, relationship fields, actions, filters, lenses, metrics.
 */
import type { Store } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { notFound } from '../errors.js';

export interface NovaFieldInfo {
  fieldType: string;
  label: string;
  attribute: string;
  targetResource?: string;
}

export interface NovaResourceResult {
  resource: {
    name: string;
    fqn: string;
    symbolId: string;
    filePath: string;
  };
  model?: {
    name: string;
    fqn: string;
    symbolId?: string;
  };
  fields: NovaFieldInfo[];
  actions: string[];
  filters: string[];
  lenses: string[];
  metrics: string[];
}

export function getNovaResource(
  store: Store,
  resourceName: string,
): TraceMcpResult<NovaResourceResult> {
  // Find the Nova resource symbol
  const symbol = store.getSymbolByFqn(resourceName)
    ?? store.getSymbolByFqn(`App\\Nova\\${resourceName}`)
    ?? findNovaSymbol(store, resourceName);

  if (!symbol) return err(notFound(`nova_resource:${resourceName}`));

  const file = store.getFileById(symbol.file_id);
  if (!file) return err(notFound(`file for nova_resource:${resourceName}`));

  const nodeId = store.getNodeId('symbol', symbol.id);

  // Collect edges
  let modelInfo: NovaResourceResult['model'];
  const fields: NovaFieldInfo[] = [];
  const actions: string[] = [];
  const filters: string[] = [];
  const lenses: string[] = [];
  const metrics: string[] = [];

  if (nodeId !== undefined) {
    const outgoing = store.getOutgoingEdges(nodeId);
    for (const edge of outgoing) {
      const meta = edge.metadata ? JSON.parse(edge.metadata) as Record<string, unknown> : {};

      switch (edge.edge_type_name) {
        case 'nova_resource_for': {
          const targetNode = store.getNodeByNodeId(edge.target_node_id);
          if (targetNode?.node_type === 'symbol') {
            const targetSym = store.getSymbolById(targetNode.ref_id);
            if (targetSym) {
              modelInfo = {
                name: targetSym.name,
                fqn: targetSym.fqn ?? targetSym.name,
                symbolId: targetSym.symbol_id,
              };
            }
          }
          if (!modelInfo && meta.targetFqn) {
            modelInfo = { name: String(meta.targetFqn).split('\\').pop()!, fqn: String(meta.targetFqn) };
          }
          break;
        }
        case 'nova_field_relationship': {
          fields.push({
            fieldType: String(meta.fieldType ?? ''),
            label: String(meta.label ?? ''),
            attribute: String(meta.attribute ?? ''),
            targetResource: meta.targetFqn as string | undefined,
          });
          break;
        }
        case 'nova_action_on': {
          const name = resolveTargetName(store, edge.target_node_id, meta);
          if (name) actions.push(name);
          break;
        }
        case 'nova_filter_on': {
          const name = resolveTargetName(store, edge.target_node_id, meta);
          if (name) filters.push(name);
          break;
        }
        case 'nova_lens_on': {
          const name = resolveTargetName(store, edge.target_node_id, meta);
          if (name) lenses.push(name);
          break;
        }
        case 'nova_metric_queries': {
          const name = resolveTargetName(store, edge.target_node_id, meta);
          if (name) metrics.push(name);
          break;
        }
      }
    }
  }

  // Also try to extract from metadata if edges weren't resolved
  if (fields.length === 0 || actions.length === 0) {
    try {
      const meta = symbol.metadata ? JSON.parse(symbol.metadata) as Record<string, unknown> : {};
      if (Array.isArray(meta.fieldRelationships) && fields.length === 0) {
        for (const f of meta.fieldRelationships as Record<string, unknown>[]) {
          fields.push({
            fieldType: String(f.fieldType ?? ''),
            label: String(f.label ?? ''),
            attribute: String(f.attribute ?? ''),
            targetResource: f.targetResourceFqn as string | undefined,
          });
        }
      }
      if (Array.isArray(meta.actions) && actions.length === 0) {
        for (const a of meta.actions as string[]) actions.push(a);
      }
      if (Array.isArray(meta.filters) && filters.length === 0) {
        for (const f of meta.filters as string[]) filters.push(f);
      }
      if (Array.isArray(meta.lenses) && lenses.length === 0) {
        for (const l of meta.lenses as string[]) lenses.push(l);
      }
      if (Array.isArray(meta.metrics) && metrics.length === 0) {
        for (const m of meta.metrics as string[]) metrics.push(m);
      }
      if (!modelInfo && meta.modelFqn) {
        const fqn = String(meta.modelFqn);
        modelInfo = { name: fqn.split('\\').pop()!, fqn };
      }
    } catch { /* ignore */ }
  }

  return ok({
    resource: {
      name: symbol.name,
      fqn: symbol.fqn ?? symbol.name,
      symbolId: symbol.symbol_id,
      filePath: file.path,
    },
    model: modelInfo,
    fields,
    actions,
    filters,
    lenses,
    metrics,
  });
}

function findNovaSymbol(store: Store, name: string) {
  const allFiles = store.getAllFiles();
  for (const file of allFiles) {
    if (file.framework_role !== 'nova_resource') continue;
    const symbols = store.getSymbolsByFile(file.id);
    const match = symbols.find(
      (s) => s.name === name || s.fqn?.endsWith(`\\${name}`),
    );
    if (match) return match;
  }
  return undefined;
}

function resolveTargetName(
  store: Store,
  targetNodeId: number,
  meta: Record<string, unknown>,
): string | undefined {
  const targetNode = store.getNodeByNodeId(targetNodeId);
  if (targetNode?.node_type === 'symbol') {
    const sym = store.getSymbolById(targetNode.ref_id);
    if (sym) return sym.fqn ?? sym.name;
  }
  if (meta.targetFqn) return String(meta.targetFqn);
  return undefined;
}
