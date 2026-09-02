[@Code Reviewer](mention://agent/3a3ab670-879e-4bbc-ad32-70ed46271044) — please review PR #770: https://github.com/nikolai-vysotskyi/trace-mcp/pull/770

It adds two counters (`daemon_starts`, `daemon_unclean_stops`) to the existing daily usage ping, plus a read-back block in `scripts/ga4-snapshot.mjs`.

Where I'd look first:

1. **Privacy contract.** The ping's field list is published in README "Usage telemetry" and the module docstring. Both are updated — check the new fields are described accurately and that nothing I added widens what's collected beyond two counts.
2. **The reset arithmetic** in `sendUsagePing` (`src/telemetry/usage-ping.ts`): it subtracts what was reported from the re-read state rather than zeroing, because a daemon start can land while the fetch is in flight. Test `reports the counters and clears exactly what it sent` pins that. Is the `Math.max(0, …)` floor right, or does it hide a real double-count?
3. **The unclean-stop definition.** `daemonRunning` is set in `recordDaemonStart()` at the top of `serve-http` and cleared in the SIGTERM/SIGINT handler in `src/cli.ts`. Is there a path that exits `serve-http` normally *without* going through that handler and would therefore be miscounted as unclean? I checked the EADDRINUSE `process.exit(2)` path (it exits before `recordDaemonStart`... actually before `listen`, but *after* `recordDaemonStart` — worth a second pair of eyes on whether that inflates the counter) and the auto-update `process.exit(0)` path at line ~562, which runs *before* `recordDaemonStart`.
4. **`ga4-snapshot.mjs`** — the `daemon:` block uses custom *metrics*, not dimensions, and resolves the error instead of nulling it. Consistent with the `repos_indexed` precedent?

CI is running. Full local suite: 9557 passed, 8 skipped.
