import { describe, expect, it } from 'vitest';
import { extractDecisions } from '../../src/memory/conversation-miner-types.js';
import { minedDecisionRejectReason } from '../../src/memory/decision-quality.js';

// Minimal synthetic equivalents of reviewed candidates. No session text is stored here.
const summary = 'We chose this approach because it keeps the local workflow simple and reliable.';
const candidates = [
  {
    label: 'cut coverage tail',
    title: 'Graph edges take priority over heuristic path matching',
    content: `${summary} Four new tests cov`,
    valid: false,
  },
  {
    label: 'gerund modifier',
    title: 'separately in theme effect over expanding colorBy deps',
    content: `${summary} We updated the theme effect instead of expanding colorBy deps.`,
    valid: false,
  },
  {
    label: 'verb as noun',
    title: 'the constructor/destructor test check',
    content: `${summary} The constructor and destructor test check was still running.`,
    valid: false,
  },
  {
    label: 'gerund main verb 1',
    title: 'Migrating the database to Postgres',
    content: summary,
    valid: true,
  },
  { label: 'gerund main verb 2', title: 'Switching to the new API', content: summary, valid: true },
  { label: 'imperative 1', title: 'Test the fallback provider', content: summary, valid: true },
  { label: 'imperative 2', title: 'Check the config before deploy', content: summary, valid: true },
] as const;

const paths = [
  {
    path: 'architecture_decision',
    text: 'We decided to use SQLite for the local cache because it works offline.',
  },
  {
    path: 'tech_choice',
    text: 'We picked Redis because it handles expiry for short lived sessions.',
  },
  { path: 'comparison', text: 'Use graph edges instead of heuristic paths.' },
  {
    path: 'bug_root_cause',
    text: 'The bug was a missing guard in the callback because the input can be empty.',
  },
  {
    path: 'preference',
    text: 'We prefer small commits because each change is easier to review and revert.',
  },
  {
    path: 'tradeoff',
    text: 'The downside is slower startup because the local index must be opened first.',
  },
  {
    path: 'discovery',
    text: 'We discovered that the watcher misses files because the directory was removed.',
  },
  {
    path: 'convention',
    text: 'Going forward use stable IDs because titles can change after review.',
  },
] as const;

describe('reviewed mined-candidate fixture', () => {
  it('counts false accepts and rejects before and after boundary repair', () => {
    const accepted = (title: string, content: string) =>
      minedDecisionRejectReason(title, content) === null;
    const beforeFalseAccepts = candidates.filter((c) => !c.valid && accepted(c.title, c.content));
    const beforeFalseRejects = candidates.filter((c) => c.valid && !accepted(c.title, c.content));
    expect(beforeFalseAccepts.map((c) => c.label)).toEqual([
      'cut coverage tail',
      'gerund modifier',
      'verb as noun',
    ]);
    expect(beforeFalseRejects).toHaveLength(0);

    // The extraction test covers removal of the artificial tail. The
    // remaining complete summary is a valid candidate.
    const repaired = { ...candidates[0], content: `${summary} Four new tests`, valid: true };
    const after = [repaired, ...candidates.slice(1)];
    expect(after.filter((c) => !c.valid && accepted(c.title, c.content))).toHaveLength(2);
    expect(after.filter((c) => c.valid && !accepted(c.title, c.content))).toHaveLength(0);
  });

  it.each(paths)('accepts a representative $path candidate', ({ text }) => {
    const results = extractDecisions([
      {
        role: 'assistant',
        text,
        timestamp: '2026-01-01T00:00:00Z',
        referenced_files: [],
        referenced_symbols: [],
      },
    ]);
    expect(results.length).toBeGreaterThan(0);
  });

  it('measures a selective lowercase-title review trial without changing admission', () => {
    const review = (title: string) => /^\p{Ll}/u.test(title);
    const flaggedBad = candidates.filter((c) => !c.valid && review(c.title));
    const flaggedGood = candidates.filter((c) => c.valid && review(c.title));
    const pathTitles = paths.flatMap(({ text }) =>
      extractDecisions([
        {
          role: 'assistant',
          text,
          timestamp: '2026-01-01T00:00:00Z',
          referenced_files: [],
          referenced_symbols: [],
        },
      ]).map((d) => d.title),
    );
    expect(flaggedBad.map((c) => c.label)).toEqual(['gerund modifier', 'verb as noun']);
    expect(flaggedGood).toHaveLength(0);
    expect(pathTitles.filter(review)).toHaveLength(6);
    expect(candidates.filter((c) => !c.valid && !review(c.title)).map((c) => c.label)).toEqual([
      'cut coverage tail',
    ]);
  });
});
