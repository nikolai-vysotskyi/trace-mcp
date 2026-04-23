/**
 * overtrue/laravel-favorite extraction.
 *
 * Detects:
 * - Models using Favoriter trait (the "user" side — can favorite things)
 * - Models using Favoriteable trait (the "subject" side — can be favorited)
 *
 * Both traits add Eloquent relationships:
 *   Favoriter:    favorites() (belongsToMany), hasFavorited(), favorite(), unfavorite(), toggleFavorite()
 *   Favoriteable: favoriters() (belongsToMany), favoritersCount(), isFavoritedBy()
 */
import type { RawEdge, RawSymbol } from '../../../../../plugin-api/types.js';

export interface LaravelFavoriteModelInfo {
  className: string;
  fqn: string;
  role: 'favoriter' | 'favoriteable' | 'both';
}

const NAMESPACE_RE = /namespace\s+([\w\\]+)\s*;/;
const CLASS_NAME_RE = /class\s+(\w+)/;
const FAVORITER_TRAIT_RE = /use\s+(?:[\w\\]*\\)?Favoriter\b/;
const FAVORITEABLE_TRAIT_RE = /use\s+(?:[\w\\]*\\)?Favoriteable\b/;
const FAVORITE_NAMESPACE_HINT_RE = /Overtrue\\LaravelFavorite/;

export function extractLaravelFavoriteModel(
  source: string,
  _filePath: string,
): LaravelFavoriteModelInfo | null {
  const isFavoriter = FAVORITER_TRAIT_RE.test(source);
  const isFavoriteable = FAVORITEABLE_TRAIT_RE.test(source);
  if (!isFavoriter && !isFavoriteable) return null;
  // Guard against unrelated traits with the same short name — require either a
  // namespaced use statement somewhere, or no other trait conflict.
  if (!FAVORITE_NAMESPACE_HINT_RE.test(source) && !/use\s+Overtrue/.test(source)) {
    // Heuristic fallback: if the file doesn't mention the package namespace at
    // all, skip — short-name collisions are common (e.g., custom Favoriteable).
    return null;
  }

  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const namespace = source.match(NAMESPACE_RE)?.[1] ?? '';
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  const role = isFavoriter && isFavoriteable
    ? 'both'
    : isFavoriter ? 'favoriter' : 'favoriteable';

  return { className, fqn, role };
}

export function buildLaravelFavoriteEdges(info: LaravelFavoriteModelInfo): RawEdge[] {
  const edges: RawEdge[] = [];
  if (info.role === 'favoriter' || info.role === 'both') {
    edges.push({
      edgeType: 'belongs_to_many',
      metadata: {
        sourceFqn: info.fqn,
        relation: 'favorites',
        target: 'Overtrue\\LaravelFavorite\\Favorite',
        framework: 'laravel-favorite',
      },
    });
  }
  if (info.role === 'favoriteable' || info.role === 'both') {
    edges.push({
      edgeType: 'belongs_to_many',
      metadata: {
        sourceFqn: info.fqn,
        relation: 'favoriters',
        target: 'App\\Models\\User',
        framework: 'laravel-favorite',
        note: 'target user model is project-specific; reported as App\\Models\\User by convention',
      },
    });
  }
  return edges;
}

export function buildLaravelFavoriteSymbols(info: LaravelFavoriteModelInfo): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  if (info.role === 'favoriter' || info.role === 'both') {
    symbols.push({
      symbolId: `${info.fqn}::favorites#method`,
      name: 'favorites',
      kind: 'method',
      signature: 'public function favorites(): MorphMany',
      byteStart: 0,
      byteEnd: 0,
      metadata: { frameworkRole: 'laravel_favorite_relation', modelFqn: info.fqn, role: 'favoriter' },
    });
  }
  if (info.role === 'favoriteable' || info.role === 'both') {
    symbols.push({
      symbolId: `${info.fqn}::favoriters#method`,
      name: 'favoriters',
      kind: 'method',
      signature: 'public function favoriters(): BelongsToMany',
      byteStart: 0,
      byteEnd: 0,
      metadata: { frameworkRole: 'laravel_favorite_relation', modelFqn: info.fqn, role: 'favoriteable' },
    });
  }
  return symbols;
}
