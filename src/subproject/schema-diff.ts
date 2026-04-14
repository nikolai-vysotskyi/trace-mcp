/**
 * Schema Diff — compares JSON Schema objects to detect breaking API changes.
 *
 * Detects: removed fields, added fields, type changes, renamed fields (heuristic),
 * new required fields. Used by contract versioning to flag breaking changes
 * when a service updates its API contract.
 */

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface SchemaDiff {
  type: 'field_removed' | 'field_added' | 'type_changed' | 'field_renamed' | 'required_added';
  path: string;
  oldValue?: string;
  newValue?: string;
  breaking: boolean;
  confidence: number;
}

export interface EndpointSchemaDiff {
  endpoint: { method: string | null; path: string };
  requestChanges: SchemaDiff[];
  responseChanges: SchemaDiff[];
  breaking: boolean;
}

interface EndpointWithSchema {
  method: string | null;
  path: string;
  requestSchema?: string | Record<string, unknown> | null;
  responseSchema?: string | Record<string, unknown> | null;
}

// ════════════════════════════════════════════════════════════════════════
// SCHEMA DIFFING
// ════════════════════════════════════════════════════════════════════════

/**
 * Compare two JSON Schema objects and return all field-level differences.
 * Walks `properties` recursively. Detects renames via Levenshtein + same type heuristic.
 */
export function diffSchemas(
  oldSchema: Record<string, unknown>,
  newSchema: Record<string, unknown>,
  pathPrefix = '',
): SchemaDiff[] {
  const diffs: SchemaDiff[] = [];
  if (!oldSchema || !newSchema) return diffs;

  const oldProps = (oldSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const newProps = (newSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const oldRequired = new Set(Array.isArray(oldSchema.required) ? oldSchema.required as string[] : []);
  const newRequired = new Set(Array.isArray(newSchema.required) ? newSchema.required as string[] : []);

  const oldKeys = new Set(Object.keys(oldProps));
  const newKeys = new Set(Object.keys(newProps));

  // Removed fields (in old, not in new)
  const removed = new Set<string>();
  for (const key of oldKeys) {
    if (!newKeys.has(key)) removed.add(key);
  }

  // Added fields (in new, not in old)
  const added = new Set<string>();
  for (const key of newKeys) {
    if (!oldKeys.has(key)) added.add(key);
  }

  // Detect renames: removed field with similar name + same type in added
  const renamedOld = new Set<string>();
  const renamedNew = new Set<string>();

  for (const oldKey of removed) {
    const oldType = getSchemaType(oldProps[oldKey]);
    let bestMatch: string | null = null;
    let bestDistance = Infinity;

    for (const newKey of added) {
      if (renamedNew.has(newKey)) continue;
      const newType = getSchemaType(newProps[newKey]);
      if (oldType !== newType) continue;

      const dist = levenshtein(oldKey, newKey);
      const maxLen = Math.max(oldKey.length, newKey.length);
      // Only consider as rename if edit distance < 60% of max length
      if (dist < maxLen * 0.6 && dist < bestDistance) {
        bestDistance = dist;
        bestMatch = newKey;
      }
    }

    if (bestMatch) {
      const maxLen = Math.max(oldKey.length, bestMatch.length);
      const confidence = 1 - bestDistance / maxLen;
      diffs.push({
        type: 'field_renamed',
        path: pathPrefix ? `${pathPrefix}.${oldKey}` : oldKey,
        oldValue: oldKey,
        newValue: bestMatch,
        breaking: true,
        confidence,
      });
      renamedOld.add(oldKey);
      renamedNew.add(bestMatch);
    }
  }

  // Remaining removed fields (not renames)
  for (const key of removed) {
    if (renamedOld.has(key)) continue;
    diffs.push({
      type: 'field_removed',
      path: pathPrefix ? `${pathPrefix}.${key}` : key,
      oldValue: getSchemaType(oldProps[key]),
      breaking: true,
      confidence: 1.0,
    });
  }

  // Remaining added fields
  for (const key of added) {
    if (renamedNew.has(key)) continue;
    const isNewRequired = newRequired.has(key) && !oldRequired.has(key);
    diffs.push({
      type: isNewRequired ? 'required_added' : 'field_added',
      path: pathPrefix ? `${pathPrefix}.${key}` : key,
      newValue: getSchemaType(newProps[key]),
      breaking: isNewRequired,
      confidence: 1.0,
    });
  }

  // Fields in both — check type changes and recurse into nested objects
  for (const key of oldKeys) {
    if (!newKeys.has(key) || renamedOld.has(key)) continue;
    const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    const oldProp = oldProps[key];
    const newProp = newProps[key];

    const oldType = getSchemaType(oldProp);
    const newType = getSchemaType(newProp);

    if (oldType !== newType) {
      diffs.push({
        type: 'type_changed',
        path: fieldPath,
        oldValue: oldType,
        newValue: newType,
        breaking: true,
        confidence: 1.0,
      });
    }

    // Newly required field
    if (newRequired.has(key) && !oldRequired.has(key)) {
      diffs.push({
        type: 'required_added',
        path: fieldPath,
        breaking: true,
        confidence: 1.0,
      });
    }

    // Recurse into nested object properties
    if (oldType === 'object' && newType === 'object') {
      diffs.push(...diffSchemas(oldProp, newProp, fieldPath));
    }

    // Recurse into array items
    if (oldType === 'array' && newType === 'array' && oldProp.items && newProp.items) {
      diffs.push(...diffSchemas(
        oldProp.items as Record<string, unknown>,
        newProp.items as Record<string, unknown>,
        `${fieldPath}[]`,
      ));
    }
  }

  return diffs;
}

// ════════════════════════════════════════════════════════════════════════
// ENDPOINT DIFFING
// ════════════════════════════════════════════════════════════════════════

/**
 * Compare two sets of endpoints and produce per-endpoint schema diffs.
 * Matches endpoints by method + path.
 */
export function diffEndpoints(
  oldEndpoints: EndpointWithSchema[],
  newEndpoints: EndpointWithSchema[],
): EndpointSchemaDiff[] {
  const results: EndpointSchemaDiff[] = [];

  // Build lookup for new endpoints
  const newMap = new Map<string, EndpointWithSchema>();
  for (const ep of newEndpoints) {
    newMap.set(endpointKey(ep), ep);
  }

  for (const oldEp of oldEndpoints) {
    const key = endpointKey(oldEp);
    const newEp = newMap.get(key);
    if (!newEp) continue; // endpoint was removed entirely — handled at endpoint level, not schema level

    const oldReq = parseSchemaField(oldEp.requestSchema);
    const newReq = parseSchemaField(newEp.requestSchema);
    const oldRes = parseSchemaField(oldEp.responseSchema);
    const newRes = parseSchemaField(newEp.responseSchema);

    const requestChanges = (oldReq && newReq) ? diffSchemas(oldReq, newReq) : [];
    const responseChanges = (oldRes && newRes) ? diffSchemas(oldRes, newRes) : [];

    if (requestChanges.length > 0 || responseChanges.length > 0) {
      results.push({
        endpoint: { method: oldEp.method, path: oldEp.path },
        requestChanges,
        responseChanges,
        breaking: requestChanges.some((d) => d.breaking) || responseChanges.some((d) => d.breaking),
      });
    }
  }

  return results;
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

function endpointKey(ep: { method: string | null; path: string }): string {
  return `${(ep.method ?? '*').toUpperCase()} ${ep.path}`;
}

function parseSchemaField(schema: string | Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!schema) return null;
  if (typeof schema === 'object') return schema;
  try { return JSON.parse(schema) as Record<string, unknown>; }
  catch { return null; }
}

function getSchemaType(prop: Record<string, unknown> | undefined): string {
  if (!prop) return 'unknown';
  return (prop.type as string) ?? 'unknown';
}

/**
 * Levenshtein edit distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}
