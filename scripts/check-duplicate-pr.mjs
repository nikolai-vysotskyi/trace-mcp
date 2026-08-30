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

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Distinct TRA issue keys mentioned in a blob of text, uppercased. */
export function issueKeys(text) {
  return [...new Set((text ?? '').match(/\bTRA-\d+\b/gi)?.map((k) => k.toUpperCase()) ?? [])];
}

/**
 * Open PRs that claim the same TRA issue as `pr` and that `pr` does not cite.
 *
 * @param {{number: number, title: string, body?: string}} pr
 * @param {Array<{number: number, title: string, body?: string}>} openPrs
 */
export function findDuplicatePrs(pr, openPrs) {
  const keys = issueKeys(`${pr.title}\n${pr.body ?? ''}`);
  if (keys.length === 0) return [];
  const cited = new Set(
    [...`${pr.body ?? ''}`.matchAll(/#(\d+)/g)].map((m) => Number.parseInt(m[1], 10)),
  );
  return openPrs.filter(
    (other) =>
      other.number !== pr.number &&
      !cited.has(other.number) &&
      issueKeys(`${other.title}\n${other.body ?? ''}`).some((k) => keys.includes(k)),
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
