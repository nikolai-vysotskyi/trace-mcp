/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { formatLastIndexed } from '../ProjectOverview';

const NOW = new Date('2026-08-28T19:01:49Z');
const iso = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();

describe('formatLastIndexed', () => {
  it('pairs a relative anchor with the absolute stamp', () => {
    expect(formatLastIndexed(iso(7200), NOW)).toMatch(/^2 hours ago · /);
    expect(formatLastIndexed(iso(300), NOW)).toMatch(/^5 minutes ago · /);
    expect(formatLastIndexed(iso(90000), NOW)).toMatch(/^yesterday · /);
    expect(formatLastIndexed(iso(1_209_600), NOW)).toMatch(/^2 weeks ago · /);
  });

  it('drops the seconds and the machine date format', () => {
    const out = formatLastIndexed('2026-08-28T17:01:49Z', NOW);
    expect(out).not.toMatch(/:49/); // no seconds
    expect(out).not.toMatch(/8\/28\/2026/); // no "8/28/2026, 5:01:49 PM"
  });

  it('treats anything under 45s as just now, and never renders a future date', () => {
    expect(formatLastIndexed(iso(10), NOW)).toMatch(/^just now · /);
    expect(formatLastIndexed(iso(-600), NOW)).not.toMatch(/·/);
  });

  it('passes an unparseable value through untouched', () => {
    expect(formatLastIndexed('never', NOW)).toBe('never');
  });
});
