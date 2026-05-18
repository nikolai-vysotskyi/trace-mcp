import { describe, expect, it, vi } from 'vitest';
import type { InferenceService } from '../../src/ai/interfaces.js';
import type { ClusterRow, DecisionRow } from '../../src/memory/decision-store.js';
import {
  buildPrompt,
  generateProjectMemo,
  hasSpecificTerms,
  stripCodeFences,
  truncateAtSentence,
} from '../../src/memory/project-memo.js';

function makeDecision(over: Partial<DecisionRow>): DecisionRow {
  return {
    id: over.id ?? 1,
    title: over.title ?? 'Decision',
    content: over.content ?? 'content',
    type: over.type ?? 'tech_choice',
    project_root: '/projects/x',
    service_name: null,
    symbol_id: null,
    file_path: null,
    tags: null,
    valid_from: '2025-01-01T00:00:00.000Z',
    valid_until: null,
    session_id: null,
    source: 'manual',
    confidence: 1,
    git_branch: null,
    review_status: null,
    created_at: over.created_at ?? '2025-01-01T00:00:00.000Z',
    updated_at: null,
    hit_count: 0,
    last_hit_at: null,
  };
}

function makeCluster(over: Partial<ClusterRow>): ClusterRow {
  return {
    id: over.id ?? 1,
    project_root: '/projects/x',
    service_name: null,
    title: over.title ?? 'Authentication',
    summary: over.summary ?? 'Auth + session handling decisions.',
    tags: over.tags ?? JSON.stringify(['auth', 'security']),
    primary_type: over.primary_type ?? 'tech_choice',
    decision_count: over.decision_count ?? 3,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: Date.now(),
  };
}

function makeInference(responseText: string): InferenceService {
  return { generate: vi.fn(async () => responseText) };
}

const SAMPLE_MEMO = `## Architecture

The codebase uses JWT auth with Redis-backed sessions. Blue-green deploys run on GitHub Actions.

## Tech stack

PostgreSQL is the system of record. Redis stores session state with TTL.

## Conventions

Tests run on every PR via GitHub Actions. Migrations live under database/migrations.

## In progress

Refactor of the session middleware to support refresh tokens.`;

describe('project-memo generator', () => {
  describe('buildPrompt', () => {
    it('includes project name + topics + grouped decisions', () => {
      const prompt = buildPrompt({
        project_name: 'myapp',
        decisions: [
          makeDecision({ id: 1, title: 'Use JWT auth', type: 'tech_choice' }),
          makeDecision({ id: 2, title: 'Blue-green deploys', type: 'architecture_decision' }),
          makeDecision({ id: 3, title: 'English-only strings', type: 'convention' }),
          makeDecision({ id: 4, title: 'Found leak in cache', type: 'discovery' }),
        ],
        clusters: [makeCluster({ title: 'Authentication' })],
      });
      expect(prompt).toContain('Project: myapp');
      expect(prompt).toContain('Topics:');
      expect(prompt).toContain('Authentication');
      expect(prompt).toContain('Architecture decisions:');
      expect(prompt).toContain('Blue-green deploys');
      expect(prompt).toContain('Tech choices:');
      expect(prompt).toContain('Use JWT auth');
      expect(prompt).toContain('Conventions:');
      expect(prompt).toContain('English-only strings');
      expect(prompt).toContain('Recent discoveries & tradeoffs:');
      expect(prompt).toContain('Found leak in cache');
      expect(prompt).toMatch(/Memo:\s*$/);
    });

    it('annotates service name when scoped', () => {
      const prompt = buildPrompt({
        project_name: 'myapp',
        service_name: 'auth-api',
        decisions: [],
        clusters: [],
      });
      expect(prompt).toContain('Service: auth-api');
    });
  });

  describe('stripCodeFences', () => {
    it('removes wrapping markdown fences', () => {
      expect(stripCodeFences('```markdown\nhello\n```')).toBe('hello');
      expect(stripCodeFences('```\nhello\n```')).toBe('hello');
    });
    it('leaves non-wrapped text alone', () => {
      expect(stripCodeFences('hello')).toBe('hello');
      expect(stripCodeFences('## heading\n\nbody')).toBe('## heading\n\nbody');
    });
  });

  describe('truncateAtSentence', () => {
    it('returns the original when under cap', () => {
      expect(truncateAtSentence('short text.', 100)).toBe('short text.');
    });

    it('truncates at the last sentence boundary inside the window', () => {
      const s = 'First sentence. Second sentence is much longer and would overshoot.';
      const out = truncateAtSentence(s, 20);
      expect(out).toBe('First sentence.');
    });

    it('falls back to last-newline when no sentence boundary fits', () => {
      const s = 'a'.repeat(60) + '\n' + 'b'.repeat(60);
      const out = truncateAtSentence(s, 70);
      expect(out.endsWith('a')).toBe(true);
      expect(out).not.toContain('b');
    });

    it('hard-slices on a space boundary when nothing else fits', () => {
      const s = 'word '.repeat(50);
      const out = truncateAtSentence(s, 20);
      // Should not end mid-word.
      expect(out.endsWith(' ')).toBe(false);
      expect(out.length).toBeLessThanOrEqual(20);
    });
  });

  describe('hasSpecificTerms', () => {
    it('passes when memo mentions a cluster title token', () => {
      expect(
        hasSpecificTerms('We do authentication via JWT.', {
          project_name: 'x',
          decisions: [],
          clusters: [makeCluster({ title: 'Authentication' })],
        }),
      ).toBe(true);
    });

    it('passes when memo mentions a decision-title token', () => {
      expect(
        hasSpecificTerms('Blue-green deploys are our jam.', {
          project_name: 'x',
          decisions: [makeDecision({ title: 'Blue-green deploys' })],
          clusters: [],
        }),
      ).toBe(true);
    });

    it('rejects generic boilerplate that shares no input tokens', () => {
      expect(
        hasSpecificTerms('This project uses unit tests and good practices.', {
          project_name: 'x',
          decisions: [makeDecision({ title: 'Use Redis cache' })],
          clusters: [makeCluster({ title: 'Authentication' })],
        }),
      ).toBe(false);
    });

    it('returns true when input has no specific terms (cannot enforce)', () => {
      expect(
        hasSpecificTerms('Anything here.', {
          project_name: 'x',
          decisions: [],
          clusters: [],
        }),
      ).toBe(true);
    });
  });

  describe('generateProjectMemo', () => {
    it('produces a memo from a happy-path inference call', async () => {
      const inference = makeInference(SAMPLE_MEMO);
      const out = await generateProjectMemo(
        {
          project_name: 'myapp',
          decisions: [
            makeDecision({ id: 1, title: 'Use JWT auth' }),
            makeDecision({ id: 2, title: 'Redis sessions', type: 'architecture_decision' }),
          ],
          clusters: [makeCluster({ title: 'Authentication' })],
        },
        { provider: inference, model: 'mock' },
      );
      expect(out.memo_md).toContain('Architecture');
      expect(out.estimated_tokens).toBeGreaterThan(0);
      expect(inference.generate).toHaveBeenCalledTimes(1);
    });

    it('rejects generic boilerplate by returning an empty memo', async () => {
      const inference = makeInference(
        '## Architecture\n\nThis project uses good engineering practices.',
      );
      const out = await generateProjectMemo(
        {
          project_name: 'myapp',
          decisions: [makeDecision({ id: 1, title: 'Use JWT auth' })],
          clusters: [makeCluster({ title: 'Authentication' })],
        },
        { provider: inference, model: 'mock' },
      );
      expect(out.memo_md).toBe('');
      expect(out.estimated_tokens).toBe(0);
    });

    it('returns an empty memo when inference throws', async () => {
      const inference: InferenceService = {
        generate: vi.fn(async () => {
          throw new Error('provider down');
        }),
      };
      const out = await generateProjectMemo(
        {
          project_name: 'myapp',
          decisions: [makeDecision({ title: 'Use JWT auth' })],
          clusters: [makeCluster({ title: 'Authentication' })],
        },
        { provider: inference, model: 'mock' },
      );
      expect(out.memo_md).toBe('');
    });

    it('truncates at sentence boundary when LLM overruns the target', async () => {
      // Build a long but specific output containing the input token.
      const long = 'Authentication is central. '.repeat(200);
      const inference = makeInference(long);
      const out = await generateProjectMemo(
        {
          project_name: 'myapp',
          decisions: [],
          clusters: [makeCluster({ title: 'Authentication' })],
        },
        { provider: inference, model: 'mock', targetTokens: 100 },
      );
      // Hard cap: targetTokens * 2 * 4 chars/token = 800 chars.
      expect(out.memo_md.length).toBeLessThanOrEqual(800);
      // Truncated at a sentence boundary — last char should be '.'.
      expect(out.memo_md.endsWith('.')).toBe(true);
    });

    it('honors the abort signal forwarded to the inference call', async () => {
      const inference: InferenceService = {
        generate: vi.fn(async (_prompt, opts) => {
          if (opts?.signal?.aborted) throw new Error('aborted');
          return SAMPLE_MEMO;
        }),
      };
      const controller = new AbortController();
      controller.abort();
      const out = await generateProjectMemo(
        {
          project_name: 'myapp',
          decisions: [makeDecision({ title: 'Use JWT auth' })],
          clusters: [makeCluster({ title: 'Authentication' })],
        },
        { provider: inference, model: 'mock', abortSignal: controller.signal },
      );
      expect(out.memo_md).toBe('');
    });
  });
});
