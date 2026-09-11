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
| 2026-09-07 | `src/db/repositories/domain-repository.ts` | `DomainRepository` (routes, components, migrations, ORM models/associations, RN screens) had zero direct tests despite being core DB/schema surface — round-trip + lookup for each entity, `findRouteByPattern`'s LIKE-wildcard matching, `getMigrationsByTable` ordering, and `getAllOrmAssociations`' file-scoped resolved-vs-unresolved-association filter (the exact query TRA-1005 is about to touch for SQLite chunking) | #1080 |
| 2026-09-09 | `src/db/repositories/analytics-repository.ts` | `AnalyticsRepository` (env vars, workspace stats, cross-workspace edges, workspace dependency graph, workspace exports, index stats, graph snapshot insertion/retrieval/pruning) had zero direct tests despite being core DB/schema surface — added comprehensive round-trip tests covering line ordering, cross-workspace edge resolution across symbol and file nodes, dependency graph self-edge filtering, and snapshot pruning | #1166 |
| 2026-09-11 | `src/db/repositories/graph-repository.ts` | `GraphRepository` (node creation & idempotency, node lookup by id/ref, edge insertion with defaults/custom tier/metadata/cross-ws, conflict upsert updates, constraint error handling, edge type management & listing, directional incoming/outgoing edge inspection, recursive CTE graph traversal with depth limits & cycle handling, file-scoped edge deletion for file/symbol nodes, outgoing import edge deletion, and batch chunking for node IDs, node refs, and cached edge queries with pivot node annotation) | #1187 |

## Next candidates (highest untested-symbol counts in `src/**`, unreached)

Re-derive before picking — this list ages. As of 2026-09-11:

- `src/api/memory-routes.ts::handleMemoryRequest` — decision-store HTTP surface (renamed/refactored since the 2026-08-30 pass; re-check `src/api/memory-routes-handlers.ts` too)
- `src/daemon/log-error.ts::serializeError` — error serialization helper
- `src/init/md-block.ts` (11) — rewrites the user's CLAUDE.md
- `src/init/tweakcc.ts` (9) — writes into another tool's config dir
- `src/api/dashboard-routes.ts` (7) — cache + cross-project queries

Edge resolvers (`src/indexer/edge-resolvers/**`) still show up heavily in
`unreached` (c-imports, csharp-imports, go-imports, java-imports,
kotlin-imports, fastapi-mounts, php-calls, member-of, heritage, iac-imports,
phantom-externals, file-projection, …), but they are exercised indirectly
through the indexing e2e tests — `test_covers` only records direct call edges
from a test, so treat that group as a classification artefact rather than a
genuine gap.
