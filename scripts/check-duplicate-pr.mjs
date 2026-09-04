#!/usr/bin/env node
// Fails a PR that duplicates another OPEN PR on the same TRA issue.
//
// TRA-476: two agents shipped the same issue twice (#598 duplicating #597 on
// TRA-448, #613 duplicating #611 on TRA-469).  Neither was a second run
// dispatched against the issue — in both cases a run working a *different*
// issue implemented the same fix — so no issue-level claim protocol or
// dispatcher lock would have fired.  The only place the two pieces of work
// are ever both visible is the PR list, so the guard lives there.
//
// A PR that cites the other one in its body is a follow-up, not a duplicate
// (#614 → #611, the healthy version), and passes.
//
// TRA-856: only a *claim* collides. A PR claims the issue named in its title or
// in a `Closes/Fixes/Resolves TRA-NNN` line; any other TRA-NNN in the body is a
// reference to a sibling issue for context, which is exactly what the PR
// template asks for. Treating those as claims flagged four unrelated daemon
// fixes against each other (#871/#874/#875, #882/#854) on 2026-09-04. Both real
// incidents named the issue in the title *and* in a `Closes` line, so the guard
// still catches them.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Distinct TRA issue keys mentioned in a blob of text, uppercased. */
export function issueKeys(text) {
  return [...new Set((text ?? '').match(/\bTRA-\d+\b/gi)?.map((k) => k.toUpperCase()) ?? [])];
}

/**
 * One key in a closing list: `TRA-9`, `` `TRA-9` ``, `[TRA-9]`, `[TRA-9](url)`.
 * Missing a wrapped key drops a real claim silently, which is the direction that
 * costs a duplicated implementation.
 */
const CLAIMED_KEY = String.raw`[\`[]?TRA-\d+\b[\`\]]?(?:\([^)]*\))?`;

/** List punctuation between keys. Repeats so `, and` reads as one separator. */
const KEY_SEPARATOR = String.raw`(?:\s*(?:,|&|and)\s*)*`;

const CLOSING_CLAIM = new RegExp(
  String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*((?:${CLAIMED_KEY}${KEY_SEPARATOR})+)`,
  'gi',
);

/**
 * Issue keys a PR *claims*: the ones in its title, plus the ones a closing
 * keyword names in the body. Everything else in the body is a reference.
 *
 * @param {{title?: string, body?: string}} pr
 */
export function claimedKeys(pr) {
  const closing = [...`${pr.body ?? ''}`.matchAll(CLOSING_CLAIM)].map((m) => m[1]).join(' ');
  return issueKeys(`${pr.title ?? ''}\n${closing}`);
}

/**
 * A release-please PR restates every issue in the changelog it assembles, so it
 * collides with every open PR by construction — and the work it names is already
 * merged, which is the opposite of duplicated. Excluded on both sides.
 *
 * @param {{title?: string}} pr
 */
export function isReleasePr(pr) {
  return /^chore\(.*\): release \d/.test(pr.title ?? '');
}

/**
 * Open PRs that claim the same TRA issue as `pr` and that `pr` does not cite.
 *
 * @param {{number: number, title: string, body?: string}} pr
 * @param {Array<{number: number, title: string, body?: string}>} openPrs
 */
export function findDuplicatePrs(pr, openPrs) {
  if (isReleasePr(pr)) return [];
  const keys = claimedKeys(pr);
  if (keys.length === 0) return [];
  const cited = new Set(
    [...`${pr.body ?? ''}`.matchAll(/#(\d+)/g)].map((m) => Number.parseInt(m[1], 10)),
  );
  return openPrs.filter(
    (other) =>
      other.number !== pr.number &&
      !cited.has(other.number) &&
      !isReleasePr(other) &&
      claimedKeys(other).some((k) => keys.includes(k)),
  );
}

export function formatReport(duplicates) {
  const lines = duplicates.map((d) => `- #${d.number} — ${d.title}`);
  return [
    '### Duplicate work check',
    '',
    'This PR claims the same TRA issue as an open PR:',
    '',
    ...lines,
    '',
    'Two agents have implemented the same issue twice before (#598/#597, #613/#611):',
    'both were complete, tested, CI-green work thrown away. Reconcile before merging.',
    '',
    'If this is a follow-up rather than a duplicate, cite the PR it follows',
    '(`Follow-up to #NNN`) in the description — the check passes once you do.',
  ].join('\n');
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function main() {
  const number = Number.parseInt(process.argv[2] ?? '', 10);
  if (!Number.isInteger(number) || number <= 0) {
    console.error('usage: check-duplicate-pr.mjs <pr-number>');
    process.exit(2);
  }
  const pr = JSON.parse(gh(['pr', 'view', String(number), '--json', 'number,title,body']));
  const openPrs = JSON.parse(
    gh(['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,body']),
  );
  const duplicates = findDuplicatePrs(pr, openPrs);
  if (duplicates.length === 0) {
    console.log('No open PR claims the same TRA issue.');
    return;
  }
  const report = formatReport(duplicates);
  console.error(report);
  writeFileSync(process.argv[3] ?? 'duplicate-pr-report.md', `${report}\n`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
