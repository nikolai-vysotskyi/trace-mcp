import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderIndex } from '../../scripts/tools-index.js';
import { allToolNames } from './tool-surface.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const INDEX = join(ROOT, 'docs/tools-index.md');

/**
 * TRA-505: docs/tools-reference.md described itself as the full reference and
 * listed roughly a third of the surface — 101 of the tools a default install
 * registers had no entry anywhere in the docs. docs/tools-index.md is generated
 * from the registrations so that gap cannot reopen.
 */
describe('docs/tools-index.md', () => {
  it('is regenerated from the registrations', () => {
    // `pnpm docs:sitemap` stamps `updated:` into the front matter from git, not
    // from the generator, so drop it before comparing (see language-matrix).
    const withoutStamp = (s: string) => s.replace(/^updated:.*\n/m, '');
    expect(withoutStamp(readFileSync(INDEX, 'utf8'))).toBe(withoutStamp(renderIndex()));
  });

  it('lists every registered tool', () => {
    const page = readFileSync(INDEX, 'utf8');
    const missing = allToolNames().filter((name) => !page.includes(`\`${name}\` |`));
    expect(missing, `tools registered but absent from the index: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('gives every tool a non-empty one-liner', () => {
    const blank = [...readFileSync(INDEX, 'utf8').matchAll(/^\| `([a-z0-9_]+)` \|(.*?)\|/gm)]
      .filter(([, , summary]) => summary.trim().length === 0)
      .map(([, name]) => name);
    expect(blank, `tools whose description did not parse: ${blank.join(', ')}`).toEqual([]);
  });
});
