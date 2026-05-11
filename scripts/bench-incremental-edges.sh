#!/usr/bin/env bash
# bench-incremental-edges.sh
#
# Measures /api/projects/reindex-file p50/p95 wallclock for the Phase 4
# scope-aware incremental edge resolution path. Two scenarios:
#
#   A) Hash-gate-hit  — `touch` only (mtime bump, content unchanged). The
#      daemon's content-hash gate should short-circuit the entire pipeline.
#      This is the fastest path and the most common in real editing.
#
#   B) Full-extract   — append a comment to force a real content change.
#      The full extract + scoped edge resolution path runs end-to-end.
#
# v1.35.1 baseline (full-extract, no incremental edges): p50 = 223 ms.
# Phase 4 target: p50 < 50 ms for the full-extract path.
#
# Requires: built CLI (pnpm run build), python3, curl, jq optional.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/cli.js"
TARGET_FILE="src/util/debounce.ts"
TARGET_ABS="$ROOT/$TARGET_FILE"
PORT="${TRACE_MCP_DAEMON_PORT:-3741}"
ITERS="${BENCH_ITERS:-10}"
TARGET_P50_MS=50
BASELINE_P50_MS=223

if [[ ! -f "$CLI" ]]; then
  echo "ERROR: $CLI not found. Run 'pnpm run build' first." >&2
  exit 1
fi
if [[ ! -f "$TARGET_ABS" ]]; then
  echo "ERROR: $TARGET_ABS not found." >&2
  exit 1
fi

# WHY revert on exit: scenario B mutates the target file. Without a trap a
# crashed run leaves edits on disk that break subsequent commits.
cleanup() {
  git -C "$ROOT" checkout -- "$TARGET_FILE" 2>/dev/null || true
}
trap cleanup EXIT

stats() {
  python3 -c '
import sys
vals = sorted(float(x) for x in sys.stdin.read().split() if x)
if not vals:
  print("p50=0 p95=0 n=0")
  sys.exit(0)
n = len(vals)
p50 = vals[n // 2]
p95 = vals[min(n - 1, int(round(0.95 * (n - 1))))]
print(f"p50={p50:.0f}ms p95={p95:.0f}ms n={n} min={vals[0]:.0f}ms max={vals[-1]:.0f}ms")
'
}

p50_of() {
  python3 -c '
import sys
vals = sorted(float(x) for x in sys.stdin.read().split() if x)
if not vals:
  print(0)
  sys.exit(0)
print(int(vals[len(vals) // 2]))
'
}

time_curl_ms() {
  local body="$1"
  python3 -c '
import subprocess, sys, time
body = sys.argv[1]
url = sys.argv[2]
t0 = time.perf_counter()
r = subprocess.run(
  ["curl", "-fsS", "-X", "POST", "-H", "Content-Type: application/json",
   "-d", body, url],
  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
t1 = time.perf_counter()
print(int((t1 - t0) * 1000))
sys.exit(r.returncode)
' "$body" "http://127.0.0.1:${PORT}/api/projects/reindex-file"
}

daemon_up() {
  curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

# ─── ensure daemon is up ───────────────────────────────────────────────────
if ! daemon_up; then
  echo "Starting daemon on port $PORT ..."
  node "$CLI" daemon start --port "$PORT" >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do
    if daemon_up; then break; fi
    sleep 0.5
  done
fi
if ! daemon_up; then
  echo "ERROR: daemon could not be started on port $PORT." >&2
  exit 1
fi

BODY=$(python3 -c "import json; print(json.dumps({'project':'$ROOT','path':'$TARGET_ABS'}))")

# ─── prime: register the project + warm the cache ─────────────────────────
echo "Priming with one reindex-file call..."
time_curl_ms "$BODY" >/dev/null
sleep 0.5

# ─── A) hash-gate-hit ─────────────────────────────────────────────────────
echo
echo "=== A) Hash-gate-hit  (touch only — content unchanged) ==="
A_SAMPLES=""
for i in $(seq 1 "$ITERS"); do
  touch "$TARGET_ABS"
  sleep 0.6
  ms=$(time_curl_ms "$BODY")
  A_SAMPLES+="$ms "
  printf "  iter %2d: %4d ms\n" "$i" "$ms"
done
A_STATS=$(echo "$A_SAMPLES" | stats)
A_P50=$(echo "$A_SAMPLES" | p50_of)
echo "  >>> hash-gate-hit:  $A_STATS"

# ─── B) full-extract ──────────────────────────────────────────────────────
echo
echo "=== B) Full-extract  (append comment — content changes each iter) ==="
B_SAMPLES=""
for i in $(seq 1 "$ITERS"); do
  printf '\n// bench edit %d\n' "$i" >> "$TARGET_ABS"
  sleep 0.6
  ms=$(time_curl_ms "$BODY")
  B_SAMPLES+="$ms "
  printf "  iter %2d: %4d ms\n" "$i" "$ms"
done
B_STATS=$(echo "$B_SAMPLES" | stats)
B_P50=$(echo "$B_SAMPLES" | p50_of)
echo "  >>> full-extract:   $B_STATS"

# ─── summary + pass/fail ──────────────────────────────────────────────────
echo
echo "=========================================================================="
echo "Summary"
echo "=========================================================================="
echo "  v1.35.1 baseline (full-extract):  p50 = ${BASELINE_P50_MS} ms"
echo "  Phase 4 target (full-extract):    p50 < ${TARGET_P50_MS} ms"
echo
echo "  A) hash-gate-hit:                 $A_STATS"
echo "  B) full-extract:                  $B_STATS"
echo

if [[ "$B_P50" -lt "$TARGET_P50_MS" ]]; then
  echo "  RESULT: PASSED  (full-extract p50 = ${B_P50} ms < ${TARGET_P50_MS} ms target)"
  EXIT_CODE=0
else
  echo "  RESULT: FAILED  (full-extract p50 = ${B_P50} ms >= ${TARGET_P50_MS} ms target)"
  EXIT_CODE=1
fi

# Show improvement vs baseline regardless of pass/fail.
if [[ "$B_P50" -gt 0 ]]; then
  IMPROVEMENT=$(( BASELINE_P50_MS - B_P50 ))
  PCT=$(( IMPROVEMENT * 100 / BASELINE_P50_MS ))
  echo "  Δ vs baseline:                  ${IMPROVEMENT} ms faster (${PCT}% improvement)"
fi

exit "$EXIT_CODE"
