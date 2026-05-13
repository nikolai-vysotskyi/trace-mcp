import { describe, expect, it } from 'vitest';
import { computeConfidence } from './decision-confidence.js';

describe('computeConfidence', () => {
  it('returns the BASE for no signals (low-signal type, no refs, short content)', () => {
    const c = computeConfidence({
      title: 'short',
      content: 'a'.repeat(50),
      type: 'preference',
    });
    expect(c).toBe(0.4);
  });

  it('boosts when a code reference is present', () => {
    const c = computeConfidence({
      title: 't',
      content: 'a'.repeat(50),
      type: 'preference',
      file_path: 'src/foo.ts',
    });
    expect(c).toBeCloseTo(0.6, 5);
  });

  it('saturates at <= 1.0 for high-signal inputs', () => {
    const c = computeConfidence({
      title: 't',
      content: 'a'.repeat(300),
      type: 'architecture_decision',
      symbol_id: 'src/foo.ts::Bar#class',
      file_path: 'src/foo.ts',
      tags: ['arch', 'security'],
      service_name: 'auth-api',
    });
    expect(c).toBeGreaterThanOrEqual(0.95);
    expect(c).toBeLessThanOrEqual(1);
  });

  it('mid-signal (code ref + short content + non-high-signal type) sits between thresholds', () => {
    const c = computeConfidence({
      title: 't',
      content: 'a'.repeat(60),
      type: 'preference',
      symbol_id: 'src/foo.ts::Bar#class',
    });
    expect(c).toBeGreaterThanOrEqual(0.45);
    expect(c).toBeLessThan(0.75);
  });

  it('never exceeds 1.0', () => {
    // Force-feed the maximum reachable signal combination
    const c = computeConfidence({
      title: 't',
      content: 'a'.repeat(5000),
      type: 'bug_root_cause',
      symbol_id: 'x',
      file_path: 'y',
      tags: Array.from({ length: 20 }, (_, i) => `t${i}`),
      service_name: 's',
    });
    expect(c).toBeLessThanOrEqual(1);
  });

  it('respects high-signal type bonus', () => {
    const baseline = computeConfidence({
      title: 't',
      content: 'a'.repeat(50),
      type: 'preference',
    });
    const boosted = computeConfidence({
      title: 't',
      content: 'a'.repeat(50),
      type: 'architecture_decision',
    });
    expect(boosted).toBeGreaterThan(baseline);
  });
});
