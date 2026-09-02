#!/usr/bin/env node
/**
 * Daily adoption snapshot from the GA4 Data API.
 *
 * Writes docs/_data/adoption.yml in the workspace; the workflow publishes it
 * to the `adoption-data` branch rather than to master, because a PR opened by
 * GITHUB_TOKEN never triggers CI and so can never satisfy master's required
 * checks.
 *
 * GA4 keeps event data for 14 months at most (TRA-273), so anything older than
 * that only survives here. The file is the durable record; GA4 is the source.
 *
 * Auth is a service-account JWT signed with node:crypto — no dependency, and
 * nothing to keep up to date. Needs GA4_SA_KEY (the service account JSON) and
 * GA4_PROPERTY_ID in the environment.
 *
 * It also carries the acquisition end of the funnel (TRA-645), which is not
 * GA4 at all but GitHub's traffic API — one file, one durable record, and the
 * GitHub window is 14 days rolling, so it needs copying out even more urgently
 * than GA4's 14 months does. That needs GITHUB_REPOSITORY and GH_TRAFFIC_TOKEN;
 * without them the acquisition block records why it is empty.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { activation, share, usage, usageByClient } from './ga4-funnel.mjs';
import { PRICE_MODEL, PRICE_PER_TOKEN, sanitizedTokens, usd } from './ga4-savings.mjs';

const OUT = 'docs/_data/adoption.yml';

/**
 * First day the property could have data. GA4 clamps a start date that predates
 * the property, so an early constant just means "everything".
 *
 * ponytail: retention is 14 months, so once the property is older than that
 * this stops being an all-time total and silently becomes a trailing window.
 * The fix then is to freeze the oldest expiring month into a carried-forward
 * baseline in adoption.yml; not worth building until there is a month to lose.
 */
const SINCE = '2025-01-01';

/** The daily install ping (`src/telemetry/usage-ping.ts`) — it carries `tokens_saved`. */
const PING_EVENT = 'app_open';

function accessToken(key) {
  const b64 = (o) =>
    Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = crypto
    .sign('RSA-SHA256', Buffer.from(unsigned), key.private_key)
    .toString('base64url');
  return fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  })
    .then((r) => r.json())
    .then((t) => {
      if (!t.access_token) throw new Error(`token exchange failed: ${JSON.stringify(t)}`);
      return t.access_token;
    });
}

async function report(token, propertyId, body) {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json();
  if (json.error) throw new Error(`runReport failed: ${json.error.message}`);
  return json;
}

const range = (days) => [{ startDate: `${days}daysAgo`, endDate: 'today' }];
const num = (r, i = 0) => Number(r?.rows?.[0]?.metricValues?.[i]?.value ?? 0);

/** YAML-safe one-liner for an error we want visible instead of a silent 0. */
const why = (e) =>
  String(e?.message ?? e)
    .replace(/["\r\n]+/g, ' ')
    .slice(0, 200);

/**
 * The top of the funnel: where visitors to the repo came from.
 *
 * GitHub's traffic API is the only acquisition source available to us — the
 * docs site has no analytics of its own, and Reddit (our largest referrer) is
 * unreadable from a run at all (`ops/user-signal.md`). Its window is a rolling
 * 14 days and nothing older is retrievable, which is exactly why the numbers
 * are copied into the daily snapshot: the `adoption-data` branch becomes the
 * durable record, the same argument that created it for GA4.
 *
 * Needs a token with `Administration: read` — `GITHUB_TOKEN` cannot be granted
 * that scope, so this degrades to a recorded reason rather than a missing key.
 */
async function traffic(repo, token) {
  if (!repo || !token) return { error: 'no repo/token in the environment' };
  const get = async (p) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/traffic/${p}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
    return res.json();
  };
  try {
    const [views, referrers] = await Promise.all([get('views'), get('popular/referrers')]);
    return {
      views_uniques_14d: Number(views?.uniques ?? 0),
      // Uniques, not raw counts: the raw view count is as inflatable as any
      // other unauthenticated counter, and clones already proved that (TRA-540).
      referrers: Object.fromEntries(
        (referrers ?? []).map((r) => [r.referrer, Number(r.uniques ?? 0)]),
      ),
    };
  } catch (e) {
    return { error: why(e) };
  }
}

/**
 * `dimension -> value` breakdown, largest first, as a plain object.
 *
 * `(not set)` is kept, not dropped (TRA-643). It means something different from
 * every other key: our own `"unknown"` is a value the install sent, while
 * `(not set)` is GA4 having no value for that dimension at all — an event that
 * predates the custom dimension's registration, or one GA4 generated itself.
 * Dropping it made every breakdown sum to less than `active_users` with nothing
 * in the file to explain the gap, which is how "41% of installs report no
 * client" got read off a denominator that was never the right one.
 */
function breakdown(res) {
  // Null-prototype: these keys come from outside (a client name the install
  // picks for itself, a referrer host), and `{}['__proto__'] = x` is a silent
  // no-op — that row would vanish from the published breakdown with no trace.
  const out = Object.create(null);
  for (const row of res?.rows ?? []) {
    const k = row.dimensionValues?.[0]?.value;
    if (k) out[k] = Number(row.metricValues?.[0]?.value ?? 0);
  }
  return out;
}

const key = JSON.parse(process.env.GA4_SA_KEY ?? '');
const propertyId = process.env.GA4_PROPERTY_ID;
if (!propertyId) throw new Error('GA4_PROPERTY_ID is not set');
const token = await accessToken(key);

/**
 * A dimension the ping only started sending in TRA-643. GA4 rejects a report on
 * a custom dimension that is not registered in the property, and this workflow
 * is the only durable record of the trend — so a missing registration must cost
 * one empty section, not the whole daily snapshot.
 */
const optionalBreakdown = (dimension, metric = 'activeUsers') =>
  report(token, propertyId, {
    dateRanges: range(28),
    dimensions: [{ name: dimension }],
    metrics: [{ name: metric }],
    limit: 25,
  }).catch(() => null);

const [
  d1,
  d7,
  d28,
  versions,
  countries,
  clients,
  saved,
  installs,
  presets,
  surfaces,
  indexed,
  called,
  calledByClient,
  arrivals,
] = await Promise.all([
  report(token, propertyId, { dateRanges: range(1), metrics: [{ name: 'activeUsers' }] }),
  report(token, propertyId, { dateRanges: range(7), metrics: [{ name: 'activeUsers' }] }),
  report(token, propertyId, {
    dateRanges: range(28),
    metrics: [{ name: 'activeUsers' }, { name: 'eventCount' }],
  }),
  report(token, propertyId, {
    dateRanges: range(28),
    dimensions: [{ name: 'customEvent:version' }],
    metrics: [{ name: 'activeUsers' }],
    limit: 25,
  }),
  report(token, propertyId, {
    dateRanges: range(28),
    dimensions: [{ name: 'country' }],
    metrics: [{ name: 'activeUsers' }],
    limit: 25,
  }),
  report(token, propertyId, {
    dateRanges: range(28),
    dimensions: [{ name: 'customEvent:client' }],
    metrics: [{ name: 'activeUsers' }],
    limit: 25,
  }),
  // Daily rather than one total: the sanitizer needs the series to find the
  // median day, and a raw sum of an unauthenticated counter is not publishable.
  //
  // Filtered to the ping event, because the cap divides tokens by `activeUsers`
  // to get a per-user rate. Unfiltered, that denominator is the property's
  // whole daily audience; if any of it ever stops carrying `tokens_saved`, the
  // rate tracks traffic instead of usage and the cap drifts in both directions.
  // Today the ping is the property's only event, so this filter changes no
  // number — it keeps the denominator pinned to the population the numerator
  // comes from if that stops being true.
  report(token, propertyId, {
    dateRanges: [{ startDate: SINCE, endDate: 'today' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'customEvent:tokens_saved' }, { name: 'activeUsers' }],
    dimensionFilter: {
      filter: { fieldName: 'eventName', stringFilter: { value: PING_EVENT } },
    },
    limit: 100000,
  }).catch(() => null),
  report(token, propertyId, {
    dateRanges: range(28),
    dimensions: [{ name: 'customEvent:install_type' }],
    metrics: [{ name: 'eventCount' }],
    limit: 10,
  }).catch(() => null),
  optionalBreakdown('customEvent:preset'),
  optionalBreakdown('customEvent:tools_advertised'),
  // Activation (TRA-645). Resolved rather than caught to null: if the custom
  // dimension is not registered in the property, GA4 says so by name, and that
  // message is worth publishing — an empty block with no reason reads as "every
  // install activated" to the next person who looks at it.
  report(token, propertyId, {
    dateRanges: range(28),
    dimensions: [{ name: 'customEvent:repos_indexed' }],
    metrics: [{ name: 'activeUsers' }],
    limit: 250,
  }).catch((e) => ({ error: why(e) })),
  // Use, not setup (TRA-673). Same resolve-with-the-error treatment as
  // activation, and for a sharper version of the same reason: an empty `usage`
  // block with no reason reads as "every install uses the tools".
  report(token, propertyId, {
    dateRanges: range(28),
    dimensions: [{ name: 'customEvent:calls' }],
    metrics: [{ name: 'activeUsers' }],
    limit: 500,
  }).catch((e) => ({ error: why(e) })),
  // Its own error line rather than a silent `null`: this query can fail on its
  // own (quota, a malformed second dimension) while the single-dimension one
  // above succeeds, and empty client maps under a healthy `usage:` block read
  // as "no client reports use" instead of "this query did not run".
  //
  // ponytail: `limit` truncates server-side without saying so — GA4's own
  // `(other)` folding lands in `unknown`, but a 1000-row cut leaves no trace.
  // Check `rowCount` if the client × calls combinations ever get near it; at
  // single-digit clients and ~60 installs they are three orders away.
  report(token, propertyId, {
    dateRanges: range(28),
    dimensions: [{ name: 'customEvent:client' }, { name: 'customEvent:calls' }],
    metrics: [{ name: 'activeUsers' }],
    limit: 1000,
  }).catch((e) => ({ error: why(e) })),
  traffic(process.env.GITHUB_REPOSITORY, process.env.GH_TRAFFIC_TOKEN),
]);

const savings = sanitizedTokens(
  (saved?.rows ?? []).map((row) => ({
    tokens: Number(row.metricValues?.[0]?.value ?? 0),
    users: Number(row.metricValues?.[1]?.value ?? 0),
  })),
);

// Keys via JSON.stringify, not `"${k}"`: every one of these comes from outside
// — an MCP client name the client chooses for itself, a referrer host GitHub
// reports — and a `"` or `\` in one would otherwise emit a broken file and take
// the whole snapshot down with it. A YAML double-quoted scalar escapes exactly
// like a JSON string, so this is the escaping, not an approximation of it.
const yaml = (obj, indent = 2) =>
  Object.entries(obj)
    .map(([k, v]) => `${' '.repeat(indent)}${JSON.stringify(String(k))}: ${v}`)
    .join('\n') || `${' '.repeat(indent)}{}`;

const act = activation(indexed?.rows);
const use = usage(called?.rows);
const useByClient = usageByClient(calledByClient?.rows);
const newInstalls = installs ? (breakdown(installs).new ?? 0) : 0;
const yamlNum = (v) => (v === null || v === undefined ? 'null' : v);
/** An `error:` line when a source failed, nothing when it did not. */
const errLine = (e) => (e ? `  error: "${e}"\n` : '');

const body = `# Adoption snapshot from the GA4 property (TraceMCP). Generated by
# .github/workflows/ga4-snapshot.yml — do not edit by hand; edits are overwritten.
#
# Why this file exists: GA4 retains event data for 14 months at most, so this
# is the only durable record of the trend. Cite these numbers, never npm
# downloads (TRA-273 — those track our release cadence, not users).
#
# Caveat: the ping's credentials ship in the published bundle (SECURITY.md
# "Telemetry Credentials"), so events are unauthenticated and inflatable.
# Read as a trend; treat a step change as suspect until corroborated.
updated: "${new Date().toISOString()}"
active_users:
  day: ${num(d1)}
  week: ${num(d7)}
  month: ${num(d28)}
events_28d: ${num(d28, 1)}

# Tokens the indexed answers saved against reading the same code raw, summed
# across every install that has not opted out, since ${SINCE}.
#
# \`tokens_saved\` is the sanitized figure and the only one to quote: days whose
# per-user rate ran away from the median are capped, because the ping's
# credentials are public and the counter is inflatable by anyone. \`tokens_saved_raw\` is
# kept beside it so the gap between them stays visible — a widening gap is the
# signal that someone is flooding the endpoint.
#
# Dollars are derived here, not sent by the client, so a price change re-prices
# the whole history: ${PRICE_MODEL} input at $${(PRICE_PER_TOKEN * 1_000_000).toFixed(2)}/Mtok.
# That is the cheapest model we price, so \`usd_saved\` is a floor — quote it as
# "at least", never as a typical or best case. Pricing at Opus would multiply it
# by five and need a caveat carried alongside the number forever.
savings:
  tokens_saved: ${savings.tokens}
  tokens_saved_raw: ${savings.raw}
  usd_saved: ${usd(savings.tokens)}
  price_model: "${PRICE_MODEL}"
  price_usd_per_mtok: ${(PRICE_PER_TOKEN * 1_000_000).toFixed(2)}
  since: "${SINCE}"
  days: ${savings.days}
  capped_days: ${savings.capped_days}

# The funnel (TRA-645) — four numbers, one per stage, so a week's distribution,
# SEO, outreach or design change can be graded against something instead of
# taste. Every one is derived below in this same file; none is hand-collected.
#
#   arrivals    unique visitors to the GitHub repo, GitHub's rolling 14 days
#   installs    first-ever pings in 28 days (\`installs_28d.new\`)
#   activated   % of active installs reporting at least one indexed repository
#   used        % of active installs that called a tool at all in the window
#   retention   day / month active installs — how many of the month ran today
#
# \`activated\` and \`used\` are two different stages, not two readings of one
# (TRA-673). \`activated\` is *setup*: it says an install once registered a
# project, so an install that indexed a repo in July and has not called a tool
# since still counts. \`used\` is *use*. When they diverge, the gap between them
# is the population that reached the product and stopped.
#
# Mind the windows: arrivals is 14 days and everything else is 28, so
# arrivals→installs is a direction, not a conversion rate. The unauthenticated-
# counter caveat above applies to all of them.
funnel:
  arrivals_uniques_14d: ${yamlNum(arrivals.views_uniques_14d)}
  new_installs_28d: ${newInstalls}
  activated_pct: ${yamlNum(act.activated_pct)}
  used_pct: ${yamlNum(use.used_pct)}
  retention_dau_mau_pct: ${yamlNum(share(num(d1), num(d28)))}

# Activation, from the ping's \`repos_indexed\` param. An install that reports
# day after day with zero indexed repositories reached the product and never
# reached its value — that population, not the install count, is the ceiling on
# everything the product does after install.
#
# \`activated_pct\` is taken against these buckets' own total, never against
# \`active_users.month\`: GA4 deduplicates \`activeUsers\` within a dimension value
# and not across them, so an install that indexed its first repo mid-window is
# counted in both \`0\` and a non-zero bucket. An \`error\` here instead of buckets
# means the custom dimension is not registered in the property.
activation:
${errLine(indexed?.error)}  activated: ${act.activated}
  not_activated: ${act.not_activated}
  activated_pct: ${yamlNum(act.activated_pct)}
  unknown: ${act.unknown}
  by_repos_indexed:
${yaml(act.buckets, 4)}

# Use, from the ping's \`calls\` param — trace-mcp tool calls since the previous
# ping, counted by the MCP server itself and therefore comparable across
# clients (TRA-673). This is the number every efficiency claim we publish
# assumes: an agent that reads files instead of calling the tools saves nothing,
# whatever the benchmark says.
#
# \`used_pct\` is the figure to quote, not a call total. The ping's credentials
# are public, so a summed counter is inflatable exactly like \`tokens_saved\`;
# a per-install boolean is bounded above by \`active_users\` and costs one forged
# install per point. Same denominator rule as activation above — the share is
# over these buckets' own total, never over \`active_users.month\`.
#
# \`by_client_used_pct\` is the one that decides distribution strategy. The
# mechanism that actually routes an agent to our tools — the PreToolUse guard
# hook — is Claude Code only, and session mining has providers for two clients.
# If use holds across clients, reach work goes wide; if it collapses without a
# hook, our addressable market is clients that can enforce routing. Read it
# beside \`by_client_installs\`: single-digit denominators conclude nothing.
#
# Empty until \`calls\` is registered as an event-scoped custom dimension in the
# property; GA4 does not backfill, so values start at registration.
usage:
${errLine(called?.error)}  used: ${use.used}
  not_used: ${use.not_used}
  used_pct: ${yamlNum(use.used_pct)}
  unknown: ${use.unknown}
  by_calls:
${yaml(use.buckets, 4)}
${calledByClient?.error ? `  by_client_error: ${JSON.stringify(calledByClient.error)}\n` : ''}  by_client_used_pct:
${yaml(useByClient.used_pct, 4)}
  by_client_installs:
${yaml(useByClient.installs, 4)}

# Acquisition — where the repo's visitors came from, over GitHub's rolling
# 14-day window. This is the only acquisition signal available to us: the docs
# site carries no analytics, and Reddit, our largest referrer, cannot be read
# from a run at all (\`ops/user-signal.md\`). Cross-check these names against the
# "Arrivals" column of \`ops/distribution.md\` before adding another directory.
acquisition:
  views_uniques_14d: ${yamlNum(arrivals.views_uniques_14d)}
${errLine(arrivals.error)}  referrers_uniques_14d:
${yaml(arrivals.referrers ?? {}, 4)}
installs_28d:
${yaml(installs ? breakdown(installs) : {})}
by_version:
${yaml(breakdown(versions))}

# Which tool preset installs actually run, and how many tools that surface
# advertises (TRA-643). \`preset-surface-budget.test.ts\` measures the same basis
# — preset members plus the ungated meta-tools — so these two are the field
# check on its 67-86% claim. \`tools_advertised\` runs higher than the bench on
# any repo with a detected framework: those tools are registration-gated and the
# bench never registers them.
#
# Both are empty until the dimensions are registered in the GA4 property; GA4
# does not backfill, so values only start at registration.
by_preset:
${yaml(presets ? breakdown(presets) : {})}
by_tools_advertised:
${yaml(surfaces ? breakdown(surfaces) : {})}
by_country:
${yaml(breakdown(countries))}
by_client:
${yaml(breakdown(clients))}
`;

fs.mkdirSync('docs/_data', { recursive: true });
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
// `updated:` alone must not produce a commit — compare everything but that line.
const strip = (s) => s.replace(/^updated:.*$/m, '');
if (strip(prev) === strip(body)) {
  console.log('adoption.yml unchanged');
  process.exit(0);
}
fs.writeFileSync(OUT, body);
console.log(body);
