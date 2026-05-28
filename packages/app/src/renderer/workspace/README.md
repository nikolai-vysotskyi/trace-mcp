# Workspace tab — design note

Single tab that replaces the previous **Projects** (`tabs/Indexes.tsx`) and
**Dashboard** (`tabs/Dashboard.tsx`) tabs. Combines the live operational
console with the aggregated health analytics into one screen.

## Why one tab

The two tabs were rendering the same list (registered projects) with
different columns and different actions. Their data sources also disagreed
in real time — the Projects tab read live SSE from the daemon, the Dashboard
tab polled a 5-minute-cached HTTP endpoint, so the *same row* could show
different statuses depending on which tab the user happened to be on.
The Dashboard's empty state even pointed at the Projects tab to add a
project — a load-bearing UX seam where there shouldn't be one.

The unified Workspace tab solves both problems: one source of truth per
field, one set of actions per row, one empty state.

## Data sources

| Source | Transport | Cache | Owns |
|---|---|---|---|
| `useDaemon()` | SSE (`/api/events`) + REST | none, push | live status, indexing progress, errors, mutations |
| `GET /api/dashboard/projects` | REST | 5 min server-side + manual invalidate | name, lastIndexed, file/symbol counts, dead exports, untested, tech-debt grade, security findings |

Cache invalidation triggers from the daemon SSE feed (re-fetch `/api/dashboard/projects`):

- `reindex_completed`
- `reindex_errored`
- `embed_completed`
- `indexing_done`
- `snapshot_created`

Plus the existing 5-minute polling fallback inside `useWorkspaceProjects`.

## Merged view model

All view components read `ProjectViewModel[]`. The merge rules live in
[`types.ts`](./types.ts) (`mergeIntoViewModel`):

- Field-level precedence:
  - **Daemon wins** for `displayStatus` (when transient), `liveStatus`,
    `progress`, `error` (when set), `inDaemon`.
  - **Dashboard wins** for `name`, all numeric metrics, `lastIndexed`,
    `techDebtGrade`, `hasMetrics`.
- A project present only in the daemon (just-added, dashboard cache cold)
  renders with `hasMetrics: false` — UI shows "—" for metric cells.
- A project present only in the dashboard (removed from daemon mid-session,
  shouldn't normally happen) renders with `inDaemon: false` — UI disables
  mutation actions.
- The daemon emits a loose status string (`ready`, `indexing`, `embedding`,
  `pending`, `error`, …); `canonicalizeDaemonStatus` collapses it to the
  closed enum the dashboard uses. The raw value is preserved in `liveStatus`
  for fine-grained UI hints (e.g. show "Embedding" sub-label while
  `displayStatus === 'indexing'`).

## Public API

`useWorkspaceProjects()` returns:

```ts
{
  projects: ProjectViewModel[];
  loading: boolean;
  refreshing: boolean;        // true during manual /api/dashboard/refresh
  error: string | null;
  connected: boolean;         // daemon reachable
  restarting: boolean;        // restartDaemon in flight
  addProject(root: string): Promise<void>;
  removeProject(root: string): Promise<void>;
  reindexProject(root: string): Promise<void>;
  reindexMany(roots: string[]): Promise<void>;
  removeMany(roots: string[]): Promise<void>;
  refresh(): Promise<void>;   // POST /api/dashboard/refresh then re-fetch
  restartDaemon(): Promise<void>;
}
```

Mutations delegate to `useDaemon()`; the hook composes — it does not
replace — the existing daemon hook.

## File layout (target)

```
packages/app/src/renderer/workspace/
  README.md                         # this file
  types.ts                          # contract, merge, filter, sort, KPI
  useWorkspaceProjects.ts           # data hook (P1a)
  __tests__/
    types.test.ts                   # pure-function tests
    useWorkspaceProjects.test.ts    # hook + merge + invalidation
  Workspace.tsx                     # shell (P2)
  WorkspaceHeader.tsx               # KPI strip + search + filters + view toggle (P1b)
  WorkspaceTableView.tsx            # sortable table (P1c)
  WorkspaceCompactView.tsx          # compact rows (P1d)
  AddProjectControl.tsx             # picker + path + drag-drop (P1g)
  BulkActionsBar.tsx                # floating action bar (P1f)
  useSelection.ts                   # multi-select hook (P1f)
  components/
    ProjectMetricsBadges.tsx        # grade + security + dead/untested chips
    InlineProgress.tsx              # phase + percent micro-bar
```

`WorkspaceCardsView.tsx` and `ProjectDetailDrawer.tsx` are deferred to a
follow-up; the contract leaves room (`ViewMode = 'table' | 'compact' | 'cards'`)
but the shell renders only `table` + `compact` for the MVP.

## Out of scope for this refactor

- Cards view + sparkline of historical grade (no `/api/dashboard/history`
  endpoint exists yet — needs server work).
- Project detail drawer (would also need a per-project metrics
  drill-down endpoint).
- Custom user-saved views (LocalStorage stub may land if cheap; otherwise
  follow-up).
