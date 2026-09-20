---
noindex: true
---

# TRA-1745 — Graph exploration and data audit

The Graph now has a useful starting point (source hubs), an incoming/outgoing relationship inspector, navigable neighbors with Back, one/two-hop focus, and an interactive category legend. Selection reserves space for the inspector; on narrow panes it becomes a bottom panel. Hover details are measured, avoid the legend, stay inside the pane, do not intercept the pointer, and dismiss on Escape, blur, pointer exit, selection, or reload.

## Environment and evidence

Tested on Nikolai's MacBook in the installed `trace-mcp.app` (3.30.0), then an independently installed, ad-hoc-signed `trace-mcp Graph Review.app` containing the production renderer build. Both use the real local daemon and real project indexes. No Vite/dev server. The original bundle and live daemon were not replaced. The server-side identity correction was executed against SQLite backups of the real main and child indexes; the installed renderer screenshots continue to show the original daemon's counts until the server update is released.

Screenshots and machine-readable results are attached to TRA-1745 rather than committing private project payloads into this public repository. Evidence includes baseline/updated overview, selected relationships, and group focus for all three projects, plus the installed tooltip overlap reproduction.

The final installed interaction pass also verified actual GPU hover (not injected component state): the tooltip rectangle stayed inside the Graph pane, had zero overlap with the legend, used `pointer-events: none`, and stacked at z-index 80 above the legend's 30. Escape removed it. At 640×480, the inspector remained inside the 404×395.5 Graph pane as a 380×177.97 bottom panel. Light appearance and the retained-graph error/Retry flow were captured; unblocking the real endpoint and pressing Retry recovered successfully.

## Projects and count reconciliation

| Real project | Structure | Baseline nodes / relationships / groups | Corrected snapshot nodes / relationships / groups |
| --- | --- | --- | --- |
| assetfeed | Laravel production/development backends, Vue frontend, Python scraper; parent and federated child indexes | 2,495 / 9,195 / 60 | 2,422 / 9,040 / 47 |
| trace-mcp | TypeScript libraries, CLI, tests and desktop app | 1,667 / 7,650 / 50 | unchanged |
| thestyle-bot | Smaller Python bot/services project | 217 / 742 / 13 | unchanged |

The first capture of the user's existing window reproduced **2,508 / 9,872 / 68** exactly, including the legend counts 724 + 553 + 262 + 174 + 795 = 2,508. The active indexes subsequently changed during the session; a later capture showed 2,509 / 9,873 / 68 before settling at the baseline above. Before/after builder comparisons use the **same SQLite backups**, so the correction is not attributed to indexing changes.

Definitions:

- Nodes are the loaded graph projection, not all files on disk. Files mode also includes virtual external dependency nodes. The UI now states source/external counts separately and labels external dependencies in the inspector.
- File relationships collapse underlying file/symbol edges. Multiple typed relationships can share a directed endpoint pair. The UI separately reports drawn links: the baseline assetfeed graph has 9,195 relationship records but 9,097 distinct drawn pairs. The 20,000-link rendering budget never limits inspector counts or neighborhood traversal.
- Groups are label-propagation communities of this projection, not directory counts or a permanent database identity. The legend shows the four largest categories; Other is their complement. Clicking Other focuses that exact complement.
- After correction, assetfeed contains 2,282 source nodes and 140 external nodes; trace-mcp contains 1,569 source nodes and 98 external nodes; thestyle-bot contains 217 source nodes. All three projections have unique IDs and zero dangling endpoints.

The assetfeed parent and its separately indexed frontend represented **54 physical source files twice**, plus 19 repeated external dependency nodes. Contained repository IDs now normalize to parent-relative identities before deduplication, community detection, and degree calculation. Repeated typed relationships retain the larger observed weight, not the sum of two indexes describing the same relationship.

Three frontend source paths remain stale in the captured indexes. Filed separately as **TRA-1746** with exact paths and reproduction. trace-mcp and thestyle-bot have zero missing source files after separating virtual dependencies. This audit does not claim the stale records are actual files.

## Interaction audit

| Surface | Execution/check |
| --- | --- |
| Search → node | Exact ForexController search, selection, camera focus, five direct neighbors; equivalent navigation on the other two projects |
| One/two-hop focus | Assetfeed 6 → 484 nodes; trace-mcp 372 → 1,087; thestyle-bot 86 → 131 on the live daemon snapshots |
| Relationship inspector | Incoming/outgoing lists, per-neighbor indexed relationship types, local filtering, navigation, Back, Escape |
| Legend | Real category membership, pressed state, dimming, camera fit, second-click reset; all three projects |
| Hover | Installed overlap reproduced before changes; measured placement and stacking covered by regression tests |
| Layout and labels | Reserve canvas space for selection; collision pass retained; stop layout after the initial settle; explicit Fit does not restart the solver |
| Files/Symbols | Uses the existing server granularity contract; request sequencing rejects stale responses |
| Empty/loading/error | Explicit empty projection; loading remains in existing status chrome; errors persist with Retry; original data remains visible on failed reload |
| Data/performance | Linear adjacency index independent of rendered links, cached hub ranking, existing worker/edge budget retained |
| Accessibility | Keyboard buttons, pressed/expanded state, direction labels, readable design tokens, all ten language catalogs |

## Validation

- Full server suite: **11,583 passed, 40 skipped** (1,031 passing files, 3 skipped). Ran `env -u CODEX_HOME pnpm test --maxWorkers=4` to avoid the runtime's session-directory override and parallel timing contention. The first default run exposed those environment/timing failures; no tests were disabled or loosened.
- Full desktop suite: **823 passed**. Includes behavioral connection navigation, tooltip placement/obstacle regression, and existing graph tests.
- Root build/lint, renderer/main build, desktop typecheck and i18n checks.
- Graph builder on real SQLite backups: approximately 237 ms assetfeed, 134 ms trace-mcp, 20 ms thestyle-bot in one measured run. These are builder timings, not GPU FPS benchmarks.
- Installed assetfeed Symbols mode: **11,080 nodes / 25,489 indexed relationships / 534 groups**, with **20,000 drawn links** explicitly disclosed. No freeze/crash during granularity changes, selection or Fit. A paused two-second CDP `TaskDuration` sample measured **37.25 ms** of renderer task time; this is not a GPU FPS claim.

Re-run the data audit with `pnpm exec tsx scripts/audit-graph-snapshot.ts <backup-folder>`. Provide `topology.db`, `<name>.db` files and `projects.json` containing `{name, root}` entries. Rewrite every topology `db_path` to a child backup inside that folder first; the script refuses references outside it. Private JSON graph payloads stay in that folder.

## Compatibility note

No database schema, stored file/symbol IDs, or MCP tool argument/response fields changed. Visualization IDs for a contained child repository change from `child:relative/path` to `child/relative/path`, matching the existing parent node. Consumers retaining transient visualization IDs should re-export the graph. Unrelated external repositories retain their namespaced IDs. The output gets smaller when duplicate representations are removed; no extra MCP response fields or token overhead were introduced.

## Independent SQL relationship reconciliation


Joined edge endpoints through file nodes and symbols.file_id in every captured project/child database, normalized contained repo paths, and compared distinct directed pairs independently of the graph builder.

| Project | Raw index edge rows examined | SQL file pairs | Graph file pairs | Unsupported / missing pairs |
| --- | --- | --- | --- | --- |
| assetfeed | 32,750 | 9,004 | 9,012 | 8 / 0 |
| trace-mcp | 64,944 | 7,650 | 7,650 | 0 / 0 |
| thestyle-bot | 7,318 | 742 | 742 | 0 / 0 |

Filed **TRA-1748**: service topology attaches repository-level relationships to the first file in each repository. Those eight file endpoints are unsupported by indexed code relationships. The PR fixes duplicate identities; this separate topology semantic issue and the three stale files in TRA-1746 remain open and must not be mistaken for verified source dependencies.

Latest native repeat: the narrow focus indicator is above the bottom inspector without overlap; hover, symbols and Retry checks passed again. Paused renderer TaskDuration was 39.012 ms in a two-second repeat. PR: https://github.com/nikolai-vysotskyi/trace-mcp/pull/1303, head 492c7fbefdc03abdd6b44f5ed6bd962c700a3c67.
