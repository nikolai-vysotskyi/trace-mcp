import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOOK_SCRIPT = path.resolve('hooks/trace-mcp-guard.sh');
const TMP_BASE = fs.realpathSync(os.tmpdir());

interface HookDecision {
  allowed: boolean;
  reason?: string;
  context?: string;
}

/** Spawn the guard hook with the given tool input and return the decision. */
function runGuard(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  cwd: string,
): HookDecision {
  const payload = JSON.stringify({
    tool_name: toolName,
    session_id: sessionId,
    tool_input: toolInput,
  });

  const result = spawnSync('bash', [HOOK_SCRIPT], {
    input: payload,
    env: { ...process.env, CLAUDE_TOOL_NAME: toolName },
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

describe('trace-mcp-guard.sh', () => {
  const projectDir = path.join(
    TMP_BASE,
    `trace-mcp-guard-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let sessionId: string;

  beforeEach(() => {
    fs.mkdirSync(projectDir, { recursive: true });
    // Unique session id per test → no cross-test state pollution
    sessionId = `vitest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  });

  afterEach(() => {
    // Clean up session-scoped guard state dirs
    const readsDir = path.join(TMP_BASE, `trace-mcp-reads-${sessionId}`);
    if (fs.existsSync(readsDir)) fs.rmSync(readsDir, { recursive: true, force: true });
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // ─── Read: basic routing ────────────────────────────────────────

  it('allows Read on non-code files', () => {
    const file = path.join(projectDir, 'README.md');
    fs.writeFileSync(file, '# readme');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(decision.allowed).toBe(true);
  });

  it('allows Read on files in vendored dirs', () => {
    const vendored = path.join(projectDir, 'node_modules', 'pkg');
    fs.mkdirSync(vendored, { recursive: true });
    const file = path.join(vendored, 'index.ts');
    fs.writeFileSync(file, 'export {};');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(decision.allowed).toBe(true);
  });

  it('denies first Read on code files with redirect message', () => {
    const file = path.join(projectDir, 'foo.ts');
    fs.writeFileSync(file, 'export const x = 1;');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('trace-mcp');
    expect(decision.context).toContain('get_outline');
  });

  it('denies Read on .env files even with non-standard suffix', () => {
    const file = path.join(projectDir, '.env.local');
    fs.writeFileSync(file, 'SECRET=xxx');
    const decision = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('get_env_vars');
  });

  // ─── Read: repeat-read dedup ─────────────────────────────────────

  it('allows second Read after first-time deny (retry path)', () => {
    const file = path.join(projectDir, 'bar.ts');
    fs.writeFileSync(file, 'export const x = 1;');
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(false);
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
  });

  it('denies 4th Read of unchanged code file with "Already read" message', () => {
    const file = path.join(projectDir, 'baz.ts');
    fs.writeFileSync(file, 'export const x = 1;');
    // Attempt 1: first-time deny
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(false);
    // Attempt 2: retry allow (count = 1)
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
    // Attempt 3: allowed (count = 2, HAD_STATE path)
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
    // Attempt 4: limit exceeded
    const d4 = runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(d4.allowed).toBe(false);
    expect(d4.reason).toContain('Already read');
    expect(d4.context).toContain('get_symbol');
  });

  it('resets counter after mtime change (post-Edit) without re-triggering friction', () => {
    const file = path.join(projectDir, 'qux.ts');
    fs.writeFileSync(file, 'export const x = 1;');
    // Burn through the limit.
    runGuard('Read', { file_path: file }, sessionId, projectDir);
    runGuard('Read', { file_path: file }, sessionId, projectDir);
    runGuard('Read', { file_path: file }, sessionId, projectDir);
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(false);

    // Simulate Edit: bump mtime 2s into the future (more robust than 1s on fast FS).
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(file, future, future);

    // After mtime bump: agent already had state, so no friction deny; allow immediately.
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(true);
    // Third read of the "new" version → limit again.
    expect(runGuard('Read', { file_path: file }, sessionId, projectDir).allowed).toBe(false);
  });

  it('tracks each file independently', () => {
    const a = path.join(projectDir, 'a.ts');
    const b = path.join(projectDir, 'b.ts');
    fs.writeFileSync(a, 'export {};');
    fs.writeFileSync(b, 'export {};');

    // Burn out file a.
    runGuard('Read', { file_path: a }, sessionId, projectDir);
    runGuard('Read', { file_path: a }, sessionId, projectDir);
    runGuard('Read', { file_path: a }, sessionId, projectDir);
    expect(runGuard('Read', { file_path: a }, sessionId, projectDir).allowed).toBe(false);

    // File b should still be on first-time path.
    expect(runGuard('Read', { file_path: b }, sessionId, projectDir).allowed).toBe(false);
    expect(runGuard('Read', { file_path: b }, sessionId, projectDir).allowed).toBe(true);
  });

  // ─── Grep / Glob ────────────────────────────────────────────────

  it('denies Grep on code with no filters', () => {
    const decision = runGuard('Grep', { pattern: 'foo' }, sessionId, projectDir);
    expect(decision.allowed).toBe(false);
    expect(decision.context).toContain('search');
  });

  it('allows Grep with type=md filter', () => {
    const decision = runGuard('Grep', { pattern: 'foo', type: 'md' }, sessionId, projectDir);
    expect(decision.allowed).toBe(true);
  });

  it('denies Glob for code patterns', () => {
    const decision = runGuard('Glob', { pattern: '**/*.ts' }, sessionId, projectDir);
    expect(decision.allowed).toBe(false);
  });

  it('allows Glob for .md patterns', () => {
    const decision = runGuard('Glob', { pattern: '**/*.md' }, sessionId, projectDir);
    expect(decision.allowed).toBe(true);
  });

  // ─── Bash ───────────────────────────────────────────────────────

  it('allows safe Bash commands (git, npm)', () => {
    expect(runGuard('Bash', { command: 'git status' }, sessionId, projectDir).allowed).toBe(true);
    expect(runGuard('Bash', { command: 'npm test' }, sessionId, projectDir).allowed).toBe(true);
  });

  it('denies Bash grep over code files', () => {
    const decision = runGuard('Bash', { command: 'grep -r foo src/*.ts' }, sessionId, projectDir);
    expect(decision.allowed).toBe(false);
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
    expect(decision.reason).toContain('50K tokens');
  });

  it('denies Agent(general-purpose) for exploration verbs (investigate)', () => {
    const decision = runGuard(
      'Agent',
      {
        subagent_type: 'general-purpose',
        description: 'investigate the auth middleware',
      },
      sessionId,
      projectDir,
    );
    expect(decision.allowed).toBe(false);
  });

  it('denies Agent(general-purpose) for expanded regex (trace/walkthrough/document)', () => {
    const cases = [
      'trace how the auth flow works',
      'walkthrough of the indexer',
      'document the plugin registry',
      'summarize the server module',
      'locate the session handler',
      'how does the guard hook work',
      'where is foo defined',
      'list all files in the tools directory',
      'find all callers of processRequest',
      'map the dependencies of the core package',
    ];
    for (const description of cases) {
      const decision = runGuard(
        'Agent',
        {
          subagent_type: 'general-purpose',
          description,
        },
        sessionId,
        projectDir,
      );
      expect(decision.allowed, `description: "${description}"`).toBe(false);
    }
  });

  it('allows Agent(general-purpose) for coding/testing work', () => {
    const cases = [
      'write the implementation of the new plugin',
      'run the test suite and fix failures',
      'refactor the auth module to use tokens',
      'fetch the latest docs for react-query',
    ];
    for (const description of cases) {
      const decision = runGuard(
        'Agent',
        {
          subagent_type: 'general-purpose',
          description,
        },
        sessionId,
        projectDir,
      );
      expect(decision.allowed, `description: "${description}"`).toBe(true);
    }
  });
});
