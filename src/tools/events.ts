/**
 * get_event_graph tool — shows event/listener relationships.
 * Finds events, their listeners, and dispatchers.
 */
import type { Store, SymbolRow } from '../db/store.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { notFound } from '../errors.js';

export interface BroadcastingInfo {
  channels: { name: string; type: string }[];
  broadcastAs?: string;
  payloadFields?: string[];
}

export interface EventNode {
  name: string;
  fqn: string;
  symbolId: string;
  listeners: { name: string; fqn: string; symbolId: string }[];
  dispatchers: { name: string; fqn: string; symbolId: string }[];
  broadcasting?: BroadcastingInfo;
}

export interface EventGraphResult {
  events: EventNode[];
}

export function getEventGraph(
  store: Store,
  eventName?: string,
): TraceMcpResult<EventGraphResult> {
  const events: EventNode[] = [];

  // Edge types that represent event-like relationships across frameworks
  const LISTENER_EDGE_TYPES = ['listens_to', 'django_signal_receiver'];
  const DISPATCH_EDGE_TYPES = ['dispatches', 'celery_dispatches'];

  if (eventName) {
    // Find specific event
    const eventSymbol = findEventSymbol(store, eventName);
    if (!eventSymbol) {
      return err(notFound(`event:${eventName}`));
    }
    const node = buildEventNode(store, eventSymbol, LISTENER_EDGE_TYPES, DISPATCH_EDGE_TYPES);
    events.push(node);
  } else {
    const seen = new Set<number>();

    // Find all events that have listener/dispatch edges targeting them
    for (const edgeType of [...LISTENER_EDGE_TYPES, ...DISPATCH_EDGE_TYPES]) {
      const edges = store.getEdgesByType(edgeType);
      for (const edge of edges) {
        if (seen.has(edge.target_node_id)) continue;
        seen.add(edge.target_node_id);

        const targetNode = store.getNodeByNodeId(edge.target_node_id);
        if (!targetNode || targetNode.node_type !== 'symbol') continue;

        const sym = store.getSymbolById(targetNode.ref_id);
        if (!sym) continue;

        events.push(buildEventNode(store, sym, LISTENER_EDGE_TYPES, DISPATCH_EDGE_TYPES));
      }
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

function buildEventNode(
  store: Store,
  eventSymbol: SymbolRow,
  listenerEdgeTypes: string[],
  dispatchEdgeTypes: string[],
): EventNode {
  const nodeId = store.getNodeId('symbol', eventSymbol.id);
  const listeners: { name: string; fqn: string; symbolId: string }[] = [];
  const dispatchers: { name: string; fqn: string; symbolId: string }[] = [];

  if (nodeId) {
    const inEdges = store.getIncomingEdges(nodeId);
    for (const edge of inEdges) {
      if (listenerEdgeTypes.includes(edge.edge_type_name)) {
        const sourceNode = store.getNodeByNodeId(edge.source_node_id);
        if (!sourceNode || sourceNode.node_type !== 'symbol') continue;
        const sym = store.getSymbolById(sourceNode.ref_id);
        if (sym) {
          listeners.push({ name: sym.name, fqn: sym.fqn ?? sym.name, symbolId: sym.symbol_id });
        }
      } else if (dispatchEdgeTypes.includes(edge.edge_type_name)) {
        const sourceNode = store.getNodeByNodeId(edge.source_node_id);
        if (!sourceNode || sourceNode.node_type !== 'symbol') continue;
        const sym = store.getSymbolById(sourceNode.ref_id);
        if (sym) {
          dispatchers.push({ name: sym.name, fqn: sym.fqn ?? sym.name, symbolId: sym.symbol_id });
        }
      }
    }
  }

  // Broadcasting: check for broadcasts_on and broadcast_as edges
  let broadcasting: BroadcastingInfo | undefined;
  if (nodeId) {
    const outEdges = store.getOutgoingEdges(nodeId);
    const channels: { name: string; type: string }[] = [];
    let broadcastAs: string | undefined;
    let payloadFields: string[] | undefined;

    for (const edge of outEdges) {
      const meta = edge.metadata ? JSON.parse(edge.metadata) as Record<string, unknown> : {};
      if (edge.edge_type_name === 'broadcasts_on') {
        channels.push({ name: String(meta.channelName ?? ''), type: String(meta.channelType ?? 'public') });
      } else if (edge.edge_type_name === 'broadcast_as') {
        broadcastAs = String(meta.broadcastAs ?? '');
      }
    }

    try {
      const symMeta = eventSymbol.metadata ? JSON.parse(eventSymbol.metadata) as Record<string, unknown> : {};
      if (Array.isArray(symMeta.payloadFields)) {
        payloadFields = symMeta.payloadFields as string[];
      }
    } catch { /* ignore */ }

    if (channels.length > 0) {
      broadcasting = { channels, broadcastAs, payloadFields };
    }
  }

  return {
    name: eventSymbol.name,
    fqn: eventSymbol.fqn ?? eventSymbol.name,
    symbolId: eventSymbol.symbol_id,
    listeners,
    dispatchers,
    broadcasting,
  };
}
