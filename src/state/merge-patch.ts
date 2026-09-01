/**
 * RFC 7396 JSON Merge Patch implementation.
 *
 * Specification:
 * define MergePatch(Target, Patch):
 *   if Patch is not an Object:
 *     return Patch
 *   if Target is not an Object:
 *     Target = {}
 *   for each Name/Value in Patch:
 *     if Value is null:
 *       if Name in Target:
 *         remove Target[Name]
 *     else:
 *       Target[Name] = MergePatch(Target[Name], Value)
 *   return Target
 */

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function deepClone<T>(val: T): T {
  if (val === undefined) return undefined as unknown as T;
  return JSON.parse(JSON.stringify(val));
}

export function applyJsonMergePatch<T = unknown>(target: unknown, patch: unknown): T {
  if (!isPlainObject(patch)) {
    return deepClone(patch) as T;
  }

  const result: Record<string, unknown> = isPlainObject(target) ? deepClone(target) : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else if (isPlainObject(value)) {
      result[key] = applyJsonMergePatch(result[key], value);
    } else {
      result[key] = deepClone(value);
    }
  }

  return result as T;
}
