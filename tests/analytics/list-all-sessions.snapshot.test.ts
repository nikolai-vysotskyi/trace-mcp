import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `os.homedir()` via env var so the module-level constant
// CLAUDE_PROJECTS_DIR (captured at import time in log-parser.ts) resolves
// into the fake home tree. vi.resetModules() + dynamic import in beforeEach
// forces re-evaluation of that constant per test.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof os>('node:os');
  const fake = () => process.env.TRACE_MCP_FAKE_HOME ?? actual.homedir();
  return { ...actual, default: { ...actual, homedir: fake }, homedir: fake };
});
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof os>('os');
  const fake = () => process.env.TRACE_MCP_FAKE_HOME ?? actual.homedir();
  return { ...actual, default: { ...actual, homedir: fake }, homedir: fake };
});

// Wrap readdirSync so tests can assert which directories got listed, without
// trying to redefine the (non-configurable in ESM) `fs` module export directly.
export const readdirSyncCalls: unknown[] = [];
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  const wrapped = (...args: Parameters<typeof fs.readdirSync>) => {
    readdirSyncCalls.push(args[0]);
    // biome-ignore lint/suspicious/noExplicitAny: passthrough to overloaded native fn
    return (actual.readdirSync as any)(...args);
  };
  return { ...actual, default: { ...actual, readdirSync: wrapped }, readdirSync: wrapped };
});

describe('listAllSessions — golden lockdown', () => {
  let fakeHome: string;
  const origEnvHome = process.env.TRACE_MCP_FAKE_HOME;
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-sessions-'));
    process.env.TRACE_MCP_FAKE_HOME = fakeHome;

    // Stub cwd to the fake home so `discoverClawProjects` strategy-2 doesn't
    // pick up a real .claw/sessions under whatever dir vitest was launched from.
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(fakeHome);

    // ── Claude Code fixtures: ~/.claude/projects/<encoded>/<session>.jsonl
    const claudeRoot = path.join(fakeHome, '.claude', 'projects');
    fs.mkdirSync(path.join(claudeRoot, '-ztest-proj-a'), { recursive: true });
    fs.writeFileSync(path.join(claudeRoot, '-ztest-proj-a', 'sess-001.jsonl'), '');
    fs.writeFileSync(path.join(claudeRoot, '-ztest-proj-a', 'sess-002.jsonl'), '');
    fs.mkdirSync(path.join(claudeRoot, '-ztest-proj-b'), { recursive: true });
    fs.writeFileSync(path.join(claudeRoot, '-ztest-proj-b', 'sess-900.jsonl'), '');

    // ── Claw Code fixture: <project>/.claw/sessions/<session>.jsonl
    // Placed under ~/dev/proj-c — `dev` appears only once in the common-roots
    // heuristic so the entry doesn't get duplicated on case-insensitive FS
    // (Projects/projects both match the same real dir on macOS).
    const clawDir = path.join(fakeHome, 'dev', 'proj-c', '.claw', 'sessions');
    fs.mkdirSync(clawDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'sess-C01.jsonl'), '');

    readdirSyncCalls.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    if (origEnvHome === undefined) delete process.env.TRACE_MCP_FAKE_HOME;
    else process.env.TRACE_MCP_FAKE_HOME = origEnvHome;
    cwdSpy?.mockRestore();
    cwdSpy = null;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('returns a stable {rel, client} set across Claude + Claw fixtures', async () => {
    // Dynamic import AFTER mocks + env are set so CLAUDE_PROJECTS_DIR is computed
    // against the fake home.
    const { listAllSessions } = await import('../../src/analytics/log-parser.js');

    const result = listAllSessions()
      .map((r) => ({
        // Normalize to forward slashes — on Windows, path.relative emits
        // backslashes, but the golden expectation uses POSIX form for
        // cross-platform stability.
        rel: path.relative(fakeHome, r.filePath).replace(/\\/g, '/'),
        client: r.client,
      }))
      .sort((a, b) => a.rel.localeCompare(b.rel));

    expect(result).toEqual([
      { rel: '.claude/projects/-ztest-proj-a/sess-001.jsonl', client: 'claude-code' },
      { rel: '.claude/projects/-ztest-proj-a/sess-002.jsonl', client: 'claude-code' },
      { rel: '.claude/projects/-ztest-proj-b/sess-900.jsonl', client: 'claude-code' },
      { rel: 'dev/proj-c/.claw/sessions/sess-C01.jsonl', client: 'claw-code' },
    ]);
  });

  it('client tags are drawn only from the current provider set', async () => {
    const { listAllSessions } = await import('../../src/analytics/log-parser.js');
    const clients = new Set(listAllSessions().map((r) => r.client));
    // Lockdown: new client values must be added deliberately — if this set grows,
    // also update consumers in conversation-miner.ts / session-indexer.ts.
    expect([...clients].sort()).toEqual(['claude-code', 'claw-code']);
  });

  // TRA-48: listAllSessions(projectRoot) must short-circuit to the target
  // project's own directories instead of scanning every registered project.
  it('with a projectRoot, returns only that project and never lists the registry dir', async () => {
    const { listAllSessions } = await import('../../src/analytics/log-parser.js');

    const claudeRoot = path.join(fakeHome, '.claude', 'projects');
    const projTargetRoot = path.join(fakeHome, 'target-proj');
    const encodedTargetDir = projTargetRoot.replace(/[\\/]+/g, '-');
    fs.mkdirSync(path.join(claudeRoot, encodedTargetDir), { recursive: true });
    fs.writeFileSync(path.join(claudeRoot, encodedTargetDir, 'sess-t01.jsonl'), '');

    const result = listAllSessions(projTargetRoot)
      .map((r) => path.relative(fakeHome, r.filePath).replace(/\\/g, '/'))
      .sort();

    expect(result).toEqual([`.claude/projects/${encodedTargetDir}/sess-t01.jsonl`]);

    // The whole-registry listing (`~/.claude/projects` itself) must never be
    // read — only the one project directory the caller asked for.
    expect(readdirSyncCalls).not.toContain(claudeRoot);
  });
});
