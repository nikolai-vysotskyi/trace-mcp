import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const html = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'index.html'), 'utf8');
const document = new JSDOM(html).window.document;

describe('landing page benchmark placement', () => {
  it('keeps the saving, quality result and scope note together in reading order', () => {
    const hero = document.querySelector('.hero');
    const metrics = document.querySelector('.metrics-strip-grid');
    const firstMetric = metrics?.querySelector('.metrics-strip-item:first-child');
    const proof = metrics?.querySelector('.metrics-strip-proof');

    expect(hero?.innerHTML).not.toContain('site.data.pr_context_bench.');
    expect(hero?.innerHTML).not.toContain('site.data.pr_context_quality.');
    expect(firstMetric?.innerHTML).toContain('site.data.pr_context_bench.pr_count');
    expect(firstMetric?.nextElementSibling).toBe(proof);
    for (const key of [
      'trace_understood',
      'baseline_understood',
      'trace_false_positives',
      'baseline_false_positives',
    ]) {
      expect(proof?.innerHTML).toContain(`site.data.pr_context_quality.${key}`);
    }
    expect(proof?.querySelector('a[href*="pr-context-benchmark.html"]')).not.toBeNull();
    expect(proof?.querySelector('a[href*="what-trace-init-installs.html"]')).not.toBeNull();
  });
});
