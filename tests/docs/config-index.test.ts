import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRows, renderIndex } from '../../scripts/config-index.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const INDEX = join(ROOT, 'docs/config-index.md');

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
    const withoutStamp = (s: string) => s.replace(/^updated:.*\n/m, '');
    expect(withoutStamp(readFileSync(INDEX, 'utf8'))).toBe(withoutStamp(renderIndex()));
  });

  it('lists every key the schema accepts', () => {
    const page = readFileSync(INDEX, 'utf8');
    const missing = buildRows()
      .map((r) => r.key)
      .filter((key) => !page.includes(`| \`${key}\` |`));
    expect(missing, `config keys absent from the index: ${missing.join(', ')}`).toEqual([]);
  });

  it('gives every key a type', () => {
    const blank = [...readFileSync(INDEX, 'utf8').matchAll(/^\| `([\w.]+)` \|(.*?)\|/gm)]
      .filter(([, , type]) => type.trim().length === 0 || type.includes('unknown'))
      .map(([, key]) => key);
    expect(blank, `config keys whose type did not resolve: ${blank.join(', ')}`).toEqual([]);
  });
});
