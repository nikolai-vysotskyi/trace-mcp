#!/usr/bin/env node
/**
 * Refresh `docs/_data/savings.yml` — the saved-token counter the site and the
 * README quote (TRA-533).
 *
 * The daily GA4 snapshot publishes to the orphan `adoption-data` branch, never
 * to master: master requires status checks with `enforce_admins`, so nothing
 * automated can push there, and a PR opened by GITHUB_TOKEN never triggers CI
 * and so could never satisfy those checks. But GitHub Pages builds the site
 * from `master/docs`, so the number has to be ON master to render — and the
 * README needs it committed regardless, being plain markdown.
 *
 * So this reads the published snapshot and writes the handful of fields the
 * public surfaces quote. Run it, commit the result, open a PR.
 *
 *   node scripts/refresh-savings.mjs
 *
 * ## What this refuses to publish, and why
 *
 * The ping's GA4 credentials ship in the published bundle (SECURITY.md
 * "Telemetry Credentials"), so the counter is unauthenticated and inflatable.
 * `sanitizedTokens` caps days whose per-user rate runs away from the median —
 * but below `MIN_DAYS_FOR_TRIM` days there is no median worth trimming against
 * and it returns the raw sum untouched. Publishing that would be publishing an
 * unsanitized number while calling it sanitized, which is the one thing
 * TRA-533 set out to avoid. So: refuse, and say why.
 *
 * Note what the day-level cap does NOT do. It is not per-install outlier
 * rejection — the GA4 Data API exposes no `client_id` dimension, that lives
 * only in the BigQuery export. It catches a single runaway day; it does not
 * catch inflation spread evenly across the window, which raises the median
 * itself and passes through untouched. The accepted threat model is therefore
 * "one noisy or broken install", not "a determined attacker". That is why the
 * published copy names the figure as self-reported rather than audited.
 *
 * ponytail: manual refresh, one command. The upgrade is a workflow step that
 * runs this and opens the PR with a PAT (GITHUB_TOKEN cannot, see above).
 */
import fs from 'node:fs';
import { INFLATION_RATIO, MIN_DAYS_FOR_TRIM } from './ga4-savings.mjs';

/**
 * First day whose pings can carry a measured `tokens_saved`.
 *
 * Set this to the release date of the first version shipping
 * `recordActualTokens` (#915 / TRA-880). Until the field has rolled onto it,
 * every summed token is `RAW_COST_ESTIMATES[tool] x 0.15` — see the refusal
 * below. Bump it, never lower it.
 *
 * Keep it equal to `SAVINGS_SINCE` in `scripts/ga4-snapshot.mjs`, which is what
 * actually bounds the query — the snapshot's `since` is emitted from it, so
 * this refusal clears when that constant and the field agree, and not before.
 *
 * ponytail: a date, not a version-to-date lookup. The one thing this compares
 * against is a date string already in the snapshot.
 */
const CORRECTED_COUNTER_SINCE = '2026-09-05';

const SRC =
  'https://raw.githubusercontent.com/nikolai-vysotskyi/trace-mcp/adoption-data/adoption.yml';
const OUT = 'docs/_data/savings.yml';

/**
 * Pull one scalar out of the snapshot's `savings:` block.
 *
 * A regex rather than a YAML parser: this needs a few numbers out of a file we
 * generate ourselves in a fixed shape, and the alternative is a dependency in
 * a script whose whole point is having none. It throws on a missing field, so
 * a reshaped block fails closed instead of publishing a blank.
 */
function field(yaml, name) {
  const block = yaml.match(/^savings:\n((?:[ \t]+.*\n)+)/m)?.[1];
  if (!block) throw new Error('no `savings:` block in the published snapshot');
  const raw = block.match(new RegExp(`^\\s+${name}:\\s*"?([^"\n]+)"?\\s*$`, 'm'))?.[1];
  if (raw === undefined) throw new Error(`no \`${name}\` in the savings block`);
  return raw.trim();
}

/**
 * Round DOWN to a readable unit and mark it `+`.
 *
 * Down, never nearest, so the displayed figure is below the snapshot it was
 * taken from. That is all `+` claims — it is NOT a promise that the number
 * only grows. The sanitizer recomputes one median across the whole window, so
 * a later day can lower that median, retroactively cap earlier days, and pull
 * the sanitized total *down* even as the raw total rises. The counter is an
 * as-of observation, dated by `refreshed`, not a monotonic odometer.
 */
function floorToUnit(n) {
  if (n >= 1_000_000_000) return `${Math.floor(n / 100_000_000) / 10}B+`;
  if (n >= 1_000_000) return `${Math.floor(n / 1_000_000)}M+`;
  if (n >= 1_000) return `${Math.floor(n / 1_000)}K+`;
  return `${Math.floor(n)}+`;
}

const res = await fetch(SRC);
if (!res.ok) throw new Error(`fetching the snapshot failed: HTTP ${res.status}`);
const snapshot = await res.text();

const tokens = Number(field(snapshot, 'tokens_saved'));
const raw = Number(field(snapshot, 'tokens_saved_raw'));
const usd = Number(field(snapshot, 'usd_saved'));
const days = Number(field(snapshot, 'days'));
const model = field(snapshot, 'price_model');
const perMtok = field(snapshot, 'price_usd_per_mtok');
if (!Number.isFinite(tokens) || !Number.isFinite(usd)) {
  throw new Error('the snapshot carries no usable savings numbers');
}

if (!Number.isFinite(days) || days < MIN_DAYS_FOR_TRIM) {
  console.error(
    `Refusing to publish: the snapshot covers ${days} day(s), and sanitizing needs at\n` +
      `least ${MIN_DAYS_FOR_TRIM} to have a median to trim against. Below that the figure is\n` +
      `the raw sum of an unauthenticated counter — publishing it would brand raw\n` +
      `data as sanitized. GA4 does not backfill, so this clears on its own once\n` +
      `the metric has been registered for ${MIN_DAYS_FOR_TRIM} days. Leaving ${OUT} untouched.`,
  );
  process.exit(1);
}

// TRA-904: two independent reasons the field aggregate cannot be quoted today,
// both fatal, so this refuses rather than prints a caveat someone can drop.
//
// 1. Every install in the field still runs the PRE-#915 counter, which scored a
//    call before the tool ran: `RAW_COST_ESTIMATES[tool] x 0.15`, a constant.
//    Measured against real responses it overstates by ~2.4x. A window that
//    includes days before CORRECTED_COUNTER_SINCE is arithmetic, not a
//    measurement, whatever caption sits under it.
// 2. `inflation_suspected` means the sanitizer capped days it could not
//    explain. TRA-843 chose to warn and publish; with (1) also true the two
//    stack, and "sanitized" would be doing work the caveat cannot.
//
// This clears on its own: once the corrected counter has shipped and the
// snapshot window starts after it, the check passes and the counter returns.
const since = field(snapshot, 'since');
if (since < CORRECTED_COUNTER_SINCE) {
  console.error(
    `Refusing to publish: the snapshot sums from ${since}, and the counter only started\n` +
      `measuring responses on ${CORRECTED_COUNTER_SINCE} (#915). Everything before that date is\n` +
      `calls x constant, ~2.4x over what the same calls measure. Re-run once the window\n` +
      `starts after the corrected counter shipped. Leaving ${OUT} untouched.`,
  );
  process.exit(1);
}

if (field(snapshot, 'inflation_suspected') === 'true') {
  console.error(
    `Refusing to publish: the snapshot carries inflation_suspected at raw_ratio ` +
      `${field(snapshot, 'raw_ratio')}. The sanitizer capped days it could not explain, and a\n` +
      `capped figure is not one to put on a storefront. Leaving ${OUT} untouched.`,
  );
  process.exit(1);
}

// The gap between raw and sanitized, said out loud at the moment the number is
// about to become a public claim (TRA-843). Not a refusal: the sanitizer is what
// makes the figure publishable, and it is still doing that — refusing here would
// freeze the site's counter at a stale value in response to someone else's
// flood. But whoever runs this and opens the PR is the last human-shaped step
// before the number is quoted, and they should know what it took to get it.
if (Number.isFinite(raw) && tokens > 0 && raw / tokens > INFLATION_RATIO) {
  console.error(
    `Warning: the endpoint received ${(raw / tokens).toFixed(2)}x what this publishes ` +
      `(over ${INFLATION_RATIO}x). The figure below is sanitized and safe to quote; ` +
      `the input is not. Check ops/user-signal.md in trace-mcp-private for a harvest overlapping this window.`,
  );
}

const body = `# The saved-token counter quoted on the homepage and in the README (TRA-533).
# Generated — do not edit by hand:
#
#     node scripts/refresh-savings.mjs
#
# Source is the daily GA4 snapshot on the orphan \`adoption-data\` branch. It
# cannot land on master automatically (master requires status checks with
# enforce_admins), so this file is refreshed through a normal PR.
#
# READ THIS BEFORE QUOTING THE NUMBER ELSEWHERE.
#
# It is an as-of observation, dated by \`refreshed\` — not a running total that
# only grows. The sanitizer recomputes one median across the whole window, so a
# later day can lower that median, retroactively cap earlier days, and pull
# \`tokens\` down even while the raw sum rises. Never write "and counting", "so
# far only grows", or anything implying monotonicity.
#
# \`*_display\` is floored below \`tokens\`/\`usd\` in THIS snapshot. That is the
# only guarantee it carries.
#
# The dollar figure is one published input rate applied to the token count —
# a conservative reference valuation, not a measurement of anyone's bill. We do
# not price the observed model mix, and installs may run cheaper, local, or
# free models. Say "at the <model> input rate", never "at least this much was
# saved". tests/docs/savings-claims.test.ts keeps the README in step.
tokens: ${tokens}
tokens_display: "${floorToUnit(tokens)}"
usd: ${usd}
usd_display: "$${Math.floor(usd)}+"
price_model: "${model}"
price_usd_per_mtok: ${perMtok}
# Window the figure covers, and the unsanitized sum beside it. Past
# ${INFLATION_RATIO}x between \`tokens_raw\` and \`tokens\`, this script warns on stderr
# and the daily snapshot annotates its workflow run — the gap is a tripwire with
# somewhere to fire, not a subtraction someone has to remember to do.
days: ${days}
tokens_raw: ${raw}
refreshed: "${new Date().toISOString().slice(0, 10)}"
`;

fs.mkdirSync('docs/_data', { recursive: true });
fs.writeFileSync(OUT, body);
console.log(body);
