import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cloneRemoteRepo,
  isSafeGitUrl,
  resolveCloneDir,
} from '../../src/tools/advanced/subproject-clone.js';

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

describe('cloneRemoteRepo ref validation', () => {
  // The validator runs before any filesystem mutation or git invocation, so
  // these calls return Err without touching disk.
  const safeUrl = 'https://github.com/owner/repo.git';

  it('refuses refs that start with a dash (argv injection into --branch)', async () => {
    const r = await cloneRemoteRepo('/tmp/p', safeUrl, { ref: '-c=core.sshCommand=evil' });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.message).toContain('unsafe git ref');
  });

  it('refuses refs containing shell metacharacters and spaces', async () => {
    for (const ref of [
      'main; rm -rf /',
      'main && id',
      'feature with spaces',
      'main`whoami`',
      'main$(id)',
    ]) {
      const r = await cloneRemoteRepo('/tmp/p', safeUrl, { ref });
      expect(r.isErr(), `expected reject: ${ref}`).toBe(true);
    }
  });

  it('refuses oversize refs', async () => {
    const r = await cloneRemoteRepo('/tmp/p', safeUrl, { ref: 'a'.repeat(257) });
    expect(r.isErr()).toBe(true);
  });

  it('does not invoke ref validation when ref is undefined', async () => {
    // No ref means cloneRemoteRepo proceeds past the validator into the SSRF
    // check and (possibly) DNS / git. We expect either Ok (when destination
    // already exists from a prior run) or Err with a non-ref reason.
    const r = await cloneRemoteRepo('/tmp/p', safeUrl, {});
    if (r.isErr()) {
      expect(r.error.message).not.toContain('unsafe git ref');
    }
  });
});

describe('cloneRemoteRepo SSRF guard', () => {
  it('refuses literal-private-IP git URLs without explicit allow-private intent', async () => {
    // 169.254.169.254 = AWS/GCP/Azure metadata endpoint. Always blocked.
    const r = await cloneRemoteRepo('/tmp/p', 'https://169.254.169.254/repo.git');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.message).toContain('SSRF');
  });

  it('refuses loopback git URLs without explicit allow-private (defense-in-depth)', async () => {
    // 127.0.0.1 is private/loopback. isExplicitlyLocalUrl will return true,
    // so allowPrivateNetworks=true, so loopback IS allowed. Use 0.0.0.0 which
    // is unspecified — always blocked.
    const r = await cloneRemoteRepo('/tmp/p', 'https://0.0.0.0/repo.git');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.message).toContain('SSRF');
  });
});
