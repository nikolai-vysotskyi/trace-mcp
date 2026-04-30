#!/usr/bin/env tsx
/**
 * MUNCH-format prework: measure token savings on realistic tool responses.
 *
 * Question we're answering: would a path-interning + row-packing wire format save
 * tokens (not just bytes) once the LLM tokenizer (cl100k_base) chews through it?
 * If we can't beat dense JSON by ≥10% on tokens, the engineering cost of MUNCH
 * is not justified — better to spend that time on Markdown output for context
 * tools.
 *
 * Run: `npx tsx scripts/munch-experiment.ts`
 */

import { encode } from 'gpt-tokenizer';

interface CompactFixture {
  name: string;
  json: unknown;
}

// ─── Fixture builders — shape-realistic responses our retrieval tools actually emit ───

function buildSearchFixture(items: number): unknown {
  return {
    items: Array.from({ length: items }, (_, i) => ({
      symbol_id: `src/services/auth/AuthService.ts::AuthService.method${i}`,
      name: `method${i}`,
      kind: 'method',
      fqn: `AuthService.method${i}`,
      signature: `method${i}(user: User, opts?: AuthOptions): Promise<Result<Token, AuthError>>`,
      summary: null,
      file: `src/services/auth/AuthService.ts`,
      line: 100 + i * 12,
      score: Number((10 - i * 0.3).toFixed(3)),
      _freshness: 'fresh',
    })),
    total: items,
    search_mode: 'fts',
    _meta: {
      freshness: { fresh: items, edited_uncommitted: 0, stale_index: 0, repo_is_stale: false },
      confidence: 0.78,
      confidence_signals: { top1_strength: 1, top_gap: 0.3, identity_match: 0.7, freshness: 1 },
    },
  };
}

function buildOutlineFixture(): unknown {
  return {
    path: 'src/services/auth/AuthService.ts',
    language: 'typescript',
    symbols: Array.from({ length: 20 }, (_, i) => ({
      symbolId: `src/services/auth/AuthService.ts::Symbol${i}`,
      name: `Symbol${i}`,
      kind: i % 3 === 0 ? 'class' : i % 3 === 1 ? 'method' : 'function',
      fqn: `services.auth.Symbol${i}`,
      signature: `Symbol${i}(input: SomeInput): SomeOutput`,
      lineStart: 10 + i * 15,
      lineEnd: 22 + i * 15,
    })),
    _freshness: 'fresh',
    _meta: {
      freshness: { fresh: 20, edited_uncommitted: 0, stale_index: 0, repo_is_stale: false },
    },
  };
}

function buildFindUsagesFixture(): unknown {
  return {
    target: {
      symbol_id: 'src/services/auth/AuthService.ts::AuthService.login',
      fqn: 'AuthService.login',
      file: 'src/services/auth/AuthService.ts',
    },
    references: Array.from({ length: 30 }, (_, i) => ({
      edge_type: i % 2 === 0 ? 'calls' : 'imports',
      symbol: {
        symbol_id: `src/controllers/PaymentController.ts::handle${i}`,
        name: `handle${i}`,
        kind: 'method',
        fqn: `PaymentController.handle${i}`,
        signature: null,
        line_start: 50 + i * 7,
      },
      file:
        i % 2 === 0 ? `src/controllers/PaymentController.ts` : `src/services/auth/AuthService.ts`,
      _freshness: 'fresh',
    })),
    total: 30,
    _meta: {
      freshness: { fresh: 30, edited_uncommitted: 0, stale_index: 0, repo_is_stale: false },
    },
  };
}

function buildCallGraphFixture(): unknown {
  return {
    root: {
      symbol_id: 'src/services/payment/PaymentService.ts::PaymentService.charge',
      name: 'charge',
      kind: 'method',
      file: 'src/services/payment/PaymentService.ts',
      calls: Array.from({ length: 12 }, (_, i) => ({
        symbol_id: `src/services/payment/PaymentService.ts::Helper${i}`,
        name: `helper${i}`,
        file: `src/services/payment/PaymentService.ts`,
        line: 200 + i * 5,
      })),
      called_by: Array.from({ length: 8 }, (_, i) => ({
        symbol_id: `src/controllers/PaymentController.ts::Handler${i}`,
        name: `handler${i}`,
        file: `src/controllers/PaymentController.ts`,
        line: 30 + i * 10,
      })),
    },
  };
}

// ─── Compact wire format prototype ───

/**
 * Build a path-interning dictionary by walking the JSON tree and collecting
 * every long string that looks like a file path (contains `/` or `\`).
 */
function buildPathDictionary(json: unknown): { dict: Map<string, number>; reverse: string[] } {
  const counts = new Map<string, number>();
  walk(json, (val) => {
    if (typeof val === 'string' && val.includes('/') && val.length > 8) {
      counts.set(val, (counts.get(val) ?? 0) + 1);
    }
  });
  // Only intern strings that appear ≥2 times (single occurrence = no win).
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

/**
 * Replace path strings in the JSON with `[id]` references. Row-pack homogeneous
 * arrays of objects: `[[k1,k2,...], [v1,v2,...], [v1,v2,...], ...]`.
 */
function compactify(node: unknown, dict: Map<string, number>): unknown {
  if (typeof node === 'string') {
    const id = dict.get(node);
    return id !== undefined ? `@${id}` : node;
  }
  if (Array.isArray(node)) {
    if (node.length >= 3 && isHomogeneousObjectArray(node)) {
      const keys = Object.keys(node[0] as Record<string, unknown>).sort();
      const rows: unknown[][] = node.map((item) =>
        keys.map((k) => compactify((item as Record<string, unknown>)[k], dict)),
      );
      return { __rows: keys, data: rows };
    }
    return node.map((item) => compactify(item, dict));
  }
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = compactify(v, dict);
    }
    return out;
  }
  return node;
}

function isHomogeneousObjectArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  const first = arr[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return false;
  const keys = Object.keys(first).sort().join(',');
  for (let i = 1; i < arr.length; i += 1) {
    const item = arr[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    if (
      Object.keys(item as Record<string, unknown>)
        .sort()
        .join(',') !== keys
    )
      return false;
  }
  return true;
}

function encodeMunch(json: unknown): string {
  const { dict, reverse } = buildPathDictionary(json);
  const compact = compactify(json, dict);
  return JSON.stringify({ __dict: reverse, body: compact });
}

/**
 * Path-interning ONLY (no row-packing). Shape stays JSON-like so the LLM doesn't
 * need to decode positional rows.
 */
function encodePathOnly(json: unknown): string {
  const { dict, reverse } = buildPathDictionary(json);
  const transformed = transformPaths(json, dict);
  return JSON.stringify({ __dict: reverse, body: transformed });
}

function transformPaths(node: unknown, dict: Map<string, number>): unknown {
  if (typeof node === 'string') {
    const id = dict.get(node);
    return id !== undefined ? `@${id}` : node;
  }
  if (Array.isArray(node)) return node.map((item) => transformPaths(item, dict));
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = transformPaths(v, dict);
    }
    return out;
  }
  return node;
}

// ─── Measurement ───

const fixtures: CompactFixture[] = [
  { name: 'search (10 results)', json: buildSearchFixture(10) },
  { name: 'search (50 results)', json: buildSearchFixture(50) },
  { name: 'get_outline (20 symbols)', json: buildOutlineFixture() },
  { name: 'find_usages (30 references)', json: buildFindUsagesFixture() },
  { name: 'get_call_graph', json: buildCallGraphFixture() },
];

const compactJson = (v: unknown) =>
  JSON.stringify(v, (_k, val) => (val === null || val === undefined ? undefined : val));

function pad(s: string, n: number): string {
  return s.length >= n ? s : `${s}${' '.repeat(n - s.length)}`;
}
function rpad(s: string, n: number): string {
  return s.length >= n ? s : `${' '.repeat(n - s.length)}${s}`;
}

const header = `${pad('fixture', 30)} | ${rpad('json T', 7)} | ${rpad('path T', 7)} | ${rpad('full T', 7)} | ${rpad('path%', 6)} | ${rpad('full%', 6)}`;
console.log(header);
console.log('-'.repeat(header.length));

let totJson = 0;
let totPath = 0;
let totFull = 0;

for (const fix of fixtures) {
  const jsonStr = compactJson(fix.json);
  const pathStr = encodePathOnly(fix.json);
  const fullStr = encodeMunch(fix.json);
  const j = encode(jsonStr).length;
  const p = encode(pathStr).length;
  const f = encode(fullStr).length;
  totJson += j;
  totPath += p;
  totFull += f;
  const ps = ((j - p) / j) * 100;
  const fs = ((j - f) / j) * 100;
  console.log(
    `${pad(fix.name, 30)} | ${rpad(String(j), 7)} | ${rpad(String(p), 7)} | ${rpad(String(f), 7)} | ${rpad(`${ps.toFixed(1)}%`, 6)} | ${rpad(`${fs.toFixed(1)}%`, 6)}`,
  );
}

console.log('-'.repeat(header.length));
const pSave = ((totJson - totPath) / totJson) * 100;
const fSave = ((totJson - totFull) / totJson) * 100;
console.log(
  `${pad('TOTAL', 30)} | ${rpad(String(totJson), 7)} | ${rpad(String(totPath), 7)} | ${rpad(String(totFull), 7)} | ${rpad(`${pSave.toFixed(1)}%`, 6)} | ${rpad(`${fSave.toFixed(1)}%`, 6)}`,
);
console.log(
  `\npath-interning only:        ${pSave.toFixed(1)}% token savings (LLM-friendly: shape preserved)`,
);
console.log(
  `path-interning + row-packing: ${fSave.toFixed(1)}% token savings (cognitive load: positional decode)`,
);

console.log(
  fSave >= 10
    ? '\n✅ Phase 3 GREEN — full MUNCH ≥ 10% token savings.'
    : '\n⚠️  Phase 3 below threshold for full MUNCH.',
);
console.log(
  pSave >= 10
    ? '✅ Path-interning alone ≥ 10% — safe to ship without row-packing risk.'
    : `⚠️  Path-interning alone only ${pSave.toFixed(1)}% — row-packing is doing the heavy lifting.`,
);
