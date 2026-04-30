import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkInstallStatus,
  getGuardMode,
  getGuardStatus,
  initializeGuard,
  installHook,
  MIN_TRACE_MCP_VERSION,
  resolveHookSourceScript,
  setBypass,
  setGuardMode,
  uninstallHook,
} from '../../packages/app/src/main/guard-control.js';

const TMP_BASE = fs.realpathSync(os.tmpdir());

function projectHash(p: string): string {
  return crypto.createHash('sha256').update(path.resolve(p)).digest('hex').slice(0, 12);
}

describe('guard-control (app main process)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(
      TMP_BASE,
      `guard-ctrl-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(projectDir)) {
      const real = fs.realpathSync(projectDir);
      const status = path.join(TMP_BASE, `trace-mcp-status-${projectHash(real)}.json`);
      const legacy = path.join(TMP_BASE, `trace-mcp-alive-${projectHash(real)}`);
      const bypass = path.join(TMP_BASE, `trace-mcp-bypass-${projectHash(real)}`);
      [status, legacy, bypass].forEach((f) => fs.rmSync(f, { force: true }));
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // ─── Mode get/set ───────────────────────────────────────────────

  it('getGuardMode returns "strict" by default (no file)', () => {
    expect(getGuardMode(projectDir)).toBe('strict');
  });

  it('setGuardMode persists to .trace-mcp/guard-mode and getGuardMode reads it back', () => {
    setGuardMode(projectDir, 'coach');
    expect(getGuardMode(projectDir)).toBe('coach');
    setGuardMode(projectDir, 'off');
    expect(getGuardMode(projectDir)).toBe('off');
  });

  it('setGuardMode creates the .trace-mcp directory', () => {
    setGuardMode(projectDir, 'strict');
    expect(fs.existsSync(path.join(projectDir, '.trace-mcp', 'guard-mode'))).toBe(true);
  });

  // ─── Status: down (no sentinels) ────────────────────────────────

  it('getGuardStatus returns health=down when no sentinels exist', () => {
    const s = getGuardStatus(projectDir);
    expect(s.health).toBe('down');
    expect(s.mode).toBe('strict');
  });

  // ─── Status: ok with rich JSON ──────────────────────────────────

  it('getGuardStatus returns health=ok with fresh status JSON', () => {
    const real = fs.realpathSync(projectDir);
    const file = path.join(TMP_BASE, `trace-mcp-status-${projectHash(real)}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        schema: 1,
        pid: 12345,
        started_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        last_successful_tool_call_at: new Date().toISOString(),
        last_failed_tool_call_at: null,
        tool_calls_total: 5,
        tool_calls_failed: 0,
        mcp_sessions_active: 1,
      }),
    );
    const s = getGuardStatus(projectDir);
    expect(s.health).toBe('ok');
    expect(s.pid).toBe(12345);
    expect(s.toolCallsTotal).toBe(5);
  });

  it('getGuardStatus returns health=stalled when last_successful is old', () => {
    const real = fs.realpathSync(projectDir);
    const file = path.join(TMP_BASE, `trace-mcp-status-${projectHash(real)}.json`);
    const sixMinAgo = new Date(Date.now() - 360_000).toISOString();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schema: 1,
        pid: 12345,
        started_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        last_successful_tool_call_at: sixMinAgo,
        last_failed_tool_call_at: null,
        tool_calls_total: 5,
        tool_calls_failed: 0,
        mcp_sessions_active: 1,
      }),
    );
    const s = getGuardStatus(projectDir);
    expect(s.health).toBe('stalled');
    expect(s.reason).toContain('quiet');
  });

  it('getGuardStatus returns health=down when heartbeat is stale', () => {
    const real = fs.realpathSync(projectDir);
    const file = path.join(TMP_BASE, `trace-mcp-status-${projectHash(real)}.json`);
    const oldTime = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      file,
      JSON.stringify({
        schema: 1,
        pid: 12345,
        started_at: oldTime,
        last_heartbeat_at: oldTime,
        last_successful_tool_call_at: oldTime,
        last_failed_tool_call_at: null,
        tool_calls_total: 5,
        tool_calls_failed: 0,
        mcp_sessions_active: 1,
      }),
    );
    const s = getGuardStatus(projectDir);
    expect(s.health).toBe('down');
  });

  // ─── Status: legacy heartbeat fallback ──────────────────────────

  it('getGuardStatus falls back to legacy heartbeat when no JSON', () => {
    const real = fs.realpathSync(projectDir);
    const legacy = path.join(TMP_BASE, `trace-mcp-alive-${projectHash(real)}`);
    fs.writeFileSync(legacy, String(Date.now()));
    const s = getGuardStatus(projectDir);
    expect(s.health).toBe('ok');
    expect(s.reason).toContain('Legacy heartbeat');
  });

  // ─── Onboarding: initializeGuard + auto-promote ─────────────────

  it('initializeGuard sets coach + install-date for new project', () => {
    const result = initializeGuard(projectDir);
    expect(result.initialized).toBe(true);
    expect(result.mode).toBe('coach');
    expect(getGuardMode(projectDir)).toBe('coach');
    expect(fs.existsSync(path.join(projectDir, '.trace-mcp', 'install-date'))).toBe(true);
  });

  it('initializeGuard is idempotent for already-initialized projects', () => {
    initializeGuard(projectDir);
    setGuardMode(projectDir, 'strict');
    const second = initializeGuard(projectDir);
    expect(second.initialized).toBe(false);
    expect(second.mode).toBe('strict');
  });

  it('getGuardStatus exposes coachExpiresAt for fresh coach project', () => {
    initializeGuard(projectDir);
    const s = getGuardStatus(projectDir);
    expect(s.mode).toBe('coach');
    expect(typeof s.coachExpiresAt).toBe('number');
    // 7 days into the future, give or take a few seconds.
    const expectedFuture = Math.floor(Date.now() / 1000) + 7 * 86_400;
    expect(s.coachExpiresAt!).toBeGreaterThan(expectedFuture - 60);
    expect(s.coachExpiresAt!).toBeLessThan(expectedFuture + 60);
  });

  it('getGuardStatus auto-promotes coach → strict after 7 days', () => {
    initializeGuard(projectDir);
    // Backdate the install-date file to 8 days ago.
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 86_400;
    fs.writeFileSync(path.join(projectDir, '.trace-mcp', 'install-date'), `${eightDaysAgo}\n`);
    const s = getGuardStatus(projectDir);
    expect(s.mode).toBe('strict');
    expect(s.autoPromoted).toBe(true);
    // install-date should be cleared after promotion.
    expect(fs.existsSync(path.join(projectDir, '.trace-mcp', 'install-date'))).toBe(false);
    // Subsequent reads should NOT re-trigger autoPromoted.
    const s2 = getGuardStatus(projectDir);
    expect(s2.mode).toBe('strict');
    expect(s2.autoPromoted).toBeUndefined();
  });

  it('explicit setGuardMode("coach") after auto-promote does not re-arm timer', () => {
    initializeGuard(projectDir);
    fs.writeFileSync(
      path.join(projectDir, '.trace-mcp', 'install-date'),
      `${Math.floor(Date.now() / 1000) - 8 * 86_400}\n`,
    );
    getGuardStatus(projectDir); // auto-promote triggers, install-date cleared
    setGuardMode(projectDir, 'coach');
    const s = getGuardStatus(projectDir);
    expect(s.mode).toBe('coach');
    // No install-date → no coachExpiresAt → won't auto-promote ever.
    expect(s.coachExpiresAt).toBeUndefined();
  });

  // ─── Hook install / uninstall ───────────────────────────────────

  it('installHook adds a PreToolUse block to ~/.claude/settings.json', () => {
    const fakeHome = path.join(TMP_BASE, `home-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(fakeHome, { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // Provide a fake source script.
      const sourceScript = path.join(fakeHome, 'source-guard.sh');
      fs.writeFileSync(sourceScript, '#!/bin/bash\nexit 0');
      // Pre-existing settings.
      const settingsPath = path.join(fakeHome, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['x'] } }));

      const result = installHook({ sourceScript });
      expect(result.ok).toBe(true);
      expect(result.alreadyInstalled).toBe(false);
      expect(result.backupPath).toBe(`${settingsPath}.bak`);
      // Backup created.
      expect(fs.existsSync(`${settingsPath}.bak`)).toBe(true);
      // Hook entry present.
      const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(updated.hooks.PreToolUse).toHaveLength(1);
      expect(updated.hooks.PreToolUse[0].matcher).toContain('Read');
      expect(updated.hooks.PreToolUse[0].hooks[0].command).toContain('trace-mcp-guard.sh');
      // Existing permissions preserved.
      expect(updated.permissions.allow).toEqual(['x']);
    } finally {
      if (prevHome) process.env.HOME = prevHome;
      else delete process.env.HOME;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('installHook is idempotent', () => {
    const fakeHome = path.join(TMP_BASE, `home-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(fakeHome, { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const sourceScript = path.join(fakeHome, 'source-guard.sh');
      fs.writeFileSync(sourceScript, '#!/bin/bash\nexit 0');
      installHook({ sourceScript });
      const second = installHook({ sourceScript });
      expect(second.ok).toBe(true);
      expect(second.alreadyInstalled).toBe(true);
    } finally {
      if (prevHome) process.env.HOME = prevHome;
      else delete process.env.HOME;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('uninstallHook removes the trace-mcp PreToolUse entry without touching others', () => {
    const fakeHome = path.join(TMP_BASE, `home-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(fakeHome, { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const settingsPath = path.join(fakeHome, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: 'Read', hooks: [{ type: 'command', command: '/some/other-hook.sh' }] },
              {
                matcher: 'Read|Grep|Glob|Bash|Agent',
                hooks: [{ type: 'command', command: '/Users/x/.claude/hooks/trace-mcp-guard.sh' }],
              },
            ],
          },
        }),
      );
      const result = uninstallHook();
      expect(result.ok).toBe(true);
      expect(result.removed).toBe(true);
      const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(updated.hooks.PreToolUse).toHaveLength(1);
      expect(updated.hooks.PreToolUse[0].hooks[0].command).toBe('/some/other-hook.sh');
    } finally {
      if (prevHome) process.env.HOME = prevHome;
      else delete process.env.HOME;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('checkInstallStatus reports installed=false when settings.json is absent', () => {
    const fakeHome = path.join(TMP_BASE, `home-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(fakeHome, { recursive: true });
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const status = checkInstallStatus();
      expect(status.claudeDetected).toBe(false);
      expect(status.installed).toBe(false);
    } finally {
      if (prevHome) process.env.HOME = prevHome;
      else delete process.env.HOME;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('exports a sane MIN_TRACE_MCP_VERSION', () => {
    expect(MIN_TRACE_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // ─── Hook source script resolution (cross-platform) ─────────────

  it('resolveHookSourceScript honors TRACE_MCP_HOOK_SCRIPT env override', () => {
    const fakeScript = path.join(projectDir, 'fake-guard.sh');
    fs.writeFileSync(fakeScript, '#!/bin/bash\nexit 0');
    const prev = process.env.TRACE_MCP_HOOK_SCRIPT;
    process.env.TRACE_MCP_HOOK_SCRIPT = fakeScript;
    try {
      expect(resolveHookSourceScript()).toBe(fakeScript);
    } finally {
      if (prev) process.env.TRACE_MCP_HOOK_SCRIPT = prev;
      else delete process.env.TRACE_MCP_HOOK_SCRIPT;
    }
  });

  it('resolveHookSourceScript ignores TRACE_MCP_HOOK_SCRIPT pointing to a missing file', () => {
    const prev = process.env.TRACE_MCP_HOOK_SCRIPT;
    process.env.TRACE_MCP_HOOK_SCRIPT = path.join(projectDir, 'does-not-exist.sh');
    try {
      // Should not return the bogus path; falls through to PATH probing.
      const result = resolveHookSourceScript();
      expect(result).not.toBe(process.env.TRACE_MCP_HOOK_SCRIPT);
    } finally {
      if (prev) process.env.TRACE_MCP_HOOK_SCRIPT = prev;
      else delete process.env.TRACE_MCP_HOOK_SCRIPT;
    }
  });

  it('resolveHookSourceScript finds the script when CLI is installed via npm-global prefix probe', () => {
    // Build a fake npm-global layout: $PREFIX/lib/node_modules/trace-mcp/hooks/trace-mcp-guard.sh
    const fakePrefix = path.join(projectDir, 'fake-npm-prefix');
    const pkgRoot = path.join(fakePrefix, 'lib', 'node_modules', 'trace-mcp');
    const hooksDir = path.join(pkgRoot, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'trace-mcp-guard.sh'), '#!/bin/bash\nexit 0');
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), '{"name":"trace-mcp"}');

    const prevPrefix = process.env.npm_config_prefix;
    const prevHookOverride = process.env.TRACE_MCP_HOOK_SCRIPT;
    // Disable the env override + the PATH probe by clearing PATH temporarily:
    // we want to verify the prefix probe step in isolation.
    const prevPath = process.env.PATH;
    process.env.npm_config_prefix = fakePrefix;
    process.env.PATH = '';
    delete process.env.TRACE_MCP_HOOK_SCRIPT;
    try {
      const result = resolveHookSourceScript();
      expect(result).toBe(path.join(hooksDir, 'trace-mcp-guard.sh'));
    } finally {
      if (prevPrefix) process.env.npm_config_prefix = prevPrefix;
      else delete process.env.npm_config_prefix;
      if (prevHookOverride) process.env.TRACE_MCP_HOOK_SCRIPT = prevHookOverride;
      if (prevPath !== undefined) process.env.PATH = prevPath;
    }
  });

  // ─── Bypass ─────────────────────────────────────────────────────

  it('setBypass(N) creates a future-mtime sentinel; getGuardStatus reports bypassUntil', () => {
    setBypass(projectDir, 10);
    const s = getGuardStatus(projectDir);
    expect(s.bypassUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('setBypass(0) removes the sentinel', () => {
    setBypass(projectDir, 10);
    setBypass(projectDir, 0);
    const s = getGuardStatus(projectDir);
    expect(s.bypassUntil ?? 0).toBe(0);
  });
});
