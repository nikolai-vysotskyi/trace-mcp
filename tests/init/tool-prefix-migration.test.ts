/**
 * `migrateLegacyToolPrefix` (TRA-650) — end-to-end over real files.
 *
 * Unlike hooks.test.ts, this does NOT mock `node:fs`: the whole point is to
 * prove the on-disk rewrite is correct byte-for-byte, which is easiest to
 * trust against a real filesystem rather than a mocked call-log. Only
 * `node:os`'s `homedir()` is mocked (before the dynamic import, since
 * `hooks.ts` reads it once at module load) so the test writes under a
 * disposable temp directory instead of the real `~/.claude`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempHome: string;
let tempProject: string;
let originalCwd: string;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  const homedir = () => process.env.TRACE_TEST_HOME as string;
  return {
    ...actual,
    homedir,
    default: { ...(actual as unknown as { default: Record<string, unknown> }).default, homedir },
  };
});

let migrateLegacyToolPrefix: typeof import('../../src/init/hooks.js').migrateLegacyToolPrefix;

beforeEach(async () => {
  vi.resetModules();
  tempHome = mkdtempSync(join(tmpdir(), 'trace-tool-prefix-home-'));
  tempProject = mkdtempSync(join(tmpdir(), 'trace-tool-prefix-project-'));
  process.env.TRACE_TEST_HOME = tempHome;
  originalCwd = process.cwd();
  process.chdir(tempProject);

  const mod = await import('../../src/init/hooks.js');
  migrateLegacyToolPrefix = mod.migrateLegacyToolPrefix;
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempProject, { recursive: true, force: true });
  delete process.env.TRACE_TEST_HOME;
  vi.restoreAllMocks();
});

describe('migrateLegacyToolPrefix', () => {
  it('rewrites a global permission allowlist entry and a hook matcher, both naming legacy tools', () => {
    const claudeDir = join(tempHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    const original = JSON.stringify(
      {
        permissions: {
          allow: ['mcp__trace-mcp__search', 'mcp__trace-mcp__get_symbol', 'Bash(git log)'],
          deny: ['mcp__trace-mcp__remove_dead_code'],
        },
        hooks: {
          PreToolUse: [
            {
              matcher: 'mcp__trace-mcp__search',
              hooks: [{ type: 'command', command: '/opt/my-org/audit-hook.sh' }],
            },
          ],
        },
      },
      null,
      2,
    );
    writeFileSync(settingsPath, original);

    const results = migrateLegacyToolPrefix();

    const updated = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(updated.permissions.allow).toEqual([
      'mcp__trace__search',
      'mcp__trace__get_symbol',
      'Bash(git log)',
    ]);
    expect(updated.permissions.deny).toEqual(['mcp__trace__remove_dead_code']);
    expect(updated.hooks.PreToolUse[0].matcher).toBe('mcp__trace__search');
    // The user's own hook command is untouched.
    expect(updated.hooks.PreToolUse[0].hooks[0].command).toBe('/opt/my-org/audit-hook.sh');

    const step = results.find((r) => r.target === settingsPath);
    expect(step?.action).toBe('updated');
    expect(step?.detail).toContain('4');
  });

  it('rewrites the project-scoped settings.local.json for the current working directory', () => {
    mkdirSync(join(tempHome, '.claude'), { recursive: true });
    const projectClaudeDir = join(tempProject, '.claude');
    mkdirSync(projectClaudeDir, { recursive: true });
    const localSettingsPath = join(projectClaudeDir, 'settings.local.json');
    writeFileSync(localSettingsPath, '{"permissions":{"allow":["mcp__trace-mcp__search"]}}');

    migrateLegacyToolPrefix();

    const updated = JSON.parse(readFileSync(localSettingsPath, 'utf8'));
    expect(updated.permissions.allow).toEqual(['mcp__trace__search']);
  });

  it('is a no-op when no Claude-family client is installed on this machine', () => {
    // Neither ~/.claude nor ~/.claw exists, and there's no project-scoped
    // settings.local.json either — nothing to migrate.
    const results = migrateLegacyToolPrefix();
    expect(results).toEqual([]);
  });

  it('rewrites project-scoped settings.local.json even when the global client directory does not exist', () => {
    // Regression (TRA-650 review): migrateLegacyToolPrefix used to gate both
    // the global AND project-scoped candidate files on clientExists(), which
    // only checks ~/.claude — so `trace init --skip-hooks --scope project` on
    // a checkout with local settings but no global Claude Code install
    // silently skipped the rewrite. Deliberately no ~/.claude here.
    const projectClaudeDir = join(tempProject, '.claude');
    mkdirSync(projectClaudeDir, { recursive: true });
    const localSettingsPath = join(projectClaudeDir, 'settings.local.json');
    writeFileSync(localSettingsPath, '{"permissions":{"allow":["mcp__trace-mcp__search"]}}');

    const results = migrateLegacyToolPrefix();

    const updated = JSON.parse(readFileSync(localSettingsPath, 'utf8'));
    expect(updated.permissions.allow).toEqual(['mcp__trace__search']);
    // process.cwd() can resolve through a symlink differently than the
    // pre-chdir tempProject string (e.g. macOS /var vs /private/var), so
    // compare the step by basename rather than an exact path match. Normalize
    // separators too — path.join on win32 emits backslashes.
    expect(
      results.some((r) => r.target.replace(/\\/g, '/').endsWith('.claude/settings.local.json')),
    ).toBe(true);
  });

  it('does not touch a settings file with no legacy references', () => {
    const claudeDir = join(tempHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    const original = '{"permissions":{"allow":["mcp__trace__search","Bash(ls)"]}}';
    writeFileSync(settingsPath, original);

    const results = migrateLegacyToolPrefix();

    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
    expect(results.find((r) => r.target === settingsPath)).toBeUndefined();
  });

  it('dry run reports the change without writing', () => {
    const claudeDir = join(tempHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    const original = '{"permissions":{"allow":["mcp__trace-mcp__search"]}}';
    writeFileSync(settingsPath, original);

    const results = migrateLegacyToolPrefix({ dryRun: true });

    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
    const step = results.find((r) => r.target === settingsPath);
    expect(step?.detail).toMatch(/would rewrite/i);
  });

  it('reports a skipped step with an error for a settings.json that is a symlink, and leaves the real target untouched', () => {
    const claudeDir = join(tempHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const realFile = join(tempHome, 'real-settings.json');
    writeFileSync(realFile, '{"permissions":{"allow":["mcp__trace-mcp__search"]}}');
    symlinkSync(realFile, join(claudeDir, 'settings.json'));

    const results = migrateLegacyToolPrefix();

    const step = results.find((r) => r.target === join(claudeDir, 'settings.json'));
    expect(step?.action).toBe('skipped');
    expect(step?.detail).toMatch(/symlink/i);
    expect(readFileSync(realFile, 'utf8')).toContain('mcp__trace-mcp__search');
  });

  it('covers both .claude and .claw when both are installed', () => {
    mkdirSync(join(tempHome, '.claude'), { recursive: true });
    mkdirSync(join(tempHome, '.claw'), { recursive: true });
    writeFileSync(
      join(tempHome, '.claude', 'settings.json'),
      '{"permissions":{"allow":["mcp__trace-mcp__search"]}}',
    );
    writeFileSync(
      join(tempHome, '.claw', 'settings.json'),
      '{"permissions":{"allow":["mcp__trace-mcp__get_symbol"]}}',
    );

    migrateLegacyToolPrefix();

    expect(
      JSON.parse(readFileSync(join(tempHome, '.claude', 'settings.json'), 'utf8')).permissions
        .allow,
    ).toEqual(['mcp__trace__search']);
    expect(
      JSON.parse(readFileSync(join(tempHome, '.claw', 'settings.json'), 'utf8')).permissions.allow,
    ).toEqual(['mcp__trace__get_symbol']);
  });
});
