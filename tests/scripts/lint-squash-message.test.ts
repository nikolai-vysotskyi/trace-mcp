import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(__dirname, '..', '..', 'scripts', 'lint-squash-message.mjs');

const { buildSquashMessage, extractCommitOverride, lintSquashMessage } = (await import(
  MODULE_PATH
)) as {
  buildSquashMessage: (title: string, body: string, prNumber?: number) => string;
  extractCommitOverride: (body: string) => string | null;
  lintSquashMessage: (title: string, body: string, prNumber?: number) => string[];
};

const TITLE = 'fix(app): give macOS back its dock margin (TRA-780)';

describe('lint-squash-message', () => {
  it('accepts an ordinary PR body with markdown and an Agent trailer', () => {
    const body = [
      'The margin goes into the rasteriser rather than back into the master.',
      '',
      'Rendered at the dock slot the plate is now 95px against 94.',
      '',
      'Agent: Lead Engineer',
    ].join('\n');
    expect(lintSquashMessage(TITLE, body, 1032)).toEqual([]);
  });

  it('accepts an empty body', () => {
    expect(lintSquashMessage(TITLE, '', 1032)).toEqual([]);
  });

  it('fails on a missing title', () => {
    expect(lintSquashMessage('', 'some body', 1)).toHaveLength(1);
  });

  // TRA-1039: v3.22.0 shipped 23d71442 in the binaries but release-please
  // silently dropped it from the changelog — the nested parens in
  // `Math.round(1024 / (824/1024))` read as a malformed footer scope and the
  // whole commit failed to parse in a green run.
  it('rejects the TRA-1039 repro and names the offending line', () => {
    const body = [
      '* fix(app): give macOS back its dock margin',
      '',
      'Apple grid puts the rounded square at 824 of 1024, 80.5%.',
      '',
      'Agent: Lead Engineer',
      '',
      '* docs: the padded canvas rounds to 1273, not 1272',
      '',
      'Math.round(1024 / (824/1024)) is 1273 and the inset 124.5; the comment claimed',
      '1272/124. The rendered plate was always the intended 824px.',
      '',
      'Agent: Lead Engineer',
    ].join('\n');
    const problems = lintSquashMessage(TITLE, body, 1032);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('silently dropped by release-please');
    expect(problems[0]).toContain('Math.round(1024 / (824/1024))');
  });

  it('rejects function-call-like text with nested parens, accepts the spaced form', () => {
    expect(lintSquashMessage(TITLE, 'TABLE(RESULT_SCAN(q)) queries', 1)).toHaveLength(1);
    expect(lintSquashMessage(TITLE, 'Math.round (1024 / (824/1024)) is 1273', 1)).toEqual([]);
  });

  it('accepts several conventional commits carried in one squash message', () => {
    const body = ['feat: first thing', '', 'fix: second thing'].join('\n\n');
    expect(lintSquashMessage('feat: umbrella', body, 7)).toEqual([]);
  });

  it('validates the BEGIN_COMMIT_OVERRIDE block instead of the squash message', () => {
    const body = [
      'TABLE(RESULT_SCAN(q)) would fail on its own',
      '',
      'BEGIN_COMMIT_OVERRIDE',
      'fix(app): override message that parses',
      'END_COMMIT_OVERRIDE',
    ].join('\n');
    expect(lintSquashMessage(TITLE, body, 1032)).toEqual([]);

    const badOverride = [
      'BEGIN_COMMIT_OVERRIDE',
      'not a conventional commit at all :::',
      'END_COMMIT_OVERRIDE',
    ].join('\n');
    // An override that is not a conventional commit parses as free text only
    // when the parser accepts it — the point is the override is what is checked.
    expect(extractCommitOverride(badOverride)).toBe('not a conventional commit at all :::');
  });

  it('extracts nothing when there is no override block', () => {
    expect(extractCommitOverride('plain body')).toBeNull();
  });
});

describe('buildSquashMessage', () => {
  it('appends the PR number GitHub adds to the squash subject, exactly once', () => {
    expect(buildSquashMessage(TITLE, 'body', 1032).split('\n')[0]).toBe(`${TITLE} (#1032)`);
    expect(buildSquashMessage(`${TITLE} (#1032)`, 'body', 1032).split('\n')[0]).toBe(
      `${TITLE} (#1032)`,
    );
  });

  it('keeps the subject alone when the body is empty', () => {
    expect(buildSquashMessage(TITLE, '', 1032)).toBe(`${TITLE} (#1032)\n`);
  });
});
