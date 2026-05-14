# IMPL Report — behavioural coverage for history / git / coupling tools

## Files shipped (5 new, 27 tests)

| File | Tests | Approach |
|------|-------|----------|
| `tests/tools/behavioural/get-circular-imports.behavioural.test.ts` | 5 | In-memory `Store` + `esm_imports` edges over `getDependencyCycles()` |
| `tests/tools/behavioural/get-coupling.behavioural.test.ts` | 6 | In-memory `Store` + `esm_imports` edges over `getCouplingMetrics()` |
| `tests/tools/behavioural/get-co-changes.behavioural.test.ts` | 6 | Direct `INSERT INTO co_changes` seeding — no git required |
| `tests/tools/behavioural/get-git-churn.behavioural.test.ts` | 5 | `vi.mock('node:child_process')` — synthesise `git log` output |
| `tests/tools/behavioural/detect-drift.behavioural.test.ts` | 5 | `vi.mock('node:child_process')` — synthesise multi-module commits |

## Implementation notes

- **Mock vs real-git**: for `getChurnRate` and `detectDrift` I picked the `vi.mock('node:child_process')` route (mirrors `get-risk-hotspots.behavioural.test.ts`). Pros: zero on-disk side effects, fully deterministic across CI runners (Windows / Linux / macOS git config drift moot), ~7ms per file instead of ~hundreds for `git init` + 5 commits. Brief authorised either approach.
- **Seed-table route**: for `getCoChanges` I seeded the `co_changes` table directly — same SQL the indexer's `persistCoChanges` would write. This isolates the query layer from the git log parser (which has its own coverage in `co-changes` indexer tests).
- **In-memory graph**: for `getDependencyCycles` and `getCouplingMetrics` I built file-level `esm_imports` edges through `store.insertEdge(fileNode, fileNode, 'esm_imports', ...)`. This is the production codepath — `buildFileGraph` joins `nodes.node_type='file'` rows directly via `CASE`.

## Drift from the brief's documented output shape

`detect_drift` register-side description advertises `{ anomalies, shotgunSurgery, total }` but the actual `detectDrift()` return shape is `{ co_change_anomalies, shotgun_surgery, summary: { total_anomalies, shotgun_hotspots } }`. Tests assert the **actual** shape. This is a doc/code drift in the user-facing tool description — flagging here, not patching (test-only brief).

## Latent bugs

None observed. All 27 tests pass on first run.

## CI / suite verdict

- 5 new behavioural files: 27/27 passing, ~90ms aggregate.
- Full suite: 6217 passing / 5 skipped + 2 pre-existing failing files (`find-usages-toon`, `search-text-toon`) confirmed failing on a clean `git stash` of my changes — not regression caused by this work.

## Risk

Sibling agent owns workspace/architecture/communities behavioural files in parallel. My commit cherry-picks only my 5 files; sibling's untracked files stay untracked.
