import type { ExtractedCte, ExtractedRelationRef } from './ast-extract.js';
import { mapPreprocessedLine, mapPreprocessedSpan, type SqlPositionMap } from './sql-source-map.js';

export function remapExtractedToOriginal(
  map: SqlPositionMap,
  ctes: ExtractedCte[],
  relationRefs: ExtractedRelationRef[],
): { ctes: ExtractedCte[]; relationRefs: ExtractedRelationRef[] } {
  const remappedCtes = ctes.map((cte) => {
    const span = mapPreprocessedSpan(map, cte.byteStart, cte.byteEnd);
    return {
      ...cte,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      byteStart: span.byteStart,
      byteEnd: span.byteEnd,
    };
  });

  const remappedRefs = relationRefs.map((ref) => ({
    ...ref,
    lineStart: mapPreprocessedLine(map, ref.lineStart),
  }));

  return { ctes: remappedCtes, relationRefs: remappedRefs };
}
