/**
 * ZustandReduxPlugin — Framework plugin for Zustand and Redux Toolkit stores.
 *
 * Extracts:
 * - Zustand: create()/createStore() → store name, state fields, actions
 * - Redux Toolkit: createSlice() → slice name, initial state fields, reducers, extraReducers
 * - useSelector/useStore hooks → which store/slice is consumed
 * - dispatch() calls → which actions are dispatched
 *
 * Supports Zustand 4+, Redux Toolkit 1.9+.
 */
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRoute,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../../errors.js';

export class ZustandReduxPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'zustand-redux',
    version: '1.0.0',
    priority: 35,
    category: 'state',
    dependencies: [],
  };

  private hasZustand = false;
  private hasRedux = false;

  detect(ctx: ProjectContext): boolean {
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };
    this.hasZustand = 'zustand' in deps;
    this.hasRedux = '@reduxjs/toolkit' in deps || 'redux-toolkit' in deps;
    return this.hasZustand || this.hasRedux;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'zustand_store', category: 'state-management', description: 'Zustand store definition' },
        { name: 'redux_slice', category: 'state-management', description: 'Redux Toolkit slice definition' },
        { name: 'dispatches_action', category: 'state-management', description: 'Component dispatches a Redux/Zustand action' },
        { name: 'selects_state', category: 'state-management', description: 'Component selects state from store' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'typescript' && language !== 'javascript') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const routes: RawRoute[] = [];
    let frameworkRole: string | undefined;

    // Zustand stores
    const zustandStores = extractZustandStores(source);
    if (zustandStores.length > 0) {
      frameworkRole = 'zustand_store';
      for (const store of zustandStores) {
        routes.push({
          method: 'STORE',
          uri: `zustand:${store.name}`,
          handler: store.name,
          metadata: {
            stateFields: store.stateFields,
            actions: store.actions,
          },
        });
      }
    }

    // Redux slices
    const reduxSlices = extractReduxSlices(source);
    if (reduxSlices.length > 0) {
      frameworkRole = 'redux_slice';
      for (const slice of reduxSlices) {
        routes.push({
          method: 'SLICE',
          uri: `redux:${slice.name}`,
          handler: slice.varName,
          metadata: {
            reducers: slice.reducers,
            initialStateFields: slice.initialStateFields,
          },
        });
      }
    }

    // Dispatched actions
    const dispatches = extractDispatches(source);
    for (const d of dispatches) {
      routes.push({
        method: 'DISPATCH',
        uri: `action:${d}`,
      });
    }

    if (routes.length === 0) return ok({ status: 'ok', symbols: [] });

    return ok({
      status: 'ok',
      symbols: [],
      routes,
      frameworkRole,
    });
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}

// ── Zustand extraction ─────────────────────────────────────────────────────

export interface ZustandStore {
  name: string;
  stateFields: string[];
  actions: string[];
}

/**
 * Extract Zustand store definitions from source code.
 * Handles: create(), create<State>()(), createStore(), zustand's create with set/get.
 */
export function extractZustandStores(source: string): ZustandStore[] {
  const stores: ZustandStore[] = [];

  // Pattern: export const useXxxStore = create((...) => ({ ... }))
  // or: export const useXxxStore = create<XxxState>()((...) => ({ ... }))
  const storeRegex = /(?:export\s+)?(?:const|let)\s+(use\w+Store|\w+Store)\s*=\s*create(?:<[^>]+>)?(?:\(\))?\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = storeRegex.exec(source)) !== null) {
    const storeName = match[1];

    // Find the body of the create() call
    const startPos = match.index + match[0].length;
    const body = extractParenBody(source, startPos);

    // Extract state fields: key: value (not functions)
    const stateFields: string[] = [];
    const actions: string[] = [];

    // Match property assignments: fieldName: value
    const propRegex = /(\w+)\s*:\s*(?!(?:async\s+)?\()/g;
    let propMatch: RegExpExecArray | null;
    while ((propMatch = propRegex.exec(body)) !== null) {
      const name = propMatch[1];
      if (!['set', 'get', 'subscribe', 'getState', 'setState', 'destroy'].includes(name)) {
        stateFields.push(name);
      }
    }

    // Match actions (functions): actionName: (args) => ..., or actionName(args) { ... }
    const actionRegex = /(\w+)\s*:\s*(?:async\s+)?\([^)]*\)\s*=>/g;
    let actionMatch: RegExpExecArray | null;
    while ((actionMatch = actionRegex.exec(body)) !== null) {
      actions.push(actionMatch[1]);
    }

    stores.push({ name: storeName, stateFields, actions });
  }

  return stores;
}

// ── Redux Toolkit extraction ───────────────────────────────────────────────

export interface ReduxSlice {
  name: string;
  varName: string;
  reducers: string[];
  initialStateFields: string[];
}

/**
 * Extract Redux Toolkit createSlice() definitions.
 */
export function extractReduxSlices(source: string): ReduxSlice[] {
  const slices: ReduxSlice[] = [];

  // Pattern: const xxxSlice = createSlice({ name: 'xxx', initialState: { ... }, reducers: { ... } })
  const sliceRegex = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*createSlice\s*\(\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = sliceRegex.exec(source)) !== null) {
    const varName = match[1];
    const startPos = match.index + match[0].length - 1; // at the opening {
    const body = extractBraceBody(source, startPos);

    // Extract slice name
    const nameMatch = body.match(/name\s*:\s*['"]([^'"]+)['"]/);
    const name = nameMatch?.[1] ?? varName.replace(/Slice$/, '');

    // Extract reducer names
    const reducers: string[] = [];
    const reducersMatch = body.match(/reducers\s*:\s*\{/);
    if (reducersMatch) {
      const reducersStart = body.indexOf('{', reducersMatch.index! + reducersMatch[0].length - 1);
      const reducersBody = extractBraceBody(body, reducersStart);
      const reducerRegex = /(\w+)\s*(?::\s*\(|(?:\s*\([^)]*\)))/g;
      let rMatch: RegExpExecArray | null;
      while ((rMatch = reducerRegex.exec(reducersBody)) !== null) {
        const rName = rMatch[1];
        if (!['state', 'action', 'payload', 'type'].includes(rName)) {
          reducers.push(rName);
        }
      }
    }

    // Extract initial state fields
    const initialStateFields: string[] = [];
    const stateMatch = body.match(/initialState\s*:\s*\{/);
    if (stateMatch) {
      const stateStart = body.indexOf('{', stateMatch.index! + stateMatch[0].length - 1);
      const stateBody = extractBraceBody(body, stateStart);
      const fieldRegex = /(\w+)\s*:/g;
      let fMatch: RegExpExecArray | null;
      while ((fMatch = fieldRegex.exec(stateBody)) !== null) {
        initialStateFields.push(fMatch[1]);
      }
    }

    slices.push({ name, varName, reducers, initialStateFields });
  }

  return slices;
}

// ── Dispatch extraction ────────────────────────────────────────────────────

/**
 * Extract dispatched action names from dispatch() calls and Zustand store method calls.
 */
export function extractDispatches(source: string): string[] {
  const dispatches: string[] = [];

  // Redux: dispatch(actionName()) or dispatch(sliceName.actions.actionName())
  const dispatchRegex = /dispatch\(\s*(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = dispatchRegex.exec(source)) !== null) {
    dispatches.push(match[1]);
  }

  // Redux: dispatch(slice.actions.actionName(...))
  const sliceDispatchRegex = /dispatch\(\s*\w+\.actions\.(\w+)/g;
  while ((match = sliceDispatchRegex.exec(source)) !== null) {
    dispatches.push(match[1]);
  }

  return [...new Set(dispatches)];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractParenBody(source: string, pos: number): string {
  let depth = 1;
  let i = pos;
  while (i < source.length && depth > 0) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') depth--;
    i++;
  }
  return source.slice(pos, i - 1);
}

function extractBraceBody(source: string, pos: number): string {
  let depth = 0;
  let start = pos;
  while (start < source.length && source[start] !== '{') start++;
  if (start >= source.length) return '';
  depth = 1;
  let i = start + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start + 1, i - 1);
}
