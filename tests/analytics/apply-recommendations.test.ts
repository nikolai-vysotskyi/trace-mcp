/**
 * TRA-769: applying a startup-context recommendation touches the user's real
 * client config, so what matters here is not the happy path alone — it's
 * that a dry run never writes, that every write is preceded by a backup, and
 * that rollback restores the exact prior bytes, including for a real
 * `~/.claude/settings.json` shape copied from a live install rather than a
 * hand-written fixture.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STARTUP_BACKUPS_DIR } from '../../src/shared/paths.js';
import {
  applyStartupRecommendations,
  rollbackStartupRecommendations,
} from '../../src/analytics/apply-recommendations.js';

// Captured before any test overrides HOME — this machine's actual home, used
// by the "real config" describe block below to round-trip genuine bytes
// rather than a hand-written fixture.
const REAL_HOME = os.homedir();

let home: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-apply-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads this on Windows.
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
  else delete process.env.USERPROFILE;
  fs.rmSync(home, { recursive: true, force: true });
});

function writeSettings(content: unknown): string {
  const file = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(file, JSON.stringify(content, null, 2) + '\n', 'utf8');
  return file;
}

describe('applyStartupRecommendations — unusedMcpServer', () => {
  it('dry run previews without writing', () => {
    const file = writeSettings({ mcpServers: { 'idle-server': { command: 'x' } } });
    const before = fs.readFileSync(file, 'utf8');

    const result = applyStartupRecommendations(
      [{ kind: 'unusedMcpServer', target: 'idle-server' }],
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.backupId).toBeNull();
    expect(result.outcomes[0].status).toBe('wouldApply');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('removes the server and keeps everything else, then rolls back byte-identical', () => {
    const file = writeSettings({
      mcpServers: { 'idle-server': { command: 'x' }, 'keep-server': { command: 'y' } },
      otherSetting: true,
    });
    const before = fs.readFileSync(file, 'utf8');

    const result = applyStartupRecommendations(
      [{ kind: 'unusedMcpServer', target: 'idle-server' }],
      { dryRun: false },
    );

    expect(result.outcomes[0].status).toBe('applied');
    expect(result.backupId).toBeTruthy();
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.mcpServers['idle-server']).toBeUndefined();
    expect(written.mcpServers['keep-server']).toEqual({ command: 'y' });
    expect(written.otherSetting).toBe(true);

    const rollback = rollbackStartupRecommendations(result.backupId ?? undefined);
    expect(rollback.errors).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('skips with a reason when the server is not configured anywhere scanned', () => {
    writeSettings({ mcpServers: {} });
    const result = applyStartupRecommendations(
      [{ kind: 'unusedMcpServer', target: 'ghost-server' }],
      { dryRun: false },
    );
    expect(result.outcomes[0].status).toBe('skipped');
    expect(result.outcomes[0].reason).toContain('ghost-server');
    expect(result.backupId).toBeNull();
  });

  it('round-trips a real settings.json shape byte-identically', () => {
    // A shape faithfully modelled on a live Claude Code settings.json: many
    // sibling keys, nested objects, an mcpServers map with more than one
    // entry — not a two-key fixture.
    const file = writeSettings({
      env: {},
      attribution: 'x',
      permissions: { allow: ['Bash(pnpm test:*)'], deny: [] },
      model: 'sonnet',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      enabledPlugins: { 'ponytail@ponytail': true, 'code-review@claude-plugins-official': false },
      mcpServers: {
        'trace-mcp': { command: 'trace-mcp', args: ['serve'], cwd: '/repo' },
        nanobanana: { command: 'npx', args: ['-y', '@ycse/nanobanana-mcp'], env: {} },
      },
    });
    const before = fs.readFileSync(file, 'utf8');

    const applied = applyStartupRecommendations(
      [{ kind: 'unusedMcpServer', target: 'nanobanana' }],
      { dryRun: false },
    );
    expect(applied.outcomes[0].status).toBe('applied');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.mcpServers.nanobanana).toBeUndefined();
    expect(written.mcpServers['trace-mcp']).toBeTruthy();
    expect(written.hooks).toBeTruthy();

    const rollback = rollbackStartupRecommendations(applied.backupId ?? undefined);
    expect(rollback.errors).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('applyStartupRecommendations — unusedSkill', () => {
  it('moves a personal skill out of discovery and rolls it back', () => {
    const skillDir = path.join(home, '.claude', 'skills', 'idle-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: idle-skill\n---\nbody', 'utf8');

    const result = applyStartupRecommendations([{ kind: 'unusedSkill', target: 'idle-skill' }], {
      dryRun: false,
    });

    expect(result.outcomes[0].status).toBe('applied');
    expect(fs.existsSync(skillDir)).toBe(false);
    const moved = path.join(home, '.claude', '.trace-mcp-disabled-skills', 'idle-skill');
    // Sibling of skills/, not inside it: a holding directory under skills/
    // gets listed as an installed skill by every scanner that reads that dir.
    expect(fs.readdirSync(path.join(home, '.claude', 'skills'))).toEqual([]);
    expect(fs.existsSync(moved)).toBe(true);
    expect(fs.readFileSync(path.join(moved, 'SKILL.md'), 'utf8')).toContain('idle-skill');

    const rollback = rollbackStartupRecommendations(result.backupId ?? undefined);
    expect(rollback.errors).toEqual([]);
    expect(fs.existsSync(skillDir)).toBe(true);
    expect(fs.existsSync(moved)).toBe(false);
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('idle-skill');
  });

  it('moves a symlinked skill without touching its target, and rolls back', () => {
    const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-apply-target-'));
    fs.writeFileSync(path.join(realTarget, 'SKILL.md'), 'real content', 'utf8');
    const link = path.join(home, '.claude', 'skills', 'linked-skill');
    fs.symlinkSync(realTarget, link, 'dir');

    const result = applyStartupRecommendations([{ kind: 'unusedSkill', target: 'linked-skill' }], {
      dryRun: false,
    });
    expect(result.outcomes[0].status).toBe('applied');
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(realTarget, 'SKILL.md'), 'utf8')).toBe('real content');

    rollbackStartupRecommendations(result.backupId ?? undefined);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8')).toBe('real content');

    fs.rmSync(realTarget, { recursive: true, force: true });
  });

  it('skips a plugin-namespaced skill without touching the filesystem', () => {
    const result = applyStartupRecommendations(
      [{ kind: 'unusedSkill', target: 'claude-seo:seo-audit' }],
      { dryRun: false },
    );
    expect(result.outcomes[0].status).toBe('skipped');
    expect(result.outcomes[0].reason).toMatch(/plugin/i);
    expect(result.backupId).toBeNull();
  });

  it('skips when the skill directory does not exist on disk', () => {
    const result = applyStartupRecommendations(
      [{ kind: 'unusedSkill', target: 'never-installed' }],
      { dryRun: false },
    );
    expect(result.outcomes[0].status).toBe('skipped');
  });
});

describe('applyStartupRecommendations — duplicateInstructions', () => {
  const SHARED_LINE =
    'This is a shared instruction line, long enough to count as meaningful duplication.';

  function writeInstructionFiles(project: string) {
    fs.writeFileSync(
      path.join(home, '.claude', 'CLAUDE.md'),
      `# Global\n\n${SHARED_LINE}\n\nOther global-only content.\n`,
      'utf8',
    );
    fs.mkdirSync(project, { recursive: true });
    const projectFile = path.join(project, 'CLAUDE.md');
    fs.writeFileSync(
      projectFile,
      `# Project\n\n${SHARED_LINE}\n\nUnique project-only content that must survive.\n`,
      'utf8',
    );
    return projectFile;
  }

  it('dry run returns a diff and token count without writing', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-apply-project-'));
    const projectFile = writeInstructionFiles(project);
    const before = fs.readFileSync(projectFile, 'utf8');

    const result = applyStartupRecommendations(
      [{ kind: 'duplicateInstructions', target: projectFile }],
      { dryRun: true },
    );

    const outcome = result.outcomes[0];
    expect(outcome.status).toBe('wouldApply');
    expect(outcome.diff).toContain(`-${SHARED_LINE}`);
    expect(outcome.tokensRemoved).toBeGreaterThan(0);
    expect(fs.readFileSync(projectFile, 'utf8')).toBe(before);

    fs.rmSync(project, { recursive: true, force: true });
  });

  it('removes only the duplicated line, keeps unique content, and rolls back byte-identically', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-apply-project-'));
    const projectFile = writeInstructionFiles(project);
    const globalFile = path.join(home, '.claude', 'CLAUDE.md');
    const globalBefore = fs.readFileSync(globalFile, 'utf8');
    const before = fs.readFileSync(projectFile, 'utf8');

    const result = applyStartupRecommendations(
      [{ kind: 'duplicateInstructions', target: projectFile }],
      { dryRun: false },
    );

    expect(result.outcomes[0].status).toBe('applied');
    const written = fs.readFileSync(projectFile, 'utf8');
    expect(written).not.toContain(SHARED_LINE);
    expect(written).toContain('Unique project-only content that must survive.');
    // The global file is never touched — the duplicate is removed from the
    // project side only.
    expect(fs.readFileSync(globalFile, 'utf8')).toBe(globalBefore);

    const rollback = rollbackStartupRecommendations(result.backupId ?? undefined);
    expect(rollback.errors).toEqual([]);
    expect(fs.readFileSync(projectFile, 'utf8')).toBe(before);

    fs.rmSync(project, { recursive: true, force: true });
  });

  it('skips when nothing is actually shared on re-check', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-apply-project-'));
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# Global only\n', 'utf8');
    const projectFile = path.join(project, 'CLAUDE.md');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(projectFile, '# Project only, nothing shared here\n', 'utf8');

    const result = applyStartupRecommendations(
      [{ kind: 'duplicateInstructions', target: projectFile }],
      { dryRun: false },
    );
    expect(result.outcomes[0].status).toBe('skipped');

    fs.rmSync(project, { recursive: true, force: true });
  });
});

describe('applyStartupRecommendations — one backup covers a whole call', () => {
  it('bundles multiple applied changes into a single backup and rolls all of them back together', () => {
    const settingsFile = writeSettings({ mcpServers: { 'idle-server': { command: 'x' } } });
    const settingsBefore = fs.readFileSync(settingsFile, 'utf8');
    const skillDir = path.join(home, '.claude', 'skills', 'idle-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'body', 'utf8');

    const result = applyStartupRecommendations(
      [
        { kind: 'unusedMcpServer', target: 'idle-server' },
        { kind: 'unusedSkill', target: 'idle-skill' },
      ],
      { dryRun: false },
    );

    expect(result.outcomes.every((o) => o.status === 'applied')).toBe(true);
    const backupIds = new Set(result.outcomes.map(() => result.backupId));
    expect(backupIds.size).toBe(1);
    expect(fs.existsSync(skillDir)).toBe(false);

    const rollback = rollbackStartupRecommendations(result.backupId ?? undefined);
    expect(rollback.errors).toEqual([]);
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(settingsBefore);
    expect(fs.existsSync(skillDir)).toBe(true);
  });
});

describe('rollbackStartupRecommendations', () => {
  it('reports an error instead of throwing when there is nothing to roll back', () => {
    const result = rollbackStartupRecommendations('does-not-exist');
    expect(result.restored).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// This machine's real ~/.claude/settings.json, if one exists — never opened
// for writing, only read once here to seed the sandbox with genuine bytes.
// The DoD for TRA-769 is "verified on a real config, not a fixture"; this is
// that verification. Skips cleanly on a CI runner or a machine with no such
// file, so it never becomes a flaky or environment-coupled failure.
const realSettingsPath = path.join(REAL_HOME, '.claude', 'settings.json');
const realSettingsRaw = (() => {
  try {
    return fs.readFileSync(realSettingsPath, 'utf8');
  } catch {
    return null;
  }
})();
const realServerName = (() => {
  if (!realSettingsRaw) return null;
  try {
    const servers = JSON.parse(realSettingsRaw)?.mcpServers;
    const names = servers && typeof servers === 'object' ? Object.keys(servers) : [];
    return names[0] ?? null;
  } catch {
    return null;
  }
})();

describe.skipIf(!realSettingsRaw || !realServerName)(
  "against this machine's real settings.json",
  () => {
    it('removes one real mcpServers entry and rolls back to byte-identical original bytes', () => {
      const file = path.join(home, '.claude', 'settings.json');
      fs.writeFileSync(file, realSettingsRaw as string, 'utf8');

      const applied = applyStartupRecommendations(
        [{ kind: 'unusedMcpServer', target: realServerName as string }],
        { dryRun: false },
      );
      expect(applied.outcomes[0].status).toBe('applied');
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(written.mcpServers[realServerName as string]).toBeUndefined();

      const rollback = rollbackStartupRecommendations(applied.backupId ?? undefined);
      expect(rollback.errors).toEqual([]);
      expect(fs.readFileSync(file, 'utf8')).toBe(realSettingsRaw);
    });
  },
);

describe('backup manifest durability', () => {
  it('a batch that throws part-way still leaves a manifest that rolls back what landed', () => {
    const settings = writeSettings({ mcpServers: { 'idle-server': { command: 'x' } } });
    const before = fs.readFileSync(settings, 'utf8');

    // Second request is rigged to throw: a FILE sits where the holding
    // directory for a disabled skill has to be created, so mkdirSync fails
    // after the first request has already rewritten settings.json.
    const skills = path.join(home, '.claude', 'skills');
    fs.mkdirSync(path.join(skills, 'idle-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.trace-mcp-disabled-skills'),
      'not a directory',
      'utf8',
    );

    const idsBefore = new Set(
      fs.existsSync(STARTUP_BACKUPS_DIR) ? fs.readdirSync(STARTUP_BACKUPS_DIR) : [],
    );
    expect(() =>
      applyStartupRecommendations(
        [
          { kind: 'unusedMcpServer', target: 'idle-server' },
          { kind: 'unusedSkill', target: 'idle-skill' },
        ],
        { dryRun: false },
      ),
    ).toThrow();

    // The write happened, so a manifest covering it must exist on disk even
    // though the call never returned a backupId.
    expect(fs.readFileSync(settings, 'utf8')).not.toBe(before);
    const newId = fs.readdirSync(STARTUP_BACKUPS_DIR).find((id) => !idsBefore.has(id));
    expect(newId).toBeTruthy();

    const rollback = rollbackStartupRecommendations(newId);
    expect(rollback.errors).toEqual([]);
    expect(fs.readFileSync(settings, 'utf8')).toBe(before);
  });
});

/**
 * Reviewer B's findings on PR #869: `target` and `backup_id` reach these
 * functions straight from a tool call, so each one is a path segment that used
 * to be joined onto a directory unchecked.
 */
describe('untrusted target and backup_id', () => {
  it('refuses a skill target that escapes skills/', () => {
    const outside = path.join(home, 'secret-user-data');
    fs.mkdirSync(outside, { recursive: true });

    const result = applyStartupRecommendations(
      [{ kind: 'unusedSkill', target: '../../secret-user-data' }],
      { dryRun: false },
    );

    expect(result.outcomes[0].status).toBe('skipped');
    expect(result.backupId).toBeNull();
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('refuses a backup id that escapes the backups directory', () => {
    const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-apply-evil-'));
    const victim = path.join(evil, 'victim.txt');
    fs.writeFileSync(victim, 'untouched', 'utf8');
    fs.writeFileSync(
      path.join(evil, 'manifest.json'),
      JSON.stringify({
        id: 'x',
        createdAt: new Date().toISOString(),
        entries: [{ type: 'file', path: victim, existed: true, content: 'overwritten' }],
      }),
      'utf8',
    );

    const result = rollbackStartupRecommendations(path.join('..', '..', evil));

    expect(result.restored).toEqual([]);
    expect(result.errors[0]).toContain('not a backup id');
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
    fs.rmSync(evil, { recursive: true, force: true });
  });

  it('refuses to edit the global instruction file as its own duplicate', () => {
    const globalFile = path.join(home, '.claude', 'CLAUDE.md');
    const body = `${'a line long enough to count as duplicated text '.repeat(2)}\nsecond such line, also long enough to be counted here\n`;
    fs.writeFileSync(globalFile, body, 'utf8');

    const result = applyStartupRecommendations(
      [{ kind: 'duplicateInstructions', target: globalFile }],
      { dryRun: false },
    );

    expect(result.outcomes[0].status).toBe('skipped');
    expect(fs.readFileSync(globalFile, 'utf8')).toBe(body);
  });

  it('does not treat an inherited Object property as a configured server', () => {
    const file = writeSettings({ mcpServers: {} });
    const before = fs.readFileSync(file, 'utf8');

    const result = applyStartupRecommendations(
      [{ kind: 'unusedMcpServer', target: 'constructor' }],
      { dryRun: false },
    );

    expect(result.outcomes[0].status).toBe('skipped');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
