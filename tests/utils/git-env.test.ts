import { describe, expect, it } from 'vitest';
import { findUnsafeRef, isSafeGitRef, safeGitEnv } from '../../src/utils/git-env.js';

describe('isSafeGitRef', () => {
  it('accepts ordinary branch and tag names', () => {
    expect(isSafeGitRef('main')).toBe(true);
    expect(isSafeGitRef('master')).toBe(true);
    expect(isSafeGitRef('feature/auth')).toBe(true);
    expect(isSafeGitRef('release/2026.05.0')).toBe(true);
    expect(isSafeGitRef('v1.2.3')).toBe(true);
    expect(isSafeGitRef('user_xyz')).toBe(true);
  });

  it('accepts revision selectors', () => {
    expect(isSafeGitRef('HEAD')).toBe(true);
    expect(isSafeGitRef('HEAD~1')).toBe(true);
    expect(isSafeGitRef('HEAD^')).toBe(true);
    expect(isSafeGitRef('origin/main')).toBe(true);
    expect(isSafeGitRef('abc1234')).toBe(true);
    expect(isSafeGitRef('@')).toBe(true);
  });

  it('rejects refs starting with a dash (argv injection)', () => {
    // `git show -c=core.sshCommand=evil` would set a global option.
    expect(isSafeGitRef('-c=core.sshCommand=evil')).toBe(false);
    expect(isSafeGitRef('-help')).toBe(false);
    expect(isSafeGitRef('--upload-pack=evil')).toBe(false);
  });

  it('rejects shell metacharacters (shell injection via execSync)', () => {
    expect(isSafeGitRef('main; rm -rf /')).toBe(false);
    expect(isSafeGitRef('main && evil')).toBe(false);
    expect(isSafeGitRef('main | nc x.y')).toBe(false);
    expect(isSafeGitRef('main`whoami`')).toBe(false);
    expect(isSafeGitRef('main$IFS')).toBe(false);
    expect(isSafeGitRef('main\nrm')).toBe(false);
    expect(isSafeGitRef('main with spaces')).toBe(false);
  });

  it('rejects double-dot (range syntax) embedded in single ref', () => {
    // Refs with `..` are range expressions, not single refs — caller can
    // construct the range explicitly from two validated refs.
    expect(isSafeGitRef('main..feature')).toBe(false);
  });

  it('rejects empty string and absurdly long values', () => {
    expect(isSafeGitRef('')).toBe(false);
    expect(isSafeGitRef('a'.repeat(257))).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isSafeGitRef(undefined)).toBe(false);
    expect(isSafeGitRef(null)).toBe(false);
    expect(isSafeGitRef(123)).toBe(false);
    expect(isSafeGitRef({})).toBe(false);
  });
});

describe('findUnsafeRef', () => {
  it('returns null when every ref is safe', () => {
    expect(findUnsafeRef({ since: 'main', until: 'HEAD' })).toBeNull();
  });

  it('skips undefined / null entries', () => {
    expect(findUnsafeRef({ since: undefined, until: 'HEAD', base: null })).toBeNull();
  });

  it('returns the first failing entry by name', () => {
    const result = findUnsafeRef({
      since: 'main',
      until: '-c=core.sshCommand=evil',
      base: 'master',
    });
    expect(result).not.toBeNull();
    expect(result?.name).toBe('until');
  });
});

describe('safeGitEnv', () => {
  it('disables system + global config and silences prompts', () => {
    const env = safeGitEnv();
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_EDITOR).toBe('true');
    // GIT_CONFIG_GLOBAL points to /dev/null on POSIX, NUL on Windows.
    expect(env.GIT_CONFIG_GLOBAL === '/dev/null' || env.GIT_CONFIG_GLOBAL === 'NUL').toBe(true);
  });

  it('lets explicit overrides win over defaults', () => {
    const env = safeGitEnv({ GIT_TERMINAL_PROMPT: '1' });
    expect(env.GIT_TERMINAL_PROMPT).toBe('1');
  });

  it('removes a key when override value is undefined', () => {
    const env = safeGitEnv({ GIT_EDITOR: undefined });
    expect(env.GIT_EDITOR).toBeUndefined();
  });
});
