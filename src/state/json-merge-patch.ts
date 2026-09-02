/**
 * JSON Merge Patch (RFC 7396) implementation.
 *
 * Implements the standard JSON Merge Patch algorithm:
 * - If patch is not an object, replaces target with patch.
 * - If patch is an object and target is not an object, initializes target as `{}`.
 * - For each key in patch:
 *   - If value is null, deletes key from target.
 *   - Otherwise, recursively applies merge patch to target[key] with value.
 */

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function cloneValue<T>(val: T): T {
  if (val === undefined || val === null) return val;
  if (typeof structuredClone === 'function') {
    return structuredClone(val);
  }
  return JSON.parse(JSON.stringify(val));
}

/**
 * Applies an RFC 7396 JSON Merge Patch to a target document.
 * Returns the patched document without mutating the original input.
 */
export function applyJsonMergePatch<T = unknown>(target: unknown, patch: unknown): T {
  if (!isPlainObject(patch)) {
    return (patch === undefined ? undefined : cloneValue(patch)) as T;
  }

  const result: Record<string, unknown> = isPlainObject(target) ? cloneValue(target) : {};

  for (const [key, patchVal] of Object.entries(patch)) {
    if (patchVal === null) {
      delete result[key];
    } else {
      result[key] = applyJsonMergePatch(result[key], patchVal);
    }
  }

  return result as T;
}
