import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODELS, PROMPTS, scoreResponse } from '../../scripts/geo-battery.mjs';

/**
 * The GEO-battery prompt list is frozen: `scripts/geo-battery.mjs` owns it,
 * `ops/geo-ranks.md` repeats it for humans, and this test fails if the two
 * drift apart — a silent prompt swap would break the week-to-week trend
 * without any other test noticing. The scorer underneath is a pure function;
 * its determinism is what makes "second run gives a comparable table" true
 * for hand-collected answers. (TRA-1947)
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const ranks = readFileSync(join(REPO_ROOT, 'ops/geo-ranks.md'), 'utf-8');

describe('GEO-battery prompt list is frozen', () => {
  it('exports exactly 20 prompts with sequential P01..P20 ids', () => {
    expect(PROMPTS).toHaveLength(20);
    expect(PROMPTS.map((p) => p.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('every prompt is a non-trivial unique question', () => {
    const texts = PROMPTS.map((p) => p.text);
    expect(new Set(texts).size).toBe(20);
    for (const t of texts) {
      expect(t.length).toBeGreaterThan(20);
      expect(t).toMatch(/\?$/);
    }
  });

  it('covers all five intent lanes from the issue', () => {
    const all = PROMPTS.map((p) => p.text).join('\n');
    for (const lane of ['code graph', 'Claude Code', 'Laravel', 'Django', 'Spring']) {
      expect(all).toContain(lane);
    }
    expect(all).toMatch(/blast radius|impact analysis/i);
    expect(all).toMatch(/Repomix|repomix/);
    expect(all).toMatch(/Serena|serena/);
  });

  it('pins 4 models on 4 surfaces', () => {
    expect(MODELS.map((m) => m.platform).sort()).toEqual(
      ['chat_gpt', 'claude', 'gemini', 'perplexity'].sort(),
    );
    for (const m of MODELS) {
      expect(m.model.length).toBeGreaterThan(0);
      expect(m.endpoint).toContain('llm_responses/live');
    }
  });

  it('ops/geo-ranks.md repeats every prompt verbatim', () => {
    for (const p of PROMPTS) {
      expect(ranks, `prompt ${p.id} missing from ops/geo-ranks.md`).toContain(p.text);
    }
  });
});

describe('GEO-battery scorer is deterministic', () => {
  const listed = [
    '1. Serena — symbol navigation.',
    '2. Sourcegraph — cross-repo search.',
    '3. trace-mcp — precomputed code graph over MCP.',
  ].join('\n');

  it('finds a mention at its list position', () => {
    expect(scoreResponse(listed, [])).toEqual({
      mentioned: true,
      cited: false,
      position: 3,
      top10: true,
      top50: true,
    });
  });

  it('reports a clean zero when we are absent', () => {
    expect(scoreResponse('1. Serena.\n2. Sourcegraph.', [])).toEqual({
      mentioned: false,
      cited: false,
      position: null,
      top10: false,
      top50: false,
    });
  });

  it('counts a cited source even without prose mention', () => {
    const s = scoreResponse('1. Serena.\n2. Sourcegraph.', [
      { title: 'trace-mcp docs', url: 'https://trace-mcp.com/vs/serena.html' },
    ]);
    expect(s.mentioned).toBe(true);
    expect(s.cited).toBe(true);
    expect(s.position).toBeNull();
    expect(s.top50).toBe(true);
  });

  it('a prose mention outside a list has no position', () => {
    const s = scoreResponse('I would also look at trace-mcp for this.', []);
    expect(s).toMatchObject({ mentioned: true, position: null, top10: false, top50: true });
  });

  it('scores the same input identically twice', () => {
    const first = scoreResponse(listed, [{ title: 'x', url: 'https://example.com' }]);
    const second = scoreResponse(listed, [{ title: 'x', url: 'https://example.com' }]);
    expect(second).toEqual(first);
  });
});
