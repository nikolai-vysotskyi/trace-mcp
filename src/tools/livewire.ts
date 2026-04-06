import type { Store } from '../db/store.js';
import { notFound, type TraceMcpResult } from '../errors.js';
import { ok, err } from 'neverthrow';

interface LivewireProperty {
  name: string;
  type?: string;
  is_lazy?: boolean;
}

interface LivewireAction {
  name: string;
  wire_targets?: string[]; // wire:click="methodName" found in blade
}

interface LivewireContextResult {
  component_class: {
    symbol_id: string;
    name: string;
    file: string;
  };
  view?: {
    path: string;
    symbol_id?: string;
  };
  properties: LivewireProperty[];
  actions: LivewireAction[];
  events: {
    dispatches: string[];
    listens: string[];
  };
  child_components: string[];
  uses_model?: string;
  version?: 'v2' | 'v3';
}

/**
 * Get full context for a Livewire component: properties, actions,
 * events (dispatched/listened), associated view, and child components.
 */
export function getLivewireContext(
  store: Store,
  componentName: string,
): TraceMcpResult<LivewireContextResult> {
  // Find the symbol for the Livewire component class
  const symbol = store.getSymbolByFqn(componentName)
    ?? findLivewireSymbol(store, componentName);

  if (!symbol) return err(notFound(componentName));

  const file = store.getFileById(symbol.file_id);
  if (!file) return err(notFound(`file for ${componentName}`));

  const nodeId = store.getNodeId('symbol', symbol.id);

  // Parse metadata stored by the Livewire indexer plugin
  let meta: Record<string, unknown> = {};
  try {
    if (symbol.metadata) meta = JSON.parse(symbol.metadata) as Record<string, unknown>;
  } catch { /* ignore */ }

  const properties: LivewireProperty[] = [];
  const actions: LivewireAction[] = [];

  // Extract properties from metadata
  if (Array.isArray(meta.properties)) {
    for (const p of meta.properties as Record<string, unknown>[]) {
      properties.push({ name: String(p.name ?? ''), type: p.type as string | undefined });
    }
  }

  // Extract actions/methods from metadata
  if (Array.isArray(meta.actions)) {
    for (const a of meta.actions as Record<string, unknown>[]) {
      actions.push({ name: String(a.name ?? '') });
    }
  }

  // Resolve edges for events, view, child components
  const dispatches: string[] = [];
  const listens: string[] = [];
  const childComponents: string[] = [];
  let viewPath: string | undefined;
  let viewSymbolId: string | undefined;
  let usesModel: string | undefined;

  if (nodeId !== undefined) {
    const outgoing = store.getOutgoingEdges(nodeId);

    // Batch resolve all target nodes
    const targetNodeIds = outgoing.map((e) => e.target_node_id);
    const refs = store.getNodeRefsBatch(targetNodeIds);
    const symRefIds = [...refs.values()].filter((r) => r.nodeType === 'symbol').map((r) => r.refId);
    const fileRefIds = [...refs.values()].filter((r) => r.nodeType === 'file').map((r) => r.refId);
    const symMap = symRefIds.length > 0 ? store.getSymbolsByIds(symRefIds) : new Map();
    const symFileIds = [...new Set([...symMap.values()].map((s) => s.file_id))];
    const fileMap = store.getFilesByIds([...new Set([...fileRefIds, ...symFileIds])]);

    for (const edge of outgoing) {
      const ref = refs.get(edge.target_node_id);
      switch (edge.edge_type_name) {
        case 'livewire_renders': {
          if (ref?.nodeType === 'file') {
            viewPath = fileMap.get(ref.refId)?.path;
          } else if (ref?.nodeType === 'symbol') {
            const s = symMap.get(ref.refId);
            if (s) {
              viewSymbolId = s.symbol_id;
              viewPath = fileMap.get(s.file_id)?.path;
            }
          }
          break;
        }
        case 'livewire_dispatches': {
          const edgeMeta = edge.metadata ? JSON.parse(edge.metadata) as Record<string, unknown> : {};
          if (edgeMeta.event) dispatches.push(String(edgeMeta.event));
          break;
        }
        case 'livewire_uses_model': {
          if (ref?.nodeType === 'symbol') {
            const s = symMap.get(ref.refId);
            if (s) usesModel = s.name;
          }
          break;
        }
        case 'livewire_child_of':
        case 'livewire_form': {
          if (ref?.nodeType === 'symbol') {
            const s = symMap.get(ref.refId);
            if (s) childComponents.push(s.name);
          }
          break;
        }
      }
    }

    const incoming = store.getIncomingEdges(nodeId);
    for (const edge of incoming) {
      if (edge.edge_type_name === 'livewire_listens') {
        const edgeMeta = edge.metadata ? JSON.parse(edge.metadata) as Record<string, unknown> : {};
        if (edgeMeta.event) listens.push(String(edgeMeta.event));
      }
    }
  }

  const version = (meta.version as 'v2' | 'v3' | undefined) ?? detectVersion(meta);

  return ok({
    component_class: {
      symbol_id: symbol.symbol_id,
      name: symbol.name,
      file: file.path,
    },
    view: viewPath ? { path: viewPath, symbol_id: viewSymbolId } : undefined,
    properties,
    actions,
    events: { dispatches, listens },
    child_components: childComponents,
    uses_model: usesModel,
    version,
  });
}

function findLivewireSymbol(store: Store, name: string) {
  return store.findSymbolByRole(name, 'livewire_component');
}

function detectVersion(meta: Record<string, unknown>): 'v2' | 'v3' | undefined {
  if (meta.isV3 === true || meta.useForms === true) return 'v3';
  if (meta.isV2 === true) return 'v2';
  return undefined;
}
