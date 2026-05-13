/**
 * Search-mode registry — verifies the 5 bundled modes register, listing
 * is sorted, lookup works, and unknown-mode lookups return undefined.
 */
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import {
  createDefaultSearchModeRegistry,
  SEARCH_MODE_NAMES,
  SearchModeRegistry,
} from '../modes/registry.js';

function makeStore(): Store {
  return new Store(initializeDatabase(':memory:'));
}

describe('SearchModeRegistry (low-level)', () => {
  it('register / getMode / listModes happy path', () => {
    const registry = new SearchModeRegistry();
    expect(registry.listModes()).toEqual([]);

    const fake = {
      name: 'fake',
      async getContext(q: unknown) {
        return { query: q, data: q };
      },
      async getCompletion() {
        return [];
      },
      async getAnswer(r: unknown[]) {
        return r;
      },
    };
    registry.register('fake', fake as never);
    expect(registry.listModes()).toEqual(['fake']);
    expect(registry.getMode('fake')).toBe(fake);
  });

  it('unknown mode → undefined', () => {
    const registry = new SearchModeRegistry();
    expect(registry.getMode('nope')).toBeUndefined();
  });

  it('duplicate registration throws', () => {
    const registry = new SearchModeRegistry();
    const fake = {
      name: 'fake',
      async getContext(q: unknown) {
        return { query: q, data: q };
      },
      async getCompletion() {
        return [];
      },
      async getAnswer(r: unknown[]) {
        return r;
      },
    };
    registry.register('fake', fake as never);
    expect(() => registry.register('fake', fake as never)).toThrow(/already registered/);
  });

  it('empty-name registration throws', () => {
    const registry = new SearchModeRegistry();
    const fake = {
      name: 'fake',
      async getContext(q: unknown) {
        return { query: q, data: q };
      },
      async getCompletion() {
        return [];
      },
      async getAnswer(r: unknown[]) {
        return r;
      },
    };
    expect(() => registry.register('', fake as never)).toThrow(/non-empty/);
  });
});

describe('createDefaultSearchModeRegistry — bundled modes', () => {
  it('registers all 5 named modes', () => {
    const store = makeStore();
    const registry = createDefaultSearchModeRegistry({
      store,
      embedding: null,
      vectorStore: null,
    });
    expect(registry.listModes()).toEqual([...SEARCH_MODE_NAMES].sort());
  });

  it('each registered mode exposes the canonical name on the retriever', () => {
    const store = makeStore();
    const registry = createDefaultSearchModeRegistry({
      store,
      embedding: null,
      vectorStore: null,
    });
    for (const name of SEARCH_MODE_NAMES) {
      const r = registry.getMode(name);
      expect(r).toBeDefined();
      expect(r!.name).toBe(name);
    }
  });

  it('SEARCH_MODE_NAMES contains exactly the 6 expected modes', () => {
    expect([...SEARCH_MODE_NAMES].sort()).toEqual(
      ['feeling_lucky', 'graph_completion', 'hybrid', 'lexical', 'semantic', 'summary'].sort(),
    );
  });
});
