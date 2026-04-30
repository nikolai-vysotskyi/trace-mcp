import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOK_SCRIPT = path.resolve('hooks/trace-mcp-guard.sh');
const TMP_BASE = fs.realpathSync(os.tmpdir());

interface HookDecision {
  allowed: boolean;
  reason?: string;
  context?: string;
}

function projectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(projectRoot).digest('hex').slice(0, 12);
}

function fileHash(p: string): string {
  return crypto.createHash('sha256').update(p).digest('hex');
}

/** Spawn the guard hook with the given tool input and return the decision. */
function runGuard(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
): HookDecision {
  const payload = JSON.stringify({
    tool_name: toolName,
    session_id: sessionId,
    tool_input: toolInput,
  });

  const result = spawnSync('bash', [HOOK_SCRIPT], {
    input: payload,
    env: { ...process.env, CLAUDE_TOOL_NAME: toolName, ...extraEnv },
    cwd,
    encoding: 'utf-8',
    timeout: 5000,
  });

  if (result.status !== 0) {
    throw new Error(`guard hook exited ${result.status}: ${result.stderr}`);
  }

  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    return { allowed: true };
  }

  const parsed = JSON.parse(stdout);
  const hookOut = parsed.hookSpecificOutput ?? {};
  return {
    allowed: hookOut.permissionDecision !== 'deny',
    reason: hookOut.permissionDecisionReason,
    context: hookOut.additionalContext,
  };
}

/** Simulate a live trace-mcp server: write a fresh heartbeat sentinel for `cwd`. */
function setHeartbeatAlive(cwd: string): string {
  const real = fs.realpathSync(cwd);
  const file = path.join(TMP_BASE, `trace-mcp-alive-${projectHash(real)}`);
  fs.writeFileSync(file, String(Date.now()));
  return file;
}

/** Simulate a stale server: write the sentinel with mtime far in the past. */
function setHeartbeatStale(cwd: string): string {
  const file = setHeartbeatAlive(cwd);
  const past = new Date(Date.now() - 120_000);
  fs.utimesSync(file, past, past);
  return file;
}

/** Simulate trace-mcp marking a file as consulted (e.g. via get_outline). */
function writeConsultationMarker(cwd: string, relPath: string): void {
  const real = fs.realpathSync(cwd);
  const dir = path.join(TMP_BASE, `trace-mcp-consulted-${projectHash(real)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileHash(relPath)), '');
}

/** Path of the bypass sentinel for `cwd`. */
function bypassFile(cwd: string): string {
  const real = fs.realpathSync(cwd);
  return path.join(TMP_BASE, `trace-mcp-bypass-${projectHash(real)}`);
}

/** Write the manual bypass sentinel with mtime N seconds in the future. */
function setManualBypass(cwd: string, secondsAhead: number): string {
  const file = bypassFile(cwd);
  fs.writeFileSync(file, 'manual');
  const future = new Date(Date.now() + secondsAhead * 1000);
  fs.utimesSync(file, future, future);
  return file;
}

/** Write a status sentinel JSON simulating server state. */
function writeStatus(
  cwd: string,
  status: {
    tool_calls_total: number;
    last_successful_tool_call_at: string | null;
  },
): string {
  const real = fs.realpathSync(cwd);
  const file = path.join(TMP_BASE, `trace-mcp-status-${projectHash(real)}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema: 1,
      pid: 12345,
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      ...status,
      last_failed_tool_call_at: null,
      tool_calls_failed: 0,
      mcp_sessions_active: 1,
    }),
  );
  return file;
}

describe('trace-mcp-guard.sh v0.7', () => {
  const projectDir = path.join(
    TMP_BASE,
    `trace-mcp-guard-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let sessionId: string;
  let heartbeatFile: string;

  beforeEach(() => {
    fs.mkdirSync(projectDir, { recursive: true });
    sessionId = `vitest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    // By default each test runs as if trace-mcp is alive — strict mode.
    heartbeatFile = setHeartbeatAlive(projectDir);
  });

  afterEach(() => {
    const readsDir = path.join(TMP_BASE, `trace-mcp-reads-${sessionId}`);
    if (fs.existsSync(readsDir)) fs.rmSync(readsDir, { recursive: true, force: true });
    if (fs.existsSync(projectDir)) {
      const real = fs.realpathSync(projectDir);
      const consultedDir = path.join(TMP_BASE, `trace-mcp-consulted-${projectHash(real)}`);
      if (fs.existsSync(consultedDir)) fs.rmSync(consultedDir, { recursive: true, force: true });
      const bp = path.join(TMP_BASE, `trace-mcp-bypass-${projectHash(real)}`);
      if (fs.existsSync(bp)) fs.rmSync(bp, { force: true });
      const statusFile = path.join(TMP_BASE, `trace-mcp-status-${projectHash(real)}.json`);
      if (fs.existsSync(statusFile)) fs.rmSync(statusFile, { force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    if (fs.existsSync(heartbeatFile)) fs.rmSync(heartbeatFile, { force: true });
  });

  // ─── Read: basic routing ────────────────────────────────────────

  it('allows Read on non-code files', () => {
    const file = path.join(projectDir, 'README.md');
    fs.writeFileSync(file, '# readme');
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
  });

  it('allows Read on files in vendored dirs', () => {
    const vendored = path.join(projectDir, 'node_modules', 'pkg');
    fs.mkdirSync(vendored, { recursive: true });
    const file = path.join(vendored, 'index.ts');
    fs.writeFileSync(file, 'export {};');
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
  });

  it('denies first Read on code files with "call get_outline first"', () => {
    const file = path.join(projectDir, 'foo.ts');
    fs.writeFileSync(file, 'export const x = 1;');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('get_outline');
    // Critical: the deny message must NOT promise that retry will work.
    expect(decision.reason).not.toContain('retry');
    expect(decision.context ?? '').not.toContain('retry');
  });

  it('denies Read on .env files even with non-standard suffix', () => {
    const file = path.join(projectDir, '.env.local');
    fs.writeFileSync(file, 'SECRET=xxx');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('get_env_vars');
  });

  it('allows Read on .env.example (template files)', () => {
    const file = path.join(projectDir, '.env.example');
    fs.writeFileSync(file, 'SECRET=placeholder');
    // .env.example doesn't match code/non-code regex; falls into the basename
    // branch and is allowed because it's not a code extension.
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(decision.allowed).toBe(true);
  });

  // ─── Read: retry-bypass loophole closure ────────────────────────

  it('denies a SECOND Read of the same code file when no consultation marker was written', () => {
    const file = path.join(projectDir, 'bar.ts');
    fs.writeFileSync(file, 'export const x = 1;');
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(false);
    // Critical: the v0.6 retry-bypass is gone. Without consultation, retry stays denied.
    const second = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain('BLOCKED');
    expect(second.reason).toContain('attempt #2');
  });

  it('escalates the deny message on repeat attempts without consultation', () => {
    const file = path.join(projectDir, 'esc.ts');
    fs.writeFileSync(file, 'export {};');
    const a = runGuard('Read', { file_path: file }, sessionId, projectDir);
    const b = runGuard('Read', { file_path: file }, sessionId, projectDir);
    const c = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(a.reason).not.toContain('BLOCKED');
    expect(b.reason).toContain('BLOCKED');
    expect(c.reason).toContain('attempt #3');
  });

  it('allows Read after a consultation marker is written (simulating get_outline)', () => {
    const file = path.join(projectDir, 'baz.ts');
    fs.writeFileSync(file, 'export {};');
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(false);
    // Agent calls get_outline; server writes the marker.
    writeConsultationMarker(projectDir, 'baz.ts');
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
  });

  it('clears deny escalation once consultation marker appears', () => {
    const file = path.join(projectDir, 'reset.ts');
    fs.writeFileSync(file, 'export {};');
    runGuard('Read', { file_path: file }, sessionId, projectDir);
    runGuard('Read', { file_path: file }, sessionId, projectDir); // BLOCKED #2
    writeConsultationMarker(projectDir, 'reset.ts');
    const after = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(after.allowed).toBe(true);
  });

  // ─── Read: heartbeat fallback ───────────────────────────────────

  it('allows Read with warning when heartbeat sentinel is missing', () => {
    fs.rmSync(heartbeatFile, { force: true });
    const file = path.join(projectDir, 'fallback.ts');
    fs.writeFileSync(file, 'export {};');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(decision.allowed).toBe(true);
    expect(decision.context).toContain('not running');
  });

  it('allows Read with warning when heartbeat is stale', () => {
    setHeartbeatStale(projectDir);
    const file = path.join(projectDir, 'fallback2.ts');
    fs.writeFileSync(file, 'export {};');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(decision.allowed).toBe(true);
    expect(decision.context).toContain('stale');
  });

  it('still blocks .env even when heartbeat is dead', () => {
    fs.rmSync(heartbeatFile, { force: true });
    const file = path.join(projectDir, '.env.local');
    fs.writeFileSync(file, 'SECRET=x');
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(false);
  });

  // ─── Read: repeat-read limit (after consultation) ───────────────

  it('denies excessive re-reads of an unchanged consulted file', () => {
    const file = path.join(projectDir, 'busy.ts');
    fs.writeFileSync(file, 'export {};');
    writeConsultationMarker(projectDir, 'busy.ts');
    // Reads 1..3 allowed, 4th denied (REPEAT_READ_LIMIT default = 3).
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
    const fourth = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toContain('Already read');
  });

  it('resets read counter when file mtime changes (post-Edit)', () => {
    const file = path.join(projectDir, 'edited.ts');
    fs.writeFileSync(file, 'export {};');
    writeConsultationMarker(projectDir, 'edited.ts');
    runGuard('Read', { file_path: file }, sessionId, projectDir);
    runGuard('Read', { file_path: file }, sessionId, projectDir);
    runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(false);
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(file, future, future);
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
  });

  // ─── Modes (strict / coach / off) ───────────────────────────────

  it('off mode: hook is a no-op', () => {
    const file = path.join(projectDir, 'off-mode.ts');
    fs.writeFileSync(file, 'export {};');
    expect(
      runGuard('Read', { file_path: file }, sessionId, projectDir, {
        TRACE_MCP_GUARD_MODE: 'off',
      }).allowed,
    ).toBe(true);
  });

  it('per-project mode file overrides env (strict file beats coach env)', () => {
    const file = path.join(projectDir, 'pp.ts');
    fs.writeFileSync(file, 'export {};');
    const modeDir = path.join(projectDir, '.trace-mcp');
    fs.mkdirSync(modeDir, { recursive: true });
    fs.writeFileSync(path.join(modeDir, 'guard-mode'), 'strict\n');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir, {
      TRACE_MCP_GUARD_MODE: 'coach',
    });
    expect(decision.allowed).toBe(false);
  });

  it('per-project mode file: off disables guard for that project', () => {
    const file = path.join(projectDir, 'ppoff.ts');
    fs.writeFileSync(file, 'export {};');
    const modeDir = path.join(projectDir, '.trace-mcp');
    fs.mkdirSync(modeDir, { recursive: true });
    fs.writeFileSync(path.join(modeDir, 'guard-mode'), 'off');
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
  });

  it('coach mode: never blocks, always emits hint context', () => {
    const file = path.join(projectDir, 'coach.ts');
    fs.writeFileSync(file, 'export {};');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir, {
      TRACE_MCP_GUARD_MODE: 'coach',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.context ?? '').toContain('coach');
    expect(decision.context ?? '').toContain('get_outline');
  });

  it('coach mode: blocks .env still (security override)', () => {
    const file = path.join(projectDir, '.env.local');
    fs.writeFileSync(file, 'SECRET=x');
    // Coach mode converts the .env deny into a hint, but still surfaces the
    // alternative — agent shouldn't simply Read .env contents. Check the
    // context contains the env-vars hint regardless of mode.
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir, {
      TRACE_MCP_GUARD_MODE: 'coach',
    });
    expect(decision.context ?? '').toContain('get_env_vars');
  });

  it('coach mode: Bash code-search becomes a hint', () => {
    const decision = runGuard('Bash', { command: 'grep -r foo src/*.ts' }, sessionId, projectDir, {
      TRACE_MCP_GUARD_MODE: 'coach',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.context ?? '').toContain('coach');
  });

  // ─── Stall detection via status JSON ────────────────────────────

  it('stall detection: triggers when last successful call is older than threshold', () => {
    // Simulate: server worked at some point (total > 0), but the last call
    // was 6 minutes ago. Threshold default is 5 min.
    const sixMinAgo = new Date(Date.now() - 360_000).toISOString();
    writeStatus(projectDir, {
      tool_calls_total: 12,
      last_successful_tool_call_at: sixMinAgo,
    });
    const file = path.join(projectDir, 'stall.ts');
    fs.writeFileSync(file, 'export {};');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(decision.allowed).toBe(true);
    expect(decision.context ?? '').toContain('stalled');
  });

  it('stall detection: does NOT trigger when calls are recent', () => {
    const now = new Date().toISOString();
    writeStatus(projectDir, {
      tool_calls_total: 3,
      last_successful_tool_call_at: now,
    });
    const file = path.join(projectDir, 'fresh.ts');
    fs.writeFileSync(file, 'export {};');
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(false);
  });

  it('stall detection: does NOT trigger before any successful call (server just started)', () => {
    writeStatus(projectDir, {
      tool_calls_total: 0,
      last_successful_tool_call_at: null,
    });
    const file = path.join(projectDir, 'cold.ts');
    fs.writeFileSync(file, 'export {};');
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(false);
  });

  // ─── Manual override ────────────────────────────────────────────

  it('TRACE_MCP_GUARD_OFF=1 fully bypasses the guard', () => {
    const file = path.join(projectDir, 'off.ts');
    fs.writeFileSync(file, 'export {};');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir, {
      TRACE_MCP_GUARD_OFF: '1',
    });
    expect(decision.allowed).toBe(true);
  });

  // ─── Manual TTL bypass (scripts/trace-mcp-disable-guard.sh) ─────

  it('manual bypass sentinel allows Read with warning', () => {
    setManualBypass(projectDir, 600); // 10 min into future
    const file = path.join(projectDir, 'bypass.ts');
    fs.writeFileSync(file, 'export {};');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(decision.allowed).toBe(true);
    expect(decision.context).toContain('manually bypassed');
  });

  it('expired manual bypass sentinel does NOT bypass', () => {
    // mtime in the past = expired; hook ignores and stays strict.
    const file = path.join(projectDir, 'expired.ts');
    fs.writeFileSync(file, 'export {};');
    const bp = bypassFile(projectDir);
    fs.writeFileSync(bp, 'manual');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(bp, past, past);
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(decision.allowed).toBe(false);
  });

  // ─── Auto-degradation when MCP channel appears dead ─────────────

  it('auto-degrades after threshold denies with zero consultation markers', () => {
    // Heartbeat is alive (set in beforeEach), but no consultation markers
    // ever appear. Simulates "process up, MCP channel dead".
    // First 4 attempts get denied. 5th attempt trips auto-degrade and is
    // allowed with "auto-degraded" in the context. After that the bypass
    // sentinel takes over for subsequent attempts.
    const decisions = [];
    for (let i = 1; i <= 6; i++) {
      const f = path.join(projectDir, `auto-${i}.ts`);
      fs.writeFileSync(f, 'export {};');
      decisions.push(
        runGuard('Read', { file_path: f }, sessionId, projectDir, {
          TRACE_MCP_GUARD_AUTO_DENY: '5',
        }),
      );
    }
    // Pre-trip denies
    expect(decisions[0].allowed).toBe(false);
    expect(decisions[3].allowed).toBe(false);
    // The trip itself: 5th attempt flips to allowed with auto-degraded reason.
    expect(decisions[4].allowed).toBe(true);
    expect(decisions[4].context ?? '').toContain('auto-degraded');
    // Subsequent attempts continue to be allowed (now via the bypass sentinel).
    expect(decisions[5].allowed).toBe(true);
  });

  it('does NOT auto-degrade when consultation markers exist (channel works)', () => {
    // The agent successfully consulted some other file → MCP is alive.
    // Even if the agent then hammers Read on a different un-consulted file,
    // auto-degrade should not kick in.
    writeConsultationMarker(projectDir, 'something.ts');
    const file = path.join(projectDir, 'noauto.ts');
    fs.writeFileSync(file, 'export {};');
    for (let i = 0; i < 7; i++) {
      const d = runGuard('Read', { file_path: file }, sessionId, projectDir, {
        TRACE_MCP_GUARD_AUTO_DENY: '5',
      });
      expect(d.allowed).toBe(false);
    }
  });

  // ─── Grep / Glob ────────────────────────────────────────────────

  it('denies Grep on code with no filters', () => {
    const decision = runGuard('Grep', { pattern: 'foo' }, sessionId, projectDir);
    expect(decision.allowed).toBe(false);
    expect(decision.context).toContain('search');
  });

  it('allows Grep with type=md filter', () => {
    expect(runGuard('Grep', { pattern: 'foo', type: 'md' }, sessionId, projectDir).allowed).toBe(
      true,
    );
  });

  it('allows Grep when heartbeat is dead (fallback)', () => {
    fs.rmSync(heartbeatFile, { force: true });
    expect(runGuard('Grep', { pattern: 'foo' }, sessionId, projectDir).allowed).toBe(true);
  });

  it('denies Glob for code patterns', () => {
    expect(runGuard('Glob', { pattern: '**/*.ts' }, sessionId, projectDir).allowed).toBe(false);
  });

  it('allows Glob for .md patterns', () => {
    expect(runGuard('Glob', { pattern: '**/*.md' }, sessionId, projectDir).allowed).toBe(true);
  });

  // ─── Bash ───────────────────────────────────────────────────────

  it('allows safe Bash commands (git, npm)', () => {
    expect(runGuard('Bash', { command: 'git status' }, sessionId, projectDir).allowed).toBe(true);
    expect(runGuard('Bash', { command: 'npm test' }, sessionId, projectDir).allowed).toBe(true);
  });

  it('allows env-prefixed safe commands', () => {
    expect(
      runGuard('Bash', { command: 'LC_ALL=C git status' }, sessionId, projectDir).allowed,
    ).toBe(true);
  });

  it('denies Bash grep over code files', () => {
    expect(
      runGuard('Bash', { command: 'grep -r foo src/*.ts' }, sessionId, projectDir).allowed,
    ).toBe(false);
  });

  it('denies env-prefixed grep on code files (no longer slips through)', () => {
    expect(
      runGuard('Bash', { command: 'LC_ALL=C grep -r foo src/foo.ts' }, sessionId, projectDir)
        .allowed,
    ).toBe(false);
  });

  it('denies git show on code files', () => {
    expect(
      runGuard('Bash', { command: 'git show HEAD:src/foo.ts' }, sessionId, projectDir).allowed,
    ).toBe(false);
  });

  it('denies git blame on code files', () => {
    expect(
      runGuard('Bash', { command: 'git blame src/foo.ts' }, sessionId, projectDir).allowed,
    ).toBe(false);
  });

  it('denies git diff on code files', () => {
    expect(
      runGuard('Bash', { command: 'git diff src/foo.ts' }, sessionId, projectDir).allowed,
    ).toBe(false);
  });

  it('denies git log -p on code files', () => {
    expect(
      runGuard('Bash', { command: 'git log -p src/foo.ts' }, sessionId, projectDir).allowed,
    ).toBe(false);
  });

  it('denies viewers on code files (bat, code, view, subl)', () => {
    expect(runGuard('Bash', { command: 'bat src/foo.ts' }, sessionId, projectDir).allowed).toBe(
      false,
    );
  });

  it('denies input redirection from code files', () => {
    expect(
      runGuard('Bash', { command: 'grep foo < src/foo.ts' }, sessionId, projectDir).allowed,
    ).toBe(false);
  });

  // ─── Agent ──────────────────────────────────────────────────────

  it('denies Agent(Explore) regardless of description', () => {
    const decision = runGuard(
      'Agent',
      { subagent_type: 'Explore', description: 'find x' },
      sessionId,
      projectDir,
    );
    expect(decision.allowed).toBe(false);
  });

  it('denies Agent(general-purpose) without an action verb', () => {
    const cases = [
      'investigate the auth middleware',
      'understand how the auth flow works',
      'analyze the indexer module',
      'document the plugin registry',
      'find all callers of processRequest',
      'how does the guard hook work',
      'where is foo defined',
      'list all files in the tools directory',
    ];
    for (const description of cases) {
      const decision = runGuard(
        'Agent',
        { subagent_type: 'general-purpose', description },
        sessionId,
        projectDir,
      );
      expect(decision.allowed, `description: "${description}"`).toBe(false);
    }
  });

  it('allows Agent(general-purpose) for explicit action work', () => {
    const cases = [
      'write the implementation of the new plugin',
      'run the test suite and fix failures',
      'refactor the auth module to use tokens',
      'fetch the latest docs for react-query',
      'plan the rollout of the new gate',
      'build a script that exports the index',
    ];
    for (const description of cases) {
      const decision = runGuard(
        'Agent',
        { subagent_type: 'general-purpose', description },
        sessionId,
        projectDir,
      );
      expect(decision.allowed, `description: "${description}"`).toBe(true);
    }
  });
});
