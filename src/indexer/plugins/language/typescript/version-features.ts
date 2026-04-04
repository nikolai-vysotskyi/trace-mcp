/**
 * Node.js / ECMAScript version feature mapping.
 * Maps AST constructs and API patterns to the minimum Node.js version that introduced them.
 *
 * Covers Node.js 12 through 24.
 */

/** Minimum Node.js version required for specific AST constructs. */
export const NODEJS_MIN_VERSION: Record<string, string> = {
  // --- Node.js 12 (V8 7.4) — ES2019 baseline ---
  // flat, flatMap, Object.fromEntries, optional catch binding — baseline, no AST signal

  // --- Node.js 14 (V8 8.4) — ES2020 ---
  'optional_chaining': '14',           // a?.b
  'nullish_coalescing': '14',          // a ?? b

  // --- Node.js 15 (V8 8.6) ---
  'logical_assignment': '15',          // a ??= b, a ||= b, a &&= b

  // --- Node.js 16 (V8 9.4) — ES2022 ---
  'class_static_block': '16',          // static { ... }
  'private_property_identifier': '16', // #privateField
  'hash_bang_line': '16',              // #!/usr/bin/env node (top-level)

  // --- Node.js 17 (V8 9.5) ---
  // structuredClone — API, not AST. Array.findLast is V8 9.7 (node 17.4+)

  // --- Node.js 18 (V8 10.1) ---
  // Array.findLast/findLastIndex stable, fetch API — no specific AST construct
  'array_pattern_with_rest': '18',     // destructuring rest in more positions

  // --- Node.js 20 (V8 11.3) — ES2023 ---
  // Array grouping, no new syntax node

  // --- Node.js 21 (V8 11.8) — ES2024 ---
  // ArrayBuffer.transfer, Atomics.waitAsync — API only

  // --- Node.js 22 (V8 12.4) — ES2024+ ---
  'using_declaration': '22',           // using x = resource (explicit resource management)
  'await_using_declaration': '22',     // await using x = resource

  // --- Decorators (stage 3, Node.js 24 / V8 13+) ---
  'decorator': '24',                   // @decorator (TC39 stage 3)
};

/**
 * Known API identifiers that signal a minimum Node.js version.
 * These are checked via simple string matching in source code.
 */
export const NODEJS_API_VERSIONS: Record<string, string> = {
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

/**
 * Determine the minimum Node.js version required for a symbol based on its AST features.
 * Returns undefined if the symbol uses only Node 12-compatible features.
 */
export function detectMinNodeVersion(nodeTypes: string[]): string | undefined {
  let maxVersion: number | undefined;
  let maxVersionStr: string | undefined;
  for (const nt of nodeTypes) {
    const ver = NODEJS_MIN_VERSION[nt];
    if (ver) {
      const num = Number(ver);
      if (!maxVersion || num > maxVersion) {
        maxVersion = num;
        maxVersionStr = ver;
      }
    }
  }
  return maxVersionStr;
}

/**
 * Detect minimum Node.js version from API usage in source text.
 * Lightweight check — scans for known global/module identifiers.
 */
export function detectMinNodeVersionFromAPIs(sourceCode: string): string | undefined {
  let maxVersion: number | undefined;
  let maxVersionStr: string | undefined;
  for (const [api, ver] of Object.entries(NODEJS_API_VERSIONS)) {
    if (sourceCode.includes(api)) {
      const num = Number(ver);
      if (!maxVersion || num > maxVersion) {
        maxVersion = num;
        maxVersionStr = ver;
      }
    }
  }
  return maxVersionStr;
}
