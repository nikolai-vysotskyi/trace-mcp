/**
 * Turning the raw snapshot rows into the funnel numbers (TRA-645, TRA-673).
 *
 * Pure functions only, so they are testable without GA4 or GitHub credentials;
 * `ga4-snapshot.mjs` does the fetching and hands the rows here.
 *
 * The funnel exists because every listing rewrite, hero redesign and outreach
 * PR was being graded on taste: we had a denominator (active installs) and
 * nothing on either side of it. Its stages are
 * arrivals → installs → activation → use → retention.
 *
 * Activation and use are deliberately separate: `repos_indexed` says an install
 * completed *setup*, `calls` says it actually used the tools (TRA-673). The gap
 * between them is the population that reached the product and stopped.
 */

/** GA4 returns dimension values as strings; an unset one is this literal. */
const NOT_SET = '(not set)';

/**
 * Tally `activeUsers` into named buckets by a numeric dimension value.
 *
 * `place` maps a non-negative number to a bucket key; anything that is not a
 * non-negative number — `(not set)`, GA4's `(other)` cardinality overflow, an
 * empty string — lands in `unknown` rather than in the zero bucket. That
 * distinction is the whole point: a missing reading is not evidence of a zero.
 * `Number('')` is 0, so the empty value has to be rejected before the parse.
 */
function tally(rows, buckets, place) {
  let unknown = 0;
  for (const row of rows ?? []) {
    const raw = row.dimensionValues?.[0]?.value;
    const users = Number(row.metricValues?.[0]?.value ?? 0);
    if (!Number.isFinite(users) || users <= 0) continue;
    const n = !raw?.trim() || raw === NOT_SET ? Number.NaN : Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      unknown += users;
      continue;
    }
    buckets[place(n)] += users;
  }
  return { buckets, unknown };
}

/**
 * Activation from the ping's `repos_indexed` param: an install that reports
 * daily with zero indexed repositories reached the product and never reached
 * its value.
 *
 * The share is taken against the rows' own total, never against
 * `active_users.month`, because `activeUsers` is deduplicated *within* a
 * dimension value and not across them: an install that indexed its first repo
 * mid-window appears in both the `0` row and a non-zero row. Read the share as
 * "of installs seen at some level", and expect the parts to over-count the
 * whole by however many installs crossed over during the window.
 *
 * @param rows GA4 `runReport` rows, dimension `customEvent:repos_indexed`,
 *   metric `activeUsers`.
 */
export function activation(rows) {
  const { buckets, unknown } = tally(rows, { 0: 0, 1: 0, '2-5': 0, '6+': 0 }, (n) =>
    n === 0 ? '0' : n === 1 ? '1' : n <= 5 ? '2-5' : '6+',
  );
  const activated = buckets['1'] + buckets['2-5'] + buckets['6+'];
  const placed = buckets['0'] + activated;
  return {
    buckets,
    unknown,
    activated,
    not_activated: buckets['0'],
    // Null, not 0: no data is a different fact from "nobody activated".
    activated_pct: placed === 0 ? null : Math.round((activated / placed) * 100),
  };
}

/**
 * Use, from the ping's `calls` param — trace-mcp tool calls since the previous
 * ping (`src/telemetry/usage-ping.ts`), counted by the server itself and so
 * comparable across MCP clients (TRA-673).
 *
 * This is the stage `activation` above is not. `repos_indexed` says an install
 * once registered a project; an install that indexed a repo in July and has not
 * called a tool since still reads as activated. `calls` says the tools were
 * actually used in the window.
 *
 * The published headline is `used_pct` — the share of installs with *any* call
 * — not the call total. The ping's GA4 credentials ship in the published bundle
 * (SECURITY.md "Telemetry Credentials"), so a summed counter is inflatable by
 * anyone, exactly as `tokens_saved` is; that is what `ga4-savings.mjs` caps.
 * A per-install boolean is not: inflating it costs one forged install per
 * point, and it is bounded above by `active_users` no matter how many events
 * are sent. That is why `calls` is read as a *dimension* here and never summed.
 *
 * Same denominator discipline as `activation`: the share is over these rows'
 * own total, never over `active_users.month`, because `activeUsers` is
 * deduplicated within a dimension value and not across them — an install that
 * made its first call mid-window appears in both the `0` row and a non-zero
 * one.
 *
 * ponytail: `calls` is a raw integer, so its cardinality is unbounded and GA4
 * folds a dimension past 500 daily values into `(other)`, which lands in
 * `unknown` here. Harmless at ~60 installs and self-announcing if it ever
 * stops being — a growing `unknown` is the signal. Bucket in the client then.
 *
 * @param rows GA4 `runReport` rows, dimension `customEvent:calls`, metric
 *   `activeUsers`.
 */
export function usage(rows) {
  const { buckets, unknown } = tally(rows, { 0: 0, '1-9': 0, '10-99': 0, '100+': 0 }, (n) =>
    n === 0 ? '0' : n < 10 ? '1-9' : n < 100 ? '10-99' : '100+',
  );
  const used = buckets['1-9'] + buckets['10-99'] + buckets['100+'];
  const placed = buckets['0'] + used;
  return {
    buckets,
    unknown,
    used,
    not_used: buckets['0'],
    used_pct: share(used, placed),
  };
}

/**
 * `usage`, split by the client the install reports (TRA-673 scope item 2).
 *
 * The question this exists for: our strongest routing mechanism — the
 * PreToolUse guard hook — is Claude Code only, while we ship into MCP
 * directories on a premise of client neutrality. If `used_pct` holds across
 * clients the hook is a nice-to-have; if it collapses without one, our
 * addressable market is "clients that can enforce tool routing" and a lot of
 * current distribution effort points at installs that will never reach value.
 *
 * `installs` is published beside every percentage on purpose: at the client
 * counts we have (single digits outside Claude Code) a percentage on its own
 * invites a conclusion the sample cannot carry.
 *
 * @param rows GA4 `runReport` rows, dimensions `customEvent:client` then
 *   `customEvent:calls`, metric `activeUsers`.
 */
export function usageByClient(rows) {
  const byClient = new Map();
  for (const row of rows ?? []) {
    const client = row.dimensionValues?.[0]?.value;
    if (!client) continue;
    // Re-shape to the single-dimension row `usage` reads, dropping the client.
    const rest = { dimensionValues: row.dimensionValues.slice(1), metricValues: row.metricValues };
    byClient.set(client, [...(byClient.get(client) ?? []), rest]);
  }
  // Null-prototype, because the key is a client name the install chooses for
  // itself and the ping is unauthenticated: `{}['__proto__'] = x` is a silent
  // no-op, so a forged `client=__proto__` would delete itself from both maps
  // with no error and no `unknown` credit — invisible in the one number this
  // function exists to produce.
  const used_pct = Object.create(null);
  const installs = Object.create(null);
  for (const [client, clientRows] of byClient) {
    const u = usage(clientRows);
    used_pct[client] = u.used_pct;
    installs[client] = u.used + u.not_used;
  }
  return { used_pct, installs };
}

/** Percentage, or null when the denominator is missing — never a fake 0. */
export function share(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/**
 * First version whose ping reports its client correctly (TRA-643, `be1fb536`).
 * Before it, the ping's final `saveState` wrote a snapshot taken before the HTTP
 * request and erased the client name the request had just recorded, so those
 * installs report `unknown` no matter which client they run.
 */
export const CLIENT_FIX_VERSION = '3.12.0';

/** Semver compare on the numeric release triple; a prerelease suffix is ignored. */
function cmpVersion(a, b) {
  // `Number('')` is 0, so an empty segment has to be rejected before the parse —
  // otherwise `(not set)`'s empty string parses as 0.0.0 and lands below the
  // floor, which is exactly the unknown-counted-as-evidence bug this guards.
  const parts = (v) =>
    String(v)
      .split('-')[0]
      .split('.')
      .map((n) => (n.trim() === '' ? Number.NaN : Number(n)));
  const [x, y] = [parts(a), parts(b)];
  if (x.some((n) => !Number.isFinite(n)) || y.some((n) => !Number.isFinite(n))) return null;
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * How much of the field runs a version that can report its client at all
 * (TRA-748) — the gate on whether `by_client` and `by_client_used_pct` mean
 * anything yet.
 *
 * `by_client_used_pct` becomes non-empty the moment `calls` is registered in the
 * property, and it decides distribution strategy — but a split computed over a
 * population that is nine-tenths client-blind cannot answer "does use hold
 * across clients" in either direction. Nineteen hours after v3.12.0 shipped,
 * versions carrying the fix were 10% of the rows. Publishing the share here is
 * the difference between a caveat that travels with the data and a caveat in an
 * issue nobody re-reads.
 *
 * `pct` is over placed rows only, the same denominator discipline as everything
 * above: GA4's `(not set)` version is not evidence of an old install.
 *
 * @param rows GA4 `runReport` rows, dimension `customEvent:version`, metric
 *   `activeUsers`.
 */
export function clientReporting(rows, floor = CLIENT_FIX_VERSION) {
  let at_or_above = 0;
  let below = 0;
  let unknown = 0;
  for (const row of rows ?? []) {
    const users = Number(row.metricValues?.[0]?.value ?? 0);
    if (!Number.isFinite(users) || users <= 0) continue;
    const c = cmpVersion(row.dimensionValues?.[0]?.value ?? '', floor);
    if (c === null) unknown += users;
    else if (c >= 0) at_or_above += users;
    else below += users;
  }
  const pct = share(at_or_above, at_or_above + below);
  return {
    fix_version: floor,
    at_or_above,
    below,
    unknown,
    pct,
    // The gate itself, as a value rather than something to re-derive: below half
    // the field on a fix-carrying version, re-read and record — do not conclude.
    readable: pct === null ? null : pct >= 50,
  };
}
