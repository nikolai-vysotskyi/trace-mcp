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
