---
noindex: true
---

# TRA-1767 — Stable graph gestures and one hover name

UI path: Graph → Cosmos `onZoomStart` / `onZoomEnd` → simulation pause and
`updateLabels`; GPU point picking → `hovered` → `GraphHover` and the same label pass.
The graph payload continues to come from `GET /api/projects/graph` unchanged.

User zoom/pan pauses the layout immediately and leaves the toolbar Paused.
Live explicitly resumes it. Labels and halos hide during the gesture and return
after one final placement pass. Programmatic initial fits retain their existing
behavior. When the hover card is visible, every canvas label candidate path
excludes that node. Selection (which hides the card) still retains canvas names.
Replacing a graph mid-gesture resets the gesture state so overlays and hover recover.

## Executed reproduction and native validation

Used the installed `trace-mcp.app` 3.31.0 on Nikolai's MacBook, then a separate
ad-hoc-signed installed `trace-mcp TRA-1767 Review.app` containing the production
renderer built from this branch. Original installed bundle unchanged. No dev
server. Isolated profiles, hidden windows, CDP wheel input and real GPU picking;
screenshots use Electron `webContents.capturePage`. Window visibility was checked
false and each test process terminated at the end. The live daemon/indexes served
all three projects; no fabricated graph payloads or injected hover state.

| Real project | Nodes | Relationships | Drawn pairs | Groups |
| --- | ---: | ---: | ---: | ---: |
| assetfeed (Laravel/Vue/Python monorepo) | 2,571 | 9,433 | 9,403 | 58 |
| trace-mcp (TypeScript CLI/library/desktop) | 1,667 | 7,650 | 7,650 | 51 |
| thestyle-bot (Python services/bot) | 217 | 742 | 742 | 13 |

Counts were independently checked against the live graph endpoint: IDs unique,
no dangling endpoints, source + external counts equal nodes, and drawn pair
counts match the UI. This is projection consistency, not a new source/index audit.
Assetfeed's live index changed from 9,435 to 9,433 relationships between captures;
the distinct drawn pairs and node count stayed unchanged. Community counts are
computed by the existing server and can vary across fresh requests.

Before: every captured hover repeated its filename in a canvas label, including
the reported CryptoCurrency.php. Labels read positions 21 times during an
approximately 0.6-second wheel sequence on each project. Cosmos already inhibits
force steps within an individual gesture, but its solver remains Live and resumes
after it; the renderer also recomputes screen-space label placement during zoom.
The fix explicitly pauses the solver across subsequent gestures and their gaps.

After: all three native checks assert zero world-coordinate movement from the
first wheel event through the gesture and after it ends, and the solver remains
paused. Hover captures show no duplicate label, with path and connected-node count
retained. Machine-readable results and before/after screenshots are attached to
TRA-1767; private screenshots/payloads are not committed here.

## Regression tests and checks

Component tests mount the actual Graph explorer with a mocked GPU boundary.
The initial implementation failed three tests (pause and two hover candidate
paths). A second-model review found the replacement-during-gesture lifecycle hole;
its new regression also failed before the fix. All seven now pass, including
one final label pass, no breathing restart, explicit Live resume, programmatic
fit, selected neighbors and Labels off.

- Server suite: 11,619 passed, 40 configured skips (`env -u CODEX_HOME pnpm test --maxWorkers=4`).
- Desktop suite: 831 passed.
- Root build/lint, desktop renderer/main build/typecheck, i18n check and diff whitespace check passed.
- Independent GPT-5.6 Sol review: approved after the lifecycle fix, no remaining blockers.

No MCP contract, persisted schema, graph data computation or tool token budget changes.
