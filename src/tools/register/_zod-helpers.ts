/**
 * Zod helpers for MCP tool input schemas.
 *
 * Background: many LLM agents fill *every* optional parameter slot with an
 * empty string `""` by default, even when their semantic intent is "no
 * filter". A naive `z.string().min(1).optional()` rejects those calls with
 * `String must contain at least 1 character(s)`, which then sends the agent
 * into a retry-or-bail loop. mempalace ran into this enough that they
 * shipped #1097 / #1084 specifically to coerce empty-string inputs to
 * "no filter" across their MCP tools.
 *
 * The helpers below normalise empty strings (and nulls) to `undefined`
 * before zod's own validation runs, so a `""` argument behaves identically
 * to omitting the field. Callers can drop them in wherever they previously
 * had `z.string().max(N).optional()`.
 */
import { z } from 'zod';

const EMPTY_TO_UNDEF = (v: unknown) => (v === '' || v === null ? undefined : v);

/**
 * Optional string filter: empty string / null are coerced to undefined,
 * non-empty strings are length-validated with the given `maxLen`.
 *
 * Example:
 * ```
 * file_pattern: optionalNonEmptyString(512).describe('Glob filter ...')
 * ```
 */
export function optionalNonEmptyString(
  maxLen = 1024,
): z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown> {
  return z.preprocess(EMPTY_TO_UNDEF, z.string().max(maxLen).optional());
}

/**
 * Optional enum filter: empty string / null are coerced to undefined.
 *
 * Example:
 * ```
 * kind: optionalEnum(['function','class','method']).describe('Symbol kind filter')
 * ```
 */
export function optionalEnum<const T extends readonly [string, ...string[]]>(
  values: T,
): z.ZodEffects<z.ZodOptional<z.ZodEnum<T>>, T[number] | undefined, unknown> {
  return z.preprocess(EMPTY_TO_UNDEF, z.enum(values).optional());
}
