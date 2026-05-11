#!/usr/bin/env bash
# bench-edit-latency.sh
#
# Measures per-Edit wallclock for the PostToolUse hot path.
# Three scenarios, 10 iterations each:
#
#   A) Cold CLI (daemon DOWN)  — simulates the pre-Phase-1 behaviour:
#      each invocation pays full Node startup + WASM init + plugin load.
#
#   B) Hot CLI (daemon UP)     — the Phase-1.1 daemon-first proxy.
#      `trace-mcp index-file` should detect the daemon and HTTP-POST instead
#      of spawning the whole pipeline.
#
#   C) Curl direct             — lower bound: pure HTTP RTT to the new
#      /api/projects/reindex-file endpoint.
#
# Prints p50/p95/mean wallclock per scenario.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/cli.js"
TARGET_FILE="$ROOT/src/util/debounce.ts"
PORT="${TRACE_MCP_DAEMON_PORT:-3741}"
ITERS="${BENCH_ITERS:-10}"

if [[ ! -f "$CLI" ]]; then
  echo "ERROR: $CLI not found. Run 'pnpm run build' first." >&2
  exit 1
fi
if [[ ! -f "$TARGET_FILE" ]]; then
  echo "ERROR: $TARGET_FILE not found." >&2
  exit 1
fi

# --- helpers --------------------------------------------------------------

# Reads list of ms from stdin, prints "p50=X p95=Y mean=Z min=A max=B".
stats() {
  python3 -c '
import sys, statistics
vals = sorted(float(x) for x in sys.stdin.read().split() if x)
if not vals:
  print("no samples")
  sys.exit(0)
n = len(vals)
p50 = vals[n//2]
p95 = vals[min(n-1, int(round(0.95*(n-1))))]
mean = statistics.mean(vals)
print(f"n={n}  p50={p50:.1f}ms  p95={p95:.1f}ms  mean={mean:.1f}ms  min={vals[0]:.1f}ms  max={vals[-1]:.1f}ms")
'
}

# Returns wallclock ms of a command. Uses python for sub-ms precision.
time_ms() {
  python3 -c '
import subprocess, sys, time
t0 = time.perf_counter()
r = subprocess.run(sys.argv[1:], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
t1 = time.perf_counter()
print(int((t1 - t0) * 1000))
sys.exit(r.returncode)
' "$@"
}

daemon_up() {
  curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

# --- A) Cold CLI (daemon DOWN) --------------------------------------------

echo "=== A) Cold CLI (daemon DOWN) — simulates pre-Phase-1 cold spawn ==="
if daemon_up; then
  echo "Daemon is up. Stopping for cold benchmark..."
  node "$CLI" daemon stop >/dev/null 2>&1 || true
  for _ in $(seq 1 5); do
    if ! daemon_up; then break; fi
    sleep 1
  done
fi
if daemon_up; then
  echo "ERROR: could not stop daemon. Skipping cold benchmark." >&2
  COLD_SAMPLES=""
else
  COLD_SAMPLES=""
  for i in $(seq 1 "$ITERS"); do
    ms=$(time_ms node "$CLI" index-file "$TARGET_FILE")
    COLD_SAMPLES+="$ms "
    printf "  iter %2d: %4d ms\n" "$i" "$ms"
  done
fi
echo
if [[ -n "$COLD_SAMPLES" ]]; then
  echo "  >>> cold: $(echo "$COLD_SAMPLES" | stats)"
else
  echo "  >>> cold: SKIPPED (daemon could not be stopped)"
fi
echo

# --- B) Hot CLI (daemon UP) -----------------------------------------------

echo "=== B) Hot CLI (daemon UP) — Phase-1.1 proxy path ==="
echo "Starting daemon..."
node "$CLI" daemon start --port "$PORT" >/dev/null 2>&1 || true
for _ in $(seq 1 10); do
  if daemon_up; then break; fi
  sleep 0.5
done
if ! daemon_up; then
  echo "ERROR: daemon did not come up. Skipping hot benchmark." >&2
  HOT_SAMPLES=""
else
  # Warm up so the project is registered.
  time_ms node "$CLI" index-file "$TARGET_FILE" >/dev/null
  HOT_SAMPLES=""
  for i in $(seq 1 "$ITERS"); do
    ms=$(time_ms node "$CLI" index-file "$TARGET_FILE")
    HOT_SAMPLES+="$ms "
    printf "  iter %2d: %4d ms\n" "$i" "$ms"
  done
fi
echo
if [[ -n "$HOT_SAMPLES" ]]; then
  echo "  >>> hot:  $(echo "$HOT_SAMPLES" | stats)"
else
  echo "  >>> hot:  SKIPPED"
fi
echo

# --- C) Curl direct --------------------------------------------------------

echo "=== C) Curl direct — lower bound HTTP RTT to /api/projects/reindex-file ==="
if ! daemon_up; then
  echo "Daemon not up, skipping."
  CURL_SAMPLES=""
else
  BODY=$(python3 -c "import json; print(json.dumps({'project':'$ROOT','path':'$TARGET_FILE'}))")
  CURL_SAMPLES=""
  for i in $(seq 1 "$ITERS"); do
    ms=$(time_ms curl -fsS -X POST -H 'Content-Type: application/json' \
      -d "$BODY" "http://127.0.0.1:${PORT}/api/projects/reindex-file")
    CURL_SAMPLES+="$ms "
    printf "  iter %2d: %4d ms\n" "$i" "$ms"
  done
fi
echo
if [[ -n "$CURL_SAMPLES" ]]; then
  echo "  >>> curl: $(echo "$CURL_SAMPLES" | stats)"
else
  echo "  >>> curl: SKIPPED"
fi
echo

# --- Summary ---------------------------------------------------------------

echo "=========================================================================="
echo "Summary (target from plan: cold ~300-500 ms; hot < 30 ms; curl ~5-10 ms)"
echo "=========================================================================="
if [[ -n "$COLD_SAMPLES" ]]; then echo "A) cold CLI: $(echo "$COLD_SAMPLES" | stats)"; fi
if [[ -n "$HOT_SAMPLES"  ]]; then echo "B) hot CLI:  $(echo "$HOT_SAMPLES"  | stats)"; fi
if [[ -n "$CURL_SAMPLES" ]]; then echo "C) curl:     $(echo "$CURL_SAMPLES" | stats)"; fi
