import { describe, expect, it } from 'vitest';
import { disambiguateProjectLabels } from '../recent-projects';

describe('disambiguateProjectLabels', () => {
  it('leaves unique basenames alone', () => {
    expect(disambiguateProjectLabels(['/a/foo', '/b/bar'])).toEqual(['foo', 'bar']);
  });

  it('grows collisions by one parent segment at a time (TRA-1058)', () => {
    expect(
      disambiguateProjectLabels([
        '/x/tra-1049-f6ea6628d239/workdir',
        '/x/task-30782d5e62d2/workdir',
        '/x/unique/workdir-only',
      ]),
    ).toEqual([
      'tra-1049-f6ea6628d239 / workdir',
      'task-30782d5e62d2 / workdir',
      'workdir-only',
    ]);
  });

  it('keeps growing until distinct, even past one extra segment', () => {
    expect(disambiguateProjectLabels(['/a/x/workdir', '/b/x/workdir'])).toEqual([
      'a / x / workdir',
      'b / x / workdir',
    ]);
  });

  it('gives up once parent segments are exhausted (still ambiguous, no crash)', () => {
    expect(disambiguateProjectLabels(['/workdir', '/workdir'])).toEqual(['workdir', 'workdir']);
  });
});
