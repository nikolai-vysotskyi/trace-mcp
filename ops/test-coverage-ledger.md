# Test coverage ledger

What the Test & Quality Health runs have actually covered, so the next run
starts where the last one stopped instead of re-deriving the same list.

Candidates come from dogfooding `get_untested_symbols` against this repo's own
index, filtered to `src/**`, functions and classes only. Since TRA-515 the tool
defaults to `level: "unreached"`, so no manual level filtering is needed —
`level: "all"` restores the old combined output.
Priority is not the headline percentage — it is the surface that can damage a
user's machine or break the tool contract: disk paths, shell, DB/schema,
parsing, the MCP tool surface.

| Date | Area | What was covered | PR |
|------|------|------------------|----|
| 2026-08-30 | `src/init/hermes-hooks.ts` | Guard-script install, `config.yaml` wiring (idempotency, stale refresh, foreign hooks, parse errors), shell-hook allowlist (shape, idempotency, malformed recovery), dry-run | #649 |

## Next candidates (highest untested-symbol counts in `src/**`, unreached)

Re-derive before picking — this list ages. As of 2026-08-30:

- `src/api/ask-sessions-routes-handlers.ts` (15) — HTTP handlers over the DB
- `src/api/memory-routes-handlers.ts` (15) — decision-store HTTP surface
- `src/init/md-block.ts` (11) — rewrites the user's CLAUDE.md
- `src/init/tweakcc.ts` (9) — writes into another tool's config dir
- `src/api/dashboard-routes.ts` (7) — cache + cross-project queries

Edge resolvers (`src/indexer/edge-resolvers/**`) also show up as unreached, but
they are exercised indirectly through the indexing e2e tests — `test_covers`
only records direct call edges from a test, so treat that group as a
classification artefact rather than a genuine gap.
