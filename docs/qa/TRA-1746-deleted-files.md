---
noindex: true
---

# TRA-1746 — Deleted files in federated indexes

Subproject discovery and explicit synchronization now reconcile confirmed file
deletions in existing child indexes before extracting their contracts. This also
repairs children that are no longer independently registered/watched, including
previously registered children whose service marker has disappeared. The daemon
already invokes discovery after loading/indexing a project. Explicit subproject
sync provides the same repair without waiting for that lifecycle event.

The parent assetfeed index was clean, while its separately retained frontend
index still contained the three reported deleted files. Contract synchronization
updated topology timestamps without reconciling that source index. Deletion now
uses the existing Store cascade, with an additional correction: symbol graph
nodes are removed before the file FK deletes their symbol rows. Previously those
polymorphic nodes survived as orphans.

## Safety and compatibility

Only ENOENT/ENOTDIR inside an accessible repository are treated as deletions.
Offline roots, permission/I/O failures, out-of-root paths, existing entries and
virtual dependency rows are preserved. Missing databases are not created.
Reconciliation runs in a transaction, rolls back on failure, closes its handle,
and deduplicates databases within each synchronization pass.

No schema migration or MCP argument/result change. No added tool response fields
or token overhead. Ordinary watcher cleanup is retained; children without their
own watcher converge on discovery/sync, rather than receiving a new watcher.
This is deletion reconciliation, not a full reparse of changed/new child files.

## Real-project verification — September 21, 2026

SQLite's backup API read the real installed indexes; every topology db_path was
rewritten to an isolated backup before executing cleanup. The original live
indexes were not repaired or replaced during this validation.

| Project | Files graph before → after (nodes / relationships) | Missing physical sources before → after |
| --- | --- | --- |
| assetfeed (Laravel/Vue/Python umbrella) | 2,572 / 9,435 → 2,568 / 9,424 | 4 → 0 |
| trace-mcp (TypeScript CLI/library/desktop) | 1,667 / 7,650 → unchanged | 0 → 0 |
| thestyle-bot (Python bot/services) | 217 / 742 → unchanged | 0 → 0 |

The frontend child loses exactly the three reported files, six symbols and 20
incident edges. Its counts change from 50 files / 118 symbols / 132 edges to
47 / 112 / 112. The same pass repairs 18 deleted scraper files (167 symbols,
15 edges); only one appeared in the connected Files projection. Thus 21 deleted
index records account for four removed visible source nodes. Virtual dependencies
are preserved. Repeating cleanup removes zero additional records.

Symbols graphs were also built before/after: assetfeed 12,053 nodes / 27,109
relationships → 12,028 / 27,086; both controls retain their exact counts. All six
projections have unique IDs and no dangling edge endpoints. Source existence is
checked using file records and Files IDs; symbol IDs can denote virtual entities
or use repository-relative plugin identifiers and are not filesystem paths.

## Installed app

Launched the installed `~/Applications/trace-mcp.app` 3.31.0 on Nikolai's
MacBook with an isolated profile and hidden window. No development renderer or
server was used. Its Graph UI rendered each real snapshot before and after
cleanup; counts matched the builder results on all three projects. Searching
for the deleted `dev-preview-cryptocard.vue` returned a selectable result before
cleanup and no result afterward. Captures use Electron `webContents.capturePage`.
The test process was terminated after capture.

The shared daemon was unreachable during this UI pass. Only the Graph response
was supplied from the captured real SQLite data through the renderer's fetch
boundary. This validates installed rendering/search against the backend results;
it is not a claim that the candidate server was deployed or that live indexes
were repaired. The surrounding sidebar could not load its unrelated data.

## Tests

The original code failed both deletion regressions (explicit sync and automatic
discovery). The intermediate fix exposed the orphaned symbol-node cascade, which
the final implementation also corrects. Seven regressions cover the graph before
and after cleanup, both edge directions, symbol nodes, idempotence, unavailable
roots, permission failures, virtual/out-of-root entries, missing databases,
rollback, and files recreated before synchronization.

- Full server suite: 11,653 passed, 40 configured skips (1,042 passing files).
  Command: `env -u CODEX_HOME pnpm test --maxWorkers=4`.
- Targeted subproject, Store and visualization suite: 287 passed.
- Root build, lint/typecheck and whitespace checks passed.

Private project payloads, screenshots and machine-readable evidence are delivered
as an issue attachment, not committed to this public repository.
