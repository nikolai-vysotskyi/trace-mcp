/**
 * Guard hook inside a linked git worktree (GH #1481).
 *
 * A linked worktree is served from the MAIN checkout's index, so the hook has
 * to (1) find the main checkout's sentinel/markers instead of reporting "server
 * not running", (2) let Read/Grep through on files the branch changed (the
 * index holds their main version), and (3) route everything else through trace
 * exactly as in a main checkout.
 */
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

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const projectHash = (root: string): string => sha(root).slice(0, 12);

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf-8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function runGuard(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
): HookDecision {
  const result = spawnSync('bash', [HOOK_SCRIPT], {
    input: JSON.stringify({ tool_name: toolName, session_id: sessionId, tool_input: toolInput }),
    env: {
      ...process.env,
      CLAUDE_TOOL_NAME: toolName,
      TRACE_MCP_GUARD_NAV_MIN: '1',
      ...extraEnv,
    },
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`guard hook exited ${result.status}: ${result.stderr}`);
  const stdout = result.stdout.trim();
  if (stdout.length === 0) return { allowed: true };
  const out = JSON.parse(stdout).hookSpecificOutput ?? {};
  return {
    allowed: out.permissionDecision !== 'deny',
    reason: out.permissionDecisionReason,
    context: out.additionalContext,
  };
}

describe.skipIf(process.platform === 'win32')('trace-mcp-guard.sh in a linked worktree', () => {
  let tmp: string;
  let main: string;
  let wt: string;
  let sessionId: string;
  const files: string[] = [];

  /** A live server bound to `root`: fresh heartbeat sentinel in $TMPDIR. */
  function heartbeat(root: string): void {
    const file = path.join(TMP_BASE, `trace-mcp-alive-${projectHash(root)}`);
    fs.writeFileSync(file, String(Date.now()));
    files.push(file);
  }

  function consulted(root: string, rel: string): void {
    const dir = path.join(TMP_BASE, `trace-mcp-consulted-${projectHash(root)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sha(rel)), '');
    files.push(dir);
  }

  beforeEach(() => {
    sessionId = `vitest-wt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(TMP_BASE, 'trace-guard-wt-')));
    main = path.join(tmp, 'main');
    wt = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(main, 'src'), { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    for (const f of ['a', 'b', 'c']) {
      fs.writeFileSync(path.join(main, `src/${f}.ts`), `export const ${f} = 1;\n`);
    }
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    // The branch changes a.ts and adds an untracked file.
    fs.writeFileSync(path.join(wt, 'src/a.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(wt, 'src/fresh.ts'), 'export const fresh = 1;\n');
    // The server is bound to the MAIN checkout (the session was routed there).
    heartbeat(main);
  });

  afterEach(() => {
    for (const f of files.splice(0)) fs.rmSync(f, { recursive: true, force: true });
    fs.rmSync(path.join(TMP_BASE, `trace-mcp-reads-${sessionId}`), {
      recursive: true,
      force: true,
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('routes an unchanged file through trace, like a main checkout does', () => {
    const d = runGuard('Read', { file_path: path.join(wt, 'src/b.ts') }, sessionId, wt);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('get_outline');
  });

  it('allows Read of a file the branch modified, without a consultation', () => {
    expect(runGuard('Read', { file_path: path.join(wt, 'src/a.ts') }, sessionId, wt).allowed).toBe(
      true,
    );
  });

  it('allows Read of an untracked file on the branch', () => {
    expect(
      runGuard('Read', { file_path: path.join(wt, 'src/fresh.ts') }, sessionId, wt).allowed,
    ).toBe(true);
  });

  it('honours a consultation recorded under the main checkout', () => {
    consulted(main, 'src/b.ts');
    expect(runGuard('Read', { file_path: path.join(wt, 'src/b.ts') }, sessionId, wt).allowed).toBe(
      true,
    );
  });

  it('works from a subdirectory of the worktree', () => {
    const cwd = path.join(wt, 'src');
    expect(runGuard('Read', { file_path: path.join(wt, 'src/a.ts') }, sessionId, cwd).allowed).toBe(
      true,
    );
    expect(runGuard('Read', { file_path: path.join(wt, 'src/b.ts') }, sessionId, cwd).allowed).toBe(
      false,
    );
  });

  it('allows Grep on a changed file and still routes a directory grep to trace', () => {
    const onFile = runGuard(
      'Grep',
      { pattern: 'a', path: path.join(wt, 'src/a.ts') },
      sessionId,
      wt,
    );
    expect(onFile.allowed).toBe(true);
    const onDir = runGuard('Grep', { pattern: 'a', path: path.join(wt, 'src') }, sessionId, wt);
    expect(onDir.allowed).toBe(false);
  });

  it('treats a file edited after the delta was cached as changed', () => {
    // First call writes the cache; b.ts is not in it.
    expect(runGuard('Read', { file_path: path.join(wt, 'src/b.ts') }, sessionId, wt).allowed).toBe(
      false,
    );
    const b = path.join(wt, 'src/b.ts');
    fs.writeFileSync(b, 'export const b = 2;\n');
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(b, future, future);
    expect(runGuard('Read', { file_path: b }, sessionId, wt).allowed).toBe(true);
  });

  it('keeps the whole delta out of a main checkout: a dirty file there is still gated', () => {
    fs.writeFileSync(path.join(main, 'src/a.ts'), 'export const a = 99;\n');
    const d = runGuard('Read', { file_path: path.join(main, 'src/a.ts') }, sessionId, main);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('get_outline');
  });

  it('does not mistake a submodule-style .git file for a worktree', () => {
    // A submodule's `.git` file points into <super>/.git/modules/<name>, whose
    // admin dir has no `commondir`. If it were taken for a worktree of <super>,
    // the live sentinel of <super> would be borrowed and the Read denied.
    const superproject = path.join(tmp, 'super');
    // Not under the superproject, so the walk-up cannot reach its sentinel.
    const sub = path.join(tmp, 'sub-checkout');
    const admin = path.join(superproject, '.git', 'modules', 'sub');
    fs.mkdirSync(admin, { recursive: true });
    fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
    fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${admin}\n`);
    fs.writeFileSync(path.join(sub, 'src/x.ts'), 'export const x = 1;\n');
    heartbeat(superproject);
    const d = runGuard('Read', { file_path: path.join(sub, 'src/x.ts') }, sessionId, sub);
    // Nothing is bound to `sub` itself, so the guard falls back (not borrowed).
    expect(d.allowed).toBe(true);
    expect(d.context).toContain('not running');
  });

  it('keeps routing once the stale sentinel of the worktree path is passed over', () => {
    // A leftover sentinel from an old direct session must not mask the live
    // main server (which would switch strict routing off for the session).
    const stale = path.join(TMP_BASE, `trace-mcp-alive-${projectHash(wt)}`);
    fs.writeFileSync(stale, 'old');
    files.push(stale);
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(stale, past, past);
    const d = runGuard('Read', { file_path: path.join(wt, 'src/b.ts') }, sessionId, wt);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('get_outline');
  });

  it('counts repeated full Reads of a changed file against the read limit', () => {
    const a = path.join(wt, 'src/a.ts');
    for (let i = 0; i < 3; i++) {
      expect(runGuard('Read', { file_path: a }, sessionId, wt).allowed).toBe(true);
    }
    const d = runGuard('Read', { file_path: a }, sessionId, wt);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('Already read');
  });

  it('resolves a relative path against the hook cwd, not the worktree root', () => {
    const cwd = path.join(wt, 'src');
    expect(runGuard('Read', { file_path: 'a.ts' }, sessionId, cwd).allowed).toBe(true);
  });

  describe('worktree nested inside the main checkout', () => {
    let nested: string;
    beforeEach(() => {
      nested = path.join(main, '.claude', 'worktrees', 'inner');
      git(main, 'worktree', 'add', '-q', '-b', 'inner', nested);
      fs.writeFileSync(path.join(nested, 'src/a.ts'), 'export const a = 3;\n');
    });

    it('honours a consultation keyed relative to the worktree', () => {
      consulted(main, 'src/b.ts');
      expect(
        runGuard('Read', { file_path: path.join(nested, 'src/b.ts') }, sessionId, nested).allowed,
      ).toBe(true);
    });

    it('still gates an unconsulted unchanged file and frees a changed one', () => {
      const b = runGuard('Read', { file_path: path.join(nested, 'src/b.ts') }, sessionId, nested);
      expect(b.allowed).toBe(false);
      expect(
        runGuard('Read', { file_path: path.join(nested, 'src/a.ts') }, sessionId, nested).allowed,
      ).toBe(true);
    });
  });
});
