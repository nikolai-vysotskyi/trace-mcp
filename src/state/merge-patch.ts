/**
 * JSON Merge Patch (RFC 7396)
 *
 * Implements the standard JSON Merge Patch algorithm described in RFC 7396:
 *
 *   define MergePatch(Target, Patch):
 *     if Patch is not an Object:
 *       return Patch
 *     if Target is not an Object:
 *       Target = {} # Target is replaced with an empty Object
 *     for each Name/Value in Patch:
 *       if Value is null:
 *         if Name exists in Target:
 *           remove Target[Name]
 *       else:
 *         Target[Name] = MergePatch(Target[Name], Value)
 *     return Target
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp) &&
    !(value instanceof Uint8Array)
  );
}

export function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // fallback
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Applies an RFC 7396 JSON Merge Patch to a target value.
 *
 * If patch is a primitive or array, target is replaced completely.
 * If patch is an object and target is not, target becomes {}.
 * For each property in patch:
 * - if value is null, property is removed from target.
 * - if value is not null, recursively merged.
 */
export function applyMergePatch<T = unknown>(target: unknown, patch: unknown): T {
  if (!isPlainObject(patch)) {
    return (patch === undefined ? undefined : cloneValue(patch)) as T;
  }

  const result: Record<string, unknown> = isPlainObject(target) ? cloneValue(target) : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else if (value !== undefined) {
      result[key] = applyMergePatch(result[key], value);
    }
  }

  return result as T;
}

/**
 * Creates an RFC 7396 JSON Merge Patch that transforms `source` into `target`.
 * Returns undefined if `source` and `target` are deeply equal.
 */
export function createMergePatch(
  source: unknown,
  target: unknown,
): Record<string, unknown> | unknown {
  if (source === target) {
    return undefined;
  }

  if (!isPlainObject(source) || !isPlainObject(target)) {
    return cloneValue(target);
  }

  const patch: Record<string, unknown> = {};
  const src = source as Record<string, unknown>;
  const tgt = target as Record<string, unknown>;

  // Detect deleted properties
  for (const key of Object.keys(src)) {
    if (!(key in tgt)) {
      patch[key] = null;
    }
  }

  // Detect added or modified properties
  for (const [key, value] of Object.entries(tgt)) {
    if (!(key in src)) {
      patch[key] = cloneValue(value);
    } else if (JSON.stringify(src[key]) !== JSON.stringify(value)) {
      if (isPlainObject(src[key]) && isPlainObject(value)) {
        const subPatch = createMergePatch(src[key], value);
        if (subPatch !== undefined) {
          patch[key] = subPatch;
        }
      } else {
        patch[key] = cloneValue(value);
      }
    }
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}
