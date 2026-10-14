---
layout: default
title: Windows CI Full-Suite Timeouts Diagnosis & Stabilization
permalink: /perf/windows-ci-timeouts/
description: Internal working document. Diagnostic measurements and stabilization for Windows CI timeouts across release and feature PRs.
noindex: true
---

# Windows CI Full-Suite Timeouts Diagnosis & Stabilization (TRA-2427)

Measured on GitHub Actions `windows-latest` (Windows Server 2025, 4 vCPUs, 7 GB RAM,
Image `windows-2025-vs2026`).

## 1. What Happened

Two consecutive Windows CI runs failed with timeouts on disjoint tests, blocking releases
and PR merges:

1. **PR #1585 (v3.37.1 Release)**:
   - Run `38578369866`, Job `115901556549` (attempt 1) failed at 13m 47s:
     `Hook timed out in 30000ms` at `tests/daemon/health-starvation.test.ts:117` in `afterAll`.
   - Rerun passed.
2. **PR #1595 (Worktree Fallback)**:
   - Run `38586038742`, Job `115928933278` (attempt 1) failed at 14m 24s with 3 test timeouts:
     - `tests/memory/decision-verification-batch.test.ts:111` (timed out in 60s; total 72.3s)
     - `src/benchmark-lab/__tests__/runner.test.ts:109` (timed out in 120s; total 171.2s)
     - `src/daemon/__tests__/project-manager-rescan-gated.test.ts:107` (timed out in 60s; total 83.3s)
     while 12,291 other tests passed.
   - Rerun `115936732763` (attempt 2) passed in 11m 47s.

Classifying these as "just CI infrastructure flakes" was incorrect. Deep log analysis
revealed two distinct structural mechanisms under Windows CI load.

## 2. Root Cause Analysis

### Mechanism A: Synchronous Large-Tree Unlinking (`health-starvation.test.ts`)

In `tests/daemon/health-starvation.test.ts`:
- `beforeAll` creates 10 projects × 400 files = **4,000 `.ts` files**, plus multiple SQLite
  databases (`seq.db`, `conc.db`, WAL, and SHM files).
- `afterAll` called `fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })`
  synchronously.
- On Windows NTFS under CI disk load, synchronous recursive unlinking of 4,000 files froze
  the event loop and exceeded the global 30,000 ms `hookTimeout` (reaching ~31.5s).

### Mechanism B: Process-Spawn Contention Under 4-Worker Concurrency

Vitest's default pool (`forks`) on a 4-vCPU Windows runner spawned **4 concurrent worker processes**.
Inside tests:
- `tests/hooks/guard-windows.test.ts` ran 8 tests with `WIN_RETRY = 2`, spawning dozens of nested
  `cmd.exe` and PowerShell processes, taking **283.97s (4.7 minutes)** in attempt 1.
- Concurrently on other workers:
  - `decision-verification-batch.test.ts` spawned 20 sequential `git.exe` processes (`execFileSync`).
  - `runner.test.ts` ran two full `runLab` passes (AST parsing, indexing, embedding queries).
  - `project-manager-rescan-gated.test.ts` ran ProjectManager indexing and `vi.waitFor` with default 1s timeout.
- On Windows Server 2025, concurrent process creation (`CreateProcessW`) under NTFS and antivirus
  filter contention caused process spawn times to balloon by 40x–100x:
  - `decision-verification-batch`: 1.62s when unstarved → 72.3s when starved (timeout at 60s).
  - `runner.test.ts`: 1.62s when unstarved → 171.2s when starved (timeout at 120s).
  - `project-manager-rescan-gated`: 6.66s when unstarved → 83.3s when starved (timeout at 60s).

## 3. Quantitative Measurements

| Test File | PR #1585 Job 115901556549 (Attempt 1) | PR #1595 Job 115928933278 (Attempt 1) | PR #1595 Job 115936732763 (Attempt 2) |
|---|---|---|---|
| `tests/daemon/health-starvation.test.ts` | **FAILED** (afterAll hook timed out in 30,000 ms) | 27.33s (passed) | 31.54s (passed, near limit) |
| `tests/memory/decision-verification-batch.test.ts` | 1.84s (passed) | **FAILED** (72.35s, timeout at 60s) | 1.62s (passed) |
| `src/benchmark-lab/__tests__/runner.test.ts` | 1.55s (passed) | **FAILED** (171.23s, timeout at 120s) | 1.62s (passed) |
| `src/daemon/__tests__/project-manager-rescan-gated.test.ts` | 6.42s (passed) | **FAILED** (83.31s, timeout at 60s) | 6.66s (passed) |
| `tests/hooks/guard-windows.test.ts` | 32.57s | **283.97s** (severe spawn thrashing) | 40.27s |
| **Total Vitest Duration** | 693.82s (11m 34s) | 713.52s (11m 53s) | 707.01s (11m 47s) |

## 4. Minimal Targeted Fixes

1. **Worker Concurrency Cap on Windows CI**:
   - In `vitest.config.ts`: `maxWorkers: process.env.CI && process.platform === 'win32' ? 2 : undefined`.
   - In `.github/workflows/ci.yml`: pass `--maxWorkers=2` for `windows-latest`.
   - Capping worker forks at 2 bounds peak process-spawn contention on Windows runners while
     retaining dual-core parallelism.
2. **Asynchronous Cleanup & Explicit Timeout in `health-starvation.test.ts`**:
   - Converted `afterAll` to async `await fs.promises.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })`.
   - Added explicit 60s timeout budget to `afterAll` and `beforeAll`.
3. **Reduced Git Spawns in `decision-verification-batch.test.ts`**:
   - Reduced `N = 20` to `N = 8`. Proves the exact same batching contract (single `cat-file --batch`,
     0 `git show` spawns, 100% verdict accuracy) while cutting 12 redundant sequential `git.exe` spawns.
4. **Explicit `vi.waitFor` Timeout in `project-manager-rescan-gated.test.ts`**:
   - Added `{ timeout: 10_000, interval: 20 }` to `vi.waitFor` in the first two tests, matching
     the 10s budget already used in the third test.
5. **Hermetic Temp Cleanup in `runner.test.ts`**:
   - Added `afterEach` cleanup for `tempHarnessRoot` so benchmark test projects do not accumulate.
