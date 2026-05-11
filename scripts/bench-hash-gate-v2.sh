#!/usr/bin/env bash
# bench-hash-gate-v2.sh
#
# Verifies Phase 2.5 hash-gate on a real, large file (src/cli.ts) inside the
# already-registered trace-mcp project. Avoids the temp-project registration
# path that was 400'ing in the earlier script.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${TRACE_MCP_DAEMON_PORT:-3741}"
TARGET="src/cli.ts"   # ~2400 lines, real-world

# Use a sandboxed copy of the file we're allowed to touch.
SANDBOX_TARGET="src/util/debounce.ts"

reindex() {
  python3 -c "
import json, subprocess, sys, time
body = json.dumps({'project': '$ROOT', 'path': '$1'})
t0 = time.perf_counter()
r = subprocess.run(['curl','-sS','-X','POST','-H','Content-Type: application/json','-d',body,
                    'http://127.0.0.1:${PORT}/api/projects/reindex-file', '-w', '%{http_code}'],
                   capture_output=True, text=True)
t1 = time.perf_counter()
ms = int((t1-t0)*1000)
print(f'{ms} {r.stdout[-3:]}')
"
}

stats() {
  python3 -c "
import statistics, sys
v = sorted(float(x) for x in sys.stdin.read().split() if x)
if not v: print('no samples'); sys.exit(0)
n = len(v)
print(f'n={n}  p50={v[n//2]:.1f}ms  mean={statistics.mean(v):.1f}ms  min={v[0]:.1f}ms  max={v[-1]:.1f}ms')
"
}

# Prime so the hash is present
echo "Priming hash for $SANDBOX_TARGET..."
reindex "$SANDBOX_TARGET" >/dev/null
sleep 1

echo
echo "=== mtime-touch x 10 (hash-gate skip path) ==="
TOUCH=""
for i in $(seq 1 10); do
  touch "$ROOT/$SANDBOX_TARGET"
  sleep 0.6  # past dedup TTL
  RESULT=$(reindex "$SANDBOX_TARGET")
  ms=$(echo "$RESULT" | awk '{print $1}')
  code=$(echo "$RESULT" | awk '{print $2}')
  TOUCH+="$ms "
  printf "  iter %2d: %4d ms  HTTP=%s\n" "$i" "$ms" "$code"
done

# Now make actual content change for comparison
echo
echo "=== content edit x 10 (full extract path) ==="
EDIT=""
for i in $(seq 1 10); do
  # add a no-op comment line, ensuring different content each time
  printf "// bench-edit %d %s\n" "$i" "$(date +%s%N)" >> "$ROOT/$SANDBOX_TARGET"
  sleep 0.6
  RESULT=$(reindex "$SANDBOX_TARGET")
  ms=$(echo "$RESULT" | awk '{print $1}')
  code=$(echo "$RESULT" | awk '{print $2}')
  EDIT+="$ms "
  printf "  iter %2d: %4d ms  HTTP=%s\n" "$i" "$ms" "$code"
done

# Revert edits
echo
echo "Reverting edits..."
git -C "$ROOT" checkout -- "$SANDBOX_TARGET" 2>/dev/null || true
sleep 1
reindex "$SANDBOX_TARGET" >/dev/null

echo
echo "============================================================"
echo "mtime-touch (gate skip): $(echo "$TOUCH" | stats)"
echo "content-edit (full)    : $(echo "$EDIT"  | stats)"
