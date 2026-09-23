---
noindex: true
---

# TRA-1748 — Keep service topology out of file and symbol dependencies

`buildSubprojectGraph` previously turned service relationships into dependencies
between the first loaded nodes of each repository. Neither endpoint was supported
by a file/symbol relationship. Those links also bypassed the edge-type filter and
influenced node importance and community detection.

The graph still merges each registered subproject's indexed dependencies and
normalizes contained repository identities. It now omits service-only links.
Actual indexed dependencies across repository boundaries remain visible. Service
relationships remain stored and available through topology; they must have
verified endpoints or a separate service-node visualization before they can be
shown as source dependencies.

## Reproduction and regression coverage

Before changing production code, the new regression reproduced six failures in
Files/Symbols modes, with and without isolated nodes, including filter bypass.
The final matrix has 12 passing cases: both granularities, both isolation modes,
and no filter / matching `calls` / nonmatching `imports` filters. It verifies the
complete graph remains unchanged when service relationships are added, preserves
a real indexed cross-repository call, and checks that topology records survive.
An unrelated service also exercises the former fallback to the main repository.

## Independent real-project reconciliation

Executed the baseline at `b8ec4257` and the corrected builder against identical
SQLite backups from the TRA-1745 audit. Only local copies were used; topology
`db_path` values were rewritten to child backups. Production indexes were not
modified. Independent SQL joins `edges` through `nodes` to `files` or
`symbols.file_id`, normalizes contained paths, and compares directed file pairs.

| Project | Nodes before → after | Relationship records before → after | Directed pairs before → after | SQL pairs | Groups before → after |
| --- | --- | --- | --- | --- | --- |
| assetfeed | 2,422 → 2,422 | 9,040 → 9,032 | 9,012 → 9,004 | 9,004 | 47 → 48 |
| trace-mcp | 1,667 → 1,667 | 7,650 → 7,650 | 7,650 → 7,650 | 7,650 | 50 → 50 |
| thestyle-bot | 217 → 217 | 742 → 742 | 742 → 742 | 742 | 13 → 13 |

Exactly eight assetfeed relationship records are removed; no edges are added.
All three projects have zero unsupported pairs, zero missing indexed pairs, zero
duplicate node IDs, and zero dangling endpoints. Their node-ID sets are unchanged.
Both control project payloads are completely identical before and after. The
assetfeed group count changes because label propagation no longer joins groups
through invented dependencies. Relationship records can have different types
for the same directed pair, explaining the distinct pair/record totals.

The historical assetfeed snapshot still has four source paths absent from the
current filesystem: three previously tracked in TRA-1746 and a scraper file
removed since capture. This fix does not change those index records or claim to
repair stale files.

## Validation

- Drove the unchanged installed `~/Applications/trace-mcp.app` 3.31.0 in a hidden,
  isolated profile on Nikolai's MacBook. Replayed real baseline/corrected SQLite
  graph payloads into its Graph request, searched/selected the affected assetfeed
  file, and selected a source hub in each control project. Captured six native
  before/after screenshots. Assetfeed's affected file goes from eight neighbors
  (including unsupported service-derived targets) to four indexed neighbors;
  both control selections and counts are unchanged.
- The live daemon refused connections during validation. This is installed UI
  verification with snapshot replay, not a deployed-server verification. The
  review instance's daemon lifecycle functions were disabled before startup;
  the production app bundle and running daemon were not replaced or restarted.
- Full server suite: 11,658 passed, 40 configured skips; 1,042 passing test files.
  Command: `env -u CODEX_HOME pnpm test --maxWorkers=4`.
- Focused graph suite: 38 passed, including all 12 new regression cases.
- `pnpm run build`, `pnpm run lint`, and Biome check of the new test passed.
- Private payloads, SQL reconciliation, exact removed-edge list, and screenshots
  are attached to TRA-1748 rather than committed to the public repository.

## Compatibility

No MCP argument/result fields, database schema, stored identities, or topology
records change. No migration is needed. Re-export/reload the visualization after
updating the server to remove the unsupported links; node importance and community
labels can change accordingly. No response fields or token overhead are added.
