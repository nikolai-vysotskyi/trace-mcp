/**
 * Compact wire format ("munch-lite") for tool responses.
 *
 * Two transformations are applied independently and can be toggled:
 *   1. Path interning — strings that look like file paths and repeat ≥2 times in
 *      the response are replaced with `@N` references and listed once in `__dict`.
 *   2. Row packing — homogeneous arrays of objects (every element shares the same
 *      key set) become `{ __rows: [keys], data: [[v1,v2,...], ...] }`.
 *
 * Empirical findings (see scripts/munch-experiment.ts):
 *   - Path interning alone: ~0% token savings (cl100k_base tokenizes repeated
 *     paths efficiently; the `@N` overhead cancels the win).
 *   - Path interning + row packing: ~25% token savings, but row-packing forces
 *     the LLM to remember positional key order. We ship it as opt-in only.
 *
 * `auto` mode encodes both forms and falls back to JSON when the compact form
 * doesn't beat JSON by a configurable margin (default 15% bytes — bytes, not
 * tokens, because byte length is cheap to measure and correlates well enough).
 */

export type WireFormat = 'json' | 'compact' | 'auto';

export interface WireFormatOptions {
  /** Enable path-interning. Default false (low-value on its own). */
  internPaths?: boolean;
  /** Enable row-packing for homogeneous object arrays. Default true when format='compact'. */
  rowPack?: boolean;
  /** Minimum byte savings ratio for auto mode to choose compact (0.15 = 15%). */
  autoThreshold?: number;
  /** Min array length to row-pack. Below this we keep dense JSON for readability. */
  minRowPackSize?: number;
}

const DEFAULTS: Required<WireFormatOptions> = {
  internPaths: false,
  rowPack: true,
  autoThreshold: 0.15,
  minRowPackSize: 3,
};

/**
 * Encode a value to JSON, applying compact transforms based on `format` and `opts`.
 * Returns the final wire string and the format actually used (auto may pick json).
 */
export function encodeWire(
  value: unknown,
  format: WireFormat = 'json',
  opts: WireFormatOptions = {},
): { text: string; format: 'json' | 'compact' } {
  if (format === 'json') {
    return { text: stringifyCompactJson(value), format: 'json' };
  }

  const merged = { ...DEFAULTS, ...opts };
  const compactText = encodeCompact(value, merged);

  if (format === 'compact') {
    return { text: compactText, format: 'compact' };
  }

  // auto: compare byte length, pick winner if compact saves ≥ threshold
  const jsonText = stringifyCompactJson(value);
  const savings = (jsonText.length - compactText.length) / jsonText.length;
  return savings >= merged.autoThreshold
    ? { text: compactText, format: 'compact' }
    : { text: jsonText, format: 'json' };
}

/** Compact JSON — no whitespace, strip null/undefined. Same shape as the legacy `j()`. */
export function stringifyCompactJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v === null || v === undefined ? undefined : v));
}

function encodeCompact(value: unknown, opts: Required<WireFormatOptions>): string {
  let dict: string[] = [];
  let interner: Map<string, number> | null = null;

  if (opts.internPaths) {
    const built = buildPathDictionary(value);
    if (built.dict.size > 0) {
      interner = built.dict;
      dict = built.reverse;
    }
  }

  const transformed = transform(value, interner, opts);
  const wrapper: Record<string, unknown> = { __wire: 'compact-v1', body: transformed };
  if (dict.length > 0) wrapper.__dict = dict;
  return stringifyCompactJson(wrapper);
}

function buildPathDictionary(root: unknown): { dict: Map<string, number>; reverse: string[] } {
  const counts = new Map<string, number>();
  walk(root, (v) => {
    if (typeof v === 'string' && v.length > 8 && (v.includes('/') || v.includes('\\'))) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  });
  const dict = new Map<string, number>();
  const reverse: string[] = [];
  let id = 0;
  for (const [s, c] of counts) {
    if (c >= 2) {
      dict.set(s, id);
      reverse.push(s);
      id += 1;
    }
  }
  return { dict, reverse };
}

function walk(node: unknown, visit: (val: unknown) => void): void {
  visit(node);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else if (node !== null && typeof node === 'object') {
    for (const v of Object.values(node)) walk(v, visit);
  }
}

function transform(
  node: unknown,
  interner: Map<string, number> | null,
  opts: Required<WireFormatOptions>,
): unknown {
  if (typeof node === 'string') {
    if (interner) {
      const id = interner.get(node);
      if (id !== undefined) return `@${id}`;
    }
    return node;
  }
  if (Array.isArray(node)) {
    if (opts.rowPack && node.length >= opts.minRowPackSize && isHomogeneousObjectArray(node)) {
      return packRows(node, interner, opts);
    }
    return node.map((item) => transform(item, interner, opts));
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const tv = transform(v, interner, opts);
      if (tv !== undefined) out[k] = tv;
    }
    return out;
  }
  return node;
}

function packRows(
  arr: unknown[],
  interner: Map<string, number> | null,
  opts: Required<WireFormatOptions>,
): { __rows: string[]; data: unknown[][] } {
  const keys = Object.keys(arr[0] as Record<string, unknown>).sort();
  const rows: unknown[][] = arr.map((item) =>
    keys.map((k) => transform((item as Record<string, unknown>)[k], interner, opts)),
  );
  return { __rows: keys, data: rows };
}

function isHomogeneousObjectArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  const first = arr[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return false;
  const keysSig = Object.keys(first).sort().join(',');
  for (let i = 1; i < arr.length; i += 1) {
    const item = arr[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    if (
      Object.keys(item as Record<string, unknown>)
        .sort()
        .join(',') !== keysSig
    )
      return false;
  }
  return true;
}

// ─── Decoder (round-trip for tests) ─────────────────────────────────

/**
 * Decode a compact-wire response back to its original JSON shape. Used by tests
 * to verify lossless round-trip; not normally called at runtime (the LLM reads
 * the compact form directly per its embedded `__wire` marker).
 */
export function decodeWire(text: string): unknown {
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  if ((parsed as { __wire?: string }).__wire !== 'compact-v1') return parsed;
  const dict = ((parsed as { __dict?: string[] }).__dict ?? []) as string[];
  return restore((parsed as { body: unknown }).body, dict);
}

function restore(node: unknown, dict: string[]): unknown {
  if (typeof node === 'string') {
    if (node.startsWith('@')) {
      const id = Number.parseInt(node.slice(1), 10);
      if (!Number.isNaN(id) && id >= 0 && id < dict.length) return dict[id];
    }
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => restore(item, dict));
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.__rows) && Array.isArray(obj.data)) {
      const keys = obj.__rows as string[];
      const rows = obj.data as unknown[][];
      return rows.map((row) => {
        const item: Record<string, unknown> = {};
        for (let i = 0; i < keys.length; i += 1) {
          item[keys[i] as string] = restore(row[i], dict);
        }
        return item;
      });
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = restore(v, dict);
    }
    return out;
  }
  return node;
}
