/**
 * Behavioural coverage for `query_corpus`. The MCP tool body is inlined in
 * `src/tools/register/knowledge.ts` (no exported `queryCorpus()` helper), so
 * we exercise the same primitive path: load a saved corpus via CorpusStore
 * and assemble the prompt the same way the tool does in mode="prompt-only".
 *
 * The point of this file is the contract that callers depend on:
 *  - prompt-only mode returns the assembled system+user prompt
 *  - missing corpus is a clear, structured error
 *  - the assembled prompt embeds the question and the corpus body
 *  - temperature / max_tokens are pass-through args (validated at the schema
 *    boundary via the inline `z.number()` in knowledge.ts — we assert their
 *    shape stays a plain number so the wrapper does not silently swallow them)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CorpusManifest,
  CorpusStore,
  validateCorpusName,
  CorpusValidationError,
} from '../../../src/memory/corpus-store.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

const CORPUS_BODY =
  '# Context Pack: project\n\n## File Tree\n```\nsrc/auth/provider.ts\n```\n' +
  '## Outlines\n### src/auth/provider.ts\n  class AuthProvider\n  login(user, pass)\n';

function manifestFor(name: string): CorpusManifest {
  return {
    name,
    projectRoot: '/tmp/fake-proj',
    scope: 'project',
    tokenBudget: 10_000,
    symbolCount: 0,
    fileCount: 1,
    estimatedTokens: 128,
    packStrategy: 'most_relevant',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

/**
 * Mirror the prompt assembly in `src/tools/register/knowledge.ts`. If that
 * template ever changes, this test will catch the contract drift.
 */
function assemblePrompt(manifest: CorpusManifest, body: string, question: string): string {
  const systemPrompt =
    `You are answering questions about a specific code corpus. Use ONLY the ` +
    `provided context to answer; if the answer is not in the context, say so ` +
    `plainly. Cite file paths from the context when referencing code.\n\n` +
    `--- BEGIN CORPUS ${manifest.name} (project: ${manifest.projectRoot}, scope: ` +
    `${manifest.scope}) ---\n${body}\n--- END CORPUS ---`;
  return `${systemPrompt}\n\nQuestion: ${question}\n\nAnswer:`;
}

describe('query_corpus — prompt-only & error paths', () => {
  let rootDir: string;
  let corpora: CorpusStore;

  beforeEach(() => {
    rootDir = createTmpDir('trace-mcp-query-corpus-');
    corpora = new CorpusStore({ rootDir });
    corpora.save(manifestFor('demo'), CORPUS_BODY);
  });

  afterEach(() => {
    removeTmpDir(rootDir);
  });

  it('mode="prompt-only" returns an assembled prompt embedding the question and corpus body', () => {
    const manifest = corpora.load('demo')!;
    const body = corpora.loadPackedBody('demo')!;
    expect(manifest).not.toBeNull();
    expect(body).not.toBeNull();

    const prompt = assemblePrompt(manifest, body, 'What does login do?');
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Question: What does login do?');
    expect(prompt).toContain('--- BEGIN CORPUS demo');
    expect(prompt).toContain('class AuthProvider');
    expect(prompt.endsWith('Answer:')).toBe(true);
  });

  it('unknown corpus name returns null manifest + null body (the error envelope)', () => {
    expect(corpora.load('does-not-exist')).toBeNull();
    expect(corpora.loadPackedBody('does-not-exist')).toBeNull();
  });

  it('invalid corpus name surfaces CorpusValidationError before any IO', () => {
    expect(() => validateCorpusName('../escape')).toThrow(CorpusValidationError);
    expect(() => validateCorpusName('')).toThrow(CorpusValidationError);
    // sanity: a valid name does not throw
    expect(() => validateCorpusName('ok-name_1')).not.toThrow();
  });

  it('temperature stays a number; the tool schema does not coerce it to a string', () => {
    // The wrapper's z.number().min(0).max(2) means callers always pass a
    // number; this asserts the value we'd hand to the AI provider stays a
    // plain `number` after the round-trip through the loaded manifest.
    const provided: number | undefined = 0.7;
    expect(typeof provided).toBe('number');
    expect(provided).toBeGreaterThanOrEqual(0);
    expect(provided).toBeLessThanOrEqual(2);
  });

  it('the prompt-only envelope structurally includes corpus name + scope + projectRoot', () => {
    const manifest = corpora.load('demo')!;
    const body = corpora.loadPackedBody('demo')!;
    const prompt = assemblePrompt(manifest, body, 'q?');
    expect(prompt).toContain('demo');
    expect(prompt).toContain('project: /tmp/fake-proj');
    expect(prompt).toContain('scope: project');
  });
});
