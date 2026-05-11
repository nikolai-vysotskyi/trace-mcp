#!/usr/bin/env bash
# trace-mcp-reindex v0.3.0
# trace-mcp PostToolUse auto-reindex hook
# Daemon-first: posts to the running daemon's /api/projects/reindex-file
# endpoint via curl (no Node startup). Falls back to a cold subprocess
# only when the daemon is unreachable.

set -euo pipefail

INPUT=$(cat)
TOOL_NAME="${CLAUDE_TOOL_NAME:-$(echo "$INPUT" | jq -r '.tool_name // empty')}"

# Only handle edit-like tools
if [[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" && "$TOOL_NAME" != "MultiEdit" ]]; then
  exit 0
fi

# Code file extensions to reindex
CODE_EXT_RE='\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|kts|rb|php|cs|cpp|c|h|hpp|swift|scala|vue|svelte|astro|blade\.php)$'

# Non-code extensions — skip silently
NONCODE_EXT_RE='\.(md|json|jsonc|yaml|yml|toml|ini|cfg|env|txt|html|xml|csv|svg|lock|log|sh|bash|zsh|fish|ps1|bat|cmd|dockerfile|dockerignore|gitignore|gitattributes|editorconfig|prettierrc|eslintrc|stylelintrc)$'

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Skip non-code files
if echo "$FILE_PATH" | grep -qiE "$NONCODE_EXT_RE"; then
  exit 0
fi

# Skip if not a recognised code file
if ! echo "$FILE_PATH" | grep -qiE "$CODE_EXT_RE"; then
  exit 0
fi

# Resolve project root: prefer git toplevel, then walk up looking for
# .git or trace-mcp.config.json. Skip silently when the file isn't in a
# tracked project.
PROJECT_ROOT=""
FILE_DIR=$(dirname "$FILE_PATH")
if command -v git >/dev/null 2>&1; then
  PROJECT_ROOT=$(cd "$FILE_DIR" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || true)
fi
if [[ -z "$PROJECT_ROOT" ]]; then
  dir="$FILE_DIR"
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    if [[ -d "$dir/.git" || -f "$dir/trace-mcp.config.json" ]]; then
      PROJECT_ROOT="$dir"
      break
    fi
    dir=$(dirname "$dir")
  done
fi
[[ -z "$PROJECT_ROOT" ]] && exit 0

# Daemon port: env override, then default 3741.
PORT="${TRACE_MCP_DAEMON_PORT:-3741}"

# Stats file — best-effort JSONL telemetry for `daemon stats`.
STATS_HOME="${TRACE_MCP_HOME:-$HOME/.trace-mcp}"
STATS_FILE="$STATS_HOME/hook-stats.jsonl"
STATS_MAX_BYTES=$((10 * 1024 * 1024))

# Portable millisecond timestamp. Prefer EPOCHREALTIME (bash 5) — strip the
# decimal point to get ms. Fall back to GNU date, then python.
now_ms() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    local s="${EPOCHREALTIME%.*}"
    local us="${EPOCHREALTIME#*.}"
    # us is always 6 digits in bash 5; take first 3 for ms.
    printf '%s%s' "$s" "${us:0:3}"
    return
  fi
  if date +%s%3N 2>/dev/null | grep -qE '^[0-9]+$'; then
    date +%s%3N
    return
  fi
  python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo 0
}

write_stat() {
  local path_kind="$1"
  local reason="$2"
  local wall_ms="$3"
  local ts
  ts=$(now_ms)
  mkdir -p "$STATS_HOME" 2>/dev/null || return 0
  # Rotate when over ~10 MB. Truncate (not delete) so concurrent appenders
  # keep their fd alive; data loss is acceptable for telemetry.
  if [[ -f "$STATS_FILE" ]]; then
    local size
    size=$(stat -f%z "$STATS_FILE" 2>/dev/null || stat -c%s "$STATS_FILE" 2>/dev/null || echo 0)
    if [[ "$size" -gt "$STATS_MAX_BYTES" ]]; then
      : > "$STATS_FILE" 2>/dev/null || true
    fi
  fi
  # Single printf for atomic-ish append; JSONL tolerates interleaved whole lines.
  # Wrap in a subshell with stderr suppressed so bash's own redirection errors
  # (e.g. read-only stats dir) never leak to the caller.
  ( printf '{"ts":%s,"path":"%s","reason":"%s","wallclock_ms":%s}\n' \
      "$ts" "$path_kind" "$reason" "$wall_ms" >> "$STATS_FILE" ) 2>/dev/null || true
}

# Wallclock for the dispatch attempt.
START_MS=$(now_ms)

# Try daemon first — single curl, ~5 ms RTT. No Node startup.
HTTP_CODE=$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg p "$PROJECT_ROOT" --arg f "$FILE_PATH" '{project:$p,path:$f}')" \
    "http://127.0.0.1:${PORT}/api/projects/reindex-file" 2>/dev/null || echo "000")

END_MS=$(now_ms)
WALL_MS=$((END_MS - START_MS))

if [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then
  write_stat "daemon" "ok" "$WALL_MS"
  exit 0
fi

# Classify failure for stats. 000 = no daemon / connection refused / timeout
# (curl exits before HTTP). Distinguish timeout via curl exit code is fiddly
# under set -e; we collapse "couldn't connect" into no-daemon.
case "$HTTP_CODE" in
  400) REASON="400" ;;
  404) REASON="404" ;;
  503) REASON="503" ;;
  5*)  REASON="5xx" ;;
  000) REASON="no-daemon" ;;
  *)   REASON="other" ;;
esac

# Fallback: cold spawn (legacy behavior). Only hit when daemon is down.
# Phase 5+7 audit fix: `nohup ... &` returns immediately after fork, so any
# duration we measure post-fork is just the spawn cost — NOT the cold CLI
# reindex duration the user actually pays. Record only the curl wallclock so
# `daemon stats` shows the cost of *detecting* the daemon is down, not a
# misleading fake reindex time.
if command -v trace-mcp >/dev/null 2>&1; then
  nohup trace-mcp index-file "$FILE_PATH" >/dev/null 2>&1 &
  write_stat "cli" "$REASON" "$WALL_MS"
else
  write_stat "skipped" "$REASON" "$WALL_MS"
fi

exit 0
