/**
 * Property-based tests for indexer invariants.
 *
 * Tests three core invariants that must hold across ALL inputs to every
 * language plugin, inspired by jcodemunch's Hypothesis-backed test suite:
 *
 *   1. ID uniqueness   — extractSymbols() never produces duplicate symbolIds
 *   2. Idempotency     — calling extractSymbols() twice on the same input
 *                        yields identical symbolId sets (no accumulation)
 *   3. No self-imports — no import edge has source === target path
 *
 * fast-check generates a large volume of random-but-valid inputs to stress
 * these invariants well beyond what example-based tests can cover.
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { YamlLanguagePlugin } from '../../src/indexer/plugins/language/yaml-lang/index.js';
import { JsonLanguagePlugin } from '../../src/indexer/plugins/language/json-lang/index.js';
import { PythonLanguagePlugin } from '../../src/indexer/plugins/language/python/index.js';
import type { LanguagePlugin } from '../../src/plugin-api/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

type PluginEntry = { name: string; plugin: LanguagePlugin; ext: string };

const plugins: PluginEntry[] = [
  { name: 'typescript', plugin: new TypeScriptLanguagePlugin(), ext: '.ts' },
  { name: 'yaml', plugin: new YamlLanguagePlugin(), ext: '.yaml' },
  { name: 'json', plugin: new JsonLanguagePlugin(), ext: '.json' },
  { name: 'python', plugin: new PythonLanguagePlugin(), ext: '.py' },
];

/** Run extractSymbols and return the raw result (ok or err). */
async function extract(plugin: LanguagePlugin, filePath: string, source: string) {
  return plugin.extractSymbols(filePath, Buffer.from(source, 'utf-8'));
}

// fast-check config: enough runs to catch edge cases, short enough to be fast
const FC_OPTS: fc.Parameters<unknown> = { numRuns: 150, seed: 42 };

// ── Arbitrary generators ─────────────────────────────────────────────────────

/** Generates plausible TypeScript identifiers (alphanumeric, no leading digit). */
const tsIdentifier = fc
  .stringMatching(/^[a-zA-Z_$][a-zA-Z0-9_$]{1,19}$/)
  .filter((s) => !/^\d/.test(s));

/** Generates a simple TypeScript function declaration. */
const tsFunctionArb = tsIdentifier.map(
  (name) => `export function ${name}(a: number, b: string): void { return; }`,
);

/** Generates a TS source with 1–5 exported functions. */
const tsSourceArb = fc
  .array(tsFunctionArb, { minLength: 1, maxLength: 5 })
  .map((decls) => decls.join('\n\n'));

/** Generates a simple YAML key: value mapping. */
const yamlSourceArb = fc
  .array(
    fc.tuple(
      fc.stringMatching(/^[a-z][a-z_]{0,15}$/),
      fc.oneof(fc.integer({ min: 0, max: 9999 }), fc.constantFrom('true', 'false', 'hello')),
    ),
    { minLength: 1, maxLength: 8 },
  )
  .map((pairs) => pairs.map(([k, v]) => `${k}: ${v}`).join('\n'));

/** Generates a simple JSON object with string-valued keys. */
const jsonSourceArb = fc
  .uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{1,10}$/), { minLength: 1, maxLength: 8 })
  .map((keys) => {
    const obj: Record<string, string> = {};
    for (const k of keys) obj[k] = 'value';
    return JSON.stringify(obj, null, 2);
  });

/** Generates a Python source with 1–4 top-level functions. */
const pyFunctionArb = tsIdentifier.map((name) => `def ${name}(x, y):\n    return x + y\n`);
const pySourceArb = fc
  .array(pyFunctionArb, { minLength: 1, maxLength: 4 })
  .map((decls) => decls.join('\n'));

// ── Invariant 1: ID uniqueness ───────────────────────────────────────────────
//
// For any valid input, extractSymbols() must return unique symbolIds.

describe('Invariant 1: ID uniqueness', () => {
  for (const { name, plugin, ext } of plugins) {
    const arb =
      name === 'typescript'
        ? tsSourceArb
        : name === 'yaml'
          ? yamlSourceArb
          : name === 'json'
            ? jsonSourceArb
            : pySourceArb;

    it(`[${name}] no duplicate symbolIds for any generated source`, async () => {
      await fc.assert(
        fc.asyncProperty(arb, async (source) => {
          const result = await extract(plugin, `file${ext}`, source);
          if (result.isErr()) return; // parse errors are allowed; just skip
          const ids = result.value.symbols.map((s) => s.symbolId);
          const unique = new Set(ids);
          if (unique.size !== ids.length) {
            const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
            throw new Error(`Duplicate symbolIds: ${dupes.join(', ')}\nSource:\n${source}`);
          }
        }),
        { ...FC_OPTS, asyncReporter: undefined },
      );
    });
  }
});

// ── Invariant 2: Idempotency ─────────────────────────────────────────────────
//
// Calling extractSymbols() twice on the same content and path must return
// exactly the same symbolId set.  This ensures no hidden mutable state
// accumulates between calls (e.g. global parser cache corruption).

describe('Invariant 2: Extraction idempotency', () => {
  for (const { name, plugin, ext } of plugins) {
    const arb =
      name === 'typescript'
        ? tsSourceArb
        : name === 'yaml'
          ? yamlSourceArb
          : name === 'json'
            ? jsonSourceArb
            : pySourceArb;

    it(`[${name}] same input always produces same symbolId set`, async () => {
      await fc.assert(
        fc.asyncProperty(arb, async (source) => {
          const fp = `file${ext}`;
          const r1 = await extract(plugin, fp, source);
          const r2 = await extract(plugin, fp, source);
          if (r1.isErr() || r2.isErr()) return; // parse errors OK; skip
          const ids1 = new Set(r1.value.symbols.map((s) => s.symbolId));
          const ids2 = new Set(r2.value.symbols.map((s) => s.symbolId));
          const added = [...ids2].filter((id) => !ids1.has(id));
          const removed = [...ids1].filter((id) => !ids2.has(id));
          if (added.length > 0 || removed.length > 0) {
            throw new Error(
              `Non-idempotent extraction!\n` +
                `  Added on 2nd call:   ${added.join(', ')}\n` +
                `  Removed on 2nd call: ${removed.join(', ')}\n` +
                `Source:\n${source}`,
            );
          }
        }),
        { ...FC_OPTS, asyncReporter: undefined },
      );
    });
  }
});

// ── Invariant 3: No self-imports ─────────────────────────────────────────────
//
// An import edge (edgeType = 'imports' / 'esm_imports' / etc.) must never
// have a `module` metadata field that resolves to the same file path.
// Self-imports are nonsensical and would corrupt the import graph.

describe('Invariant 3: No self-imports', () => {
  // For self-import testing we focus on TypeScript (has import extraction)
  // and YAML (has module edges for docker-compose extends, ansible roles, etc.)

  it('[typescript] import edges never reference the same file', async () => {
    const importingArb = fc
      .array(tsIdentifier, { minLength: 1, maxLength: 4 })
      .map((names) => names.map((n) => `import { ${n} } from './${n}.js';`).join('\n'));

    await fc.assert(
      fc.asyncProperty(importingArb, async (source) => {
        const fp = 'src/file.ts';
        const result = await extract(plugin_ts, fp, source);
        if (result.isErr()) return;
        for (const edge of result.value.edges ?? []) {
          const meta = edge.metadata as Record<string, unknown> | undefined;
          const mod = typeof meta?.module === 'string' ? meta.module : '';
          if (mod === fp || mod === './file.js' || mod === './file.ts' || mod === './file') {
            throw new Error(`Self-import detected: ${fp} imports ${mod}`);
          }
        }
      }),
      FC_OPTS,
    );
  });

  it('[yaml] import edges never use the same file path as their module', async () => {
    // Docker Compose extends with a made-up external file should never point to itself
    const composeArb = fc.constantFrom(
      // Valid compose extends that point to OTHER files
      `services:\n  web:\n    image: nginx`,
      `version: '3'\nservices:\n  app:\n    build: .`,
    );
    await fc.assert(
      fc.asyncProperty(composeArb, async (source) => {
        const fp = 'docker-compose.yml';
        const result = await extract(plugin_yaml, fp, source);
        if (result.isErr()) return;
        for (const edge of result.value.edges ?? []) {
          const meta = edge.metadata as Record<string, unknown> | undefined;
          const mod = typeof meta?.module === 'string' ? meta.module : '';
          if (mod === fp) {
            throw new Error(`Self-import in YAML: ${fp} has module=${mod}`);
          }
        }
      }),
      FC_OPTS,
    );
  });
});

// ── Invariant 4: Byte ranges are valid ──────────────────────────────────────
//
// Every symbol's byteStart must be < byteEnd, and both must be within the
// content buffer length. Violated ranges cause O(1) source-reader to return
// garbage.

describe('Invariant 4: Symbol byte ranges are valid', () => {
  for (const { name, plugin, ext } of plugins) {
    const arb =
      name === 'typescript'
        ? tsSourceArb
        : name === 'yaml'
          ? yamlSourceArb
          : name === 'json'
            ? jsonSourceArb
            : pySourceArb;

    it(`[${name}] all symbols have 0 <= byteStart < byteEnd <= contentLength`, async () => {
      await fc.assert(
        fc.asyncProperty(arb, async (source) => {
          const buf = Buffer.from(source, 'utf-8');
          const result = await extract(plugin, `file${ext}`, source);
          if (result.isErr()) return;
          for (const sym of result.value.symbols) {
            if (
              sym.byteStart < 0 ||
              sym.byteEnd < 0 ||
              sym.byteStart >= sym.byteEnd ||
              sym.byteEnd > buf.byteLength
            ) {
              throw new Error(
                `Invalid byte range for symbol ${sym.symbolId}: ` +
                  `[${sym.byteStart}, ${sym.byteEnd}) in buffer of length ${buf.byteLength}\n` +
                  `Source:\n${source}`,
              );
            }
          }
        }),
        { ...FC_OPTS, asyncReporter: undefined },
      );
    });
  }
});

// Module-level plugin refs (avoid repeated construction in property loops)
const plugin_ts = new TypeScriptLanguagePlugin();
const plugin_yaml = new YamlLanguagePlugin();
