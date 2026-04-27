/**
 * Tests for Zustand / Redux Toolkit state management plugin.
 */
import { describe, it, expect } from 'vitest';
import {
  ZustandReduxPlugin,
  extractZustandStores,
  extractReduxSlices,
  extractDispatches,
} from '../../../src/indexer/plugins/integration/state/zustand/index.js';

// ── detect() ──────────────────────────────────────────────────

describe('ZustandReduxPlugin.detect()', () => {
  const plugin = new ZustandReduxPlugin();

  it('returns true when zustand is in deps', () => {
    expect(
      plugin.detect({
        rootPath: '/test',
        packageJson: { dependencies: { zustand: '^4.0.0', react: '18' } },
        configFiles: [],
      }),
    ).toBe(true);
  });

  it('returns true when @reduxjs/toolkit is in deps', () => {
    expect(
      plugin.detect({
        rootPath: '/test',
        packageJson: { dependencies: { '@reduxjs/toolkit': '^1.9.0', react: '18' } },
        configFiles: [],
      }),
    ).toBe(true);
  });

  it('returns false when neither is present', () => {
    expect(
      plugin.detect({
        rootPath: '/test',
        packageJson: { dependencies: { react: '18' } },
        configFiles: [],
      }),
    ).toBe(false);
  });
});

// ── registerSchema() ──────────────────────────────────────────

describe('ZustandReduxPlugin.registerSchema()', () => {
  const plugin = new ZustandReduxPlugin();
  const schema = plugin.registerSchema();

  it('returns state-management edge types', () => {
    const names = schema.edgeTypes!.map((e) => e.name);
    expect(names).toContain('zustand_store');
    expect(names).toContain('redux_slice');
    expect(names).toContain('dispatches_action');
    expect(names).toContain('selects_state');
  });

  it('all edge types have state-management category', () => {
    for (const et of schema.edgeTypes!) {
      expect(et.category).toBe('state-management');
    }
  });
});

// ── extractZustandStores() ────────────────────────────────────

describe('extractZustandStores()', () => {
  it('extracts a basic Zustand store', () => {
    const source = `
import { create } from 'zustand';

export const useCounterStore = create((set) => ({
  count: 0,
  name: 'counter',
  increment: (amount) => set((state) => ({ count: state.count + amount })),
  reset: () => set({ count: 0 }),
}));`;
    const stores = extractZustandStores(source);
    expect(stores).toHaveLength(1);
    expect(stores[0].name).toBe('useCounterStore');
    expect(stores[0].stateFields).toContain('count');
    expect(stores[0].stateFields).toContain('name');
    expect(stores[0].actions).toContain('increment');
    expect(stores[0].actions).toContain('reset');
  });

  it('extracts typed Zustand store with create<State>()()', () => {
    const source = `
export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  token: '',
  login: (credentials) => set({ user: credentials.user }),
}));`;
    const stores = extractZustandStores(source);
    expect(stores).toHaveLength(1);
    expect(stores[0].name).toBe('useAuthStore');
    expect(stores[0].stateFields).toContain('user');
    expect(stores[0].stateFields).toContain('token');
    expect(stores[0].actions).toContain('login');
  });

  it('returns empty for non-zustand file', () => {
    const source = `const foo = bar();`;
    expect(extractZustandStores(source)).toHaveLength(0);
  });

  it('handles multiple stores in one file', () => {
    const source = `
const useAStore = create((set) => ({ a: 1 }));
const useBStore = create((set) => ({ b: 2 }));`;
    expect(extractZustandStores(source)).toHaveLength(2);
  });
});

// ── extractReduxSlices() ──────────────────────────────────────

describe('extractReduxSlices()', () => {
  it('extracts a basic createSlice()', () => {
    const source = `
import { createSlice } from '@reduxjs/toolkit';

const counterSlice = createSlice({
  name: 'counter',
  initialState: {
    value: 0,
    status: 'idle',
  },
  reducers: {
    increment(state) { state.value += 1; },
    decrement(state) { state.value -= 1; },
    setStatus(state, action) { state.status = action.payload; },
  },
});`;
    const slices = extractReduxSlices(source);
    expect(slices).toHaveLength(1);
    expect(slices[0].name).toBe('counter');
    expect(slices[0].varName).toBe('counterSlice');
    expect(slices[0].initialStateFields).toContain('value');
    expect(slices[0].initialStateFields).toContain('status');
    expect(slices[0].reducers).toContain('increment');
    expect(slices[0].reducers).toContain('decrement');
    expect(slices[0].reducers).toContain('setStatus');
  });

  it('returns empty for non-redux file', () => {
    const source = `const x = doStuff();`;
    expect(extractReduxSlices(source)).toHaveLength(0);
  });

  it('handles exported slice', () => {
    const source = `
export const authSlice = createSlice({
  name: 'auth',
  initialState: { user: null },
  reducers: { logout(state) { state.user = null; } },
});`;
    const slices = extractReduxSlices(source);
    expect(slices).toHaveLength(1);
    expect(slices[0].name).toBe('auth');
  });
});

// ── extractDispatches() ───────────────────────────────────────

describe('extractDispatches()', () => {
  it('extracts dispatch(actionName()) calls', () => {
    const source = `
dispatch(increment());
dispatch(setStatus('loading'));`;
    const dispatches = extractDispatches(source);
    expect(dispatches).toContain('increment');
    expect(dispatches).toContain('setStatus');
  });

  it('extracts dispatch(slice.actions.x()) calls', () => {
    const source = `dispatch(counterSlice.actions.increment(5));`;
    const dispatches = extractDispatches(source);
    expect(dispatches).toContain('increment');
  });

  it('deduplicates dispatch calls', () => {
    const source = `
dispatch(increment());
dispatch(increment());`;
    const dispatches = extractDispatches(source);
    expect(dispatches.filter((d) => d === 'increment')).toHaveLength(1);
  });

  it('returns empty for no dispatches', () => {
    expect(extractDispatches('const x = 1;')).toHaveLength(0);
  });
});

// ── extractNodes() ────────────────────────────────────────────

describe('ZustandReduxPlugin.extractNodes()', () => {
  const plugin = new ZustandReduxPlugin();
  // Need to call detect first to set internal state
  plugin.detect({
    rootPath: '/test',
    packageJson: { dependencies: { zustand: '^4.0.0' } },
    configFiles: [],
  });

  it('sets frameworkRole for zustand store', () => {
    const source = `export const useStore = create((set) => ({ count: 0 }));`;
    const result = plugin.extractNodes('store.ts', Buffer.from(source), 'typescript');
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.frameworkRole).toBe('zustand_store');
    expect(parsed.routes!.length).toBeGreaterThan(0);
    expect(parsed.routes![0].method).toBe('STORE');
  });

  it('sets frameworkRole for redux slice', () => {
    const source = `const slice = createSlice({ name: 'test', initialState: { x: 1 }, reducers: {} });`;
    const result = plugin.extractNodes('slice.ts', Buffer.from(source), 'typescript');
    expect(result.isOk()).toBe(true);
    const parsed = result._unsafeUnwrap();
    expect(parsed.frameworkRole).toBe('redux_slice');
    expect(parsed.routes![0].method).toBe('SLICE');
  });

  it('returns empty for non-store file', () => {
    const source = `export function hello() { return 'hi'; }`;
    const result = plugin.extractNodes('hello.ts', Buffer.from(source), 'typescript');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().routes ?? []).toHaveLength(0);
  });

  it('skips non-typescript files', () => {
    const source = `const useStore = create((set) => ({ count: 0 }));`;
    const result = plugin.extractNodes('store.py', Buffer.from(source), 'python');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().symbols).toHaveLength(0);
  });
});
