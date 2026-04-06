/**
 * Laravel Event/Listener graph extraction.
 * Parses EventServiceProvider $listen property and event()/dispatch() calls.
 */
import type { RawEdge } from '../../../../../plugin-api/types.js';

interface EventListenerMapping {
  eventClass: string;
  listenerClasses: string[];
}

interface EventDispatch {
  eventClass: string;
  location: string; // 'ClassName::methodName' or similar
}

/**
 * Extract $listen mappings from an EventServiceProvider source.
 * Returns Event -> Listener[] pairs.
 */
export function extractEventListeners(
  source: string,
): EventListenerMapping[] {
  const mappings: EventListenerMapping[] = [];
  const useMap = buildUseMap(source);

  // Match: protected $listen = [ EventClass::class => [ ListenerClass::class, ... ], ... ];
  const listenMatch = source.match(
    /\$listen\s*=\s*\[([\s\S]*?)\]\s*;/,
  );
  if (!listenMatch) return mappings;

  const body = listenMatch[1];

  // Match each event => listeners pair
  const pairRegex = /([\w\\]+)::class\s*=>\s*\[([\s\S]*?)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pairRegex.exec(body)) !== null) {
    const eventRef = match[1];
    const listenersBlock = match[2];

    const eventClass = resolveClass(eventRef, useMap);
    const listenerClasses: string[] = [];

    const listenerRegex = /([\w\\]+)::class/g;
    let lm: RegExpExecArray | null;
    while ((lm = listenerRegex.exec(listenersBlock)) !== null) {
      listenerClasses.push(resolveClass(lm[1], useMap));
    }

    mappings.push({ eventClass, listenerClasses });
  }

  return mappings;
}

/**
 * Detect event() and dispatch() calls in a source file.
 * Returns a list of dispatched event class references.
 */
export function detectEventDispatches(
  source: string,
): string[] {
  const useMap = buildUseMap(source);
  const dispatches: string[] = [];

  // Match: event(new EventClass(...))
  const eventRegex = /\bevent\s*\(\s*new\s+(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = eventRegex.exec(source)) !== null) {
    dispatches.push(resolveClass(match[1], useMap));
  }

  // Match: EventClass::dispatch(...)
  const dispatchRegex = /(\w+)::dispatch\s*\(/g;
  while ((match = dispatchRegex.exec(source)) !== null) {
    const cls = match[1];
    // Skip Route::dispatch, etc.
    if (['Route', 'Bus', 'Queue'].includes(cls)) continue;
    dispatches.push(resolveClass(cls, useMap));
  }

  return dispatches;
}

/**
 * Build listens_to edges from event-listener mappings.
 */
export function buildEventEdges(
  mappings: EventListenerMapping[],
): RawEdge[] {
  const edges: RawEdge[] = [];

  for (const mapping of mappings) {
    for (const listener of mapping.listenerClasses) {
      edges.push({
        edgeType: 'listens_to',
        metadata: {
          sourceFqn: listener,
          targetFqn: mapping.eventClass,
        },
      });
    }
  }

  return edges;
}

/**
 * Build dispatches edges from detected event dispatches.
 */
export function buildDispatchEdges(
  sourceFqn: string,
  dispatches: string[],
): RawEdge[] {
  return dispatches.map((eventClass) => ({
    edgeType: 'dispatches',
    metadata: {
      sourceFqn,
      targetFqn: eventClass,
    },
  }));
}

/** Build a map of short class name -> FQN from use statements. */
function buildUseMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const regex = /use\s+([\w\\]+?)(?:\s+as\s+(\w+))?;/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const fqn = match[1];
    const alias = match[2] ?? fqn.split('\\').pop()!;
    map.set(alias, fqn);
  }
  return map;
}

/** Resolve a short class name to FQN using use map. */
function resolveClass(ref: string, useMap: Map<string, string>): string {
  if (ref.includes('\\')) return ref;
  return useMap.get(ref) ?? ref;
}
