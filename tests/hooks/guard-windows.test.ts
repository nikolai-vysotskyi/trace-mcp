import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ─── Guard v2 navigation gate, Windows port (TRA-757) ────────────────
//
// TRA-711 shipped the gate on POSIX only in practice: the Windows guard counted
// navigation calls but nothing ever reset the counter, and the Windows
// UserPromptSubmit hook wrote neither the streak reset nor the
// relationship-question flag. The effect was the opposite of the intent — after
// three navigation calls the guard intervened on every navigation call for the
// rest of the session, which is exactly the light-question regression TRA-705
// measured at 1.45x. These tests pin the ported behaviour; they mirror the POSIX
// ones in guard.test.ts / lifecycle-hooks.test.ts.
//
// Windows CI runs on the `cross-platform` label, workflow_dispatch and the
// schedule (see .github/workflows/ci.yml).

const GUARD_CMD = path.resolve('hooks/trace-mcp-guard.cmd');
const PROMPT_CMD = path.resolve('hooks/trace-mcp-user-prompt-submit.cmd');
const TMP_BASE = fs.realpathSync(os.tmpdir());

describe.skipIf(process.platform !== 'win32')('guard v2 navigation gate on Windows', () => {
  let projectDir: string;
  let sessionId: string;

  const readsDir = () => path.join(TMP_BASE, `trace-mcp-reads-${sessionId}`);

  function run(script: string, payload: unknown, env: Record<string, string> = {}): string {
    const result = spawnSync('cmd.exe', ['/d', '/c', script], {
      input: JSON.stringify(payload),
      env: { ...process.env, TEMP: TMP_BASE, TMP: TMP_BASE, ...env },
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return (result.stdout ?? '').trim();
  }

  /** One navigation call through the guard. Returns true when it was denied. */
  function nav(pattern: string, env: Record<string, string> = {}): boolean {
    const out = run(
      GUARD_CMD,
      { tool_name: 'Grep', session_id: sessionId, tool_input: { pattern } },
      { CLAUDE_TOOL_NAME: 'Grep', TRACE_MCP_ENFORCE: 'strict', ...env },
    );
    return out.includes('"permissionDecision": "deny"');
  }

  /** One user prompt through the UserPromptSubmit hook. */
  function prompt(text: string): void {
    run(PROMPT_CMD, { prompt: text, session_id: sessionId });
  }

  beforeEach(() => {
    sessionId = `vitest-navwin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    projectDir = path.join(TMP_BASE, `trace-mcp-navwin-${sessionId}`);
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    for (const p of [readsDir(), projectDir, path.join(TMP_BASE, `trace-mcp-guard-${sessionId}`)]) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  });

  it('stays silent on the first two navigation calls, intervenes on the third', () => {
    expect(nav('one')).toBe(false);
    expect(nav('two')).toBe(false);
    expect(nav('three')).toBe(true);
  });

  it('routes from the FIRST call when a relationship question is flagged', () => {
    fs.mkdirSync(readsDir(), { recursive: true });
    fs.writeFileSync(path.join(readsDir(), '.nav-force'), '');
    expect(nav('handleRequest')).toBe(true);
  });

  it('resets the streak after a quiet window', () => {
    expect(nav('one')).toBe(false);
    expect(nav('two')).toBe(false);
    const stale = Math.floor(Date.now() / 1000) - 600;
    fs.writeFileSync(path.join(readsDir(), '.nav-streak'), `2 ${stale}\r\n`);
    expect(nav('three', { TRACE_MCP_GUARD_NAV_WINDOW: '300' })).toBe(false);
  });

  it('a new user prompt clears the streak, so a light question is left alone', () => {
    expect(nav('one')).toBe(false);
    expect(nav('two')).toBe(false);
    prompt('rename the config loader');
    expect(nav('three')).toBe(false);
  });

  it('a relationship question makes the next navigation call route immediately', () => {
    prompt('who calls handleRequest?');
    expect(fs.existsSync(path.join(readsDir(), '.nav-force'))).toBe(true);
    expect(nav('handleRequest')).toBe(true);
  });

  it('matches the Russian relationship shapes too', () => {
    // The .cmd carries these as \uXXXX escapes and decodes stdin as UTF-8, so a
    // non-ASCII prompt has to survive both hops to reach the regex.
    prompt('кто вызывает handleRequest?');
    expect(fs.existsSync(path.join(readsDir(), '.nav-force'))).toBe(true);
    expect(nav('handleRequest')).toBe(true);
  });

  it('a plain question clears the relationship flag', () => {
    prompt('who calls handleRequest?');
    prompt('rename the config loader');
    expect(fs.existsSync(path.join(readsDir(), '.nav-force'))).toBe(false);
  });
});
