#!/usr/bin/env node

/**
 * lint-squash-message.mjs — fail CI when the future squash-merge commit would
 * be silently dropped by release-please (TRA-1039).
 *
 * Why this gate exists: release-please parses each squash commit on master
 * with `@conventional-commits/parser`, and a commit it cannot parse is NOT an
 * error — it is skipped with one `commit could not be parsed` debug line in a
 * green run. `fix(app)` then ships in the binaries but never appears in the
 * changelog (v3.22.0 lost `23d71442` this way: `Math.round(1024 / (824/1024))`
 * in the PR body reads as a malformed footer scope and the whole commit is
 * discarded). `pr-title-lint` cannot see this — it checks the PR title, while
 * the parser chokes on the PR body.
 *
 * What this checks: the message GitHub will build for the squash-merge —
 * `<PR title> (#<PR number>)` as the subject, PR body as the body — parsed
 * with the SAME parser release-please uses. Any piece that throws there is a
 * commit that would vanish from the changelog, so the check fails loudly here.
 *
 * Parser parity: keep `@conventional-commits/parser` pinned to the version
 * bundled by the `release-please-action` pin in `.github/workflows/release.yml`
 * (v5.0.0 → release-please 17.x → parser 0.4.x). When that pin moves,
 * re-verify with the TRA-1039 repro in tests/scripts/lint-squash-message.test.ts.
 *
 * Usage (CI passes PR_TITLE/PR_BODY/PR_NUMBER env vars):
 *   PR_TITLE="fix(app): ..." PR_BODY="..." PR_NUMBER=1032 \
 *     node scripts/lint-squash-message.mjs
 *
 * Usage (local):
 *   node scripts/lint-squash-message.mjs --title "fix(app): ..." \
 *     --body-file /tmp/pr-body.md --pr 1032
 *
 * Exits non-zero naming the offending line when the squash message would not parse.
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parser } from '@conventional-commits/parser';

/**
 * Rebuilds the commit message GitHub will create for the squash-merge:
 * the PR title plus the appended ` (#<number>)` suffix as the subject,
 * the PR body as the body.
 */
export function buildSquashMessage(title, body, prNumber) {
  const subject = (title ?? '').trim();
  const suffix = prNumber ? ` (#${prNumber})` : '';
  const subjectWithNumber = suffix && !subject.endsWith(suffix) ? `${subject}${suffix}` : subject;
  const trimmedBody = (body ?? '').replace(/\s+$/, '');
  return trimmedBody ? `${subjectWithNumber}\n\n${trimmedBody}\n` : `${subjectWithNumber}\n`;
}

/**
 * When the PR body carries a `BEGIN_COMMIT_OVERRIDE` block, release-please
 * uses that block INSTEAD of the squash message (see `preprocessCommitMessage`
 * in release-please's src/commit.ts) — so that is what has to parse.
 */
export function extractCommitOverride(body) {
  const after = (body ?? '').split('BEGIN_COMMIT_OVERRIDE')[1];
  if (after === undefined) return null;
  const override = after.split('END_COMMIT_OVERRIDE')[0].trim();
  return override === '' ? null : override;
}

/**
 * Copied from `splitMessages` in release-please's src/commit.ts: a squash
 * message can carry several conventional commits separated by a blank line,
 * and nested commits inside BEGIN_NESTED_COMMIT/END_NESTED_COMMIT blocks.
 * Each piece is parsed independently there, so each piece is checked here.
 */
export function splitMessages(message) {
  const parts = message.split('BEGIN_NESTED_COMMIT');
  const messages = [parts.shift()];
  for (const part of parts) {
    const [newMessage, ...rest] = part.split('END_NESTED_COMMIT');
    messages.push(newMessage);
    messages[0] = messages[0] + rest.join('END_NESTED_COMMIT');
  }

  const conventionalCommits = messages[0]
    .split(
      /\r?\n\r?\n(?=(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\(.*?\))?: )/,
    )
    .filter(Boolean);
  return [...conventionalCommits, ...messages.slice(1)];
}

/** Pulls the `at <line>:<col>` position out of a parser error, if present. */
function errorPosition(error) {
  const match = /at (\d+):(\d+)/.exec(error?.message ?? String(error));
  if (!match) return null;
  return { line: Number(match[1]), column: Number(match[2]) };
}

/**
 * @returns {string[]} human-readable problems; empty means release-please
 * would parse every piece of the future squash commit.
 */
export function lintSquashMessage(title, body, prNumber) {
  if (!title || title.trim() === '') {
    return ['missing PR title — the squash-merge subject would be empty'];
  }
  const override = extractCommitOverride(body);
  const messages = override ? [override] : splitMessages(buildSquashMessage(title, body, prNumber));
  const problems = [];
  for (const message of messages) {
    try {
      parser(message);
    } catch (error) {
      const subject = message.split('\n')[0];
      const position = errorPosition(error);
      const lines = message.split('\n');
      const offending =
        position && lines[position.line - 1] !== undefined
          ? `\noffending line ${position.line}: ${lines[position.line - 1].trim()}`
          : '';
      problems.push(
        `squash message would be silently dropped by release-please: "${subject}"\n` +
          `parser error: ${error instanceof Error ? error.message : String(error)}${offending}\n` +
          `A body line shaped like word(... with a second '(' before its ')' is misread as a footer ` +
          `— reword it (a space before '(' or plain words instead of the formula), or pin the ` +
          `notes with a BEGIN_COMMIT_OVERRIDE block in the PR body.`,
      );
    }
  }
  return problems;
}

function readArgValue(argv, name) {
  const flag = `--${name}`;
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  let title = readArgValue(argv, 'title') ?? process.env.PR_TITLE;
  let body = process.env.PR_BODY ?? '';
  const bodyFile = readArgValue(argv, 'body-file');
  if (bodyFile) body = readFileSync(bodyFile, 'utf8');
  const inlineBody = readArgValue(argv, 'body');
  if (inlineBody !== undefined) body = inlineBody;
  const pr = readArgValue(argv, 'pr') ?? process.env.PR_NUMBER;
  const prNumber = pr !== undefined && pr !== '' ? Number(pr) : undefined;

  const problems = lintSquashMessage(title, body, prNumber);
  if (problems.length > 0) {
    for (const problem of problems) {
      // One annotation per problem so the failure surfaces on the PR checks page.
      console.error(`::error::${problem.replace(/\n/g, '%0A')}`);
      console.error(problem);
    }
    process.exit(1);
  }

  console.log('Squash message parses with release-please\u2019s parser.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
