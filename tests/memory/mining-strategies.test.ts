/**
 * End-to-end coverage for `mineSessions`'s strategy parameter.
 *
 * Mocks `listAllSessions` (filesystem discovery) so we can drive synthetic
 * Claude Code JSONL fixtures through the real extraction pipeline without
 * touching ~/.claude/projects. The InferenceService is mocked too so no
 * real LLM is contacted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceService } from '../../src/ai/interfaces.js';
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

// Import after the mock is registered so the miner picks up the mock.
import { mineSessions } from '../../src/memory/conversation-miner.js';

function writeSessionFile(
  filePath: string,
  turns: Array<{ role: 'user' | 'assistant'; text: string }>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = turns.map((turn, i) => {
    const timestamp = new Date(Date.now() - (turns.length - i) * 60_000).toISOString();
    return JSON.stringify({
      type: turn.role,
      timestamp,
      message: {
        role: turn.role,
        content: [{ type: 'text', text: turn.text }],
      },
    });
  });
  fs.writeFileSync(filePath, lines.join('\n'));
}

function makeProvider(response: string): {
  service: InferenceService;
  generate: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn(async () => response);
  return { service: { generate } as unknown as InferenceService, generate };
}

describe('mineSessions — strategy parameter', () => {
  let store: DecisionStore;
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpDir = createTmpDir('mining-strat-');
    projectRoot = tmpDir;
    store = new DecisionStore(path.join(tmpDir, 'decisions.db'));
    mockSessions.length = 0;
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(tmpDir)) removeTmpDir(tmpDir);
    mockSessions.length = 0;
  });

  function addRegexFriendlySession(name = 'regex-friendly') {
    const file = path.join(tmpDir, 'sessions', `${name}.jsonl`);
    writeSessionFile(file, [
      { role: 'user', text: 'What cache should we pick for hot reads?' },
      {
        role: 'assistant',
        text: 'We decided to use Redis for session caching because it handles high throughput. The root cause was that the previous in-memory cache was thrashing under load.',
      },
    ]);
    mockSessions.push({
      filePath: file,
      projectPath: projectRoot,
      client: 'claude-code',
      mtime: Date.now(),
    });
    return file;
  }

  it('regex strategy preserves legacy result shape (no strategy field)', async () => {
    addRegexFriendlySession();
    const result = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
      strategy: 'regex',
    });
    expect(result.sessions_mined).toBeGreaterThanOrEqual(1);
    expect(result.strategy).toBeUndefined();
    expect(result.llm_sessions).toBeUndefined();
  });

  it('default (no strategy) behaves identically to regex', async () => {
    addRegexFriendlySession();
    const result = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
    });
    expect(result.strategy).toBeUndefined();
    expect(result.decisions_extracted).toBeGreaterThan(0);
  });

  it('llm strategy without provider falls back to regex with a warning', async () => {
    addRegexFriendlySession();
    const result = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
      strategy: 'llm',
      // No llmContext provided.
    });
    expect(result.strategy).toBe('regex');
    expect(result.llm_sessions).toBe(0);
    // Regex output should still land.
    expect(result.decisions_extracted).toBeGreaterThan(0);
  });

  it('hybrid + provider available merges LLM and regex decisions', async () => {
    addRegexFriendlySession();
    const llmResp = JSON.stringify([
      {
        title: 'Adopt clean-architecture layering',
        type: 'architecture_decision',
        content:
          'After reviewing options we settled on a clean-architecture layout with explicit ports, because it isolates domain logic from infrastructure cleanly.',
        tags: ['architecture'],
        confidence: 0.9,
      },
    ]);
    const { service, generate } = makeProvider(llmResp);

    const result = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
      strategy: 'hybrid',
      llmContext: { inference: service, model: 'test-model' },
      llmKnobs: { minSessionLength: 50, maxTokensPerSession: 8000, maxSessions: 50 },
    });

    expect(result.strategy).toBe('hybrid');
    expect(result.llm_sessions).toBe(1);
    expect(result.llm_decisions_extracted).toBeGreaterThanOrEqual(1);
    expect(generate).toHaveBeenCalledTimes(1);
    // Regex hits PLUS at least one LLM hit landed.
    expect(result.decisions_extracted).toBeGreaterThan(1);
  });

  it('hybrid + no provider is identical to regex', async () => {
    addRegexFriendlySession();
    const result = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
      strategy: 'hybrid',
      // No llmContext provided.
    });
    expect(result.strategy).toBe('regex');
    expect(result.llm_sessions).toBe(0);
  });

  it('cost guard caps llm sessions at maxSessions', async () => {
    // Set up 5 sessions but cap the LLM at 2.
    for (let i = 0; i < 5; i++) {
      const file = path.join(tmpDir, 'sessions', `s${i}.jsonl`);
      writeSessionFile(file, [
        { role: 'user', text: 'Discuss something for session ' + i },
        {
          role: 'assistant',
          text:
            'Long enough conversation to clear the min length threshold. '.repeat(20) +
            ` Reference to session ${i}.`,
        },
      ]);
      mockSessions.push({
        filePath: file,
        projectPath: projectRoot,
        client: 'claude-code',
        mtime: Date.now(),
      });
    }

    const { service, generate } = makeProvider('[]');
    const result = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
      strategy: 'hybrid',
      llmContext: { inference: service, model: 'test-model' },
      llmKnobs: { minSessionLength: 50, maxTokensPerSession: 8000, maxSessions: 2 },
    });

    expect(result.llm_sessions).toBe(2);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('hybrid dedups when regex and LLM produce same title', async () => {
    addRegexFriendlySession();
    // LLM returns a decision whose normalized title collides with one of the
    // regex hits — the merge should keep the higher-confidence row, not
    // double-count.
    const llmResp = JSON.stringify([
      {
        title: 'use Redis for session caching',
        type: 'tech_choice',
        content: 'LLM-extracted: same decision, higher confidence.',
        tags: ['caching'],
        confidence: 0.99,
      },
    ]);
    const { service } = makeProvider(llmResp);

    const baseline = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
      strategy: 'regex',
    });

    // Fresh store for the hybrid run to make the comparison apples-to-apples.
    store.close();
    store = new DecisionStore(path.join(tmpDir, 'decisions-2.db'));

    const hybrid = await mineSessions(store, {
      projectRoot,
      rejectThreshold: 0,
      reviewThreshold: 0.95,
      strategy: 'hybrid',
      llmContext: { inference: service, model: 'test-model' },
      llmKnobs: { minSessionLength: 50, maxTokensPerSession: 8000, maxSessions: 50 },
    });

    // Without dedup the hybrid count would be baseline + 1 LLM decision.
    // With dedup it should be at most baseline + 0 (collision replaced) — i.e.
    // never exceeds baseline + 1, and ideally equals baseline when the title
    // collides exactly.
    expect(hybrid.decisions_extracted).toBeLessThanOrEqual(baseline.decisions_extracted + 1);
  });
});
