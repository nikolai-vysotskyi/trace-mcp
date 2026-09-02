/**
 * Store.resolveFile — unique-suffix fallback for read-side path lookups.
 *
 * Regression guard for the NOT_FOUND round-trip waste measured in TRA-693:
 * agents whose cwd is a subdirectory of the indexed root pass paths relative to
 * that cwd, and every such call used to cost a failed call plus a search()
 * recovery. 42 of 56 mappable NOT_FOUND failures in the local session history
 * were resolvable by a unique suffix match in the very database that was queried.
 */
import { describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';

function seed(store: Store, paths: string[]): void {
  for (const p of paths) store.insertFile(p, 'php', null, null);
}

describe('Store.resolveFile', () => {
  it('returns the exact match when one exists', () => {
    const store = createTestStore();
    seed(store, ['app/Models/City.php', 'sub/app/Models/City.php']);
    expect(store.resolveFile('app/Models/City.php')?.path).toBe('app/Models/City.php');
  });

  it('resolves a cwd-relative path to the single indexed file that ends with it', () => {
    const store = createTestStore();
    seed(store, ['thewed-laravel/app/Http/Controllers/SitemapController.php', 'other/Readme.php']);
    expect(store.resolveFile('app/Http/Controllers/SitemapController.php')?.path).toBe(
      'thewed-laravel/app/Http/Controllers/SitemapController.php',
    );
  });

  it('strips a leading ./ or /', () => {
    const store = createTestStore();
    seed(store, ['pkg/app/Models/City.php']);
    expect(store.resolveFile('./app/Models/City.php')?.path).toBe('pkg/app/Models/City.php');
    expect(store.resolveFile('/app/Models/City.php')?.path).toBe('pkg/app/Models/City.php');
  });

  it('prefers the normalized exact match over suffix candidates', () => {
    const store = createTestStore();
    seed(store, ['app/Models/City.php', 'sub/app/Models/City.php']);
    // './' spelling must resolve to the root file, not be rejected as ambiguous
    // just because a subdirectory holds a file with the same suffix.
    expect(store.resolveFile('./app/Models/City.php')?.path).toBe('app/Models/City.php');
    expect(store.resolveFile('/app/Models/City.php')?.path).toBe('app/Models/City.php');
  });

  it('refuses to guess when the suffix is ambiguous', () => {
    const store = createTestStore();
    seed(store, ['a/app/Models/City.php', 'b/app/Models/City.php']);
    expect(store.resolveFile('app/Models/City.php')).toBeUndefined();
  });

  it('does not match a partial path segment', () => {
    const store = createTestStore();
    seed(store, ['app/Models/BigCity.php']);
    expect(store.resolveFile('City.php')).toBeUndefined();
  });

  it('treats LIKE wildcards in the query as literal characters', () => {
    const store = createTestStore();
    seed(store, ['app/Models/City.php', 'app/Models/Town.php']);
    // '%' and '_' must not turn into wildcards and match both rows.
    expect(store.resolveFile('app/Models/%.php')).toBeUndefined();
    expect(store.resolveFile('app/Models/Cit_.php')).toBeUndefined();
  });

  it('still misses genuinely unknown files', () => {
    const store = createTestStore();
    seed(store, ['app/Models/City.php']);
    expect(store.resolveFile('app/Models/Ghost.php')).toBeUndefined();
  });
});
