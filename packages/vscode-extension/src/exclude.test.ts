import { describe, expect, it } from 'vitest';
import { shouldExclude } from './exclude.js';

const DEFAULT_GLOBS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/*.lock',
  '**/*.log',
];

describe('shouldExclude', () => {
  it('matches default exclude globs', () => {
    expect(shouldExclude('node_modules/lodash/index.js', DEFAULT_GLOBS)).toBe(true);
    expect(shouldExclude('packages/app/dist/main.js', DEFAULT_GLOBS)).toBe(true);
    expect(shouldExclude('build/output.txt', DEFAULT_GLOBS)).toBe(true);
    expect(shouldExclude('.git/HEAD', DEFAULT_GLOBS)).toBe(true);
    expect(shouldExclude('subdir/package.lock', DEFAULT_GLOBS)).toBe(true);
    expect(shouldExclude('logs/server.log', DEFAULT_GLOBS)).toBe(true);
  });

  it('does not match regular source files', () => {
    expect(shouldExclude('src/foo.ts', DEFAULT_GLOBS)).toBe(false);
    expect(shouldExclude('packages/app/src/main.ts', DEFAULT_GLOBS)).toBe(false);
    expect(shouldExclude('README.md', DEFAULT_GLOBS)).toBe(false);
  });

  it('normalizes Windows backslashes', () => {
    expect(shouldExclude('node_modules\\lodash\\index.js', DEFAULT_GLOBS)).toBe(true);
    expect(shouldExclude('src\\foo.ts', DEFAULT_GLOBS)).toBe(false);
  });

  it('matches dotfiles via the dot:true minimatch flag', () => {
    expect(shouldExclude('.git/config', DEFAULT_GLOBS)).toBe(true);
    expect(shouldExclude('subdir/.git/config', DEFAULT_GLOBS)).toBe(true);
  });

  it('returns false on an empty pattern list', () => {
    expect(shouldExclude('any/path', [])).toBe(false);
  });

  it('skips invalid patterns instead of throwing', () => {
    // Garbage pattern in user config must not break the save handler.
    const globs = ['[invalid', '**/*.ts'];
    expect(() => shouldExclude('src/foo.ts', globs)).not.toThrow();
    expect(shouldExclude('src/foo.ts', globs)).toBe(true);
  });
});
