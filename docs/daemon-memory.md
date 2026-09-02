---
layout: default
title: "Daemon memory: what it costs and what caps it"
description: Measured resident-set attribution for the trace-mcp daemon — what each region holds and which config knob bounds it.
updated: 2026-08-30
---

# Daemon memory: what it costs and what caps it

The HTTP daemon is a background process — the shared-index deployment described
under [configuration](configuration.md#stdio-vs-http--choosing-your-setup). If
it outweighs the user's browser it has failed regardless of how fast queries
are. This page records what the
resident set is actually made of, measured rather than estimated, and which
knob bounds each part.

## Measured attribution (TRA-422)

macOS 26.5, Apple Silicon, daemon v3.2.0 at rest, 11 projects loaded, no query
traffic. `ps -o rss=` reported 1.55 GB; `vmmap -summary` splits it:

| Region | Resident | What it is | Bounded by |
|---|---:|---|---|
| Memory Tag 255 | 714 MB | V8 heap + Node allocations. `heap_used` was 370–515 MB at the same moment, so V8 holds roughly 2× its live set in committed pages it has not returned to the OS. | project count |
| `mapped file` | 380 MB | SQLite `mmap` of each project's `index.db`. | `index_mmap_mb` × project count |
| `MALLOC_SMALL` | 258 MB (206 MB dirty) | Native allocations: SQLite page cache, tree-sitter trees. | `index_cache_mb` × connections |
| `MALLOC_SMALL (empty)` | 104 MB (22 MB dirty) | Freed, not returned to the OS. | — |
| `__TEXT` / `__LINKEDIT` / `__OBJC_RO` / `__DATA*` | ~330 MB | Node binary and native modules. Clean, file-backed, shared with every other Node process on the machine. | fixed |
| page table in kernel | 55 MB | Cost of the ~112 GB of virtual address space V8 reserves. | fixed |

The `mapped file` rows are per-project and worth reading directly:

```
64.0M  63.6M  .trace-mcp/index/thewed-2f9565b74fb5.db
64.0M  63.7M  .trace-mcp/index/general-e8778b435c05.db
64.0M  63.3M  .trace-mcp/index/assetfeed-76da1a753b39.db
34.1M  33.4M  .trace-mcp/index/workdir-45190de3e39c.db
...
```

Three DBs are larger than the 64 MB `index_mmap_mb` window and sit at the cap
with essentially every mapped page resident — a full-table scan touches the
whole window. Smaller DBs are mapped in their entirety. Average across the 11:
**34.5 MB per project from mmap alone.**

**Marginal cost of one loaded project: ~100 MB resident** (~35 MB mmap, ~23 MB
native page cache and tree-sitter, the balance V8 heap). Fixed floor with zero
projects loaded is ~165 MB RSS, of which ~330 MB of library text is shared.

A JS heap snapshot was not the right instrument here: the V8 heap is only ~28 %
of RSS, so it cannot attribute the other 72 %.

## The ceiling

`daemon_eager_load_projects` (default **8**) is the number of projects the
daemon keeps resident. 8 × ~100 MB ≈ 800 MB marginal on top of the ~350 MB
fixed footprint. Raise it on a big machine with few repos; lower it if the
daemon is competing for memory.

Two rules enforce it, both in the sweep armed by `startIdleUnloadSweep`:

- **TTL** — `project_idle_unload_minutes` (default 30) unloads any project not
  touched in that long.
- **LRU ceiling** — anything above `daemon_eager_load_projects` is unloaded
  least-recently-accessed first, regardless of TTL.

Before TRA-422 only the TTL existed and the eager cap applied at startup only,
so lazy loads (`/mcp` auto-register, `/api/projects/reindex-file`) drifted past
it unchecked: a daemon that booted with `eager: 8, deferred: 34` was holding 11
projects three minutes later, with nothing to bring it back down.

Both rules skip projects that are `starting`/`indexing` or have live clients
(`resourcePool.getRefCount > 0`). The ceiling is therefore best-effort: a
daemon with 11 busy projects stays at 11 rather than tearing down work in
flight. Set either knob to 0 to disable that rule; with both at 0 no timer is
armed.

Unloading is in-memory only. The project stays in the registry and reloads
lazily on its next request (503 + `Retry-After` while it warms, the same path a
cold-start project takes).

## Reproducing the measurement

```bash
PID=$(curl -s http://127.0.0.1:3741/health | python3 -c 'import sys,json;print(json.load(sys.stdin)["pid"])')
ps -o rss= -p "$PID"                 # total RSS in KB
vmmap -summary "$PID"                # region breakdown
vmmap "$PID" | grep 'mapped file'    # per-project index.db mmap residency
```

`Daemon vitals` lines in `~/.trace-mcp/daemon.log` carry `rss_mb`,
`heap_used_mb` and `projects_loaded` every 60 s, which is the cheap way to
watch the floor over time.

## Known caveat

The sweep runs every 5 minutes, so a burst of lazy loads can sit above the
ceiling for up to one interval before it is enforced. Enforcing on each
`addProject` instead would close that window; it was not worth the coupling
until the delay is shown to matter.

The sweep also cannot help a daemon that does not live long enough to run it —
see TRA-421 on daemon restarts.

Every knob named above — `daemon_eager_load_projects`,
`project_idle_unload_minutes`, `index_mmap_mb`, `index_cache_mb` — is a
[configuration](configuration.md) key, and what the mapped `index.db` files
actually hold is the storage layer described in
[architecture](architecture.md#storage).
