import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverClaudeSessions,
  decodeClaudeProjectName,
} from '../../src/tools/advanced/claude-sessions.js';

// ── decodeClaudeProjectName ───────────────────────────────────────────────────
//
// The decoder is filesystem-aware: it walks the real FS to resolve ambiguous
// dashes.  We test only cases whose decoded form doesn't exist on disk so we
// always hit the "greedy fallback" branch and the output is deterministic.

describe('decodeClaudeProjectName', () => {
  it('rejects names that do not start with a dash', () => {
    expect(decodeClaudeProjectName('not-encoded')).toBe(null);
  });

  it('returns "/" for a single dash', () => {
    expect(decodeClaudeProjectName('-')).toBe('/');
  });

  it('greedy-decodes a path that cannot exist on disk (all-numeric tokens)', () => {
    // "/999/888/777" is very unlikely to exist → fallback to greedy decode
    const result = decodeClaudeProjectName('-999-888-777');
    expect(result).toBe('/999/888/777');
  });
});

// ── discoverClaudeSessions ────────────────────────────────────────────────────
//
// We create a temporary Claude-style projects directory with encoded subdirs.
// The "real" project is placed at a dash-free tmpdir path so encoding is
// unambiguous (no literal dashes in the path segments).

describe('discoverClaudeSessions', () => {
  let claudeRoot: string; // stands in for ~/.claude/projects
  let projectsDir: string;
  let realProject: string; // a dash-free path that will round-trip cleanly

  beforeEach(() => {
    // Create Claude-style layout:  tmpRoot/projects/<encoded>
    claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudetest'));
    projectsDir = path.join(claudeRoot, 'projects');
    fs.mkdirSync(projectsDir);

    // Create a real project directory whose path has NO literal dashes,
    // so the encoded name round-trips unambiguously.
    // We create it directly under claudeRoot (short, no dashes).
    realProject = path.join(claudeRoot, 'proj');
    fs.mkdirSync(realProject);

    // Encode realProject → each "/" becomes "-"
    const encoded = realProject.replace(/\//g, '-');
    const sessionDir = path.join(projectsDir, encoded);
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), '{}\n');
    fs.mkdirSync(path.join(sessionDir, 'memory'));

    // A second entry whose decoded path does NOT exist on disk
    const vanishedEncoded = '-tmp-vanished12345';
    fs.mkdirSync(path.join(projectsDir, vanishedEncoded));
  });

  afterEach(() => {
    fs.rmSync(claudeRoot, { recursive: true, force: true });
  });

  it('lists all directories when onlyExisting=false', () => {
    const r = discoverClaudeSessions({
      scanRoot: projectsDir,
      onlyExisting: false,
    });
    expect(r.isOk()).toBe(true);
    const value = r._unsafeUnwrap();
    expect(value.totalDirs).toBe(2);
    expect(value.sessions.length).toBe(2);

    const real = value.sessions.find((s) => s.projectPath === realProject);
    expect(real).toBeDefined();
    expect(real?.exists).toBe(true);
    expect(real?.sessionFiles).toBe(1);
    expect(real?.hasMemory).toBe(true);
  });

  it('drops vanished entries when onlyExisting=true (default)', () => {
    const r = discoverClaudeSessions({
      scanRoot: projectsDir,
      onlyExisting: true,
    });
    const value = r._unsafeUnwrap();
    expect(value.sessions.length).toBe(1);
    expect(value.sessions[0].projectPath).toBe(realProject);
    expect(value.sessions[0].exists).toBe(true);
  });

  it('respects excludePrefix and drops the matching session', () => {
    const r = discoverClaudeSessions({
      scanRoot: projectsDir,
      onlyExisting: true,
      excludePrefix: realProject,
    });
    expect(r._unsafeUnwrap().sessions.length).toBe(0);
  });

  it('respects the limit parameter', () => {
    // Add two more encoded entries pointing to the same real project
    for (let i = 0; i < 2; i++) {
      const extra = path.join(claudeRoot, `proj${i}`);
      fs.mkdirSync(extra);
      fs.mkdirSync(path.join(projectsDir, extra.replace(/\//g, '-')));
    }
    const r = discoverClaudeSessions({ scanRoot: projectsDir, onlyExisting: true, limit: 2 });
    expect(r._unsafeUnwrap().sessions.length).toBe(2);
  });

  it('returns an error when the scan root does not exist', () => {
    const r = discoverClaudeSessions({ scanRoot: path.join(claudeRoot, 'no-such-dir') });
    expect(r.isErr()).toBe(true);
  });
});
