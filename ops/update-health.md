# Update health ledger — what's actually been proven to upgrade

Every run of the Update Health & Upgrade Path autopilot topic starts as a fresh
Multica issue with no memory of previous runs. This file is that memory: which
starting versions and scenarios have been driven through a real upgrade (not
read from code), and what is still open. **Read it before re-testing a scenario
someone already covered, and add a row in the same change that covers a new
one.**

Rules for keeping it honest, same as `ops/distribution.md`:

- Record what you **verified**, with the date, the tool used, and the result.
- A scenario "looks correct in the code" is not a row here — see TRA-357, which
  is exactly the incident this ledger exists to stop repeating: the staged-zip
  updater read correctly and failed 5/5 times in the field.
- Never delete a row. If a later run finds a regression, add a new row noting
  it broke — the history of "used to work" is as useful as "works now".

## Mechanism, as of 2026-09-05

Two upgrade paths exist, not one:

- **`scripts/postinstall-app.mjs`** — the bridge for legacy bundles only. A
  bundle counts as legacy iff it still ships
  `Contents/Resources/scripts/apply-pending-update.mjs` (the old staged-zip
  updater's marker file), which is every build up to and including 3.8.0.
  Triggered by `npm install -g trace-mcp`.
- **`electron-updater` + Squirrel.Mac** (macOS) / **NSIS** (Windows) — every
  build after that owns its own updates. Landed in TRA-436 (Developer ID
  signing + notarization) and TRA-437 (the electron-updater switch + bridge
  cutover), both merged 2026-08-30.

`docs/development.md` ("Desktop app update channels") and `ops/distribution.md`
("macOS code signing and notarization") carry the full detail. **If you are
about to describe the update mechanism as "our own thing, not electron-updater,
because we don't have a paid Apple Developer account" — that was true before
2026-08-29 and is not true now.** That framing has been showing up stale in
autopilot-issue boilerplate; correct it at the source (the autopilot topic
definition) rather than re-describing it wrong in a new issue each run.

## Verified upgrade scenarios

| From | To | Tool | Result | Verified |
|---|---|---|---|---|
| v1.50.0 (the exact TRA-357 incident version, ad-hoc-adjacent, legacy bridge) | 3.17.1 | `scripts/verify-upgrade-path.mjs --from v1.50.0` | **PASS** — bundle swapped, Gatekeeper accepted | 2026-09-05 |
| v3.8.0 (last legacy bundle before the electron-updater cutover; also Developer ID signed already — the isLegacyBundle gate is file-presence, not signature) | 3.17.1 | manual sandbox run of `scripts/postinstall-app.mjs` (same technique `verify-upgrade-path.mjs` automates) | **PASS** | 2026-09-05 |
| Two legacy bundles on one machine (e.g. `~/Applications` + `/Applications`) both at 3.8.0 | both to 3.17.1 in one `npm install -g` | manual sandbox run, two `TRACE_MCP_APP_DIRS` entries | **PASS** — "2 legacy bundles — updating each", both landed | 2026-09-05 |
| Swap interrupted mid-rename (only `trace-mcp.app.bak-<pid>` on disk, no live bundle — simulates a crash between the two renames in `applyTo()`) | recovered, then updated to 3.17.1 | manual sandbox run exercising `recoverInterruptedSwap()` | **PASS** — backup restored, then updated normally | 2026-09-05 |
| Release completeness: v3.10.0 → v3.17.1 (8 releases) | — | `gh release view --json assets`, checked for `*-win.zip`, `trace-mcp.Setup.*.exe`, `latest.yml` | **PASS**, all present | 2026-09-05 |
| npm `latest` vs GitHub `releases/latest` | — | `registry.npmjs.org/trace-mcp/latest` vs `gh release list` | **match** (3.17.1) | 2026-09-05 |
| Windows self-update (`scripts/verify-win-update.mjs`) | — | not run | **not covered this session — no Windows host available.** The script exists and is real (installs the previous NSIS build, drives the app's own update IPC over CDP), it just was not executed from this macOS-only run. | 2026-09-05 |

## Known, already-tracked gaps (do not re-file)

- **TRA-692**: a second installed bundle that is neither the running one nor
  the marker's target (e.g. dragged into a third, non-conventional directory)
  is invisible to every check, including the ones this ledger exercised above.
  Scope is deliberate per `scripts/locate-app.mjs`'s own comments — revisit
  only if a real install outside the two conventional directories is observed.
- **v3.9.0** shipped with no Windows assets at all (TRA-566-adjacent; already
  known, not a live gap since v3.10.0+).

## Fixed this session (2026-09-05)

`scripts/verify-upgrade-path.mjs` called `postinstall-app.mjs` without
overriding `TRACE_MCP_LAUNCHCTL_BIN`. `postinstall-app.mjs` unconditionally
runs `launchctl stop com.trace-mcp.server` before resolving which bundle to
touch — so running the verification script for real (as the script's own
header says the autopilot should) bounced the machine's actual running daemon
as a side effect, even though the script only ever touches a sandboxed copy of
the app. launchd's `KeepAlive` respawns it, so nothing broke, but a
verification tool has no business touching production state. Fixed by adding a
no-op `launchctl` stub alongside the existing pgrep stub.
