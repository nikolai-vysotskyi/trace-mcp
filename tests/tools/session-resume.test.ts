import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSessionSummary, getSessionResume } from '../../src/session/resume.js';

// Use a temp dir to avoid polluting real ~/.trace-mcp
// We need to mock the SESSIONS_DIR — since session-resume uses TRACE_MCP_HOME,
// we test with a real project root that hashes deterministically.

describe('Session Resume', () => {
  const sessionsDir = path.join(os.homedir(), '.trace-mcp', 'sessions');

  // Use a unique fake project root per TEST to avoid cross-test contamination
  let fakeProjectRoot: string;

  beforeEach(() => {
    fakeProjectRoot = `/tmp/test-project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(() => {
    // Clean up session files
    try {
      const files = fs.readdirSync(sessionsDir);
      for (const f of files) {
        const filePath = path.join(sessionsDir, f);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          if (content.includes('test-project')) {
            fs.unlinkSync(filePath);
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  });

  it('returns empty resume for project with no sessions', () => {
    const resume = getSessionResume(fakeProjectRoot);
    expect(resume.sessions_available).toBe(0);
    expect(resume.recent_sessions).toHaveLength(0);
    expect(resume.hot_files).toHaveLength(0);
  });

  it('persists and retrieves a session summary', () => {
    flushSessionSummary({
      projectRoot: fakeProjectRoot,
      startedAt: new Date(Date.now() - 300000).toISOString(),
      totalCalls: 25,
      filesTouched: ['src/server.ts', 'src/config.ts'],
      topTools: { get_symbol: 10, search: 8, get_outline: 7 },
      deadEnds: ['search("nonexistentThing")'],
      dedupSavedTokens: 1500,
    });

    const resume = getSessionResume(fakeProjectRoot);
    expect(resume.sessions_available).toBe(1);
    expect(resume.recent_sessions).toHaveLength(1);
    expect(resume.recent_sessions[0].calls).toBe(25);
    expect(resume.recent_sessions[0].files_touched).toContain('src/server.ts');
  });

  it('aggregates multiple sessions and finds hot files', () => {
    // Session 1
    flushSessionSummary({
      projectRoot: fakeProjectRoot,
      startedAt: new Date(Date.now() - 600000).toISOString(),
      totalCalls: 10,
      filesTouched: ['src/server.ts', 'src/config.ts'],
      topTools: { get_symbol: 5, search: 5 },
      deadEnds: ['search("missing")'],
      dedupSavedTokens: 500,
    });

    // Session 2
    flushSessionSummary({
      projectRoot: fakeProjectRoot,
      startedAt: new Date(Date.now() - 300000).toISOString(),
      totalCalls: 15,
      filesTouched: ['src/server.ts', 'src/index.ts'],
      topTools: { get_outline: 8, get_symbol: 7 },
      deadEnds: ['search("missing")'],
      dedupSavedTokens: 800,
    });

    const resume = getSessionResume(fakeProjectRoot);
    expect(resume.sessions_available).toBe(2);
    expect(resume.recent_sessions).toHaveLength(2);

    // src/server.ts should be a hot file (appeared in both sessions)
    expect(resume.hot_files.some((f) => f.file === 'src/server.ts')).toBe(true);

    // "missing" dead end appeared in both sessions
    expect(resume.persistent_dead_ends).toContain('search("missing")');
  });

  it('skips empty sessions (0 calls)', () => {
    flushSessionSummary({
      projectRoot: fakeProjectRoot,
      startedAt: new Date().toISOString(),
      totalCalls: 0,
      filesTouched: [],
      topTools: {},
      deadEnds: [],
      dedupSavedTokens: 0,
    });

    const resume = getSessionResume(fakeProjectRoot);
    expect(resume.sessions_available).toBe(0);
  });

  it('respects max_sessions parameter', () => {
    for (let i = 0; i < 10; i++) {
      flushSessionSummary({
        projectRoot: fakeProjectRoot,
        startedAt: new Date(Date.now() - (10 - i) * 60000).toISOString(),
        totalCalls: i + 1,
        filesTouched: [`file-${i}.ts`],
        topTools: { search: i + 1 },
        deadEnds: [],
        dedupSavedTokens: 0,
      });
    }

    const resume3 = getSessionResume(fakeProjectRoot, 3);
    expect(resume3.recent_sessions).toHaveLength(3);
    // Should be the 3 most recent
    expect(resume3.recent_sessions[2].calls).toBe(10);

    const resume5 = getSessionResume(fakeProjectRoot, 5);
    expect(resume5.recent_sessions).toHaveLength(5);
  });
});
