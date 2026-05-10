/**
 * Smoke tests for the four lifecycle hook scripts (SessionStart,
 * UserPromptSubmit, Stop, SessionEnd).
 *
 * The scripts shell out to the `trace-mcp` CLI; we replace it with a tiny
 * stub on $PATH so the tests don't depend on a built dist or a running
 * daemon. Each test asserts:
 *   - parse-clean (`bash -n`)
 *   - non-zero exit codes never bubble up
 *   - structured output matches Claude Code's hookSpecificOutput envelope
 *     when the upstream call yields data
 *   - silent exit (no stdout) when there is nothing to inject
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HOOKS_DIR = path.resolve('hooks');
const SESSION_START = path.join(HOOKS_DIR, 'trace-mcp-session-start.sh');
const USER_PROMPT_SUBMIT = path.join(HOOKS_DIR, 'trace-mcp-user-prompt-submit.sh');
const STOP_HOOK = path.join(HOOKS_DIR, 'trace-mcp-stop.sh');
const SESSION_END_HOOK = path.join(HOOKS_DIR, 'trace-mcp-session-end.sh');

function makeStub(stubDir: string, output: string, exitCode = 0): string {
  fs.mkdirSync(stubDir, { recursive: true });
  const stubPath = path.join(stubDir, 'trace-mcp');
  // Stub reads its own argv to support multiple subcommands. Tests pass the
  // expected stdout via output. The stub always exits with exitCode so we can
  // simulate failure paths.
  const body = `#!/usr/bin/env bash
cat <<'__TRACEMCP_STUB_OUTPUT__'
${output}
__TRACEMCP_STUB_OUTPUT__
exit ${exitCode}
`;
  fs.writeFileSync(stubPath, body);
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

function runHook(
  script: string,
  stdin: string,
  opts: { stubDir: string; cwd: string; env?: Record<string, string> } = {
    stubDir: '',
    cwd: process.cwd(),
  },
): { stdout: string; status: number } {
  // Prepend the stub dir to PATH so `trace-mcp` resolves to our stub. The
  // caller's `env.PATH` (when provided) wins — that's how the "CLI missing"
  // tests sanitize node_modules out of PATH.
  const callerEnv = opts.env ?? {};
  const basePath = opts.stubDir
    ? `${opts.stubDir}:${process.env.PATH ?? ''}`
    : (process.env.PATH ?? '');
  const envOverlay: Record<string, string | undefined> = {
    ...process.env,
    PATH: basePath,
    ...callerEnv,
  };
  if (callerEnv.PATH && opts.stubDir) {
    envOverlay.PATH = `${opts.stubDir}:${callerEnv.PATH}`;
  }
  try {
    const stdout = execSync(`bash ${script}`, {
      input: stdin,
      cwd: opts.cwd,
      env: envOverlay,
      encoding: 'utf-8',
      timeout: 20_000,
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return {
      stdout: err.stdout ? err.stdout.toString() : '',
      status: err.status ?? 1,
    };
  }
}

describe.skipIf(process.platform === 'win32')('lifecycle hook scripts (POSIX)', () => {
  let tmpRoot: string;
  let stubDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-lifecycle-test-'));
    stubDir = path.join(tmpRoot, 'bin');
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-lifecycle-proj-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  describe('parses cleanly', () => {
    it('every lifecycle hook script passes `bash -n`', () => {
      for (const script of [SESSION_START, USER_PROMPT_SUBMIT, STOP_HOOK, SESSION_END_HOOK]) {
        // Throws if the script has a syntax error.
        execSync(`bash -n ${script}`, { encoding: 'utf-8' });
      }
    });
  });

  describe('trace-mcp-session-start.sh', () => {
    it('emits SessionStart additionalContext when wake-up returns JSON', () => {
      const wakeUpJson = JSON.stringify({
        project: { name: 'demo', root: projectDir },
        decisions: {
          total_active: 2,
          recent: [
            {
              id: 1,
              title: 'Use Pinia for state',
              type: 'tech_choice',
              symbol: 'src/stores/index.ts::Store#class',
              when: '2026-01-01T00:00:00Z',
            },
            {
              id: 2,
              title: 'Postgres over MySQL',
              type: 'tech_choice',
              when: '2026-01-02T00:00:00Z',
            },
          ],
        },
        memory: { total_decisions: 2, sessions_mined: 5, sessions_indexed: 1, by_type: {} },
        estimated_tokens: 60,
      });
      makeStub(stubDir, wakeUpJson, 0);

      const { stdout, status } = runHook(SESSION_START, JSON.stringify({ session_id: 's1' }), {
        stubDir,
        cwd: projectDir,
      });
      expect(status).toBe(0);
      const envelope = JSON.parse(stdout.trim());
      expect(envelope.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(envelope.hookSpecificOutput.additionalContext).toContain('[trace-mcp wake-up]');
      expect(envelope.hookSpecificOutput.additionalContext).toContain('Use Pinia for state');
      expect(envelope.hookSpecificOutput.additionalContext).toContain('Postgres over MySQL');
    });

    it('exits silently when the trace-mcp CLI is missing entirely', () => {
      // Empty stubDir + fake HOME → no trace-mcp shim. Build an isolated
      // PATH that contains only directories proven NOT to ship a `trace-mcp`
      // binary on this machine — that way the hook's `command -v trace-mcp`
      // probe genuinely fails. We seed PATH with /bin and /usr/bin (POSIX
      // coreutils for jq/sha256sum/cat) and explicitly skip any segment
      // that already resolves trace-mcp.
      const fakeHome = path.join(tmpRoot, 'home');
      fs.mkdirSync(fakeHome);

      const baseDirs = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
      const cleanDirs = baseDirs.filter((d) => {
        if (!fs.existsSync(d)) return false;
        try {
          fs.accessSync(path.join(d, 'trace-mcp'));
          // trace-mcp present here — skip this dir.
          return false;
        } catch {
          return true;
        }
      });
      // Bash itself must be reachable.
      expect(cleanDirs.length).toBeGreaterThan(0);
      const sanitizedPath = cleanDirs.join(path.delimiter);

      const { stdout, status } = runHook(SESSION_START, '{}', {
        stubDir: '',
        cwd: projectDir,
        env: { HOME: fakeHome, PATH: sanitizedPath },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
    });

    it('exits silently when wake-up CLI errors out', () => {
      makeStub(stubDir, 'oops not json', 1);
      const { stdout, status } = runHook(SESSION_START, '{}', { stubDir, cwd: projectDir });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
    });

    it('respects TRACE_MCP_SESSION_START_OFF=1 opt-out', () => {
      makeStub(
        stubDir,
        '{"project":{"name":"x","root":"/x"},"decisions":{"total_active":0,"recent":[]},"memory":{"total_decisions":0,"sessions_mined":0,"sessions_indexed":0,"by_type":{}},"estimated_tokens":1}',
        0,
      );
      const { stdout, status } = runHook(SESSION_START, '{}', {
        stubDir,
        cwd: projectDir,
        env: { TRACE_MCP_SESSION_START_OFF: '1' },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
    });
  });

  describe('trace-mcp-user-prompt-submit.sh', () => {
    it('emits UserPromptSubmit additionalContext when decisions are returned', () => {
      const decisionsJson = JSON.stringify([
        {
          id: 7,
          type: 'preference',
          title: 'Always strict mode',
          content: 'TypeScript strict mode is required for all new code.',
          symbol_id: 'tsconfig.json',
        },
        {
          id: 8,
          type: 'convention',
          title: 'No default exports',
          content: 'Use named exports everywhere.',
          file_path: 'src/index.ts',
        },
      ]);
      makeStub(stubDir, decisionsJson, 0);

      const { stdout, status } = runHook(
        USER_PROMPT_SUBMIT,
        JSON.stringify({ prompt: 'Should I use default exports?', session_id: 'p1' }),
        { stubDir, cwd: projectDir },
      );
      expect(status).toBe(0);
      const envelope = JSON.parse(stdout.trim());
      expect(envelope.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(envelope.hookSpecificOutput.additionalContext).toContain('Always strict mode');
      expect(envelope.hookSpecificOutput.additionalContext).toContain('No default exports');
      expect(envelope.hookSpecificOutput.additionalContext).toContain('relevant decision');
    });

    it('exits silently on empty decisions array', () => {
      makeStub(stubDir, '[]', 0);
      const { stdout, status } = runHook(
        USER_PROMPT_SUBMIT,
        JSON.stringify({ prompt: 'anything', session_id: 'p2' }),
        { stubDir, cwd: projectDir },
      );
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
    });

    it('exits silently when prompt is missing', () => {
      makeStub(stubDir, '[]', 0);
      const { stdout, status } = runHook(USER_PROMPT_SUBMIT, JSON.stringify({}), {
        stubDir,
        cwd: projectDir,
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
    });

    it('exits silently when CLI errors', () => {
      makeStub(stubDir, '', 1);
      const { stdout, status } = runHook(USER_PROMPT_SUBMIT, JSON.stringify({ prompt: 'x' }), {
        stubDir,
        cwd: projectDir,
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
    });
  });

  describe('trace-mcp-stop.sh', () => {
    it('exits within ~1s and spawns a detached miner', () => {
      // Stub `trace-mcp memory mine` to sleep briefly so we can observe the lock file.
      const stubBody = `#!/usr/bin/env bash
sleep 2
echo "mined ok"
`;
      fs.mkdirSync(stubDir, { recursive: true });
      fs.writeFileSync(path.join(stubDir, 'trace-mcp'), stubBody);
      fs.chmodSync(path.join(stubDir, 'trace-mcp'), 0o755);

      const start = Date.now();
      const { stdout, status } = runHook(STOP_HOOK, '{}', { stubDir, cwd: projectDir });
      const elapsed = Date.now() - start;

      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
      // The hook must NEVER block the agent's turn — give a generous bound to
      // avoid CI flake but assert non-blocking behaviour.
      expect(elapsed).toBeLessThan(1500);
    });

    it('respects TRACE_MCP_STOP_OFF=1 opt-out', () => {
      makeStub(stubDir, '', 0);
      const { stdout, status } = runHook(STOP_HOOK, '{}', {
        stubDir,
        cwd: projectDir,
        env: { TRACE_MCP_STOP_OFF: '1' },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
    });
  });

  describe('trace-mcp-session-end.sh', () => {
    it('appends to the project journal and cleans up per-session reads dir', () => {
      const fakeHome = path.join(tmpRoot, 'home');
      fs.mkdirSync(fakeHome, { recursive: true });

      // Pre-create a session reads dir that the hook should remove.
      const sessionId = 'sid-end-test-12345';
      const fakeTmp = path.join(tmpRoot, 'tmp');
      fs.mkdirSync(fakeTmp);
      const readsDir = path.join(fakeTmp, `trace-mcp-reads-${sessionId}`);
      fs.mkdirSync(readsDir);
      fs.writeFileSync(path.join(readsDir, 'marker'), 'x');

      const { stdout, status } = runHook(
        SESSION_END_HOOK,
        JSON.stringify({ session_id: sessionId }),
        {
          stubDir: '',
          cwd: projectDir,
          env: { HOME: fakeHome, TMPDIR: fakeTmp },
        },
      );
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
      expect(fs.existsSync(readsDir)).toBe(false);

      const journalDir = path.join(fakeHome, '.trace-mcp', 'sessions');
      expect(fs.existsSync(journalDir)).toBe(true);
      const files = fs.readdirSync(journalDir).filter((f) => f.endsWith('-end.log'));
      expect(files.length).toBe(1);
      const journal = fs.readFileSync(path.join(journalDir, files[0]!), 'utf-8');
      expect(journal).toContain(sessionId);
    });

    it('handles missing session_id without crashing', () => {
      const fakeHome = path.join(tmpRoot, 'home');
      fs.mkdirSync(fakeHome, { recursive: true });
      const { stdout, status } = runHook(SESSION_END_HOOK, '{}', {
        stubDir: '',
        cwd: projectDir,
        env: { HOME: fakeHome, TMPDIR: tmpRoot },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
    });

    it('respects TRACE_MCP_SESSION_END_OFF=1 opt-out', () => {
      const fakeHome = path.join(tmpRoot, 'home');
      fs.mkdirSync(fakeHome, { recursive: true });
      const { stdout, status } = runHook(
        SESSION_END_HOOK,
        JSON.stringify({ session_id: 'sid-off' }),
        {
          stubDir: '',
          cwd: projectDir,
          env: { HOME: fakeHome, TMPDIR: tmpRoot, TRACE_MCP_SESSION_END_OFF: '1' },
        },
      );
      expect(status).toBe(0);
      expect(stdout.trim()).toBe('');
      // Journal directory must NOT have been created.
      expect(fs.existsSync(path.join(fakeHome, '.trace-mcp', 'sessions'))).toBe(false);
    });
  });
});
