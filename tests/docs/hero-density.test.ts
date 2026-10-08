import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const html = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'index.html'), 'utf8');
const document = new JSDOM(html).window.document;

describe('landing hero density', () => {
  it('keeps the install action ahead of the benchmark and scope note', () => {
    const hero = document.querySelector('.hero');
    const metrics = document.querySelector('.metrics-strip');
    const headline = hero?.querySelector('h1')?.textContent?.trim() ?? '';

    expect(headline.length).toBeLessThan(40);
    expect(hero?.querySelectorAll('.hero-desc')).toHaveLength(1);
    expect(hero?.querySelector('.hero-cta')).not.toBeNull();
    expect(hero?.querySelector('.hero-install')).not.toBeNull();
    expect(hero?.textContent).toContain(
      'trace-mcp indexes what your agent keeps re-reading, and serves the answer instead.',
    );
    expect(hero?.innerHTML).not.toContain('site.data.pr_context_bench.');
    expect(hero?.innerHTML).not.toContain('site.data.pr_context_quality.');
    expect(hero?.textContent).not.toContain('tweakcc');
    expect(metrics?.querySelector('.metrics-strip-proof')).not.toBeNull();
  });

  it('keeps the full blind comparison and scope next to the first metric', () => {
    const metrics = document.querySelector('.metrics-strip');
    const proof = metrics?.querySelector('.metrics-strip-proof');
    expect(metrics?.querySelector('.metrics-strip-item:first-child')?.nextElementSibling).toBe(
      proof,
    );
    expect(metrics?.querySelector('.metrics-strip-item:first-child')?.innerHTML).toContain(
      'site.data.pr_context_bench.pr_count',
    );
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
