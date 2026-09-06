import { describe, expect, it } from 'vitest';
import { median, parseJudge, type Row, summarise } from '../../scripts/bench-pr-quality.js';

const row = (
  arm: 'baseline' | 'trace',
  understood: boolean,
  fp: number,
  ms: number,
): Row['baseline'] => ({
  text: arm,
  api_ms: ms,
  output_tokens: 100,
  understood,
  false_positives: fp,
  findings: 3,
  note: '',
});

describe('bench-pr-quality judge parsing', () => {
  it('accepts the bare JSON object the judge is asked for', () => {
    const j = parseJudge(
      '{"A":{"understood":true,"findings":3,"false_positives":1,"note":"ok"},' +
        '"B":{"understood":false,"findings":2,"false_positives":0,"note":"no"}}',
    );
    expect(j.A.understood).toBe(true);
    expect(j.A.false_positives).toBe(1);
    expect(j.B.understood).toBe(false);
    expect(j.B.findings).toBe(2);
  });

  it('tolerates prose or a fence around the JSON', () => {
    const j = parseJudge(
      'Sure, here it is:\n```json\n{"A":{"understood":true,"findings":1,"false_positives":0,"note":""},' +
        '"B":{"understood":true,"findings":1,"false_positives":2,"note":""}}\n```\n',
    );
    expect(j.B.false_positives).toBe(2);
  });

  // A judgement that silently defaults to understood=false would publish a
  // quality regression that never happened. It has to throw instead.
  it('throws rather than guessing when a verdict is missing', () => {
    expect(() => parseJudge('no json here')).toThrow();
    expect(() => parseJudge('{"A":{"findings":1},"B":{"understood":true}}')).toThrow();
  });
});

describe('bench-pr-quality aggregation', () => {
  it('reports rates and per-PR means, not sums', () => {
    const rows = [
      {
        repo: 'r',
        number: 1,
        url: '',
        baseline: row('baseline', true, 0, 10),
        trace: row('trace', true, 2, 30),
      },
      {
        repo: 'r',
        number: 2,
        url: '',
        baseline: row('baseline', false, 1, 20),
        trace: row('trace', true, 0, 50),
      },
    ] as Row[];
    const b = summarise(rows, 'baseline');
    expect(b.understood_rate).toBe(0.5);
    expect(b.false_positives_per_pr).toBe(0.5);
    expect(b.median_api_ms).toBe(15);
    expect(summarise(rows, 'trace').understood_rate).toBe(1);
  });

  it('does not divide by zero on an empty run', () => {
    expect(summarise([], 'trace')).toEqual({
      understood_rate: 0,
      false_positives_per_pr: 0,
      findings_per_pr: 0,
      median_api_ms: 0,
      median_output_tokens: 0,
    });
  });

  it('medians even-length samples', () => {
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('bench-pr-quality judge parsing — real failure modes from the 2026-09-06 run', () => {
  // Two of 60 judgements died on a leading brace that was not the verdict.
  it('skips a leading object that is not the verdict', () => {
    const j = parseJudge(
      'Here is my analysis: {not json} and the verdict:\n' +
        '{"A":{"understood":true,"findings":2,"false_positives":0,"note":"a"},' +
        '"B":{"understood":false,"findings":1,"false_positives":1,"note":"b"}}',
    );
    expect(j.A.understood).toBe(true);
    expect(j.B.false_positives).toBe(1);
  });

  it('is not confused by a brace inside a note string', () => {
    const j = parseJudge(
      '{"A":{"understood":true,"findings":1,"false_positives":0,"note":"claims {x} is unset"},' +
        '"B":{"understood":true,"findings":1,"false_positives":0,"note":"ok"}}',
    );
    expect(j.A.note).toContain('{x}');
  });
});
