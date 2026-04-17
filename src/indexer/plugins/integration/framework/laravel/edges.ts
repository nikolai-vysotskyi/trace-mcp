/**
 * Core edge resolvers for Laravel: Eloquent, FormRequest, Event, Dispatch.
 * Extracted from LaravelPlugin to reduce class complexity.
 */
import type { RawEdge, ResolveContext } from '../../../../../plugin-api/types.js';
import { extractEloquentModel } from './eloquent.js';
import { detectFormRequestUsage } from './requests.js';
import { extractEventListeners, detectEventDispatches } from './events.js';

export function resolveEloquentEdges(
  source: string,
  file: { id: number; path: string },
  ctx: ResolveContext,
  edges: RawEdge[],
): void {
  const modelInfo = extractEloquentModel(source, file.path);
  if (!modelInfo) return;

  const sourceSymbol = ctx.getSymbolByFqn(modelInfo.fqn);
  if (!sourceSymbol) return;

  for (const rel of modelInfo.relationships) {
    const targetSymbol = ctx.getSymbolByFqn(rel.relatedClass);
    if (!targetSymbol) continue;

    edges.push({
      sourceNodeType: 'symbol',
      sourceRefId: sourceSymbol.id,
      targetNodeType: 'symbol',
      targetRefId: targetSymbol.id,
      edgeType: rel.edgeType,
      metadata: {
        method: rel.methodName,
        relationType: rel.type,
      },
    });
  }
}

export function resolveFormRequestEdges(
  source: string,
  file: { id: number; path: string },
  ctx: ResolveContext,
  edges: RawEdge[],
): void {
  const usages = detectFormRequestUsage(source);
  if (usages.length === 0) return;

  const symbols = ctx.getSymbolsByFile(file.id);
  const controllerClass = symbols.find((s) => s.kind === 'class');
  if (!controllerClass) return;

  for (const usage of usages) {
    const methodSymbol = symbols.find(
      (s) => s.kind === 'method' && s.name === usage.methodName,
    );
    if (!methodSymbol) continue;

    const requestSymbol = ctx.getSymbolByFqn(usage.requestClass);
    if (!requestSymbol) continue;

    edges.push({
      sourceNodeType: 'symbol',
      sourceRefId: methodSymbol.id,
      targetNodeType: 'symbol',
      targetRefId: requestSymbol.id,
      edgeType: 'validates_with',
      metadata: { method: usage.methodName },
    });
  }
}

export function resolveEventEdges(
  source: string,
  _file: { id: number; path: string },
  ctx: ResolveContext,
  edges: RawEdge[],
): void {
  const mappings = extractEventListeners(source);
  if (mappings.length === 0) return;

  for (const mapping of mappings) {
    const eventSymbol = ctx.getSymbolByFqn(mapping.eventClass);
    if (!eventSymbol) continue;

    for (const listenerFqn of mapping.listenerClasses) {
      const listenerSymbol = ctx.getSymbolByFqn(listenerFqn);
      if (!listenerSymbol) continue;

      edges.push({
        sourceNodeType: 'symbol',
        sourceRefId: listenerSymbol.id,
        targetNodeType: 'symbol',
        targetRefId: eventSymbol.id,
        edgeType: 'listens_to',
      });
    }
  }
}

export function resolveDispatchEdges(
  source: string,
  file: { id: number; path: string },
  ctx: ResolveContext,
  edges: RawEdge[],
): void {
  const dispatches = detectEventDispatches(source);
  if (dispatches.length === 0) return;

  const symbols = ctx.getSymbolsByFile(file.id);
  const cls = symbols.find((s) => s.kind === 'class');
  if (!cls) return;

  for (const eventFqn of dispatches) {
    const eventSymbol = ctx.getSymbolByFqn(eventFqn);
    if (!eventSymbol) continue;

    edges.push({
      sourceNodeType: 'symbol',
      sourceRefId: cls.id,
      targetNodeType: 'symbol',
      targetRefId: eventSymbol.id,
      edgeType: 'dispatches',
    });
  }
}

/**
 * Scan a composer.json file for Laravel Package Discovery entries.
 * Creates `calls` edges from the composer.json FILE → the registered ServiceProvider/facade class.
 *
 * Supports both `extra.laravel.providers` and `extra.laravel.aliases`.
 * These classes are auto-registered by Laravel at runtime via Package Discovery,
 * so they otherwise appear as orphan classes in the dependency graph.
 */
export function resolveComposerLaravelProviders(
  source: string,
  file: { id: number; path: string },
  ctx: ResolveContext,
  edges: RawEdge[],
): void {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(source);
  } catch {
    return;
  }

  const extra = (json.extra as Record<string, unknown> | undefined)?.laravel as
    | Record<string, unknown>
    | undefined;
  if (!extra) return;

  const providers = Array.isArray(extra.providers) ? (extra.providers as string[]) : [];
  const aliases = extra.aliases && typeof extra.aliases === 'object'
    ? Object.values(extra.aliases as Record<string, unknown>).filter(
        (v): v is string => typeof v === 'string',
      )
    : [];

  const registrations: Array<{ fqn: string; kind: 'provider' | 'alias' }> = [
    ...providers.map((fqn) => ({ fqn, kind: 'provider' as const })),
    ...aliases.map((fqn) => ({ fqn, kind: 'alias' as const })),
  ];

  // Determine the composer.json's package directory (workspace-scoped prefix).
  // For `top15/top15-laravel/nova-components/LinkGroupComponent/composer.json`,
  // the package prefix is `top15/top15-laravel/nova-components/LinkGroupComponent/`.
  // We prefer matches under this prefix (same package).
  const packagePrefix = file.path.replace(/\/composer\.json$/, '/');

  for (const reg of registrations) {
    // composer.json uses backslash-escaped FQNs. Normalize.
    const normalizedFqn = reg.fqn.replace(/\\\\/g, '\\').replace(/^\\/, '');

    // Disambiguate between forks: prefer a symbol whose file sits inside the
    // same composer package directory. Fall back to any FQN match.
    let targetSymbol = findSymbolByFqnScoped(ctx, normalizedFqn, packagePrefix);
    if (!targetSymbol) continue;

    edges.push({
      sourceNodeType: 'file',
      sourceRefId: file.id,
      targetNodeType: 'symbol',
      targetRefId: targetSymbol.id,
      edgeType: 'references',
      metadata: {
        registration: reg.kind,
        via: 'composer_laravel_discovery',
        fqn: normalizedFqn,
      },
    });
  }
}

/**
 * Look up a symbol by FQN, preferring matches whose file path is a descendant
 * of `preferredPrefix`. Needed because forked Laravel packages can share
 * identical FQNs across different workspaces.
 */
function findSymbolByFqnScoped(
  ctx: ResolveContext,
  fqn: string,
  preferredPrefix: string,
): { id: number; symbolId: string; name: string; kind: string; filePath: string } | null {
  // Try all files — we need to scan because getSymbolByFqn returns only one match.
  const allFiles = ctx.getAllFiles();
  // Fast path: same package directory
  for (const f of allFiles) {
    if (!f.path.startsWith(preferredPrefix)) continue;
    const syms = ctx.getSymbolsByFile(f.id);
    const hit = syms.find((s) => s.fqn === fqn);
    if (hit) return { id: hit.id, symbolId: hit.symbolId, name: hit.name, kind: hit.kind, filePath: f.path };
  }
  // Fallback: first match anywhere
  const generic = ctx.getSymbolByFqn(fqn);
  if (generic) {
    return { id: generic.id, symbolId: generic.symbolId, name: generic.name, kind: generic.kind, filePath: '' };
  }
  return null;
}
