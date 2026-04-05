/**
 * Cache for pre-compiled global RegExp instances.
 * Avoids re-creating RegExp objects from .source on every function call.
 * Usage: replace `new RegExp(PATTERN.source, 'g')` with `globalRe(PATTERN)`.
 */
const globalReCache = new WeakMap<RegExp, RegExp>();
const globalResCaches = new WeakMap<RegExp, RegExp>();

/**
 * Returns a reusable global RegExp from a non-global pattern.
 * Resets lastIndex before returning so it's safe for consecutive exec() loops.
 * The regex is compiled once and cached via WeakMap keyed on the source pattern.
 */
export function globalRe(pattern: RegExp): RegExp {
  let cached = globalReCache.get(pattern);
  if (!cached) {
    cached = new RegExp(pattern.source, 'g');
    globalReCache.set(pattern, cached);
  }
  cached.lastIndex = 0;
  return cached;
}

/**
 * Same as globalRe but with dotAll flag ('gs').
 */
export function globalReS(pattern: RegExp): RegExp {
  let cached = globalResCaches.get(pattern);
  if (!cached) {
    cached = new RegExp(pattern.source, 'gs');
    globalResCaches.set(pattern, cached);
  }
  cached.lastIndex = 0;
  return cached;
}
