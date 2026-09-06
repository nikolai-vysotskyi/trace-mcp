/**
 * Min/max over an array without spreading it into a call.
 *
 * `Math.min(...xs)` passes every element as a separate argument, so it throws
 * `RangeError: Maximum call stack size exceeded` once the array exceeds V8's
 * argument limit (~65k–125k, stack-dependent). That is not a theoretical
 * ceiling: reported from the field (GitHub #957) as `search` failing on every
 * query against a 152 734-symbol index, while the same query worked on a small
 * one — the small index takes the on-the-fly fallback and never reaches the
 * ranking code.
 *
 * Any array whose length is bounded by the index rather than by a `limit` has
 * to be reduced, not spread.
 */
export function minMax(values: readonly number[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}
