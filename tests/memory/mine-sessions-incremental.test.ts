/**
 * End-to-end coverage for the P2.3 incremental cursor in `mineSessions`.
 *
 * Drives the real extraction pipeline against synthetic Claude Code JSONL
 * fixtures, asserting that re-mining picks up only the appended portion
 * once a session has been mined once.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionStore } from '../../src/memory/decision-store.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

type MockSession = {
  filePath: string;
  projectPath: string;
  client: 'claude-code' | 'claw-code';
  mtime: number;
};
const mockSessions: MockSession[] = [];

vi.mock('../../src/analytics/log-parser.js', () => ({
  listAllSessions: () => mockSessions.slice(),
}));

// Import after the mock so the miner picks it up.
import { mineSessions } from '../../src/memory/conversation-miner.js';

function turnRecord(role: 'user' | 'assistant', text: string, tsOffset: number): string {
  return JSON.stringify({
    type: role,
    timestamp: new Date(1_700_000_000_000 + tsOffset * 1000).toISOString(),
    message: { role, content: [{ type: 'text', text }] },
  });
}

function decisionTurns(prefix: string): Array<{ role: 'user' | 'assistant'; text: string }> {
  return [
    { role: 'user', text: `${prefix} — what cache for hot reads?` },
    {
      role: 'assistant',
      text: `${prefix} — we decided to use Redis for session caching because it handles high throughput consistently across nodes.`,
    },
  ];
}

function writeSessionFile(
  filePath: string,
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = turns.map((t, i) => turnRecord(t.role, t.text, i));
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

function appendSessionFile(
  filePath: string,
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
  tsBase: number,
): void {
  const lines = turns.map((t, i) => turnRecord(t.role, t.text, tsBase + i));
  fs.appendFileSync(filePath, lines.join('\n') + '\n');
}

describe('mineSessions — incremental cursor', () => {
  let store: DecisionStore;
  let tmpDir: string;
  let projectRoot: string;
  let sessionFile: string;

  beforeEach(() => {
    tmpDir = createTmpDir('mine-incr-');
    projectRoot = tmpDir;
    store = new DecisionStore(path.join(tmpDir, 'decisions.db'));
    sessionFile = path.join(tmpDir, 'sessions', 'session.jsonl');
    mockSessions.length = 0;
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
    mockSessions.length = 0;
  });

  function registerSession() {
    mockSessions.push({
      filePath: sessionFile,
      projectPath: projectRoot,
      client: 'claude-code',
      mtime: Date.now(),
    });
  }

  it('two-pass: appended bytes are mined on the second pass', async () => {
    writeSessionFile(sessionFile, decisionTurns('pass-1'));
    registerSession();

    const first = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    expect(first.sessions_mined).toBeGreaterThanOrEqual(1);
    const firstExtracted = first.decisions_extracted;
    expect(firstExtracted).toBeGreaterThan(0);

    // Append fresh decision content to the same file.
    appendSessionFile(sessionFile, decisionTurns('pass-2'), 100);

    const second = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    // We expect new decisions extracted in this pass — proves the appended
    // bytes were parsed (the legacy code would skip the session entirely).
    expect(second.decisions_extracted).toBeGreaterThan(0);
    expect(second.sessions_mined).toBeGreaterThanOrEqual(1);
  });

  it('shrunk file triggers a full re-mine from offset 0', async () => {
    writeSessionFile(sessionFile, decisionTurns('initial-long-content'));
    registerSession();
    const first = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    expect(first.decisions_extracted).toBeGreaterThan(0);

    // Replace with a SHORTER file containing fresh decision content.
    fs.writeFileSync(sessionFile, '');
    writeSessionFile(sessionFile, decisionTurns('short'));

    const second = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    // Shrunk-then-rewritten file should re-mine from 0 → produce decisions.
    expect(second.decisions_extracted).toBeGreaterThan(0);
  });

  it('unchanged file is skipped without re-parsing on the second pass', async () => {
    writeSessionFile(sessionFile, decisionTurns('only-pass'));
    registerSession();

    const first = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    expect(first.sessions_mined).toBeGreaterThanOrEqual(1);

    const second = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    // No changes to the file → cursor returns null → session is skipped.
    expect(second.sessions_mined).toBe(0);
    expect(second.sessions_skipped).toBeGreaterThanOrEqual(1);
    expect(second.decisions_extracted).toBe(0);
  });

  it('force=true ignores the cursor and re-reads the full file', async () => {
    writeSessionFile(sessionFile, decisionTurns('force-pass'));
    registerSession();

    const first = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    expect(first.decisions_extracted).toBeGreaterThan(0);

    // Same file, no append — but force=true forces a re-read.
    const second = await mineSessions(store, {
      projectRoot,
      force: true,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    // Re-extracts the same decisions (count > 0). Without force this would be 0.
    expect(second.sessions_mined).toBeGreaterThanOrEqual(1);
    expect(second.decisions_extracted).toBeGreaterThan(0);
  });

  it('incrementalCursor=false falls back to legacy binary mined/unmined', async () => {
    writeSessionFile(sessionFile, decisionTurns('legacy-pass'));
    registerSession();

    const first = await mineSessions(store, {
      projectRoot,
      incrementalCursor: false,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    expect(first.sessions_mined).toBeGreaterThanOrEqual(1);

    // Append fresh content — legacy mode IGNORES it.
    appendSessionFile(sessionFile, decisionTurns('legacy-pass-2'), 100);

    const second = await mineSessions(store, {
      projectRoot,
      incrementalCursor: false,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    // Legacy binary: already mined → skipped, no new extraction even though
    // the file grew.
    expect(second.sessions_mined).toBe(0);
    expect(second.decisions_extracted).toBe(0);
    expect(second.sessions_skipped).toBeGreaterThanOrEqual(1);
  });
});
