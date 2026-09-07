#!/usr/bin/env node
/**
 * The two claim surfaces that live outside the repository — TRA-1120.
 *
 * `tests/docs/readme-claims.test.ts` and `savings-claims.test.ts` compare every
 * doc surface to `docs/_data/`, but they can only see files. The GitHub repo
 * description and the npm registry `description` are the two loudest surfaces
 * we own and neither is a file: the auto-index layer copies the GitHub string
 * verbatim (`linny006/mcp-servers-live` renders it five times on one page) and
 * every `npm view` and plugin listing reads the npm one. On 2026-09-07 they
 * disagreed with each other — 70.5% on GitHub, 90.6% on npm — with CI green,
 * because nothing compared either to `docs/_data/`.
 *
 * Same anchor discipline as counts.yml (TRA-1086): the repo's own data files
 * are the truth and each surface is compared to them, never to each other.
 *
 * Network, so it is a script and not a vitest case — the house rule is that
 * `tests/docs/*` runs offline. `checkRemoteClaims` below is pure and is what
 * `tests/docs/remote-claims.test.ts` exercises; only `main` touches the wire.
 *
 * Run: `node scripts/check-remote-claims.mjs`. Nightly in ci.yml.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');

const GITHUB_API = 'https://api.github.com/repos/nikolai-vysotskyi/trace-mcp';
const NPM_API = 'https://registry.npmjs.org/trace-mcp';

/** Everything a remote one-liner is allowed to assert, straight out of `docs/_data/`. */
export function anchors() {
  const counts = parseYaml(read('docs/_data/counts.yml'));
  const bench = JSON.parse(read('docs/_data/pr_context_bench.json'));
  const response = JSON.parse(read('docs/_data/response_tokens.json'));
  const pkg = JSON.parse(read('package.json'));
  return {
    counts,
    // Both published savings figures answer different questions (PR context vs
    // per-call responses), so either is a legal number to quote — a third one
    // is not.
    savings: [String(bench.median_savings_pct), String(response.reduction_pct)],
    packageDescription: pkg.description,
  };
}

/**
 * Figures a surface may never carry again. Each was live on a surface we own,
 * each is retired, and each still circulates in third-party copies we cannot
 * edit — which is the argument for never letting a new one leave.
 */
const RETIRED =
  /\b90\.6\s*%|up to 99\s*%|~?\s*42 minutes|\b40\s*[–—-]\s*50\s*%|\b53 framework|\b68 languages/i;

/**
 * Every pattern here hunts for a `%` glyph, so a one-liner that spells the
 * number out — "90.6 percent fewer input tokens" — would otherwise clear both
 * the retired-figure check and the anchor sweep at once. That is not a
 * contrived string: these descriptions are hand-edited through
 * `gh api -X PATCH`, so the text often arrives pasted out of prose. Matching
 * runs on the normalised copy; the failure message still prints the live one.
 */
const normalise = (text) => text.replace(/\s*per\s?cent(?:age)?\b/gi, '%');

/**
 * `100% local` is false while the usage ping POSTs to GA by default
 * (`src/telemetry/usage-ping.ts`, off via `TRACE_MCP_TELEMETRY=off` or
 * `telemetry.usage_ping: false`). TRA-1013 owns the wording fix for the README;
 * this keeps the absolute from coming back on the surfaces that issue's diff
 * cannot reach.
 *
 * What is banned is the *unqualified* absolute, not the locality claim — "your
 * code and index never leave the machine, an anonymous usage ping is opt-out"
 * is both stronger and true, and a gate that failed it would push the copy back
 * towards the vaguer wording.
 */
const ABSOLUTE_LOCALITY =
  /\b(100\s*%|fully|entirely|completely)\s+local(?:ly)?\b|\b(nothing|no data|never)\s+leaves\b/i;
/**
 * Presence, not proximity: any mention of the ping anywhere in the string
 * exempts all of it. Sound for two one-line descriptions and not for a page —
 * "100% local. We never sell your telemetry." would clear this. Tighten it to
 * the sentence if this gate ever grows a surface longer than a sentence or two.
 */
const DISCLOSES_PING = /ping|telemetry|analytics/i;

const TOKEN_CONTEXT = /token|saving|saved|reduction|fewer|less/i;

/**
 * @param {{name: string, text: string, mirrors?: string}[]} surfaces
 * @param {ReturnType<typeof anchors>} anchor
 * @returns {string[]} one line per violation; empty means the surfaces are clean
 */
export function checkRemoteClaims(surfaces, anchor) {
  const problems = [];
  for (const { name, text, mirrors } of surfaces) {
    const fail = (msg) => problems.push(`${name}: ${msg}\n    live: ${text}`);
    // Everything below matches on this; only the drift check compares the raw
    // string, because that one is a literal equality against package.json.
    const claim = normalise(text);

    if (!text) {
      fail('has no description at all — the auto-indexes have nothing to copy but the repo name');
      continue;
    }

    const retired = claim.match(RETIRED);
    if (retired) {
      fail(
        `quotes the retired "${retired[0]}". Retiring a claim does not retire the copies of it; ` +
          'see the TRA-1090 note in ops/distribution.md before restoring any number.',
      );
    }

    const absolute = DISCLOSES_PING.test(claim) ? null : claim.match(ABSOLUTE_LOCALITY);
    if (absolute) {
      fail(
        `claims "${absolute[0]}" while the usage ping is on by default (TRA-1013). Say what is ` +
          'true instead: code and index stay on the machine, the anonymous ping is opt-out.',
      );
    }

    // Every count the surface states has to be the count docs/_data/counts.yml
    // states — exactly, the way every guarded in-repo surface is since TRA-1086.
    for (const [, n, noun] of claim.matchAll(
      /(\d+)\+?\s+(languages?|frameworks?|tools?|resources?)/gi,
    )) {
      const key = `${noun.toLowerCase().replace(/s?$/, '')}s`;
      const expected = anchor.counts[key];
      if (expected !== undefined && Number(n) !== expected) {
        fail(`says "${n} ${noun}" where docs/_data/counts.yml says ${expected}`);
      }
    }

    // And every percentage it quotes at a stranger has to be a generated one.
    for (const [, pct] of claim.matchAll(/(\d{1,3}(?:\.\d)?)\s*%/g)) {
      if (!TOKEN_CONTEXT.test(claim)) continue;
      if (anchor.savings.includes(pct)) continue;
      // One number, one line. The two checks above already name the figure when
      // it is a retired one or the locality absolute; repeating it here would
      // make a single stale description look like three separate defects.
      if (retired?.[0].includes(pct) || absolute?.[0].includes(pct)) continue;
      fail(
        `quotes ${pct}%, which is not in docs/_data/. The published figures are ` +
          `${anchor.savings.join('% and ')}%.`,
      );
    }

    if (mirrors !== undefined && text !== mirrors) {
      fail(
        'has drifted from package.json `description`. npm serves the latest PUBLISHED version, ' +
          'so this is expected between the merge and the release that carries it — and it is a ' +
          `real defect once that release is out.\n    want: ${mirrors}`,
      );
    }
  }
  return problems;
}

async function json(url, token) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'trace-mcp-remote-claims-check',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const anchor = anchors();
  const [repo, npm] = await Promise.all([
    json(GITHUB_API, process.env.GITHUB_TOKEN),
    json(NPM_API),
  ]);
  const latest = npm['dist-tags']?.latest;

  const problems = checkRemoteClaims(
    [
      { name: 'GitHub repo description', text: repo.description ?? '' },
      {
        name: `npm description (published ${latest})`,
        text: npm.versions?.[latest]?.description ?? npm.description ?? '',
        mirrors: anchor.packageDescription,
      },
    ],
    anchor,
  );

  if (problems.length === 0) {
    console.log('Both remote claim surfaces agree with docs/_data/.');
    return;
  }
  console.error(`${problems.length} problem(s) on the remote claim surfaces:\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  console.error(
    'The GitHub description is one `gh api -X PATCH repos/:owner/:repo -f description=...` away.\n' +
      'The npm one is fixed by package.json plus a release — see ops/distribution.md.',
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
