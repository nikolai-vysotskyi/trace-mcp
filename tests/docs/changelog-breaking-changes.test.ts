/**
 * Breaking-change notes must actually say what broke (TRA-412).
 *
 * v2.0.0 shipped a `⚠ BREAKING CHANGES` section whose only bullet ended in a
 * colon: release-please dropped the Markdown table that followed it in the
 * commit footer. Users who had lost seven MCP tools got no replacement names
 * anywhere they would look. A note that renders as a dangling colon should
 * not be publishable, so assert the shape here rather than in review.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHANGELOG = readFileSync(join(process.cwd(), 'CHANGELOG.md'), 'utf8');

/** `### ⚠ BREAKING CHANGES` body text, keyed by the release heading above it. */
function breakingSections(): Array<{ release: string; body: string }> {
  const lines = CHANGELOG.split('\n');
  const out: Array<{ release: string; body: string }> = [];
  let release = '(unknown)';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) release = lines[i];
    if (!lines[i].startsWith('### ') || !lines[i].includes('BREAKING CHANGES')) continue;
    const body: string[] = [];
    for (let k = i + 1; k < lines.length && !lines[k].startsWith('#'); k++) body.push(lines[k]);
    out.push({ release, body: body.join('\n') });
  }
  return out;
}

describe('CHANGELOG breaking-change notes', () => {
  const sections = breakingSections();

  it('finds the breaking-change sections it is meant to guard', () => {
    expect(sections.length).toBeGreaterThan(0);
  });

  it.each(sections.map((s) => [s.release, s.body] as const))(
    'has a non-empty body under %s',
    (_release, body) => {
      expect(body.trim()).not.toBe('');
    },
  );

  it.each(sections.map((s) => [s.release, s.body] as const))(
    'does not trail off mid-sentence under %s',
    (_release, body) => {
      // A bullet ending in ':' promises a list or table that must follow it.
      const bullets = body.split('\n').filter((l) => l.trimStart().startsWith('* '));
      for (const bullet of bullets) {
        if (!bullet.trimEnd().endsWith(':')) continue;
        const after = body.slice(body.indexOf(bullet) + bullet.length).trim();
        expect(after, `dangling colon: ${bullet.trim()}`).not.toBe('');
      }
    },
  );

  it('names every tool retired in 2.0.0', () => {
    const v2 = sections.find((s) => s.release.includes('[2.0.0]'));
    expect(v2).toBeDefined();
    for (const name of [
      'pin_symbol',
      'pin_file',
      'search_with_mode',
      'get_dead_exports',
      'get_untested_exports',
      'get_session_resume',
      'get_project_memo',
    ]) {
      expect(v2?.body).toContain(name);
    }
  });
});
