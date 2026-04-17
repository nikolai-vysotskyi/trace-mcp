/**
 * spatie/laravel-medialibrary extraction.
 *
 * Detects:
 * - Models implementing HasMedia interface and using InteractsWithMedia trait
 * - registerMediaCollections() method definitions
 * - Named media collections (addMediaCollection('name'))
 */
import type { RawEdge, RawSymbol } from '../../../../../plugin-api/types.js';

// ─── Interfaces ──────────────────────────────────────────────

export interface MediaLibraryModelInfo {
  className: string;
  fqn: string;
  collections: string[];
  hasMediaInterface: boolean;
}

// ─── Detection ───────────────────────────────────────────────

const NAMESPACE_RE = /namespace\s+([\w\\]+)\s*;/;
const CLASS_NAME_RE = /class\s+(\w+)/;
const INTERACTS_WITH_MEDIA_RE = /use\s+(?:[\w\\]*\\)?InteractsWithMedia\b/;
const HAS_MEDIA_INTERFACE_RE = /implements\s+[^\{]*?\bHasMedia\b/;
const ADD_MEDIA_COLLECTION_RE = /addMediaCollection\s*\(\s*['"]([^'"]+)['"]/g;

// ─── Model extraction ────────────────────────────────────────

/**
 * Extract InteractsWithMedia trait + HasMedia interface usage and declared media collections.
 */
export function extractMediaLibraryModel(
  source: string,
  _filePath: string,
): MediaLibraryModelInfo | null {
  const usesTrait = INTERACTS_WITH_MEDIA_RE.test(source);
  const hasInterface = HAS_MEDIA_INTERFACE_RE.test(source);
  if (!usesTrait && !hasInterface) return null;
  if (!/class\s+\w+/.test(source)) return null;

  const nsMatch = source.match(NAMESPACE_RE);
  const namespace = nsMatch?.[1] ?? '';
  const classMatch = source.match(CLASS_NAME_RE);
  if (!classMatch) return null;
  const className = classMatch[1];
  const fqn = namespace ? `${namespace}\\${className}` : className;

  const collections: string[] = [];
  let match: RegExpExecArray | null;
  const collectionRe = new RegExp(ADD_MEDIA_COLLECTION_RE.source, ADD_MEDIA_COLLECTION_RE.flags);
  while ((match = collectionRe.exec(source)) !== null) {
    collections.push(match[1]);
  }

  return { className, fqn, collections, hasMediaInterface: hasInterface };
}

// ─── Edge builders ───────────────────────────────────────────

export function buildMediaLibraryModelEdges(info: MediaLibraryModelInfo): RawEdge[] {
  const edges: RawEdge[] = [];
  for (const collection of info.collections) {
    edges.push({
      edgeType: 'medialibrary_collection',
      metadata: {
        modelFqn: info.fqn,
        collection,
      },
    });
  }
  return edges;
}

export function buildMediaLibraryModelSymbols(info: MediaLibraryModelInfo): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  if (info.collections.length === 0) {
    return symbols;
  }
  symbols.push({
    name: `${info.className}::mediaCollections`,
    kind: 'variable',
    signature: `media [${info.collections.join(', ')}]`,
    metadata: {
      frameworkRole: 'medialibrary_model',
      modelFqn: info.fqn,
      collections: info.collections,
    },
  });
  return symbols;
}
