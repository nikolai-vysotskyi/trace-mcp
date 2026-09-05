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
 *
 * These used to be built as bare `z.preprocess(coerce, inner.optional())`,
 * with no outer `.optional()`. Zod v4 tracks a schema's input-side
 * optionality (`_zod.optin`) separately from its output-side optionality
 * (`_zod.optout`); for a preprocess pipe, `optin` comes from the *coercion*
 * function's schema, which has no way to statically declare "may be
 * omitted". The MCP SDK's zod-v4 JSON Schema conversion renders a tool's
 * published `inputSchema` using that input-side view, so every field built
 * this way was advertised to clients as `required` even though the runtime
 * schema happily accepted an omitted value (TRA-962). Wrapping the whole
 * pipe in an outer `.optional()` fixes this: `ZodOptional` sets both optin
 * and optout unconditionally, regardless of what it wraps.
 */
import { z } from 'zod';

function emptyToUndef<A>(v: unknown): A | undefined {
  return v === '' || v === null ? undefined : (v as A);
}

/**
 * Optional string filter: empty string / null are coerced to undefined,
 * non-empty strings are length-validated with the given `maxLen`.
 *
 * Example:
 * ```
 * file_pattern: optionalNonEmptyString(512).describe('Glob filter ...')
 * ```
 */
export function optionalNonEmptyString(maxLen = 1024) {
  return z.preprocess(emptyToUndef<string>, z.string().max(maxLen).optional()).optional();
}

/**
 * Optional enum filter: empty string / null are coerced to undefined.
 *
 * Example:
 * ```
 * kind: optionalEnum(['function','class','method']).describe('Symbol kind filter')
 * ```
 */
export function optionalEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(emptyToUndef<T[number]>, z.enum(values).optional()).optional();
}
