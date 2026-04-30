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

  // ─── Manual override ────────────────────────────────────────────

  it('TRACE_MCP_GUARD_OFF=1 fully bypasses the guard', () => {
    const file = path.join(projectDir, 'off.ts');
    fs.writeFileSync(file, 'export {};');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir, {
      TRACE_MCP_GUARD_OFF: '1',
    });
    expect(decision.allowed).toBe(true);
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
