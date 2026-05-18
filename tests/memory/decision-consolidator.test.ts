/**
 * Unit tests for `consolidateOne`, `parseVerdicts`, `mergeContents`,
 * `mergeTags` in src/memory/decision-consolidator.ts.
 *
 * These tests exercise pure logic only — no real LLM, no DecisionStore.
 * The InferenceService is mocked via `vi.fn` returning canned JSON
 * strings.
 */

import { describe, expect, it, vi } from 'vitest';
import type { InferenceService } from '../../src/ai/interfaces.js';
import {
  consolidateOne,
  mergeContents,
  mergeTags,
  parseVerdicts,
  type ConsolidationVerdict,
} from '../../src/memory/decision-consolidator.js';
import type { DecisionRow } from '../../src/memory/decision-store.js';

function makeInference(responseText: string): InferenceService & {
  generate: ReturnType<typeof vi.fn>;
} {
  return {
    generate: vi.fn(async () => responseText),
  };
}

function makeFailingInference(err: Error): InferenceService & {
  generate: ReturnType<typeof vi.fn>;
} {
  return {
    generate: vi.fn(async () => {
      throw err;
    }),
  };
}

let nextId = 1;
function row(partial: Partial<DecisionRow> & { title: string; content: string }): DecisionRow {
  const id = partial.id ?? nextId++;
  return {
    id,
    title: partial.title,
    content: partial.content,
    type: partial.type ?? 'architecture_decision',
    project_root: partial.project_root ?? '/projects/test',
    service_name: partial.service_name ?? null,
    symbol_id: partial.symbol_id ?? null,
    file_path: partial.file_path ?? null,
    tags: partial.tags ?? null,
    valid_from: partial.valid_from ?? new Date().toISOString(),
    valid_until: partial.valid_until ?? null,
    session_id: partial.session_id ?? null,
    source: partial.source ?? 'manual',
    confidence: partial.confidence ?? 1.0,
    git_branch: partial.git_branch ?? null,
    review_status: partial.review_status ?? null,
    created_at: partial.created_at ?? new Date().toISOString(),
    updated_at: partial.updated_at ?? Date.now(),
    hit_count: partial.hit_count ?? 0,
    last_hit_at: partial.last_hit_at ?? null,
  };
}

describe('consolidateOne', () => {
  it('returns [] when candidates list is empty', async () => {
    const subject = row({ title: 'Use JWT for auth', content: 'Short-lived tokens.' });
    const inference = makeInference('[]');
    const result = await consolidateOne(
      { subject, candidates: [] },
      { provider: inference, model: 'mock' },
    );
    expect(result).toEqual([]);
    // Should not even call the LLM when there are no candidates.
    expect(inference.generate).not.toHaveBeenCalled();
  });

  it('returns a merge_into_existing verdict when LLM picks one', async () => {
    const subject = row({ title: 'Use JWT auth', content: 'JWT with refresh tokens.' });
    const candidate = row({ title: 'Use JWT for authentication', content: 'JWT bearer tokens.' });
    const llmResponse = JSON.stringify([
      {
        existing_id: candidate.id,
        verdict: 'merge_into_existing',
        rationale_short: 'restates the candidate',
      },
    ]);
    const inference = makeInference(llmResponse);
    const result = await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock' },
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: 'merge_into_existing',
      existing_id: candidate.id,
      merged_content_hint: undefined,
    });
  });

  it('returns a replace_existing verdict', async () => {
    const subject = row({ title: 'JWT with rotation', content: 'Refined JWT scheme.' });
    const candidate = row({ title: 'Use JWT', content: 'Earlier draft.' });
    const inference = makeInference(
      JSON.stringify([{ existing_id: candidate.id, verdict: 'replace_existing' }]),
    );
    const result = await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock' },
    );
    expect(result).toEqual([{ kind: 'replace_existing', existing_id: candidate.id }]);
  });

  it('returns an invalidate_existing verdict', async () => {
    const subject = row({ title: 'Drop the auth strategy', content: '' });
    const candidate = row({ title: 'Use JWT', content: 'Old.' });
    const inference = makeInference(
      JSON.stringify([{ existing_id: candidate.id, verdict: 'invalidate_existing' }]),
    );
    const result = await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock' },
    );
    expect(result).toEqual([{ kind: 'invalidate_existing', existing_id: candidate.id }]);
  });

  it('omits verdicts for keep_separate (default)', async () => {
    const subject = row({ title: 'Use JWT auth', content: 'JWT.' });
    const candidate = row({ title: 'Use Redis sessions', content: 'Sessions in Redis.' });
    const inference = makeInference('[]');
    const result = await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock' },
    );
    expect(result).toEqual([]);
  });

  it('drops verdicts referencing unknown existing_ids', async () => {
    const subject = row({ title: 'Use JWT auth', content: 'JWT.' });
    const candidate = row({ title: 'Use JWT', content: 'JWT.' });
    // existing_id 99999 is not in the candidate set.
    const inference = makeInference(
      JSON.stringify([
        { existing_id: 99999, verdict: 'merge_into_existing' },
        { existing_id: candidate.id, verdict: 'replace_existing' },
      ]),
    );
    const result = await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock' },
    );
    expect(result).toEqual([{ kind: 'replace_existing', existing_id: candidate.id }]);
  });

  it('handles malformed JSON gracefully by returning []', async () => {
    const subject = row({ title: 'Use JWT auth', content: 'JWT.' });
    const candidate = row({ title: 'Use JWT', content: 'JWT.' });
    const inference = makeInference('this is not JSON at all');
    const result = await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock' },
    );
    expect(result).toEqual([]);
  });

  it('handles a non-array JSON response by returning []', async () => {
    const subject = row({ title: 'Use JWT auth', content: 'JWT.' });
    const candidate = row({ title: 'Use JWT', content: 'JWT.' });
    const inference = makeInference('{"verdict": "merge_into_existing"}');
    const result = await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock' },
    );
    expect(result).toEqual([]);
  });

  it('returns [] when the provider throws', async () => {
    const subject = row({ title: 'Use JWT auth', content: 'JWT.' });
    const candidate = row({ title: 'Use JWT', content: 'JWT.' });
    const inference = makeFailingInference(new Error('network down'));
    const result = await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock' },
    );
    expect(result).toEqual([]);
  });

  it('forwards abortSignal to provider.generate', async () => {
    const subject = row({ title: 'Use JWT auth', content: 'JWT.' });
    const candidate = row({ title: 'Use JWT', content: 'JWT.' });
    const inference = makeInference('[]');
    const controller = new AbortController();
    await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock', abortSignal: controller.signal },
    );
    const callArgs = inference.generate.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(callArgs?.signal).toBe(controller.signal);
  });

  it('caps candidates at MAX_CANDIDATES_PER_CALL (5)', async () => {
    const subject = row({ title: 'Use JWT auth', content: 'JWT.' });
    const candidates = Array.from({ length: 10 }, (_, i) =>
      row({ title: `Use JWT variant ${i}`, content: `JWT variant ${i}` }),
    );
    const inference = makeInference('[]');
    await consolidateOne({ subject, candidates }, { provider: inference, model: 'mock' });
    const prompt = inference.generate.mock.calls[0]?.[0] as string;
    // Count occurrences of '[N] id=' header to assert the cap.
    const headerMatches = prompt.match(/\[\d+\] id=/g) ?? [];
    expect(headerMatches.length).toBe(5);
  });

  it('excludes the subject itself from candidates even if duplicated in input', async () => {
    const subject = row({ id: 42, title: 'Use JWT auth', content: 'JWT.' });
    const inference = makeInference('[]');
    await consolidateOne(
      { subject, candidates: [subject] },
      { provider: inference, model: 'mock' },
    );
    // No candidates left → no LLM call.
    expect(inference.generate).not.toHaveBeenCalled();
  });

  it('deduplicates verdicts that reference the same existing_id twice', async () => {
    const subject = row({ title: 'Use JWT auth', content: 'JWT.' });
    const candidate = row({ title: 'Use JWT', content: 'JWT.' });
    const inference = makeInference(
      JSON.stringify([
        { existing_id: candidate.id, verdict: 'merge_into_existing' },
        { existing_id: candidate.id, verdict: 'replace_existing' },
      ]),
    );
    const result = await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock' },
    );
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('merge_into_existing');
  });

  it('drops verdicts with unknown verdict kind', async () => {
    const subject = row({ title: 'Use JWT auth', content: 'JWT.' });
    const candidate = row({ title: 'Use JWT', content: 'JWT.' });
    const inference = makeInference(
      JSON.stringify([
        { existing_id: candidate.id, verdict: 'shred_database' },
        { existing_id: candidate.id, verdict: 'merge_into_existing' },
      ]),
    );
    const result = await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock' },
    );
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('merge_into_existing');
  });

  it('tolerates LLM responses wrapped in markdown fences', async () => {
    const subject = row({ title: 'Use JWT auth', content: 'JWT.' });
    const candidate = row({ title: 'Use JWT', content: 'JWT.' });
    const responseInFence = `Here's the answer:\n\n\`\`\`json\n[{"existing_id": ${candidate.id}, "verdict": "merge_into_existing"}]\n\`\`\`\n\nDone.`;
    const inference = makeInference(responseInFence);
    const result = await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock' },
    );
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('merge_into_existing');
  });

  it('honors merged_content_hint when present', async () => {
    const subject = row({ title: 'Use JWT auth', content: 'JWT.' });
    const candidate = row({ title: 'Use JWT', content: 'JWT.' });
    const inference = makeInference(
      JSON.stringify([
        {
          existing_id: candidate.id,
          verdict: 'merge_into_existing',
          merged_content_hint: 'Use JWT bearer tokens with refresh rotation.',
        },
      ]),
    );
    const result = await consolidateOne(
      { subject, candidates: [candidate] },
      { provider: inference, model: 'mock' },
    );
    expect(result[0]).toEqual({
      kind: 'merge_into_existing',
      existing_id: candidate.id,
      merged_content_hint: 'Use JWT bearer tokens with refresh rotation.',
    });
  });
});

describe('parseVerdicts', () => {
  it('parses a clean array', () => {
    const validIds = new Set([10, 20]);
    const result = parseVerdicts(
      JSON.stringify([
        { existing_id: 10, verdict: 'merge_into_existing' },
        { existing_id: 20, verdict: 'replace_existing' },
      ]),
      validIds,
    );
    expect(result).toEqual<ConsolidationVerdict[]>([
      { kind: 'merge_into_existing', existing_id: 10, merged_content_hint: undefined },
      { kind: 'replace_existing', existing_id: 20 },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseVerdicts('', new Set())).toEqual([]);
    expect(parseVerdicts('[]', new Set())).toEqual([]);
  });
});

describe('mergeContents', () => {
  it('returns existing when subject is empty', () => {
    expect(mergeContents('existing body', '')).toBe('existing body');
  });

  it('returns subject when existing is empty', () => {
    expect(mergeContents('', 'subject body')).toBe('subject body');
  });

  it('concatenates with separator', () => {
    expect(mergeContents('a', 'b')).toBe('a\n\n[merged] b');
  });

  it('no-ops when subject is a substring of existing', () => {
    expect(mergeContents('foo bar baz', 'bar')).toBe('foo bar baz');
  });
});

describe('mergeTags', () => {
  it('unions while preserving order of the first array', () => {
    expect(mergeTags(['auth', 'jwt'], ['jwt', 'security'])).toEqual(['auth', 'jwt', 'security']);
  });

  it('handles undefined / empty input', () => {
    expect(mergeTags(undefined, ['x'])).toEqual(['x']);
    expect(mergeTags(['x'], undefined)).toEqual(['x']);
    expect(mergeTags(undefined, undefined)).toEqual([]);
  });

  it('caps at 20 tags', () => {
    const a = Array.from({ length: 25 }, (_, i) => `tag${i}`);
    expect(mergeTags(a, [])).toHaveLength(20);
  });
});
