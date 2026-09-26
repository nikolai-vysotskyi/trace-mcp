/**
 * Tests for `getProjectPromptsStatus` (TRA-1933 Phase B) — the read-only
 * project probe behind `trace-mcp clients prompts`.
 *
 * Real fs inside a tmp sandbox, same module-isolation dance as
 * mcp-client-status.test.ts. `TWEAKCC_CONFIG_DIR` pins the tweakcc lookup
 * into the sandbox so the real home is never consulted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let sandbox: string;
let fakeHome: string;
let projectRoot: string;

let getProjectPromptsStatus: typeof import('../../src/init/mcp-client.js').getProjectPromptsStatus;

const GUARD_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: 'Read|Grep|Glob|Bash',
        hooks: [{ type: 'command', command: '/x/hooks/trace-mcp-guard' }],
      },
    ],
  },
});

beforeEach(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-prompts-'));
  fakeHome = path.join(sandbox, 'home');
  projectRoot = path.join(sandbox, 'project');
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });

  vi.stubEnv('HOME', fakeHome);
  vi.stubEnv('USERPROFILE', fakeHome);
  vi.stubEnv('APPDATA', path.join(fakeHome, 'AppData', 'Roaming'));
  vi.stubEnv('TWEAKCC_CONFIG_DIR', path.join(sandbox, 'tweakcc'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(sandbox, 'xdg'));
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  vi.resetModules();
  ({ getProjectPromptsStatus } = await import('../../src/init/mcp-client.js'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('getProjectPromptsStatus', () => {
  it('reports everything missing in an empty project', () => {
    expect(getProjectPromptsStatus(projectRoot)).toEqual({
      projectRoot,
      claudeMdExists: false,
      claudeMdHasTraceBlock: false,
      agentsMdExists: false,
      agentsMdHasTraceBlock: false,
      projectHook: 'missing',
      projectHookPath: null,
      tweakccPrompts: false,
    });
  });

  it('detects the trace block in CLAUDE.md (both marker generations)', () => {
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '# P\n<!-- trace:start -->\n');
    const withNew = getProjectPromptsStatus(projectRoot);
    expect(withNew.claudeMdExists).toBe(true);
    expect(withNew.claudeMdHasTraceBlock).toBe(true);

    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '# P\n<!-- trace-mcp:start -->\n');
    expect(getProjectPromptsStatus(projectRoot).claudeMdHasTraceBlock).toBe(true);
  });

  it('does not mistake a plain CLAUDE.md for a routed one', () => {
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '# Plain project notes\n');
    const s = getProjectPromptsStatus(projectRoot);
    expect(s.claudeMdExists).toBe(true);
    expect(s.claudeMdHasTraceBlock).toBe(false);
  });

  it('detects the trace block in AGENTS.md independently of CLAUDE.md', () => {
    fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '<!-- trace:start -->\n');
    const s = getProjectPromptsStatus(projectRoot);
    expect(s.claudeMdExists).toBe(false);
    expect(s.agentsMdExists).toBe(true);
    expect(s.agentsMdHasTraceBlock).toBe(true);
  });

  it('reports the project hook active when settings.local.json carries the guard', () => {
    const dir = path.join(projectRoot, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const hookFile = path.join(dir, 'settings.local.json');
    fs.writeFileSync(hookFile, GUARD_SETTINGS);

    const s = getProjectPromptsStatus(projectRoot);
    expect(s.projectHook).toBe('active');
    expect(s.projectHookPath).toBe(hookFile);
  });

  it('names the checked file even when it carries no hook', () => {
    const dir = path.join(projectRoot, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    const hookFile = path.join(dir, 'settings.local.json');
    fs.writeFileSync(hookFile, JSON.stringify({ hooks: {} }));

    const s = getProjectPromptsStatus(projectRoot);
    expect(s.projectHook).toBe('missing');
    expect(s.projectHookPath).toBe(hookFile);
  });

  it('survives a malformed settings.local.json without throwing', () => {
    const dir = path.join(projectRoot, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.local.json'), '{not json');

    expect(() => getProjectPromptsStatus(projectRoot)).not.toThrow();
    expect(getProjectPromptsStatus(projectRoot).projectHook).toBe('missing');
  });

  it('reports tweakcc prompts when the pinned config dir carries them', () => {
    const dir = path.join(sandbox, 'tweakcc', 'system-prompts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tool-description-readfile.md'), '# routed\n');

    expect(getProjectPromptsStatus(projectRoot).tweakccPrompts).toBe(true);
  });
});
