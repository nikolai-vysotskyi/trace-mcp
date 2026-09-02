#!/usr/bin/env node
// Fails when an issue sits in `waiting_for_release` while the PR linked to it is
// not merged.
//
// TRA-659: six issues spent 17 hours in that status against an open, red PR.
// Two runs did it for the same reason — the run armed auto-merge, read that as
// completion, set `waiting_for_release`, and ended. `waiting_for_release` is the
// one status a board sweep skips (it means the Releaser owns the item now), so
// the delay was invisible until a human looked at the PR list.
//
// Auto-merge is a request. A request a required check will refuse is not a
// completion: the status may only be set against a PR that is actually merged,
// read from the PR, not inferred from having armed the merge.
//
// The issue → PR links come from the platform's own link table
// (`multica issue pull-requests`), not from parsing PR prose. Reconstructing
// ownership from a body line is what an earlier draft of this check did, and it
// read "Stage 3 of the TRA-435 epic" as a claim on TRA-435 — a reference bound
// to an unrelated merged PR passes the very issue the check exists to catch.
//
// The Releaser autopilot already walks this exact set of issues to advance them
// to `done`; this is that walk with one extra assertion.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Splits issues by whether a merged PR backs the status.
 *
 * An issue with no linked PR is reported, not failed: doc-only and ops-only work
 * legitimately reaches the status without one, and the link table is only as
 * complete as the PRs that named their issue. Failing on those would bury the
 * real signal — but they are printed, because an unverifiable claim is not a
 * verified one.
 *
 * @param {Array<{issue: {identifier: string, title: string}, prs: Array<{number: number, state: string, merge_state_status?: string, failed_check_names?: string[]}>}>} entries
 */
export function findUnmergedClaims(entries) {
  const unmerged = [];
  const unlinked = [];
  for (const { issue, prs } of entries) {
    if (prs.length === 0) {
      unlinked.push(issue);
    } else if (!prs.some((pr) => pr.state === 'merged')) {
      unmerged.push({ issue, prs });
    }
  }
  return { unmerged, unlinked };
}

/** `#715 open, BLOCKED, failing: CodeQL` — everything needed to see the claim was wrong. */
export function describePr(pr) {
  const parts = [`#${pr.number} ${pr.state}`];
  if (pr.merge_state_status && pr.merge_state_status !== 'unknown') {
    parts.push(pr.merge_state_status);
  }
  if (pr.failed_check_names?.length) {
    parts.push(`failing: ${pr.failed_check_names.join(', ')}`);
  }
  return parts.join(', ');
}

export function formatReport({ unmerged, unlinked }) {
  const lines = ['### waiting_for_release check', ''];
  if (unmerged.length === 0) {
    lines.push('Every issue in `waiting_for_release` with a linked PR has a merged one.');
  } else {
    lines.push('These issues claim to be merged, but their PR is not:', '');
    for (const { issue, prs } of unmerged) {
      lines.push(`- ${issue.identifier} — ${issue.title} → ${prs.map(describePr).join(' | ')}`);
    }
    lines.push(
      '',
      'Move each back to `in_progress` and comment naming the PR and its real state.',
      'Arming auto-merge is not merging: `waiting_for_release` may only be set once',
      'the PR reads merged.',
    );
  }
  if (unlinked.length > 0) {
    lines.push(
      '',
      `Not verifiable — no PR is linked to them (${unlinked.map((i) => i.identifier).join(', ')}).`,
      'Check by hand that each is doc-only or ops-only work rather than a PR that',
      'never recorded its issue.',
    );
  }
  return lines.join('\n');
}

function multica(args) {
  return JSON.parse(
    execFileSync('multica', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
}

function main() {
  const { issues } = multica([
    'issue',
    'list',
    '--status',
    'waiting_for_release',
    '--limit',
    '100',
    '--output',
    'json',
  ]);
  const entries = [];
  const unreadable = [];
  for (const issue of issues) {
    try {
      const { pull_requests } = multica(['issue', 'pull-requests', issue.id, '--output', 'json']);
      entries.push({ issue, prs: pull_requests });
    } catch {
      // A failed lookup is not "no PR linked": passing on it would be the exact
      // false clean bill the check exists to prevent.
      unreadable.push(issue.identifier);
    }
  }
  if (unreadable.length > 0) {
    console.error(`Could not read the linked PRs of ${unreadable.join(', ')} — check incomplete.`);
  }
  const result = findUnmergedClaims(entries);
  const report = formatReport(result);
  if (result.unmerged.length > 0) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
  if (unreadable.length > 0) process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
