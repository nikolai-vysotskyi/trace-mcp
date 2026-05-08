import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSafeGitUrl, resolveCloneDir } from '../../src/tools/advanced/subproject-clone.js';

describe('isSafeGitUrl', () => {
  it('accepts ordinary https GitHub / GitLab URLs', () => {
    expect(isSafeGitUrl('https://github.com/owner/repo')).toBe(true);
    expect(isSafeGitUrl('https://github.com/owner/repo.git')).toBe(true);
    expect(isSafeGitUrl('https://gitlab.com/group/sub/repo.git')).toBe(true);
    expect(isSafeGitUrl('https://example.com:8443/team/svc.git')).toBe(true);
  });

  it('accepts git@ ssh shorthand', () => {
    expect(isSafeGitUrl('git@github.com:owner/repo.git')).toBe(true);
    expect(isSafeGitUrl('git@bitbucket.org:team/svc')).toBe(true);
  });

  it('rejects non-string / empty / oversize values', () => {
    expect(isSafeGitUrl(undefined)).toBe(false);
    expect(isSafeGitUrl(null)).toBe(false);
    expect(isSafeGitUrl(123)).toBe(false);
    expect(isSafeGitUrl('')).toBe(false);
    expect(isSafeGitUrl('a'.repeat(1025))).toBe(false);
  });

  it('rejects shell metacharacters', () => {
    for (const u of [
      'https://github.com/x/y; rm -rf /',
      'https://github.com/x/y && id',
      'https://github.com/x/y`whoami`',
      'https://github.com/x with spaces/repo',
      'https://github.com/x/$(id)',
    ]) {
      expect(isSafeGitUrl(u), `expected reject: ${u}`).toBe(false);
    }
  });

  it('rejects leading dash (argv injection)', () => {
    expect(isSafeGitUrl('--upload-pack=evil')).toBe(false);
    expect(isSafeGitUrl('-c=core.sshCommand=evil')).toBe(false);
  });

  it('rejects unsupported schemes', () => {
    expect(isSafeGitUrl('ftp://github.com/owner/repo')).toBe(false);
    expect(isSafeGitUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeGitUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('resolveCloneDir', () => {
  it('places clones under <projectRoot>/.trace-mcp/subprojects/<owner>/<repo>', () => {
    const projectRoot = '/tmp/host-project';
    const dir = resolveCloneDir(projectRoot, 'https://github.com/foo/bar.git');
    expect(dir).toBe(path.resolve(projectRoot, '.trace-mcp/subprojects/foo/bar'));
  });

  it('strips trailing .git from ssh-style urls', () => {
    const dir = resolveCloneDir('/tmp/p', 'git@github.com:foo/bar.git');
    expect(dir).toBe(path.resolve('/tmp/p', '.trace-mcp/subprojects/foo/bar'));
  });

  it('uses the trailing two segments for nested groups', () => {
    const dir = resolveCloneDir('/tmp/p', 'https://gitlab.com/team/sub/svc.git');
    // Expect the leaf two: "sub/svc"
    expect(dir).toBe(path.resolve('/tmp/p', '.trace-mcp/subprojects/sub/svc'));
  });
});
