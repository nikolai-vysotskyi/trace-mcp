import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { compareBranches, getChangedSymbols } from '../../src/tools/quality/changed-symbols.js';

/**
 * Regression suite for the shell- and argv-injection vectors that previously
 * existed in compareBranches / getChangedSymbols. The functions used to
 * interpolate user-supplied refs into a shell command via execSync; a hostile
 * MCP caller could inject arbitrary commands. The current implementation
 * validates refs and uses execFileSync, so any unsafe value should be rejected
 * before the subprocess starts.
 */
describe('changed-symbols ref validation', () => {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  const cwd = process.cwd();

  it('compareBranches rejects a branch starting with a dash', () => {
    const result = compareBranches(store, cwd, { branch: '-c=core.sshCommand=evil' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.message).toMatch(/Invalid git ref/);
    }
  });

  it('compareBranches rejects shell metacharacters in the branch', () => {
    for (const ref of ['main; rm -rf /', 'main && id', 'main`whoami`', 'main | nc x.y']) {
      const result = compareBranches(store, cwd, { branch: ref });
      expect(result.isErr()).toBe(true);
    }
  });

  it('compareBranches rejects a hostile base ref', () => {
    const result = compareBranches(store, cwd, { branch: 'main', base: '--upload-pack=evil' });
    expect(result.isErr()).toBe(true);
  });

  it('getChangedSymbols rejects a hostile since ref', () => {
    const result = getChangedSymbols(store, cwd, { since: '-x; rm -rf /' });
    expect(result.isErr()).toBe(true);
  });

  it('getChangedSymbols rejects a hostile until ref', () => {
    const result = getChangedSymbols(store, cwd, { since: 'main', until: 'HEAD; id' });
    expect(result.isErr()).toBe(true);
  });
});
