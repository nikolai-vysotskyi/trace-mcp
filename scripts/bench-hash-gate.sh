#!/usr/bin/env bash
# bench-hash-gate.sh
#
# Verifies Phase 2.5 content-hash gate: when mtime drifts but content is
# unchanged (formatter-on-save, git touch, etc.), the file is skipped via
# xxh64 hash compare instead of full extract.
#
# Method:
#   1. Pick a target file. Read its current mtime + content.
#   2. Prime: full reindex → records content_hash + mtime.
#   3. Touch (changes mtime, not content) → reindex → should be skipped
#      via the hash gate (mtime fast-path would also catch this if mtime
#      were unchanged, but the touch bumps mtime so only the hash gate
#      saves us).
#   4. Modify (different content) → reindex → must NOT be skipped.
#
# Direct HTTP calls so we measure daemon-side behaviour without CLI overhead.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/cli.js"
PORT="${TRACE_MCP_DAEMON_PORT:-3741}"

# Workspace
WORK_DIR=$(mktemp -d -t trace-mcp-hashgate-XXXX)
trap "rm -rf '$WORK_DIR'" EXIT
cd "$WORK_DIR"
git init --quiet
echo '{"name":"hashgate-bench","version":"0.0.0","type":"module"}' > package.json
mkdir src
cat > src/sample.ts <<'EOF'
export function hello(name: string): string {
  return `hello, ${name}`;
}

export class Greeter {
  constructor(private prefix: string) {}
  greet(name: string): string {
    return `${this.prefix}: ${hello(name)}`;
  }
}
EOF
git add -A >/dev/null && git -c user.email=b@b -c user.name=b commit -qm init >/dev/null

echo "Workspace: $WORK_DIR"

daemon_up() {
  curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

# Start daemon if not up.
if ! daemon_up; then
  echo "Starting daemon..."
  node "$CLI" daemon start --port "$PORT" >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do daemon_up && break; sleep 0.5; done
fi
if ! daemon_up; then
  echo "ERROR: daemon could not be brought up" >&2
  exit 1
fi

# Register the project.
echo "Registering project..."
curl -fsS -X POST -H 'Content-Type: application/json' \
  -d "{\"projectRoot\":\"$WORK_DIR\"}" \
  "http://127.0.0.1:${PORT}/api/projects" >/dev/null 2>&1 || true

# Give it a moment to do the initial index.
sleep 2

# Helper that POSTs to /api/projects/reindex-file and times it.
time_reindex() {
  local file="$1"
  python3 -c "
import json, subprocess, time
body = json.dumps({'project': '$WORK_DIR', 'path': '$file'})
t0 = time.perf_counter()
r = subprocess.run(['curl','-fsS','-X','POST','-H','Content-Type: application/json',
                    '-d',body,'http://127.0.0.1:${PORT}/api/projects/reindex-file'],
                   capture_output=True, text=True)
t1 = time.perf_counter()
print(int((t1-t0)*1000))
"
}

echo
echo "=== Priming (first full extract) ==="
PRIME=$(time_reindex "src/sample.ts")
echo "  prime: ${PRIME} ms"

# Wait past the 500 ms dedup TTL so subsequent calls actually do work.
sleep 1

echo
echo "=== mtime-only touch x 10 (should hit hash gate after 1st) ==="
TOUCH_SAMPLES=""
for i in $(seq 1 10); do
  touch "$WORK_DIR/src/sample.ts"
  # Wait past dedup TTL between calls
  sleep 0.6
  ms=$(time_reindex "src/sample.ts")
  TOUCH_SAMPLES+="$ms "
  printf "  iter %2d: %4d ms\n" "$i" "$ms"
done

echo
echo "=== Content change x 5 (must NOT hit hash gate) ==="
EDIT_SAMPLES=""
for i in $(seq 1 5); do
  echo "// edit $i $(date +%s%N)" >> "$WORK_DIR/src/sample.ts"
  sleep 0.6
  ms=$(time_reindex "src/sample.ts")
  EDIT_SAMPLES+="$ms "
  printf "  iter %2d: %4d ms\n" "$i" "$ms"
done

echo
echo "=========================================================================="
echo "Summary"
echo "=========================================================================="
echo "prime (full extract):                            ${PRIME} ms"
python3 -c "
import statistics
def s(name, vals):
  v = sorted(float(x) for x in vals.split() if x)
  if not v: return f'{name}: no samples'
  return f'{name}: n={len(v)}  p50={v[len(v)//2]:.1f}ms  mean={statistics.mean(v):.1f}ms  min={v[0]:.1f}ms  max={v[-1]:.1f}ms'
print(s('mtime-touch (hash-gate path)', '''$TOUCH_SAMPLES'''))
print(s('content-edit (full extract)', '''$EDIT_SAMPLES'''))
"
echo
echo "Plan target: mtime-touch should be much faster than content-edit"
echo "(plan §2.5: 'formatter-on-save / cosmetic mtime churn: full reparse → ~free skip')"
