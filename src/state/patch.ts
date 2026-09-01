/**
 * RFC 7396 JSON Merge Patch Implementation
 *
 * https://datatracker.ietf.org/doc/html/rfc7396
 */

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Recursively applies an RFC 7396 JSON Merge Patch to a target object.
 *
 * - If patch is not an object, patch is returned (replacing target).
 * - If target is not an object, it is converted to a plain object.
 * - If a key in patch has value `null`, that key is deleted from target.
 * - Otherwise, the value is recursively merged.
 */
export function applyJsonMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) {
    return patch;
  }

  const base: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
    } else {
      base[key] = applyJsonMergePatch(base[key], value);
    }
  }

  return base;
}
