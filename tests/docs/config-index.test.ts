import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertRepresentative,
  buildRows,
  renderIndex,
  withoutStamp,
} from '../../scripts/config-index.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const INDEX = join(ROOT, 'docs/config-index.md');
const page = () => readFileSync(INDEX, 'utf8');

/**
 * TRA-801: docs/configuration.md called itself the reference for "every key" and
 * described 190 of the 263 the schema accepts — whole subsystems (`predictive`,
 * `runtime`, `indexer`, `pipeline`, `vault`, `logging`, `git`) and six daemon
 * knobs appeared nowhere in the repository. docs/config-index.md is generated
 * from the schema so that gap cannot reopen.
 */
describe('docs/config-index.md', () => {
  it('is regenerated from the schema', () => {
    // `pnpm docs:sitemap` stamps `updated:` from git, not from the generator.
    expect(withoutStamp(page())).toBe(withoutStamp(renderIndex()));
  });

  it('lists every key the schema accepts', () => {
    const missing = buildRows()
      .map((r) => r.key)
      .filter((key) => !page().includes(`| \`${key}\` |`));
    expect(missing, `config keys absent from the index: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * The three assertions above all read the key set from the generator, so they
   * pass vacuously on an empty table — which is exactly what a zod release that
   * changed the JSON Schema projection would produce. These anchors are written
   * by hand and cover one key per shape the renderer has to handle.
   */
  it('keeps the anchors a hand-written reader would look up', () => {
    const expected: Array<[string, string, string]> = [
      ['include', 'string[]', '_built-in list_'],
      ['follow_symlinks', 'boolean', '`false`'],
      ['ai.provider', '`onnx`', '`"onnx"`'],
      ['frameworks', 'object', '—'],
      ['ai.base_url', 'string', '_unset_'],
      ['frameworks.laravel.artisan.timeout', 'number (> 0)', '`10000`'],
      ['index_cache_mb', 'number (≥ 1, ≤ 1024)', '`16`'],
      ['hermes.enabled', '`auto` \\| boolean', '`"auto"`'],
      ['tools.preset', 'string', '`"minimal"`'],
      ['predictive.module_depth', 'number', '`2`'],
      ['tools.meta_fields', 'boolean \\| (`_hints`', '`true`'],
    ];
    const rows = new Map(buildRows().map((r) => [r.key, r]));
    for (const [key, type, def] of expected) {
      const row = rows.get(key);
      expect(row, `${key} is missing from the index`).toBeDefined();
      // `ai.provider` has thirteen members; pin the first so the row is real
      // without repinning the list on every provider we add.
      expect(row?.type.startsWith(type), `${key}: type is ${row?.type}, expected ${type}`).toBe(
        true,
      );
      expect(row?.default, `${key}: default`).toBe(def);
    }
  });

  it('gives every key a type the page can render', () => {
    // Anything outside this grammar means the renderer met a schema shape it
    // does not understand and printed the raw JSON Schema keyword instead —
    // `literal` for a `z.literal()` union, say, which is how `hermes.enabled`
    // shipped before review caught it.
    const atom = /^(?:string|boolean|object|any|number(?: \([^)]+\))?|`[^`]+`)$/;
    /** Splits a union on ` \| ` at paren depth 0, so `(a \| b)[]` stays one member. */
    const members = (type: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < type.length; i++) {
        if (type[i] === '(') depth++;
        else if (type[i] === ')') depth--;
        else if (depth === 0 && type.startsWith(' \\| ', i)) {
          out.push(type.slice(start, i));
          i += 3;
          start = i + 1;
        }
      }
      out.push(type.slice(start));
      return out;
    };
    const renderable = (type: string): boolean =>
      members(type).every((part) => {
        const item = part.replace(/\[\]$/, '');
        const inner = /^\((.*)\)$/.exec(item);
        return inner ? renderable(inner[1]) : atom.test(item);
      });
    const bad = buildRows().filter((r) => !renderable(r.type));
    expect(
      bad.map((r) => `${r.key}: ${r.type}`),
      'unrenderable types',
    ).toEqual([]);
  });

  it('refuses to publish a page that lost the schema', () => {
    expect(() =>
      assertRepresentative([{ key: 'db.path', type: 'string', default: '`x`' }]),
    ).toThrow(/do not publish/);
    expect(() => assertRepresentative(buildRows())).not.toThrow();
  });
});
