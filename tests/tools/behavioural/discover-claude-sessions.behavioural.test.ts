/**
 * Behavioural coverage for `discoverClaudeSessions()` — the engine behind the
 * `discover_claude_sessions` MCP tool.
 *
 * IMPL: src/tools/advanced/claude-sessions.ts
 *
 * The tool is inline-registered in src/tools/register/advanced.ts and forwards
 * to `discoverClaudeSessions({ scanRoot, excludePrefix, onlyExisting, limit })`.
 * We test the underlying function directly so we can override `scanRoot` to a
 * temp directory and avoid touching ~/.claude/projects.
 *
 * Cases:
 *  - returns a populated envelope when projects are seeded under scan_root
 *  - only_existing filters out projects whose decoded path is gone
 *  - exclude_prefix removes a matching project
 *  - limit caps the number of returned sessions, sorted by lastActiveMs desc
 *  - nonexistent scan_root returns an err() Result
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverClaudeSessions } from '../../../src/tools/advanced/claude-sessions.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

// `decodeClaudeProjectName` walks the filesystem from POSIX root `/`, so the
// "exists=true" fixture only makes sense on a POSIX host. The Windows runner
// has no `/` root and tmp paths look like `C:\Users\…`, which the encoder
// cannot represent. Skip on Windows — the impl itself is POSIX-only.
const isWin = process.platform === 'win32';
const describeOrSkip = isWin ? describe.skip : describe;

function encodePath(p: string): string {
  // Claude's encoding: every "/" becomes "-" (the leading "/" → "-" too).
  return p.replace(/\//g, '-');
}

function seedProject(scanRoot: string, projectPath: string, sessionFiles = 1): string {
  const encoded = encodePath(projectPath);
  const dir = path.join(scanRoot, encoded);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < sessionFiles; i++) {
    fs.writeFileSync(path.join(dir, `sess-${i}.jsonl`), '{}\n');
  }
  return dir;
}

describeOrSkip('discoverClaudeSessions() — behavioural contract', () => {
  let tmpDir: string;
  let scanRoot: string;
  // Real existing path on every dev machine — used to seed an "exists=true"
  // project. We use tmpDir itself so the assertion is hermetic.
  let realProject: string;
  let phantomProject: string;

  beforeEach(() => {
    tmpDir = createTmpDir('discover-claude-behav-');
    scanRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(scanRoot, { recursive: true });

    realProject = path.join(tmpDir, 'real-proj');
    fs.mkdirSync(realProject, { recursive: true });
    phantomProject = path.join(tmpDir, 'phantom-proj-that-does-not-exist');
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
  });

  it('returns sessions for every encoded project dir under scan_root', () => {
    seedProject(scanRoot, realProject, 2);
    seedProject(scanRoot, phantomProject, 1);

    const result = discoverClaudeSessions({ scanRoot });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const env = result.value;

    expect(env.scannedRoot).toBe(scanRoot);
    expect(env.totalDirs).toBe(2);
    expect(env.sessions.length).toBe(2);
    const paths = env.sessions.map((s) => s.projectPath).sort();
    expect(paths).toContain(realProject);

    const real = env.sessions.find((s) => s.projectPath === realProject);
    expect(real?.exists).toBe(true);
    expect(real?.sessionFiles).toBe(2);
  });

  it('only_existing filters out projects whose decoded path is gone', () => {
    seedProject(scanRoot, realProject, 1);
    seedProject(scanRoot, phantomProject, 1);

    const result = discoverClaudeSessions({ scanRoot, onlyExisting: true });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const paths = result.value.sessions.map((s) => s.projectPath);
    expect(paths).toContain(realProject);
    expect(paths).not.toContain(phantomProject);
    expect(result.value.sessions.every((s) => s.exists)).toBe(true);
  });

  it('exclude_prefix removes a matching project from the results', () => {
    seedProject(scanRoot, realProject, 1);
    const otherProject = path.join(tmpDir, 'other-proj');
    fs.mkdirSync(otherProject, { recursive: true });
    seedProject(scanRoot, otherProject, 1);

    const result = discoverClaudeSessions({ scanRoot, excludePrefix: realProject });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const paths = result.value.sessions.map((s) => s.projectPath);
    expect(paths).not.toContain(realProject);
    expect(paths).toContain(otherProject);
  });

  it('limit caps the number of returned sessions, sorted by lastActiveMs desc', () => {
    // Seed three projects with controlled mtimes so the sort is deterministic.
    const p1 = path.join(tmpDir, 'p1');
    const p2 = path.join(tmpDir, 'p2');
    const p3 = path.join(tmpDir, 'p3');
    for (const p of [p1, p2, p3]) fs.mkdirSync(p, { recursive: true });

    const d1 = seedProject(scanRoot, p1, 1);
    const d2 = seedProject(scanRoot, p2, 1);
    const d3 = seedProject(scanRoot, p3, 1);

    const now = Date.now();
    fs.utimesSync(d1, new Date(now - 30_000), new Date(now - 30_000));
    fs.utimesSync(d2, new Date(now - 10_000), new Date(now - 10_000));
    fs.utimesSync(d3, new Date(now), new Date(now));

    const result = discoverClaudeSessions({ scanRoot, limit: 2 });
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const env = result.value;
    expect(env.sessions.length).toBe(2);
    // Most recently active first.
    expect(env.sessions[0].projectPath).toBe(p3);
    expect(env.sessions[1].projectPath).toBe(p2);
    // totalDirs reports underlying count, not the cap.
    expect(env.totalDirs).toBe(3);
  });

  it('nonexistent scan_root returns an error Result', () => {
    const missing = path.join(tmpDir, 'never-created');
    const result = discoverClaudeSessions({ scanRoot: missing });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    // Error envelope carries the offending path in its message.
    expect(result.error.message).toContain(missing);
  });
});
