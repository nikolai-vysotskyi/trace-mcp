#!/usr/bin/env bash
# trace-mcp-mirror v0.1.0 (TRA-725, experiment E1')
#
# PostToolUse mirror for Read and Bash. The native tool runs untouched; this
# hook rewrites its output before it reaches the model via the harness field
# `hookSpecificOutput.updatedToolOutput` ("Replaces the tool output before it
# is sent to the model", Claude Code >= 2.1.x). The full result is spilled to
# disk and referenced by path, so the agent can pull it back when the
# compressed view is not enough.
#
# This is deliberately a hook and not a pair of mirror TOOLS. A mirror tool
# competes with the native one for the model's choice, and TRA-705 measured
# that competition at 13-16% adoption -- below the 30% death line written into
# TRA-725 before the experiment. A PostToolUse hook is not a choice: it sees
# 100% of Read/Bash calls by construction.
#
# Compression is deterministic and model-free (TRA-725 step 1):
#   1. collapse runs of identical lines
#   2. drop build/install progress noise
#   3. head/tail window whatever is still oversized
#
# Every rewrite appends one JSONL record to the measurement log so compression
# and call counts can be read off a real session rather than estimated.
#
# Install (PostToolUse, matcher "Read|Bash"). Env knobs:
#   TRACE_MCP_MIRROR_MIN_CHARS   below this, pass through untouched (default 2000)
#   TRACE_MCP_MIRROR_KEEP_HEAD   lines kept from the top of a window (default 80)
#   TRACE_MCP_MIRROR_KEEP_TAIL   lines kept from the bottom of a window (default 40)
#   TRACE_MCP_MIRROR_DISABLE     any non-empty value: pass through untouched
#   TRACE_MCP_MIRROR_HOME        state dir (default ~/.trace-mcp/mirror)

set -uo pipefail

INPUT=$(cat)
[ -n "${TRACE_MCP_MIRROR_DISABLE:-}" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

MIN_CHARS="${TRACE_MCP_MIRROR_MIN_CHARS:-2000}"
KEEP_HEAD="${TRACE_MCP_MIRROR_KEEP_HEAD:-80}"
KEEP_TAIL="${TRACE_MCP_MIRROR_KEEP_TAIL:-40}"
HOME_DIR="${TRACE_MCP_MIRROR_HOME:-$HOME/.trace-mcp/mirror}"

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
case "$TOOL_NAME" in
  Read|Bash) ;;
  *) exit 0 ;;
esac

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "default"')

# The harness validates that updatedToolOutput matches the tool's own output
# shape and silently discards a rewrite that does not ("PostToolUse hook
# returned updatedToolOutput that does not match <tool>'s output shape; using
# original output"). So we never emit a bare string: we locate the one text
# field inside tool_response, swap it, and hand the whole structure back.
#   Read: { type: "text", file: { filePath, content, numLines, startLine, totalLines } }
#   Bash: { stdout, stderr, interrupted, isImage, noOutputExpected }
if [ "$TOOL_NAME" = "Read" ]; then
  TEXT_PATH='.file.content'
else
  TEXT_PATH='.stdout'
fi

ORIGINAL=$(printf '%s' "$INPUT" | jq -r --arg p "$TEXT_PATH" '
  .tool_response
  | if type == "object" then getpath($p | ltrimstr(".") | split(".")) else empty end
  | if type == "string" then . else empty end
')
[ -z "$ORIGINAL" ] && exit 0

ORIG_CHARS=${#ORIGINAL}
[ "$ORIG_CHARS" -lt "$MIN_CHARS" ] && exit 0

SPILL_DIR="$HOME_DIR/$SESSION_ID"
mkdir -p "$SPILL_DIR" 2>/dev/null || exit 0
# A spill is only useful while its session is alive, so anything older than a
# day is garbage. Without this the directory grows for as long as the hook is
# installed.
find "$HOME_DIR" -name '*.txt' -type f -mtime +1 -delete 2>/dev/null
SPILL="$SPILL_DIR/$(date +%s)-$$.txt"
printf '%s' "$ORIGINAL" >"$SPILL" 2>/dev/null || exit 0

# --- step 1+2: collapse identical runs, drop progress noise -------------------
# NOISE_RE is intentionally conservative: only lines that carry no information a
# later turn could need. Anything ambiguous stays.
NOISE_RE='^[[:space:]]*(⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|[0-9]+%|Progress:|Downloading|Fetching|Resolving|Reused |Added [0-9]+ package|Packages: |Progress: resolved|npm (WARN|notice) |[.]{3,})'

COMPRESSED=$(printf '%s\n' "$ORIGINAL" \
  | grep -Ev "$NOISE_RE" \
  | awk '
      { if ($0 == prev) { n++; next }
        if (n > 0) { printf "  … previous line repeated %d more time(s)\n", n; n = 0 }
        print; prev = $0 }
      END { if (n > 0) printf "  … previous line repeated %d more time(s)\n", n }
    ')

# --- step 3: head/tail window ------------------------------------------------
TOTAL_LINES=$(printf '%s\n' "$COMPRESSED" | wc -l | tr -d ' ')
WINDOW=$((KEEP_HEAD + KEEP_TAIL))
if [ "$TOTAL_LINES" -gt "$WINDOW" ]; then
  ELIDED=$((TOTAL_LINES - WINDOW))
  COMPRESSED=$(printf '%s\n' "$COMPRESSED" | head -n "$KEEP_HEAD"
    printf '  … %d line(s) elided by trace-mcp mirror …\n' "$ELIDED"
    printf '%s\n' "$COMPRESSED" | tail -n "$KEEP_TAIL")
fi

NEW_CHARS=${#COMPRESSED}
# A rewrite that does not actually shrink the payload is pure risk. Bail out.
if [ "$NEW_CHARS" -ge "$ORIG_CHARS" ]; then
  rm -f "$SPILL"
  exit 0
fi

SAVED_PCT=$(( (ORIG_CHARS - NEW_CHARS) * 100 / ORIG_CHARS ))
FOOTER=$(printf '\n[trace-mcp mirror] %s output compressed %d → %d chars (−%d%%). Full output: %s' \
  "$TOOL_NAME" "$ORIG_CHARS" "$NEW_CHARS" "$SAVED_PCT" "$SPILL")

# --- measurement log ---------------------------------------------------------
printf '%s\n' "$(jq -nc \
  --arg s "$SESSION_ID" --arg t "$TOOL_NAME" --arg f "$SPILL" \
  --argjson o "$ORIG_CHARS" --argjson n "$NEW_CHARS" \
  '{ts: (now|todate), session: $s, tool: $t, orig_chars: $o, new_chars: $n, spill: $f}')" \
  >>"$HOME_DIR/metrics.jsonl" 2>/dev/null

printf '%s' "$INPUT" | jq -c \
  --arg p "$TEXT_PATH" --arg out "$COMPRESSED$FOOTER" '
  ($p | ltrimstr(".") | split(".")) as $path
  | (.tool_response | setpath($path; $out)) as $resp
  | (if ($resp | has("file")) then
       $resp | .file.numLines = ($out | split("\n") | length)
     else $resp end) as $resp
  | {hookSpecificOutput: {hookEventName: "PostToolUse", updatedToolOutput: $resp}}
'
