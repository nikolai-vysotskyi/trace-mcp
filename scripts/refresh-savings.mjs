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
 * ponytail: manual refresh, one command. The upgrade is a workflow step that
 * runs this and opens the PR with a PAT (GITHUB_TOKEN cannot, see above);
 * worth it once the number moves often enough that anyone notices it is stale.
 * Until then the `+` suffix does the work — every published figure is a floor
 * that only grows, so a stale counter understates and never lies.
 */
import fs from 'node:fs';

const SRC =
  'https://raw.githubusercontent.com/nikolai-vysotskyi/trace-mcp/adoption-data/adoption.yml';
const OUT = 'docs/_data/savings.yml';

/**
 * Pull one scalar out of the snapshot's `savings:` block.
 *
 * A regex rather than a YAML parser: this needs four numbers out of a file we
 * generate ourselves in a fixed shape, and the alternative is a dependency in
 * a script whose whole point is having none.
 */
function field(yaml, name) {
  const block = yaml.match(/^savings:\n((?:[ \t]+.*\n)+)/m)?.[1];
  if (!block) throw new Error('no `savings:` block in the published snapshot');
  const raw = block.match(new RegExp(`^\\s+${name}:\\s*"?([^"\n]+)"?\\s*$`, 'm'))?.[1];
  if (raw === undefined) throw new Error(`no \`${name}\` in the savings block`);
  return raw.trim();
}

/**
 * Round DOWN to a readable unit and mark it `+`. Down, never nearest: the
 * published figure must stay true as the real one grows past it, which is what
 * lets a counter refreshed by hand sit on the landing page without rotting
 * into a false claim.
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
const usd = Number(field(snapshot, 'usd_saved'));
const model = field(snapshot, 'price_model');
const perMtok = field(snapshot, 'price_usd_per_mtok');
if (!Number.isFinite(tokens) || !Number.isFinite(usd)) {
  throw new Error('the snapshot carries no usable savings numbers');
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
# Every published figure is floored and suffixed \`+\`, so a stale counter
# understates and never lies. Quote \`*_display\`, never the raw numbers.
#
# The dollar figure is derived from tokens at ONE published input price, the
# cheapest model we track — so it is a floor, not a typical case. Quote it as
# "at least". tests/docs/savings-claims.test.ts keeps the README in step.
tokens: ${tokens}
tokens_display: "${floorToUnit(tokens)}"
usd: ${usd}
usd_display: "$${Math.floor(usd)}+"
price_model: "${model}"
price_usd_per_mtok: ${perMtok}
refreshed: "${new Date().toISOString().slice(0, 10)}"
`;

fs.mkdirSync('docs/_data', { recursive: true });
fs.writeFileSync(OUT, body);
console.log(body);
