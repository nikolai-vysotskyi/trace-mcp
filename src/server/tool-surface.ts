/**
 * Progressive tool disclosure (TRA-402): the shared vocabulary for "this tool
 * exists but this session hasn't paid for its schema yet".
 *
 * A preset used to be a permanent restriction — a tool outside it was never
 * registered and could never be reached. That made the small presets a bad
 * trade: the session saved schema tokens up front but lost the tool for good,
 * so most users ran `full` and paid the whole surface on every session.
 *
 * With `load_tools` a preset becomes a *deferral* instead. The tools outside
 * it are registered but disabled, invisible to `tools/list`, and one call away.
 * `tools.exclude` keeps its old meaning — a hard restriction that escalation
 * must not be able to undo.
 *
 * Both surfaces need the same name resolution: the local server (tool-gate.ts,
 * which owns the RegisteredTool objects) and the daemon proxy
 * (daemon/router/proxy-backend.ts, which can only filter frames). This module
 * is the piece they share so they cannot drift apart.
 */
import { z } from 'zod';
import { resolvePreset } from '../tools/project/presets.js';

/**
 * Convert a RegisteredTool's stored input schema into JSON Schema, the shape a
 * client would have received from `tools/list`. Returning it inline is what
 * makes escalation work for clients that ignore `tools/list_changed`: they get
 * the schema in the `load_tools` response and can drive the tool via `batch`.
 * Anything unconvertible yields `undefined` rather than failing the load.
 */
export function toJsonSchemaOrUndefined(schema: unknown): unknown {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema as z.ZodType);
  } catch {
    return undefined;
  }
}

/** Outcome of resolving a `load_tools` request against the deferred surface. */
export interface ToolLoadPlan {
  /** Deferred tools the request names, which this session may load. */
  load: string[];
  /** Named tools that are already part of the live surface. */
  alreadyLoaded: string[];
  /** Names that match no tool this server knows about. */
  unknown: string[];
  /** Named tools held back by `tools.exclude` — escalation must not undo that. */
  blocked: string[];
}

/**
 * Expand a `load_tools` request into concrete tool names.
 *
 * `preset` contributes that preset's membership; `tools` contributes explicit
 * names. Passing both unions them — an agent that wants "the review preset plus
 * taint_analysis" shouldn't need two round-trips. `full`/`all` means every
 * deferred tool.
 */
export function expandLoadRequest(
  request: { preset?: string; tools?: string[] },
  deferred: readonly string[],
): string[] {
  const names = new Set<string>(request.tools ?? []);
  if (request.preset) {
    const resolved = resolvePreset(request.preset);
    if (resolved === 'all') {
      for (const name of deferred) names.add(name);
    } else if (resolved) {
      for (const name of resolved) names.add(name);
    } else {
      // An unknown preset name is a caller error, not a silent no-op — surface
      // it through `unknown` rather than quietly loading nothing.
      names.add(`preset:${request.preset}`);
    }
  }
  return [...names];
}

/**
 * Sort the requested names into the four buckets `load_tools` reports back.
 *
 * `known` is every tool this server registered (loaded or deferred), so a
 * typo lands in `unknown` instead of looking like a permissions problem.
 */
export function planToolLoad(
  requested: readonly string[],
  known: {
    isLoaded: (name: string) => boolean;
    isDeferred: (name: string) => boolean;
    isExcluded: (name: string) => boolean;
  },
): ToolLoadPlan {
  const plan: ToolLoadPlan = { load: [], alreadyLoaded: [], unknown: [], blocked: [] };
  for (const name of requested) {
    if (known.isExcluded(name)) plan.blocked.push(name);
    else if (known.isLoaded(name)) plan.alreadyLoaded.push(name);
    else if (known.isDeferred(name)) plan.load.push(name);
    else plan.unknown.push(name);
  }
  return plan;
}

/**
 * The escalation hint every deferred-surface response carries. Written once
 * here because the local server and the daemon proxy both emit it, and an
 * agent that only ever sees one of them must get the same instructions.
 */
export const LOAD_TOOLS_HINT =
  'Tools loaded. If your client re-reads tools/list on notifications/tools/list_changed they are now callable directly; ' +
  'otherwise call them through `batch` ({ calls: [{ tool, args }] }) using the schemas returned above.';

/** A deferred tool as the gate records it (see server/tool-gate.ts). */
export interface DeferredToolEntry<H = unknown> {
  registered: { enabled: boolean; description?: string; inputSchema?: unknown };
  handler: H;
}

/** Everything `runLoadTools` mutates or consults on the local-server path. */
export interface LoadToolsDeps<H = unknown> {
  deferredTools: Map<string, DeferredToolEntry<H>>;
  toolHandlers: Map<string, H>;
  registeredToolNames: string[];
  isExcluded: (name: string) => boolean;
  /** Emit exactly one notifications/tools/list_changed for the whole batch. */
  notifyListChanged: () => void;
}

/**
 * Body of the `load_tools` tool, as a pure-ish function so it can be tested
 * without standing up a full server context. Enables the requested deferred
 * tools, installs their handlers (so `batch` reaches them too), and returns the
 * response payload — including each loaded tool's schema, which is what makes
 * escalation work on clients that ignore `tools/list_changed`.
 */
export function runLoadTools<H>(
  deps: LoadToolsDeps<H>,
  args: { preset?: string; tools?: string[] },
): Record<string, unknown> {
  const deferredNames = [...deps.deferredTools.keys()];

  // No arguments is the discovery call, not an error: it lists what this
  // session deferred. Discovery has to work from inside the smallest preset
  // without depending on any other tool being registered.
  if (!args.preset && !(args.tools && args.tools.length > 0)) {
    return {
      loaded: [],
      deferred_tools: deferredNames,
      hint: 'Names only — the schemas are what this session is not paying for. Call load_tools again with `tools` or `preset` to pull any of them in.',
    };
  }

  const plan = planToolLoad(expandLoadRequest(args, deferredNames), {
    isLoaded: (n) => deps.toolHandlers.has(n),
    isDeferred: (n) => deps.deferredTools.has(n),
    isExcluded: deps.isExcluded,
  });

  const tools: Array<{ name: string; description?: string; input_schema?: unknown }> = [];
  for (const name of plan.load) {
    const entry = deps.deferredTools.get(name);
    if (!entry) continue;
    entry.registered.enabled = true;
    deps.toolHandlers.set(name, entry.handler);
    deps.registeredToolNames.push(name);
    deps.deferredTools.delete(name);
    tools.push({
      name,
      description: entry.registered.description,
      input_schema: toJsonSchemaOrUndefined(entry.registered.inputSchema),
    });
  }

  if (plan.load.length > 0) deps.notifyListChanged();

  return {
    loaded: plan.load,
    already_loaded: plan.alreadyLoaded,
    unknown: plan.unknown,
    blocked: plan.blocked,
    tools,
    still_deferred: deps.deferredTools.size,
    hint: plan.load.length > 0 ? LOAD_TOOLS_HINT : undefined,
  };
}
