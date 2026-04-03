/**
 * Tests for get_event_graph tool.
 * Uses in-memory store with manually inserted symbols + edges.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { getEventGraph } from '../../src/tools/events.js';

function makeStore(): Store {
  const db = initializeDatabase(':memory:');
  return new Store(db);
}

function insertSymbol(
  store: Store,
  fileId: number,
  name: string,
  fqn: string,
  kind = 'class',
): number {
  return store.insertSymbol(fileId, {
    symbolId: `sym:${fqn}`,
    name,
    kind,
    fqn,
    byteStart: 0,
    byteEnd: 100,
  });
}

describe('get_event_graph', () => {
  let store: Store;
  let fileId: number;

  beforeEach(() => {
    store = makeStore();
    fileId = store.insertFile('app/Events/OrderShipped.php', 'php', 'h1', 100);
  });

  it('returns empty events list when no edges exist', () => {
    const result = getEventGraph(store);
    expect(result.isOk()).toBe(true);
    expect(result.value.events).toHaveLength(0);
  });

  it('returns NOT_FOUND for unknown event name', () => {
    const result = getEventGraph(store, 'NonExistent');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  describe('with listens_to edges', () => {
    let eventSymId: number;
    let listenerFileId: number;
    let listenerSymId: number;

    beforeEach(() => {
      eventSymId = insertSymbol(store, fileId, 'OrderShipped', 'App\\Events\\OrderShipped');

      listenerFileId = store.insertFile('app/Listeners/SendShipmentNotification.php', 'php', 'h2', 100);
      listenerSymId = insertSymbol(
        store,
        listenerFileId,
        'SendShipmentNotification',
        'App\\Listeners\\SendShipmentNotification',
      );

      const eventNodeId = store.getNodeId('symbol', eventSymId)!;
      const listenerNodeId = store.getNodeId('symbol', listenerSymId)!;

      store.insertEdge(listenerNodeId, eventNodeId, 'listens_to');
    });

    it('finds event with its listener via getEventGraph(store)', () => {
      const result = getEventGraph(store);
      expect(result.isOk()).toBe(true);
      const events = result.value.events;

      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('OrderShipped');
      expect(events[0].fqn).toBe('App\\Events\\OrderShipped');
      expect(events[0].listeners).toHaveLength(1);
      expect(events[0].listeners[0].name).toBe('SendShipmentNotification');
    });

    it('finds specific event by short name', () => {
      const result = getEventGraph(store, 'OrderShipped');
      expect(result.isOk()).toBe(true);
      expect(result.value.events[0].name).toBe('OrderShipped');
      expect(result.value.events[0].listeners).toHaveLength(1);
    });

    it('finds specific event by FQN', () => {
      const result = getEventGraph(store, 'App\\Events\\OrderShipped');
      expect(result.isOk()).toBe(true);
      expect(result.value.events[0].listeners[0].fqn).toBe(
        'App\\Listeners\\SendShipmentNotification',
      );
    });

    it('event has no dispatchers when only listens_to edge exists', () => {
      const result = getEventGraph(store, 'OrderShipped');
      expect(result.isOk()).toBe(true);
      expect(result.value.events[0].dispatchers).toHaveLength(0);
    });
  });

  describe('with dispatches edges', () => {
    let eventSymId: number;
    let controllerFileId: number;
    let controllerSymId: number;

    beforeEach(() => {
      eventSymId = insertSymbol(store, fileId, 'OrderShipped', 'App\\Events\\OrderShipped');

      controllerFileId = store.insertFile('app/Http/Controllers/OrderController.php', 'php', 'h3', 100);
      controllerSymId = insertSymbol(
        store,
        controllerFileId,
        'OrderController',
        'App\\Http\\Controllers\\OrderController',
      );

      const eventNodeId = store.getNodeId('symbol', eventSymId)!;
      const controllerNodeId = store.getNodeId('symbol', controllerSymId)!;

      store.insertEdge(controllerNodeId, eventNodeId, 'dispatches');
    });

    it('finds event with its dispatcher via getEventGraph(store)', () => {
      const result = getEventGraph(store);
      expect(result.isOk()).toBe(true);
      const events = result.value.events;

      expect(events).toHaveLength(1);
      expect(events[0].dispatchers).toHaveLength(1);
      expect(events[0].dispatchers[0].name).toBe('OrderController');
    });

    it('event with only dispatches edge has no listeners', () => {
      const result = getEventGraph(store, 'OrderShipped');
      expect(result.isOk()).toBe(true);
      expect(result.value.events[0].listeners).toHaveLength(0);
      expect(result.value.events[0].dispatchers).toHaveLength(1);
    });
  });

  describe('with multiple events', () => {
    beforeEach(() => {
      const eventFile2 = store.insertFile('app/Events/UserRegistered.php', 'php', 'h4', 100);
      const e1 = insertSymbol(store, fileId, 'OrderShipped', 'App\\Events\\OrderShipped');
      const e2 = insertSymbol(store, eventFile2, 'UserRegistered', 'App\\Events\\UserRegistered');

      const listenerFile = store.insertFile('app/Listeners/NotifyAdmin.php', 'php', 'h5', 100);
      const l1 = insertSymbol(store, listenerFile, 'NotifyAdmin', 'App\\Listeners\\NotifyAdmin');

      store.insertEdge(store.getNodeId('symbol', l1)!, store.getNodeId('symbol', e1)!, 'listens_to');
      store.insertEdge(store.getNodeId('symbol', l1)!, store.getNodeId('symbol', e2)!, 'listens_to');
    });

    it('returns all events with listens_to edges', () => {
      const result = getEventGraph(store);
      expect(result.isOk()).toBe(true);
      expect(result.value.events).toHaveLength(2);
      const names = result.value.events.map((e) => e.name).sort();
      expect(names).toEqual(['OrderShipped', 'UserRegistered']);
    });

    it('does not duplicate events when filtered by name', () => {
      const result = getEventGraph(store, 'UserRegistered');
      expect(result.isOk()).toBe(true);
      expect(result.value.events).toHaveLength(1);
      expect(result.value.events[0].name).toBe('UserRegistered');
    });
  });

  describe('with both listens_to and dispatches edges on same event', () => {
    it('returns listeners and dispatchers together', () => {
      const eventSymId = insertSymbol(store, fileId, 'OrderShipped', 'App\\Events\\OrderShipped');

      const lFile = store.insertFile('app/Listeners/L.php', 'php', 'h6', 100);
      const cFile = store.insertFile('app/Controllers/C.php', 'php', 'h7', 100);
      const lSym = insertSymbol(store, lFile, 'Listener', 'App\\Listeners\\Listener');
      const cSym = insertSymbol(store, cFile, 'Controller', 'App\\Controllers\\Controller');

      const en = store.getNodeId('symbol', eventSymId)!;
      store.insertEdge(store.getNodeId('symbol', lSym)!, en, 'listens_to');
      store.insertEdge(store.getNodeId('symbol', cSym)!, en, 'dispatches');

      const result = getEventGraph(store, 'OrderShipped');
      expect(result.isOk()).toBe(true);
      const ev = result.value.events[0];
      expect(ev.listeners).toHaveLength(1);
      expect(ev.dispatchers).toHaveLength(1);
      expect(ev.listeners[0].name).toBe('Listener');
      expect(ev.dispatchers[0].name).toBe('Controller');
    });
  });
});
