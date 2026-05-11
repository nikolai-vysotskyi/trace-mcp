#!/usr/bin/env bash
# bench-hash-gate-large.sh
#
# Same as bench-hash-gate.sh but uses a real large file from the repo so
# the hash-gate skip vs full extract delta is visible above HTTP/IO noise.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/cli.js"
PORT="${TRACE_MCP_DAEMON_PORT:-3741}"

WORK_DIR=$(mktemp -d -t trace-mcp-hashgate-large-XXXX)
trap "rm -rf '$WORK_DIR'" EXIT
cd "$WORK_DIR"
git init --quiet
echo '{"name":"hashgate-large-bench","version":"0.0.0","type":"module"}' > package.json
mkdir -p src

# Generate a synthetic but realistic 5000-line TS file with many functions
# and classes, ensuring the parser has real work to do.
python3 -c "
import sys
out = []
out.append('// Synthetic large file for hash-gate benchmark.')
for i in range(200):
    out.append(f'export interface Iface{i} {{ id: number; name: string; field{i}: string; nested: {{ x: number }}; }}')
    out.append(f'export class Class{i} {{')
    out.append(f'  constructor(private readonly opts: Iface{i}) {{}}')
    for m in range(10):
        out.append(f'  method{m}_{i}(a: number, b: Iface{i}): Iface{i} {{ return {{ ...this.opts, field{i}: String(a + b.id) }}; }}')
    out.append('}')
    out.append(f'export function func{i}(arg: Iface{i}): number {{')
    out.append(f'  const v = arg.id + arg.field{i}.length;')
    out.append('  return v;')
    out.append('}')
print('\n'.join(out))
" > src/large.ts
wc -l src/large.ts

git add -A >/dev/null && git -c user.email=b@b -c user.name=b commit -qm init >/dev/null
echo "Workspace: $WORK_DIR"

daemon_up() { curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; }
if ! daemon_up; then node "$CLI" daemon start --port "$PORT" >/dev/null 2>&1 || true; for _ in $(seq 1 10); do daemon_up && break; sleep 0.5; done; fi
daemon_up || { echo "daemon down" >&2; exit 1; }

curl -fsS -X POST -H 'Content-Type: application/json' \
  -d "{\"projectRoot\":\"$WORK_DIR\"}" \
  "http://127.0.0.1:${PORT}/api/projects" >/dev/null 2>&1 || true
sleep 3 # wait for initial index

time_reindex() {
  python3 -c "
import json, subprocess, time
body = json.dumps({'project': '$WORK_DIR', 'path': 'src/large.ts'})
t0 = time.perf_counter()
subprocess.run(['curl','-fsS','-X','POST','-H','Content-Type: application/json','-d',body,
               'http://127.0.0.1:${PORT}/api/projects/reindex-file'],
              capture_output=True, check=True)
t1 = time.perf_counter()
print(int((t1-t0)*1000))
"
}

echo
echo "=== Priming so the hash + mtime are in the DB ==="
PRIME=$(time_reindex); echo "  prime: ${PRIME} ms"
sleep 1 # past dedup TTL

echo
echo "=== mtime-only touch x 10 (hash gate path) ==="
TOUCH=""
for i in $(seq 1 10); do
  touch "$WORK_DIR/src/large.ts"
  sleep 0.6
  ms=$(time_reindex); TOUCH+="$ms "
  printf "  iter %2d: %4d ms\n" "$i" "$ms"
done

echo
echo "=== Content edit x 10 (full extract path) ==="
EDIT=""
for i in $(seq 1 10); do
  echo "// edit $i $(date +%s%N)" >> "$WORK_DIR/src/large.ts"
  sleep 0.6
  ms=$(time_reindex); EDIT+="$ms "
  printf "  iter %2d: %4d ms\n" "$i" "$ms"
done

echo
echo "============================================================="
python3 -c "
import statistics
def s(name, vals):
  v = sorted(float(x) for x in vals.split() if x)
  if not v: return f'{name}: no samples'
  return f'{name}: n={len(v)}  p50={v[len(v)//2]:.1f}ms  mean={statistics.mean(v):.1f}ms  min={v[0]:.1f}ms  max={v[-1]:.1f}ms'
print(s('mtime-touch (hash-gate skip)', '''$TOUCH'''))
print(s('content-edit (full extract)', '''$EDIT'''))
"
