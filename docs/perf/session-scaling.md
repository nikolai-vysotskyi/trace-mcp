# Concurrency & Session Scaling Benchmark Report (TRA-931)

Automated benchmark evaluation of multi-session concurrency scaling for stdio AI coding agent sessions.
Tracking issue: **TRA-931** (parent umbrella tracking issue: **TRA-921**).

## Executive Summary

When multiple AI coding agent sessions (e.g. Claude Code, Cursor, Cline, Roo) run concurrently on the same machine and codebase, their architectural backing determines whether system resources scale sub-linearly or explode linearly.

This benchmark harness (`scripts/bench-session-scaling.ts`) measures cold start, 60s steady-state idle resource consumption, 1-file edit cost, and concurrency scaling across $N \in \{1, 4, 9\}$ simultaneous stdio sessions.

Key baseline findings on `trace-mcp` v3.18.0:
1. **Sub-linear Scaling with Daemon (Arm A):** Total resident memory scales by only **3.64×** between $N=1$ (673.6 MB) and $N=9$ (2,449.2 MB) despite a 9× increase in concurrent agents. Total thread count scales by **4.20×** (30 -> 126 threads).
2. **Linear Memory & Thread Explosion Without Daemon (Arm B):** When falling back to unmanaged local mode, total RSS explodes by **9.06×** (181.6 MB -> 1,645.1 MB), and thread count scales by exactly **9.00×** (12 -> 108 threads).
3. **Strict CPU Isolation on File Edits:** In daemon-healthy mode, reindexing a 1-file change consumes **2.66s – 3.79s CPU** exclusively in the persistent background daemon, while all active stdio sessions burn **0.00s CPU**.
4. **Local Cold-Start Degradation Under Concurrency:** In daemon-absent mode, concurrent cold start p50 degrades by **+132%** (from 932 ms at N=1 to 2,164 ms at N=9) due to SQLite file locking and disk contention across 9 uncoordinated database openers.

---

## Benchmark Corpus & Environment

- **Corpus:** `trace-mcp` repository at pinned v3.18.0 release commit [`9256cf184370cc7175e076baf2c142c4054d0d6c`](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9256cf184370cc7175e076baf2c142c4054d0d6c).
  - 898+ TypeScript files, 11,134 symbols.
- **Fixture Isolation:** Standalone git repository extracted via `git archive` per test run into a fresh temporary directory, avoiding lock interference or shared worktree index aliasing.
- **Hardware & OS:** macOS Darwin arm64 (Apple Silicon).
- **Measurement Primitives:**
  - RSS: Sampled via `ps -o rss=` over the full recursive process tree (`ppid` walk).
  - Threads: Sampled via `ps -M -p <pid>`.
  - CPU: Sampled via `ps -o cputime=` tracking accumulated user + system seconds.
  - Cold start: JSON-RPC stdio initialization handshake (`initialize` -> `notifications/initialized` -> `tools/call: get_project_map`).
  - Idle stabilization: 60-second hold before steady-state sampling to allow V8 garbage collection and Node.js event loops to settle.

---

## Baseline Measurements Matrix (v3.18.0)

Data source: [`docs/perf/session-scaling.json`](./session-scaling.json) (Run timestamp: `2026-09-05T16:21:04.489Z`).

### 1. Single Session Metrics (N = 1)

| Metric | Arm A: Daemon Healthy (Proxy) | Arm B: Daemon Absent (Local Fallback) | Note |
|---|---|---|---|
| **Cold Start to `get_project_map`** | 2,699 ms | **932 ms** | Local opens SQLite directly; proxy connects over HTTP |
| **Cold Start Peak RSS** | **192.4 MB** | 216.9 MB | Proxy peak is lower than local standalone engine |
| **Startup Threads** | 12 | 12 | Node.js runtime baseline |
| **Idle RSS at 60s (per session)** | **145.5 MB** | 181.6 MB | Proxy session drops to 145.5 MB after GC |
| **Idle Daemon RSS** | 528.1 MB | N/A | Daemon retains shared symbol graph & DB connection |
| **Total System RSS (Idle)** | 673.6 MB | **181.6 MB** | Daemon pays one-time base cost for shared index |
| **Total System Threads (Idle)** | 30 | **12** | Daemon adds 18 background management threads |
| **1-File Change Wall Time** | **2,489 ms** | 3,501 ms | Incremental reindex of `src/util/debounce.ts` |
| **1-File Change Daemon CPU** | 2.66 s | N/A | Background daemon absorbs all indexing workload |
| **1-File Change Sessions CPU** | **0.00 s** | 0.00 s | Sessions burn 0 CPU during background reindex |

---

### 2. Concurrency Scaling Matrix (N = 1, 4, 9)

| N | Mode | Cold Start (p50 / max) | Per-Sess RSS | Total System RSS | Total Threads | 1-File Change CPU (Daemon / Sess) |
|---|---|---|---|---|---|---|
| **1** | `daemon_healthy` | 2,699 ms / 2,699 ms | 145.5 MB | 673.6 MB | 30 | 2.66 s / 0.00 s |
| **1** | `daemon_absent` | 932 ms / 932 ms | 181.6 MB | 181.6 MB | 12 | N/A / 0.00 s |
| **4** | `daemon_healthy` | 3,721 ms / 3,762 ms | 173.8 MB | 1,501.8 MB | 66 | 3.79 s / 0.00 s |
| **4** | `daemon_absent` | 1,133 ms / 1,186 ms | 182.1 MB | 728.4 MB | 48 | N/A / 0.00 s |
| **9** | `daemon_healthy` | 3,608 ms / 3,712 ms | 175.0 MB | 2,449.2 MB | 126 | 3.69 s / 0.00 s |
| **9** | `daemon_absent` | 2,164 ms / 2,341 ms | 182.5 MB | 1,645.1 MB | 108 | N/A / 0.00 s |

---

### 3. Scaling Multipliers (N=9 vs N=1)

$$\text{Multiplier} = \frac{\text{Metric}(N=9)}{\text{Metric}(N=1)}$$

| Dimension | Daemon Healthy (Arm A) | Daemon Absent (Arm B) | Advantage of Daemon |
|---|---|---|---|
| **Total System RSS** | **3.64×** | 9.06× | **2.49× less memory growth** ($3.64\times$ vs $9.06\times$) |
| **Total Thread Count** | **4.20×** | 9.00× | **2.14× less thread growth** ($4.20\times$ vs $9.00\times$) |
| **1-File Edit Total CPU** | **1.39×** | N/A (0s idle) | Daemon reindex cost is flat regardless of session count |
| **Cold Start Latency** | 1.34× | 2.32× | Local cold start degrades by 2.32× under disk contention |

---

## Architectural Analysis

### Why the Daemon Model Scales
1. **Shared Graph & Single Database Handle:** In Arm A, the daemon holds the parsed AST cache, SQLite connections, and symbol graph in a single resident process (~528–875 MB). Stdio sessions act strictly as thin JSON-RPC-to-HTTP proxies consuming only ~145–175 MB resident memory.
2. **Deterministic Reindex Workload:** When a source file changes, the daemon executes a single scoped incremental reindex pass (~2.66–3.79 CPU seconds). The N sessions consume 0 CPU seconds because they never inspect files or re-parse ASTs directly.
3. **No File Lock Contention:** Because only the daemon writes to the SQLite database, concurrent read operations do not contend for WAL locks.

### Failure Modes in Daemon-Absent Mode
1. **Linear Resource Proliferation:** In Arm B, every newly spawned agent session brings its own SQLite engine, tree-sitter parsers, and file watcher. At N=9, this consumes 108 OS threads and 1.65 GB of memory.
2. **Cold-Start Degradation:** At N=9, concurrent initialization of 9 SQLite databases contending for the same file system and page cache increases p50 cold start latency by **+132%** (from 932 ms to 2,164 ms).

---

## Reproduction & CI Commands

The benchmark is registered in `package.json` and can be re-run at any time:

```bash
# Full benchmark run (N = 1, 4, 9 with 60s idle hold):
pnpm run bench:session-scaling

# Smoke test run (N = 1, 4 with 5s idle hold):
npx tsx scripts/bench-session-scaling.ts --quick

# Custom configuration:
npx tsx scripts/bench-session-scaling.ts --steps 1,2,4,8 --idle 30 --port 37425
```

The script writes version-stamped JSON to `docs/perf/session-scaling.json` and automatically computes regression deltas against previous runs.
