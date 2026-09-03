import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ─── Guard v2 navigation gate, Windows port (TRA-757) ────────────────
//
// TRA-711 shipped the crawl detector, but only its POSIX half worked. The
// Windows guard counted navigation calls with nothing ever resetting the
// counter — no `.nav-force` bypass, no rolling window — and the Windows
// UserPromptSubmit hook wrote neither signal. From the third navigation call
// on, the guard intervened on every navigation call for the rest of the
// session: the inverse of the gate's purpose, and exactly the light-question
// regression TRA-705 priced at 1.45x.
//
// These mirror the POSIX tests in guard.test.ts / lifecycle-hooks.test.ts.
// They are the only coverage the .cmd hooks have, so every assertion runs
// against the real hook output string rather than a boolean — a failure on a
// Windows runner has to explain itself without a local repro.
//
// Windows CI runs on the `cross-platform` label, workflow_dispatch and the
// schedule (see .github/workflows/ci.yml).

const GUARD_CMD = path.resolve('hooks/trace-mcp-guard.cmd');
const PROMPT_CMD = path.resolve('hooks/trace-mcp-user-prompt-submit.cmd');
const TMP_BASE = fs.realpathSync(os.tmpdir());
const DENY = '"permissionDecision": "deny"';

describe.skipIf(process.platform !== 'win32')('guard v2 navigation gate on Windows', () => {
  let projectDir: string;
  let sessionId: string;

  const readsDir = () => path.join(TMP_BASE, `trace-mcp-reads-${sessionId}`);

  /** Hook stdout, with exit status and stderr appended when either is unclean. */
  function run(script: string, payload: unknown, env: Record<string, string> = {}): string {
    const r = spawnSync('cmd.exe', ['/d', '/c', script], {
      input: JSON.stringify(payload),
      env: { ...process.env, TEMP: TMP_BASE, TMP: TMP_BASE, ...env },
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 60_000,
    });
    const stdout = r.stdout ?? '';
    const stderr = (r.stderr ?? '').trim();
    if (r.status === 0 && stderr.length === 0) return stdout;
    return `${stdout}\n[exit ${r.status}] ${stderr}`;
  }

  /** One navigation call through the guard, as the guard's own output. */
  function nav(pattern: string, env: Record<string, string> = {}): string {
    return run(
      GUARD_CMD,
      { tool_name: 'Grep', session_id: sessionId, tool_input: { pattern } },
      { CLAUDE_TOOL_NAME: 'Grep', TRACE_MCP_ENFORCE: 'strict', ...env },
    ).trim();
  }

  /** One user prompt through the UserPromptSubmit hook. */
  function prompt(text: string): string {
    return run(PROMPT_CMD, { prompt: text, session_id: sessionId }).trim();
  }

  /** Session state the two hooks share, as a directory listing. */
  function navState(): string[] {
    try {
      return fs.readdirSync(readsDir());
    } catch {
      // Name the directories that DO exist: a mismatch here is a %TEMP%
      // disagreement between the test and the hook, not a gate bug.
      return fs.readdirSync(TMP_BASE).filter((n) => n.startsWith('trace-mcp-reads-'));
    }
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

  it('records the navigation streak under the session reads dir', () => {
    nav('one');
    expect(navState()).toContain('.nav-streak');
  });

  it('stays silent on the first two navigation calls, intervenes on the third', () => {
    expect(nav('one')).toBe('');
    expect(nav('two')).toBe('');
    expect(nav('three')).toContain(DENY);
  });

  it('routes from the FIRST call when a relationship question is flagged', () => {
    fs.mkdirSync(readsDir(), { recursive: true });
    fs.writeFileSync(path.join(readsDir(), '.nav-force'), '');
    expect(nav('handleRequest')).toContain(DENY);
  });

  it('resets the streak after a quiet window', () => {
    expect(nav('one')).toBe('');
    expect(nav('two')).toBe('');
    const stale = Math.floor(Date.now() / 1000) - 600;
    fs.writeFileSync(path.join(readsDir(), '.nav-streak'), `2 ${stale}\r\n`);
    expect(nav('three', { TRACE_MCP_GUARD_NAV_WINDOW: '300' })).toBe('');
  });

  it('a new user prompt clears the streak, so a light question is left alone', () => {
    expect(nav('one')).toBe('');
    expect(nav('two')).toBe('');
    prompt('rename the config loader');
    expect(navState()).not.toContain('.nav-streak');
    expect(nav('three')).toBe('');
  });

  it('a relationship question makes the next navigation call route immediately', () => {
    prompt('who calls handleRequest?');
    expect(navState()).toContain('.nav-force');
    expect(nav('handleRequest')).toContain(DENY);
  });

  it('matches the Russian relationship shapes too', () => {
    // The .cmd carries these as \uXXXX escapes and decodes stdin as UTF-8, so a
    // non-ASCII prompt has to survive both hops to reach the regex.
    prompt('кто вызывает handleRequest?');
    expect(navState()).toContain('.nav-force');
    expect(nav('handleRequest')).toContain(DENY);
  });

  it('a plain question clears the relationship flag', () => {
    prompt('who calls handleRequest?');
    prompt('rename the config loader');
    expect(navState()).not.toContain('.nav-force');
  });
});
