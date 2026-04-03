/**
 * get_event_graph tool — shows event/listener relationships.
 * Finds events, their listeners, and dispatchers.
 */
import type { Store, SymbolRow } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { notFound } from '../errors.js';

export interface EventNode {
  name: string;
  fqn: string;
  symbolId: string;
  listeners: { name: string; fqn: string; symbolId: string }[];
  dispatchers: { name: string; fqn: string; symbolId: string }[];
}

export interface EventGraphResult {
  events: EventNode[];
}

export function getEventGraph(
  store: Store,
  eventName?: string,
): TraceMcpResult<EventGraphResult> {
  const events: EventNode[] = [];

  if (eventName) {
    // Find specific event
    const eventSymbol = findEventSymbol(store, eventName);
    if (!eventSymbol) {
      return err(notFound(`event:${eventName}`));
    }
    const node = buildEventNode(store, eventSymbol);
    events.push(node);
  } else {
    // Find all events that have listens_to edges targeting them
    const listensToEdges = store.getEdgesByType('listens_to');
    const seen = new Set<number>();

    for (const edge of listensToEdges) {
      if (seen.has(edge.target_node_id)) continue;
      seen.add(edge.target_node_id);

      const targetNode = store.getNodeByNodeId(edge.target_node_id);
      if (!targetNode || targetNode.node_type !== 'symbol') continue;

      const sym = store.getSymbolById(targetNode.ref_id);
      if (!sym) continue;

      events.push(buildEventNode(store, sym));
    }

    // Also find events that have dispatches edges
    const dispatchEdges = store.getEdgesByType('dispatches');
    for (const edge of dispatchEdges) {
      if (seen.has(edge.target_node_id)) continue;
      seen.add(edge.target_node_id);

      const targetNode = store.getNodeByNodeId(edge.target_node_id);
      if (!targetNode || targetNode.node_type !== 'symbol') continue;

      const sym = store.getSymbolById(targetNode.ref_id);
      if (!sym) continue;

      events.push(buildEventNode(store, sym));
    }
  }

  return ok({ events });
}

function findEventSymbol(store: Store, name: string): SymbolRow | undefined {
  // Try FQN
  let sym = store.getSymbolByFqn(name);
  if (sym) return sym;

  // Try App\Events\ prefix
  sym = store.getSymbolByFqn(`App\\Events\\${name}`);
  if (sym) return sym;

  // Search by name
  const results = store.db.prepare(
    "SELECT * FROM symbols WHERE name = ? AND kind = 'class'",
  ).all(name) as SymbolRow[];
  return results[0];
}

function buildEventNode(store: Store, eventSymbol: SymbolRow): EventNode {
  const nodeId = store.getNodeId('symbol', eventSymbol.id);
  const listeners: { name: string; fqn: string; symbolId: string }[] = [];
  const dispatchers: { name: string; fqn: string; symbolId: string }[] = [];

  if (nodeId) {
    // Find listeners (incoming listens_to edges)
    const inEdges = store.getIncomingEdges(nodeId);
    for (const edge of inEdges) {
      if (edge.edge_type_name !== 'listens_to') continue;
      const sourceNode = store.getNodeByNodeId(edge.source_node_id);
      if (!sourceNode || sourceNode.node_type !== 'symbol') continue;
      const sym = store.getSymbolById(sourceNode.ref_id);
      if (sym) {
        listeners.push({
          name: sym.name,
          fqn: sym.fqn ?? sym.name,
          symbolId: sym.symbol_id,
        });
      }
    }

    // Find dispatchers (incoming dispatches edges)
    for (const edge of inEdges) {
      if (edge.edge_type_name !== 'dispatches') continue;
      const sourceNode = store.getNodeByNodeId(edge.source_node_id);
      if (!sourceNode || sourceNode.node_type !== 'symbol') continue;
      const sym = store.getSymbolById(sourceNode.ref_id);
      if (sym) {
        dispatchers.push({
          name: sym.name,
          fqn: sym.fqn ?? sym.name,
          symbolId: sym.symbol_id,
        });
      }
    }
  }

  return {
    name: eventSymbol.name,
    fqn: eventSymbol.fqn ?? eventSymbol.name,
    symbolId: eventSymbol.symbol_id,
    listeners,
    dispatchers,
  };
}
