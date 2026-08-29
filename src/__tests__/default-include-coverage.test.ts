import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';
import { DATA_ONLY_LANGUAGES, TraceMcpConfigSchema } from '../config.js';
import { createAllLanguagePlugins } from '../indexer/plugins/language/all.js';

/**
 * TRA-400: the shipped default `include` used to reach 24 of the 81 registered
 * language plugins — a repo's VHDL, Terraform, SQL, CSS or shell indexed
 * nothing at all. The default is now derived from the plugin registry, but as a
 * literal string (config load must not import tree-sitter grammars). This test
 * is the thing that keeps the two in sync: register a plugin with a new
 * extension and the default include has to grow with it, or fail here.
 */

const defaults = TraceMcpConfigSchema.parse({});
const isIncluded = picomatch(defaults.include);
const isExcluded = picomatch(defaults.exclude);

/** A repo-relative sample path for an extension or bare filename a plugin claims. */
function samplePath(claim: string): string {
  return claim.startsWith('.') ? `pkg/sample${claim}` : `pkg/${claim}`;
}

const plugins = createAllLanguagePlugins().map((p) => ({
  language: p.manifest.name.replace(/-language$/, ''),
  claims: [...p.supportedExtensions],
}));

const dataOnly = new Set<string>(DATA_ONLY_LANGUAGES);

describe('default include globs', () => {
  it('registers at least the 80 language plugins this test was written against', () => {
    expect(plugins.length).toBeGreaterThanOrEqual(80);
  });

  it.each(plugins.filter((p) => !dataOnly.has(p.language)))(
    'indexes every file $language claims',
    ({ claims }) => {
      for (const claim of claims) {
        const path = samplePath(claim);
        expect(isIncluded(path), `${path} is not matched by the default include`).toBe(true);
        expect(isExcluded(path), `${path} is removed by the default exclude`).toBe(false);
      }
    },
  );

  it.each([...dataOnly])('leaves %s out of the default index', (language) => {
    const plugin = plugins.find((p) => p.language === language);
    expect(
      plugin,
      `DATA_ONLY_LANGUAGES names ${language}, which is not a registered plugin`,
    ).toBeDefined();
    for (const claim of plugin?.claims ?? []) {
      // composer.json is the one deliberate exception — Laravel package
      // discovery reads it, so it is included by name rather than by extension.
      expect(isIncluded(samplePath(claim))).toBe(false);
    }
  });

  it('keeps every default include pattern global so monorepo re-anchoring is a no-op', () => {
    expect(defaults.include.filter((p) => !p.startsWith('**/'))).toEqual([]);
  });

  it('still excludes the vendored trees the global globs now reach', () => {
    for (const path of [
      'node_modules/left-pad/index.js',
      'vendor/laravel/framework/src/Foo.php',
      '.terraform/modules/vpc/main.tf',
      'target/release/build/foo/out/gen.rs',
      'Pods/Alamofire/Source/Alamofire.swift',
      'coverage/lcov-report/prettify.js',
      'public/js/app.min.js',
      'assets/site.min.css',
      '.venv/lib/site-packages/requests/api.py',
      'obj/Debug/AssemblyInfo.cs',
    ]) {
      // `.terraform` and `.venv` are dot-directories, which fast-glob skips via
      // `dot: false`; the rest have to be caught by an explicit exclude.
      const skipped = isExcluded(path) || path.split('/').some((seg) => seg.startsWith('.'));
      expect(skipped, `${path} would be indexed`).toBe(true);
    }
  });
});
