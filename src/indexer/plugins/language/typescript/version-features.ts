/**
 * Version feature mapping for Node.js, TypeScript compiler, and ECMAScript standard.
 *
 * Three orthogonal version axes:
 * - Node.js runtime (12–24)     → minNodeVersion
 * - TypeScript compiler (4.0–5.8) → minTsVersion
 * - ECMAScript standard (ES2015–ES2025) → minEsVersion
 */

// ═══════════════════════════════════════════════════════
// Node.js runtime — AST constructs → minimum Node version
// ═══════════════════════════════════════════════════════

const NODEJS_MIN_VERSION: Record<string, string> = {
  // Node 14 (V8 8.4) — ES2020
  'optional_chaining': '14',
  'nullish_coalescing': '14',

  // Node 15 (V8 8.6)
  'logical_assignment': '15',

  // Node 16 (V8 9.4) — ES2022
  'class_static_block': '16',
  'private_property_identifier': '16',
  'hash_bang_line': '16',

  // Node 18 (V8 10.1)
  'array_pattern_with_rest': '18',

  // Node 22 (V8 12.4) — ES2024+
  'using_declaration': '22',
  'await_using_declaration': '22',

  // Node 24 (V8 13+)
  'decorator': '24',
};

/** API identifiers → minimum Node.js version (string-match in source). */
const NODEJS_API_VERSIONS: Record<string, string> = {
  'structuredClone': '17',
  'fetch': '18',
  'AbortSignal.timeout': '18',
  'AbortSignal.any': '20',
  'Array.fromAsync': '22',
  'navigator': '21',
  'WebSocket': '22',
  'import.meta.resolve': '20',
  'node:test': '18',
  'node:sqlite': '22',
};

// ═══════════════════════════════════════════════════════
// TypeScript compiler — AST constructs → minimum TS version
// ═══════════════════════════════════════════════════════

const TS_MIN_VERSION: Record<string, string> = {
  // TS 4.0 — variadic tuple types, labeled tuple elements
  'labeled_tuple_member': '4.0',

  // TS 4.1 — template literal types, key remapping in mapped types
  'template_literal_type': '4.1',

  // TS 4.2 — abstract constructor types, smarter type alias preservation
  'abstract_construct_type': '4.2',

  // TS 4.3 — override keyword
  'override_modifier': '4.3',

  // TS 4.5 — type-only import/export specifiers (import { type X })
  'type_import_specifier': '4.5',
  'type_export_specifier': '4.5',

  // TS 4.7 — instantiation expressions, extends constraints on infer
  'instantiation_expression': '4.7',

  // TS 4.9 — satisfies operator
  'satisfies_expression': '4.9',

  // TS 5.0 — const type parameters, decorator metadata (stage 3)
  'const_type_parameter': '5.0',
  'decorator': '5.0',

  // TS 5.2 — using / await using (explicit resource management)
  'using_declaration': '5.2',
  'await_using_declaration': '5.2',
};

/** TS source-level patterns (regex-matched). */
const TS_SOURCE_PATTERNS: [RegExp, string][] = [
  // TS 4.9 — satisfies
  [/\bsatisfies\s+[A-Z]/, '4.9'],
  // TS 5.0 — const type parameter: <const T>
  [/<const\s+[A-Z]/, '5.0'],
  // TS 5.2 — using declarations
  [/\busing\s+[a-zA-Z]/, '5.2'],
  // TS 5.3 — import attributes: import ... with { type: "json" }
  [/\bwith\s*\{/, '5.3'],
];

// ═══════════════════════════════════════════════════════
// ECMAScript standard — AST constructs → minimum ES version
// ═══════════════════════════════════════════════════════

const ES_MIN_VERSION: Record<string, string> = {
  // ES2015 (ES6)
  'arrow_function': 'ES2015',
  'class_declaration': 'ES2015',
  'template_string': 'ES2015',
  'for_in_statement': 'ES2015',
  'spread_element': 'ES2015',
  'computed_property_name': 'ES2015',
  'shorthand_property_identifier_pattern': 'ES2015',
  'generator_function_declaration': 'ES2015',
  'yield_expression': 'ES2015',

  // ES2016
  'binary_expression:exponentiation': 'ES2016', // handled via special check

  // ES2017
  'await_expression': 'ES2017',

  // ES2018
  'for_await_statement': 'ES2018',         // for await...of
  'regex_flags:s': 'ES2018',               // dotAll flag

  // ES2019
  'optional_catch_binding': 'ES2019',      // catch {}  (no param)

  // ES2020
  'optional_chaining': 'ES2020',
  'nullish_coalescing': 'ES2020',
  'import_expression': 'ES2020',           // dynamic import()
  'bigint': 'ES2020',

  // ES2021
  'logical_assignment': 'ES2021',          // ??=, ||=, &&=

  // ES2022
  'class_static_block': 'ES2022',
  'private_property_identifier': 'ES2022',
  'hash_bang_line': 'ES2022',

  // ES2024
  'using_declaration': 'ES2024',
  'await_using_declaration': 'ES2024',

  // ES2025
  'decorator': 'ES2025',
};

/** Map ES year labels to sortable integers for comparison. */
const ES_YEAR_NUM: Record<string, number> = {
  'ES2015': 2015, 'ES2016': 2016, 'ES2017': 2017, 'ES2018': 2018,
  'ES2019': 2019, 'ES2020': 2020, 'ES2021': 2021, 'ES2022': 2022,
  'ES2023': 2023, 'ES2024': 2024, 'ES2025': 2025,
};

// ═══════════════════════════════════════════════════════
// Detection functions
// ═══════════════════════════════════════════════════════

/** Detect minimum Node.js version from AST node types. */
export function detectMinNodeVersion(nodeTypes: string[]): string | undefined {
  let max = 0;
  let result: string | undefined;
  for (const nt of nodeTypes) {
    const ver = NODEJS_MIN_VERSION[nt];
    if (ver) {
      const num = Number(ver);
      if (num > max) { max = num; result = ver; }
    }
  }
  return result;
}

/** Detect minimum Node.js version from API usage in source text. */
export function detectMinNodeVersionFromAPIs(sourceCode: string): string | undefined {
  let max = 0;
  let result: string | undefined;
  for (const [api, ver] of Object.entries(NODEJS_API_VERSIONS)) {
    if (sourceCode.includes(api)) {
      const num = Number(ver);
      if (num > max) { max = num; result = ver; }
    }
  }
  return result;
}

/** Detect minimum TypeScript compiler version from AST node types. */
export function detectMinTsVersion(nodeTypes: string[]): string | undefined {
  let max = 0;
  let result: string | undefined;
  for (const nt of nodeTypes) {
    const ver = TS_MIN_VERSION[nt];
    if (ver) {
      const num = parseFloat(ver);
      if (num > max) { max = num; result = ver; }
    }
  }
  return result;
}

/** Detect minimum TypeScript version from source-level patterns. */
export function detectMinTsVersionFromSource(sourceCode: string): string | undefined {
  let max = 0;
  let result: string | undefined;
  for (const [re, ver] of TS_SOURCE_PATTERNS) {
    if (re.test(sourceCode)) {
      const num = parseFloat(ver);
      if (num > max) { max = num; result = ver; }
    }
  }
  return result;
}

/** Detect minimum ECMAScript version from AST node types. */
export function detectMinEsVersion(nodeTypes: string[]): string | undefined {
  let max = 0;
  let result: string | undefined;
  for (const nt of nodeTypes) {
    const ver = ES_MIN_VERSION[nt];
    if (ver) {
      const num = ES_YEAR_NUM[ver] ?? 0;
      if (num > max) { max = num; result = ver; }
    }
  }
  return result;
}
