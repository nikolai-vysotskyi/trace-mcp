#!/usr/bin/env node
// Fails when an issue sits in `waiting_for_release` while the PR that claims it
// is not merged.
//
// TRA-659: six issues spent 17 hours in that status against an open, red PR.
// Two runs did it for the same reason — the run armed auto-merge, read that as
// completion, set `waiting_for_release`, and ended. `waiting_for_release` is the
// one status a board sweep skips (it means the Releaser owns the item now), so
// the delay was invisible until a human looked at the PR list.
//
// Auto-merge is a request. A request a required check will refuse is not a
// completion: the status may only be set against a PR that is actually MERGED,
// read from the PR, not inferred from having armed the merge.
//
// The Releaser autopilot already walks this exact set of issues to advance them
// to `done`; this is that walk with one extra assertion.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of)\b/i;

/** Distinct TRA issue keys in a blob of text, uppercased. */
export function issueKeys(text) {
  return [...new Set((text ?? '').match(/\bTRA-\d+\b/gi)?.map((k) => k.toUpperCase()) ?? [])];
}

/**
 * A release-please PR restates every issue in the changelog it assembles, so it
 * names issues whose work is already merged — the opposite of a claim.
 *
 * @param {{title?: string}} pr
 */
export function isReleasePr(pr) {
  return /^chore\(.*\): release \d/.test(pr.title ?? '');
}

/**
 * Issue keys a PR claims to deliver: keys in the title, plus keys on a body line
 * carrying a closing keyword. A key mentioned in passing ("the TRA-476
 * incident") is a reference, not a claim, and must not bind an issue's status to
 * an unrelated PR.
 *
 * @param {{title?: string, body?: string}} pr
 */
export function claimedKeys(pr) {
  if (isReleasePr(pr)) return [];
  const fromBody = (pr.body ?? '')
    .split('\n')
    .filter((line) => CLOSING_KEYWORD.test(line))
    .join('\n');
  return issueKeys(`${pr.title ?? ''}\n${fromBody}`);
}

/**
 * Issues in `waiting_for_release` whose claiming PRs exist but none is merged.
 *
 * An issue no PR claims is reported separately, not failed: doc-only and
 * ops-only issues legitimately reach the status without one, and guessing at
 * those would bury the real signal.
 *
 * @param {Array<{identifier: string, id: string, title: string}>} issues
 * @param {Array<{number: number, title: string, body?: string, state: string, mergeStateStatus?: string}>} prs
 */
export function findUnmergedClaims(issues, prs) {
  /** @type {Map<string, typeof prs>} */
  const byKey = new Map();
  for (const pr of prs) {
    for (const key of claimedKeys(pr)) {
      byKey.set(key, [...(byKey.get(key) ?? []), pr]);
    }
  }
  const unmerged = [];
  const unlinked = [];
  for (const issue of issues) {
    const claiming = byKey.get(issue.identifier.toUpperCase()) ?? [];
    if (claiming.length === 0) {
      unlinked.push(issue);
    } else if (!claiming.some((pr) => pr.state === 'MERGED')) {
      unmerged.push({ issue, prs: claiming });
    }
  }
  return { unmerged, unlinked };
}

export function formatReport({ unmerged, unlinked }) {
  const lines = ['### waiting_for_release check', ''];
  if (unmerged.length === 0) {
    lines.push('Every issue in `waiting_for_release` has a merged PR.');
  } else {
    lines.push('These issues claim to be merged, but their PR is not:', '');
    for (const { issue, prs } of unmerged) {
      const state = prs
        .map(
          (pr) =>
            `#${pr.number} ${pr.state}${pr.state === 'OPEN' ? `/${pr.mergeStateStatus ?? 'UNKNOWN'}` : ''}`,
        )
        .join(', ');
      lines.push(`- ${issue.identifier} — ${issue.title} → ${state}`);
    }
    lines.push(
      '',
      'Move each back to `in_progress` and comment naming the PR and its real state.',
      'Arming auto-merge is not merging: `waiting_for_release` may only be set once',
      'the PR reads MERGED.',
    );
  }
  if (unlinked.length > 0) {
    lines.push(
      '',
      `Not verifiable — no PR claims them (${unlinked.map((i) => i.identifier).join(', ')}).`,
    );
  }
  return lines.join('\n');
}

function run(cmd, args) {
  return JSON.parse(
    execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
}

function main() {
  const issues = run('multica', [
    'issue',
    'list',
    '--status',
    'waiting_for_release',
    '--limit',
    '100',
    '--output',
    'json',
  ]).issues;
  const prs = run('gh', [
    'pr',
    'list',
    '--state',
    'all',
    '--limit',
    '400',
    '--json',
    'number,title,body,state,mergeStateStatus',
  ]);
  const result = findUnmergedClaims(issues, prs);
  const report = formatReport(result);
  if (result.unmerged.length === 0) {
    console.log(report);
    return;
  }
  console.error(report);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
