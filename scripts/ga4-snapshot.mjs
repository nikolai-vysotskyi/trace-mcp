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
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
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
const num = (r, i = 0) => Number(r.rows?.[0]?.metricValues?.[i]?.value ?? 0);

/** `dimension -> value` breakdown, largest first, as a plain object. */
function breakdown(res) {
  const out = {};
  for (const row of res.rows ?? []) {
    const k = row.dimensionValues?.[0]?.value;
    if (k && k !== '(not set)') out[k] = Number(row.metricValues?.[0]?.value ?? 0);
  }
  return out;
}

const key = JSON.parse(process.env.GA4_SA_KEY ?? '');
const propertyId = process.env.GA4_PROPERTY_ID;
if (!propertyId) throw new Error('GA4_PROPERTY_ID is not set');
const token = await accessToken(key);

const [d1, d7, d28, versions, countries, clients, saved, installs] = await Promise.all([
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
  report(token, propertyId, {
    dateRanges: [{ startDate: SINCE, endDate: 'today' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'customEvent:tokens_saved' }, { name: 'activeUsers' }],
    limit: 100000,
  }).catch(() => null),
  report(token, propertyId, {
    dateRanges: range(28),
    dimensions: [{ name: 'customEvent:install_type' }],
    metrics: [{ name: 'eventCount' }],
    limit: 10,
  }).catch(() => null),
]);

const savings = sanitizedTokens(
  (saved?.rows ?? []).map((row) => ({
    tokens: Number(row.metricValues?.[0]?.value ?? 0),
    users: Number(row.metricValues?.[1]?.value ?? 0),
  })),
);

const yaml = (obj, indent = 2) =>
  Object.entries(obj)
    .map(([k, v]) => `${' '.repeat(indent)}"${k}": ${v}`)
    .join('\n') || `${' '.repeat(indent)}{}`;

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
savings:
  tokens_saved: ${savings.tokens}
  tokens_saved_raw: ${savings.raw}
  usd_saved: ${usd(savings.tokens)}
  price_model: "${PRICE_MODEL}"
  price_usd_per_mtok: ${(PRICE_PER_TOKEN * 1_000_000).toFixed(2)}
  since: "${SINCE}"
  days: ${savings.days}
  capped_days: ${savings.capped_days}
installs_28d:
${yaml(installs ? breakdown(installs) : {})}
by_version:
${yaml(breakdown(versions))}
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
