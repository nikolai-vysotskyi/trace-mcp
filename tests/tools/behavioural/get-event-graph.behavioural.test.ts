/**
 * Behavioural coverage for `getEventGraph()` (the `get_event_graph` MCP tool).
 * Seeds an event class with two incoming edges:
 *   - `listens_to` from a listener class
 *   - `dispatches` from a controller class
 * Asserts the listener/dispatcher split, the eventName filter, the
 * empty-index envelope, and the NOT_FOUND error for unknown events.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getEventGraph } from '../../../src/tools/framework/events.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

function seed(): Fixture {
  const store = createTestStore();

  // Event class.
  const eventFileId = store.insertFile('app/Events/UserRegistered.php', 'php', 'h-evt', 200);
  const eventSymDb = store.insertSymbol(eventFileId, {
    symbolId: 'app/Events/UserRegistered.php::App\\Events\\UserRegistered#class',
    name: 'UserRegistered',
    kind: 'class',
    fqn: 'App\\Events\\UserRegistered',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 12,
  });

  // Listener class.
  const listenerFileId = store.insertFile(
    'app/Listeners/SendWelcomeEmail.php',
    'php',
    'h-lis',
    200,
  );
  const listenerSymDb = store.insertSymbol(listenerFileId, {
    symbolId: 'app/Listeners/SendWelcomeEmail.php::App\\Listeners\\SendWelcomeEmail#class',
    name: 'SendWelcomeEmail',
    kind: 'class',
    fqn: 'App\\Listeners\\SendWelcomeEmail',
    byteStart: 0,
    byteEnd: 120,
    lineStart: 1,
    lineEnd: 15,
  });

  // Dispatcher (controller) class.
  const dispFileId = store.insertFile('app/Http/AuthController.php', 'php', 'h-disp', 200);
  const dispSymDb = store.insertSymbol(dispFileId, {
    symbolId: 'app/Http/AuthController.php::App\\Http\\AuthController#class',
    name: 'AuthController',
    kind: 'class',
    fqn: 'App\\Http\\AuthController',
    byteStart: 0,
    byteEnd: 150,
    lineStart: 1,
    lineEnd: 20,
  });

  // Edges: listener -listens_to-> event ; dispatcher -dispatches-> event.
  const eventNid = store.getNodeId('symbol', eventSymDb);
  const listenerNid = store.getNodeId('symbol', listenerSymDb);
  const dispNid = store.getNodeId('symbol', dispSymDb);
  if (eventNid != null && listenerNid != null) {
    store.insertEdge(listenerNid, eventNid, 'listens_to', true, undefined, false, 'ast_resolved');
  }
  if (eventNid != null && dispNid != null) {
    store.insertEdge(dispNid, eventNid, 'dispatches', true, undefined, false, 'ast_resolved');
  }

  return { store };
}

describe('getEventGraph() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('returns events[] with the seeded event when no filter is given', () => {
    const result = getEventGraph(ctx.store);
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(Array.isArray(out.events)).toBe(true);
    expect(out.events.length).toBeGreaterThan(0);
    const evt = out.events.find((e) => e.name === 'UserRegistered');
    expect(evt).toBeDefined();
    expect(evt!.fqn).toBe('App\\Events\\UserRegistered');
  });

  it('splits incoming edges into listeners vs dispatchers by edge type', () => {
    const result = getEventGraph(ctx.store, 'UserRegistered');
    expect(result.isOk()).toBe(true);
    const evt = result._unsafeUnwrap().events[0];
    expect(evt.listeners.length).toBe(1);
    expect(evt.listeners[0].name).toBe('SendWelcomeEmail');
    expect(evt.dispatchers.length).toBe(1);
    expect(evt.dispatchers[0].name).toBe('AuthController');
  });

  it('each listener/dispatcher entry has name + fqn + symbolId', () => {
    const result = getEventGraph(ctx.store, 'UserRegistered');
    expect(result.isOk()).toBe(true);
    const evt = result._unsafeUnwrap().events[0];
    for (const ref of [...evt.listeners, ...evt.dispatchers]) {
      expect(typeof ref.name).toBe('string');
      expect(typeof ref.fqn).toBe('string');
      expect(typeof ref.symbolId).toBe('string');
    }
  });

  it('eventName filter narrows to exactly that event', () => {
    const result = getEventGraph(ctx.store, 'UserRegistered');
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(out.events.length).toBe(1);
    expect(out.events[0].name).toBe('UserRegistered');
  });

  it('empty store returns an empty events array, not an error', () => {
    const emptyStore = createTestStore();
    const result = getEventGraph(emptyStore);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().events).toEqual([]);
  });

  it('unknown event name surfaces NOT_FOUND error', () => {
    const result = getEventGraph(ctx.store, 'NoSuchEvent');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });
});
