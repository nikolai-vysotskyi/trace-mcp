import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAllLanguagePlugins } from '../../src/indexer/plugins/language/all.js';
import { renderMatrix } from '../../scripts/language-matrix.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LANG_DIR = join(ROOT, 'src/indexer/plugins/language');
const MATRIX = join(ROOT, 'docs/language-matrix.md');

describe('language plugin registration', () => {
  /**
   * TRA-395: `src/indexer/plugins/language/vhdl/` shipped a complete plugin
   * with a green test suite (tests/languages/hdl.test.ts constructs it
   * directly) — but nobody ever added it to createAllLanguagePlugins(), so
   * every .vhd file in every indexed repo was silently skipped. Testing a
   * plugin in isolation proves nothing about whether it is wired up.
   */
  it('registers every language plugin directory', () => {
    const dirs = readdirSync(LANG_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => existsSync(join(LANG_DIR, name, 'index.ts')));

    const allSource = readFileSync(join(LANG_DIR, 'all.ts'), 'utf8');
    const imported = new Set(
      [...allSource.matchAll(/from '\.\/([\w-]+)\/index\.js'/g)].map((m) => m[1]),
    );
    const instantiated = new Set(
      [...allSource.matchAll(/new (\w+LanguagePlugin)\(\)/g)].map((m) => m[1]),
    );

    const unregistered = dirs.filter((dir) => {
      if (!imported.has(dir)) return true;
      const exported = /export const (\w+LanguagePlugin)/.exec(
        readFileSync(join(LANG_DIR, dir, 'index.ts'), 'utf8'),
      )?.[1];
      return exported ? !instantiated.has(exported) : false;
    });

    expect(unregistered, 'language plugin dirs missing from createAllLanguagePlugins()').toEqual(
      [],
    );
  });

  it('gives every registered plugin at least one extension to match on', () => {
    for (const plugin of createAllLanguagePlugins()) {
      expect(plugin.supportedExtensions.length, plugin.manifest.name).toBeGreaterThan(0);
    }
  });
});

describe('docs/language-matrix.md', () => {
  it('is regenerated from the code', () => {
    // `pnpm docs:sitemap` stamps `updated:` into the front matter of every page
    // in the sitemap, this one included since it was published. That line comes
    // from git, not from the generator, so drop it before comparing.
    const withoutStamp = (s: string) => s.replace(/^updated:.*\n/m, '');
    expect(withoutStamp(readFileSync(MATRIX, 'utf8'))).toBe(withoutStamp(renderMatrix()));
  });
});
