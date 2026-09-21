import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installHermesHooks } from '../../src/init/hermes-hooks.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

const MINIMAL_CONFIG = 'model: gpt-5\nhooks: {}\n';

describe('installHermesHooks', () => {
  let home: string;
  let previousHome: string | undefined;

  const scriptPath = () => path.join(home, 'agent-hooks', 'trace-mcp-guard.sh');
  const configPath = () => path.join(home, 'config.yaml');
  const allowlistPath = () => path.join(home, 'shell-hooks-allowlist.json');
  const byTarget = (results: ReturnType<typeof installHermesHooks>, target: string) => {
    const hit = results.find((r) => r.target === target);
    if (!hit)
      throw new Error(`no result for ${target}, got ${results.map((r) => r.target).join()}`);
    return hit;
  };
  const hookEntries = () =>
    (YAML.parse(fs.readFileSync(configPath(), 'utf-8')).hooks?.pre_tool_call ?? []) as Array<{
      matcher?: string;
      command?: string;
      timeout?: number;
    }>;

  beforeEach(() => {
    home = createTmpDir('hermes-home-');
    previousHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    removeTmpDir(home);
  });

  it('installs an executable guard script under HERMES_HOME', () => {
    const results = installHermesHooks();

    expect(byTarget(results, scriptPath()).action).toBe('created');
    expect(fs.readFileSync(scriptPath(), 'utf-8')).toContain('trace-mcp-hermes-guard v');
    // Windows has no POSIX permission bits — fs.chmod is a no-op there and mode & 0o111 is always 0.
    if (process.platform !== 'win32') {
      expect(fs.statSync(scriptPath()).mode & 0o111).toBeTruthy();
    }
  });

  it('skips config.yaml wiring when Hermes has never been set up', () => {
    const result = byTarget(installHermesHooks(), configPath());

    expect(result.action).toBe('skipped');
    expect(result.detail).toMatch(/hermes setup/);
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('adds a pre_tool_call hook pointing at the guard script', () => {
    fs.writeFileSync(configPath(), MINIMAL_CONFIG);

    const result = byTarget(installHermesHooks(), configPath());

    expect(result.action).toBe('updated');
    expect(hookEntries()).toEqual([{ matcher: 'terminal', command: scriptPath(), timeout: 5 }]);
    // Unrelated user settings survive the edit.
    expect(YAML.parse(fs.readFileSync(configPath(), 'utf-8')).model).toBe('gpt-5');
  });

  it('is idempotent — a second run changes nothing', () => {
    fs.writeFileSync(configPath(), MINIMAL_CONFIG);
    installHermesHooks();
    const configAfterFirst = fs.readFileSync(configPath(), 'utf-8');

    const results = installHermesHooks();

    expect(byTarget(results, scriptPath()).action).toBe('already_configured');
    expect(byTarget(results, configPath()).action).toBe('already_configured');
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(configAfterFirst);
  });

  it('refreshes a stale entry instead of appending a duplicate', () => {
    fs.writeFileSync(
      configPath(),
      YAML.stringify({
        hooks: { pre_tool_call: [{ matcher: 'terminal', command: scriptPath(), timeout: 60 }] },
      }),
    );

    const result = byTarget(installHermesHooks(), configPath());

    expect(result.action).toBe('updated');
    expect(result.detail).toMatch(/Refreshed/);
    expect(hookEntries()).toEqual([{ matcher: 'terminal', command: scriptPath(), timeout: 5 }]);
  });

  it('keeps third-party hooks in place', () => {
    const foreign = { matcher: 'terminal', command: '/opt/other/hook.sh', timeout: 3 };
    fs.writeFileSync(configPath(), YAML.stringify({ hooks: { pre_tool_call: [foreign] } }));

    installHermesHooks();

    expect(hookEntries()).toContainEqual(foreign);
    expect(hookEntries()).toHaveLength(2);
  });

  it('refuses to touch a config.yaml it cannot parse', () => {
    const broken = 'hooks:\n  pre_tool_call: [\n';
    fs.writeFileSync(configPath(), broken);

    const result = byTarget(installHermesHooks(), configPath());

    expect(result.action).toBe('skipped');
    expect(result.detail).toMatch(/parse errors/);
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(broken);
  });

  it('writes nothing in dry-run mode', () => {
    fs.writeFileSync(configPath(), MINIMAL_CONFIG);

    const results = installHermesHooks({ dryRun: true, autoAllowlist: true });

    expect(results.every((r) => r.action === 'skipped')).toBe(true);
    expect(fs.existsSync(scriptPath())).toBe(false);
    expect(fs.existsSync(allowlistPath())).toBe(false);
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(MINIMAL_CONFIG);
  });

  it('warns that the hook stays dormant when not auto-allowlisted', () => {
    fs.writeFileSync(configPath(), MINIMAL_CONFIG);

    const results = installHermesHooks();

    expect(byTarget(results, configPath()).detail).toMatch(/accept-hooks/);
    expect(results.some((r) => r.target === allowlistPath())).toBe(false);
  });

  it('pre-approves the guard in the allowlist when asked, exactly once', () => {
    fs.writeFileSync(configPath(), MINIMAL_CONFIG);

    const first = byTarget(installHermesHooks({ autoAllowlist: true }), allowlistPath());
    const approvals = JSON.parse(fs.readFileSync(allowlistPath(), 'utf-8')).approvals;

    expect(first.action).toBe('created');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ event: 'pre_tool_call', command: scriptPath() });
    expect(approvals[0].approved_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]+Z$/);
    expect(approvals[0].script_mtime_at_approval).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]+Z$/);

    const second = byTarget(installHermesHooks({ autoAllowlist: true }), allowlistPath());
    expect(second.action).toBe('already_configured');
    expect(JSON.parse(fs.readFileSync(allowlistPath(), 'utf-8')).approvals).toHaveLength(1);
  });

  it('preserves foreign approvals and recovers from a malformed allowlist', () => {
    const foreign = { event: 'post_tool_call', command: '/opt/other/hook.sh' };
    fs.writeFileSync(
      allowlistPath(),
      JSON.stringify({ approvals: [foreign], hooks_auto_accept: false }),
    );

    installHermesHooks({ autoAllowlist: true });
    const kept = JSON.parse(fs.readFileSync(allowlistPath(), 'utf-8'));
    expect(kept.approvals).toHaveLength(2);
    expect(kept.approvals[0]).toEqual(foreign);
    expect(kept.hooks_auto_accept).toBe(false);

    fs.writeFileSync(allowlistPath(), '{ not json');
    const result = byTarget(installHermesHooks({ autoAllowlist: true }), allowlistPath());
    expect(result.action).toBe('created');
    expect(JSON.parse(fs.readFileSync(allowlistPath(), 'utf-8')).approvals).toHaveLength(1);
  });
});

// The decision table shells out to bash + python3 (the guard's own runtime).
// Skip cleanly on machines without them instead of going red.
const hasGuardRuntime = (() => {
  try {
    execFileSync('bash', ['--version'], { stdio: 'ignore' });
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGuardRuntime)('guard script decisions', () => {
  let home: string;
  let previousHome: string | undefined;

  const scriptPath = () => path.join(home, 'agent-hooks', 'trace-mcp-guard.sh');

  /** Feed the installed guard script a Hermes pre_tool_call payload, return parsed stdout. */
  const runGuard = (command: string, toolName = 'terminal'): Record<string, unknown> => {
    const payload = JSON.stringify({ tool_name: toolName, tool_input: { command } });
    const stdout = execFileSync('bash', [scriptPath()], { input: payload, encoding: 'utf-8' });
    return JSON.parse(stdout) as Record<string, unknown>;
  };
  const decisionOf = (command: string, toolName?: string): 'pass' | 'block' =>
    runGuard(command, toolName).decision === 'block' ? 'block' : 'pass';

  beforeEach(() => {
    home = createTmpDir('hermes-guard-');
    previousHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = home;
    installHermesHooks();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    removeTmpDir(home);
  });

  // The guard's contract, pinned: unconstrained recursive search is blocked,
  // scoped or non-recursive invocations pass through.
  const cases: Array<[string, 'pass' | 'block']> = [
    // Unconstrained recursive grep — blocked.
    ['grep -r foo', 'block'],
    ['grep -R foo', 'block'],
    ['grep --recursive foo', 'block'],
    ['grep -rn foo', 'block'],
    ['grep -ri foo', 'block'],
    ['grep -r -e foo', 'block'],
    ['grep -r -efoo', 'block'],
    ['grep -r --regexp=foo', 'block'],
    ['grep -r -m 5 foo', 'block'],
    // rg/ag/ack recurse by default — blocked without a flag.
    ['rg foo', 'block'],
    ['ag foo', 'block'],
    ['ack foo', 'block'],
    ['rg --max-count 5 foo', 'block'],
    ['grep -r foo | head -20', 'block'],
    ['/usr/bin/grep -r foo', 'block'],
    // Scoped with --include/--exclude — passes (the promised exception).
    ["grep -r --include='*.ts' foo src/", 'pass'],
    ['grep -r --include *.ts foo', 'pass'],
    ['grep -r --exclude-dir=node_modules foo', 'pass'],
    // Scoped with an explicit path operand — passes.
    ['grep -r foo src/', 'pass'],
    ['grep -r -e foo src', 'pass'],
    ['grep -r -m5 foo src', 'pass'],
    ['rg foo src/', 'pass'],
    // rg-native scoping flags — passes.
    ["rg -g '*.ts' foo", 'pass'],
    ['rg --glob *.ts foo', 'pass'],
    // Not recursive at all — passes.
    ['grep foo', 'pass'],
    ['grep -n foo bar.ts', 'pass'],
    // Introspection flags never search — passes.
    ['rg --help', 'pass'],
    ['rg --version', 'pass'],
    // Not a search — passes.
    ['ls -la', 'pass'],
  ];

  it.each(cases)('`%s` → %s', (command, expected) => {
    expect(decisionOf(command)).toBe(expected);
  });

  it('passes non-terminal tools through untouched', () => {
    expect(decisionOf('grep -r foo', 'search')).toBe('pass');
    expect(runGuard('grep -r foo', 'search')).toEqual({});
  });

  it('still blocks find -name source walks', () => {
    expect(decisionOf('find . -name "*.ts"')).toBe('block');
    expect(decisionOf('find . -name "*.md"')).toBe('pass');
  });

  it('block reasons point at the trace-mcp equivalent', () => {
    const out = runGuard('rg foo');
    expect(out.decision).toBe('block');
    expect(String(out.reason)).toMatch(/search_text/);
  });
});
