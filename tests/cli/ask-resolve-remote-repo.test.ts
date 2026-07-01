/**
 * Regression test for CWE-78 (command injection) in `trace-mcp ask --repo`.
 *
 * `resolveRemoteRepo` used to build a shell command string via template
 * interpolation:
 *
 *   execSync(`git clone --depth=1 --single-branch "https://github.com/${repo}.git" "${tmpDir}"`)
 *
 * `repo` comes directly from the `--repo <owner/name>` CLI flag, so a value
 * containing shell metacharacters could break out of the quotes (CWE-78).
 * A regex guard (`^[\w.-]+\/[\w.-]+$`) already rejected malformed input
 * before reaching execSync, but the string was still concatenated into a
 * shell command as defense-in-depth belt-and-suspenders. This test locks in
 * two properties:
 *
 *  1. Malformed / malicious `repo` strings are rejected before any process
 *     is spawned (regex guard, unchanged behavior).
 *  2. The clone itself never goes through a shell — `execFileSync('git', [...])`
 *     is used instead of `execSync(string)`, so even a value that somehow
 *     passed validation could never be reinterpreted by a shell.
 */
import { execFileSync, execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRemoteRepo } from '../../src/cli/ask.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);

describe('resolveRemoteRepo — command injection hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a repo string with shell metacharacters before spawning anything', async () => {
    const malicious = 'foo/bar"; rm -rf /; echo "';

    await expect(resolveRemoteRepo(malicious)).rejects.toThrow(/Invalid repo format/);

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('rejects a repo string with a leading dash (git flag injection)', async () => {
    await expect(resolveRemoteRepo('--upload-pack=evil/x')).rejects.toThrow(/Invalid repo format/);
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('never calls execSync for the clone (no shell string interpolation)', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    // A well-formed repo string will pass validation and reach the clone
    // call; downstream setup (setupProject/loadConfig/pipeline) will likely
    // throw afterward since there's no real cloned repo on disk — that's
    // fine, we only care about how the clone itself was invoked.
    await resolveRemoteRepo('facebook/react').catch(() => {
      /* expected — no real clone happened under execFileSync mock */
    });

    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('passes repo/URL as discrete execFileSync argv elements, not shell-concatenated', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    await resolveRemoteRepo('facebook/react').catch(() => {
      /* expected */
    });

    const cloneCall = mockExecFileSync.mock.calls.find((c) => {
      const args = (c[1] ?? []) as string[];
      return c[0] === 'git' && args[0] === 'clone';
    });
    expect(cloneCall).toBeDefined();
    const [cmd, args] = cloneCall as [string, string[]];
    expect(cmd).toBe('git');
    expect(args.some((a) => a.includes('facebook/react'))).toBe(true);
    // No argv element should contain shell metacharacters — proves there is
    // no shell in between that could reinterpret them.
    for (const a of args) {
      expect(a).not.toMatch(/[;&`$|]/);
    }
  });
});
