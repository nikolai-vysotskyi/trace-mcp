#!/usr/bin/env bash
# trace-mcp-guard v0.8.0
# trace-mcp PreToolUse guard
# Routes Read/Grep/Glob/Bash/Agent on source code files through trace-mcp.
#
# Three modes (TRACE_MCP_GUARD_MODE env, default strict):
#   - strict   : block code Read/Grep/Glob until trace-mcp consultation;
#                full enforcement.
#   - coach    : never block; instead inject the trace-mcp suggestion as
#                additionalContext on every call that *would* have been
#                denied. Designed for first-week users — value without
#                friction; auto-promotes to strict via the desktop app.
#   - off      : disable the hook entirely.
#
# Stall detection (v0.8): the server now writes a rich JSON status sentinel
# (trace-mcp-status-{hash}.json). The hook reads `last_successful_tool_call_at`
# and treats a long quiet period (>5min) with no recent calls as a stalled
# MCP channel — auto-fallback without waiting for 5 denied attempts.
#
# Earlier fallback paths still apply:
#   - Manual bypass via scripts/trace-mcp-{disable,enable}-guard.sh.
#   - Auto-degradation when N denies pile up with zero consultation markers.
#
# Design (v0.7 — closes the retry-bypass loophole from v0.6):
#
#   1. Consultation markers are the ONLY way to unlock Read on a code file.
#      Calling get_outline / get_symbol / find_usages / etc. on a file makes
#      the trace-mcp server write a marker; the hook reads it and allows
#      subsequent Read. There is no longer a "retry once and you're in" path.
#
#   2. Heartbeat sentinel handles the legitimate fallback case. The trace-mcp
#      server periodically touches $TMPDIR/trace-mcp-alive-{projectHash}. If
#      the file is missing or older than $STALE_THRESHOLD_SEC, the server is
#      considered unavailable and Read is allowed with a warning. This covers
#      crashed servers, "session not found", and not-yet-started servers
#      without giving the agent a knob to bypass a healthy server.
#
#   3. Repeat-deny escalation. When the agent retries Read on a file without
#      consulting trace-mcp first, the deny message escalates from advisory
#      to a hard imperative on the second attempt and beyond. The escalation
#      counter resets when a consultation marker appears.
#
#   4. Manual user override: TRACE_MCP_GUARD_OFF=1 fully bypasses the guard.
#      Intended for direct user shell sessions, not the agent.
#
# Install: add to ~/.claude/settings.json or .claude/settings.local.json
# See README.md for setup instructions.

set -euo pipefail

# ─── Manual user override ──────────────────────────────────────────
# Allow direct shell users to opt out without editing settings.json.
if [[ "${TRACE_MCP_GUARD_OFF:-0}" == "1" ]]; then
  exit 0
fi

# ─── Mode selection ────────────────────────────────────────────────
# strict (default) | coach | off
GUARD_MODE="${TRACE_MCP_GUARD_MODE:-strict}"
case "$GUARD_MODE" in
  strict|coach|off) ;;
  *) GUARD_MODE="strict" ;;
esac
if [[ "$GUARD_MODE" == "off" ]]; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME="${CLAUDE_TOOL_NAME:-$(echo "$INPUT" | jq -r '.tool_name // empty')}"

# ─── File-extension classifiers ────────────────────────────────────
# Code file extensions to guard
CODE_EXT_RE='\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|kts|rb|php|cs|cpp|c|h|hpp|swift|scala|vue|svelte|astro|blade\.php)$'

# Non-code extensions — always allow
NONCODE_EXT_RE='\.(md|json|jsonc|yaml|yml|toml|ini|cfg|txt|html|xml|csv|svg|lock|log|sh|bash|zsh|fish|ps1|bat|cmd|dockerfile|dockerignore|gitignore|gitattributes|editorconfig|prettierrc|eslintrc|stylelintrc)$'

# .env files — always route through trace-mcp to prevent secret leakage
ENV_FILE_RE='\.env(\.[a-zA-Z0-9._-]+)?$'

# Example/template env files — committed to git, contain placeholders.
ENV_EXAMPLE_RE='\.env\.(example|examples|sample|samples|template|templates|dist|defaults?|docs?)$'

is_sensitive_env_file() {
  local p="$1"
  echo "$p" | grep -qiE "$ENV_FILE_RE" || return 1
  echo "$p" | grep -qiE "$ENV_EXAMPLE_RE" && return 1
  return 0
}

# Safe Bash command prefixes (full prefix or env-prefixed: `LC_ALL=C cmd`).
SAFE_BASH_RE='^((([A-Z_][A-Z0-9_]*=[^ ]*) +)*)(git|npm|npx|pnpm|yarn|bun|node|deno|cargo|go|make|mvn|gradle|docker|kubectl|helm|terraform|pip|poetry|uv|pytest|vitest|jest|phpunit|composer|artisan|rails|bundle|mix|dotnet|cmake|ninja|meson)( |$)'

# Cross-platform sha256 hash
file_sha256() {
  echo -n "$1" | sha256sum 2>/dev/null | cut -d' ' -f1 || echo -n "$1" | shasum -a 256 2>/dev/null | cut -d' ' -f1
}

# Portable mtime (Linux: stat -c %Y; macOS/BSD: stat -f %m).
file_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

deny() {
  local reason="$1"
  local context="$2"
  if [[ "$GUARD_MODE" == "coach" ]]; then
    # Coach mode: never block. Inject the trace-mcp hint as additionalContext
    # so the agent sees the suggestion without losing the round-trip.
    cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "trace-mcp coach: $reason\\n\\n$context"
  }
}
EOF
    exit 0
  fi
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "$reason",
    "additionalContext": "$context"
  }
}
EOF
  exit 0
}

allow_with_context() {
  local context="$1"
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "$context"
  }
}
EOF
  exit 0
}

# ─── Project + session paths ───────────────────────────────────────
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "default"')
PROJECT_ROOT="$(pwd)"
if command -v sha256sum >/dev/null 2>&1; then
  PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | sha256sum | cut -c1-12)
elif command -v shasum >/dev/null 2>&1; then
  PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | shasum -a 256 | cut -c1-12)
else
  PROJECT_HASH=""
fi
CONSULTED_DIR="${TMPDIR:-/tmp}/trace-mcp-consulted-${PROJECT_HASH}"
HEARTBEAT_FILE="${TMPDIR:-/tmp}/trace-mcp-alive-${PROJECT_HASH}"
STATUS_FILE="${TMPDIR:-/tmp}/trace-mcp-status-${PROJECT_HASH}.json"
BYPASS_FILE="${TMPDIR:-/tmp}/trace-mcp-bypass-${PROJECT_HASH}"
READS_DIR="${TMPDIR:-/tmp}/trace-mcp-reads-${SESSION_ID}"
DENY_AGGREGATE_FILE="$READS_DIR/.deny-aggregate"
mkdir -p "$READS_DIR" 2>/dev/null || true

# Tunables
REPEAT_READ_LIMIT=${TRACE_MCP_GUARD_REPEAT_LIMIT:-3}
STALE_THRESHOLD_SEC=${TRACE_MCP_GUARD_STALE_SEC:-30}
# Stall detection: if status JSON shows last_successful_tool_call_at is older
# than this AND tool_calls_total > 0, MCP channel is considered stalled.
STALL_THRESHOLD_SEC=${TRACE_MCP_GUARD_STALL_SEC:-300}
# Auto-degradation: trip when N denies accumulate within WINDOW seconds AND
# no consultation markers exist (suggests MCP channel is dead but process is up).
AUTO_DEGRADE_DENY_THRESHOLD=${TRACE_MCP_GUARD_AUTO_DENY:-5}
AUTO_DEGRADE_WINDOW_SEC=${TRACE_MCP_GUARD_AUTO_WINDOW:-300}
AUTO_DEGRADE_DURATION_SEC=${TRACE_MCP_GUARD_AUTO_DURATION:-300}

# Convert ISO 8601 timestamp → epoch seconds. Empty/invalid input → 0.
iso_to_epoch() {
  local ts="$1"
  [[ -z "$ts" ]] && { echo 0; return; }
  # GNU date (Linux) and BSD date (macOS) both accept ISO 8601 via -d / -j.
  date -d "$ts" +%s 2>/dev/null && return
  # macOS BSD date: drop sub-seconds + Z, parse as UTC.
  local trimmed="${ts%%.*}"
  trimmed="${trimmed%Z}"
  date -juf "%Y-%m-%dT%H:%M:%S" "$trimmed" +%s 2>/dev/null && return
  echo 0
}

# ─── Liveness / bypass check ───────────────────────────────────────
# HEARTBEAT_DEAD=1 → fallback mode: allow Read with warning instead of
# hard-blocking. Triggered by:
#   1. Manual bypass sentinel (bypass file exists with mtime in the future,
#      written by scripts/trace-mcp-disable-guard.sh).
#   2. Auto-degradation sentinel (same file, written by the hook itself
#      after detecting many denies with zero consultation markers — covers
#      the "process alive, MCP channel dead" case where heartbeat alone
#      can't help).
#   3. Heartbeat sentinel missing or stale (process not running).
HEARTBEAT_DEAD=0
HEARTBEAT_REASON=""
NOW=$(date +%s)

if [[ -z "$PROJECT_HASH" ]]; then
  HEARTBEAT_DEAD=1
  HEARTBEAT_REASON="hash unavailable"
elif [[ -f "$BYPASS_FILE" ]]; then
  BP_MTIME=$(file_mtime "$BYPASS_FILE")
  if (( BP_MTIME > NOW )); then
    REMAINING=$((BP_MTIME - NOW))
    HEARTBEAT_DEAD=1
    HEARTBEAT_REASON="trace-mcp guard manually bypassed (${REMAINING}s remaining); re-enable: bash scripts/trace-mcp-enable-guard.sh"
  else
    # Expired bypass — clean up so it doesn't accumulate.
    rm -f "$BYPASS_FILE" 2>/dev/null || true
  fi
fi

if (( HEARTBEAT_DEAD == 0 )); then
  if [[ ! -f "$HEARTBEAT_FILE" ]]; then
    HEARTBEAT_DEAD=1
    HEARTBEAT_REASON="trace-mcp server not running (no heartbeat sentinel)"
  else
    HB_MTIME=$(file_mtime "$HEARTBEAT_FILE")
    AGE=$((NOW - HB_MTIME))
    if (( AGE > STALE_THRESHOLD_SEC )); then
      HEARTBEAT_DEAD=1
      HEARTBEAT_REASON="trace-mcp heartbeat stale (${AGE}s old, threshold ${STALE_THRESHOLD_SEC}s)"
    fi
  fi
fi

# Stall detection (v0.8): even with a fresh heartbeat, the MCP channel may be
# stuck. The status JSON exposes last_successful_tool_call_at; if it has been
# silent for STALL_THRESHOLD_SEC AND tool_calls_total > 0 (i.e. MCP did work
# at some point and then went quiet), treat as stalled.
if (( HEARTBEAT_DEAD == 0 )) && [[ -f "$STATUS_FILE" ]]; then
  STATUS_TOTAL=$(jq -r '.tool_calls_total // 0' "$STATUS_FILE" 2>/dev/null || echo 0)
  STATUS_LAST=$(jq -r '.last_successful_tool_call_at // empty' "$STATUS_FILE" 2>/dev/null || echo "")
  if [[ "$STATUS_TOTAL" =~ ^[0-9]+$ ]] && (( STATUS_TOTAL > 0 )) && [[ -n "$STATUS_LAST" ]]; then
    LAST_EPOCH=$(iso_to_epoch "$STATUS_LAST")
    if (( LAST_EPOCH > 0 )); then
      QUIET=$((NOW - LAST_EPOCH))
      if (( QUIET > STALL_THRESHOLD_SEC )); then
        HEARTBEAT_DEAD=1
        HEARTBEAT_REASON="trace-mcp MCP channel stalled — no successful tool call for ${QUIET}s (threshold ${STALL_THRESHOLD_SEC}s)"
      fi
    fi
  fi
fi

# Auto-degradation: track per-session deny aggregate. If N denies pile up
# within the window AND no consultation markers exist, assume the MCP channel
# is broken (process alive but session dead) and write a bypass sentinel.
maybe_auto_degrade() {
  # Already in fallback mode for any reason — nothing to do.
  if (( HEARTBEAT_DEAD == 1 )); then
    return
  fi
  # If consultation markers exist for this project, the agent is reaching
  # trace-mcp successfully — don't auto-degrade.
  if [[ -d "$CONSULTED_DIR" ]] && [[ -n "$(ls -A "$CONSULTED_DIR" 2>/dev/null)" ]]; then
    return
  fi

  local count=0
  local first_ts=$NOW
  if [[ -f "$DENY_AGGREGATE_FILE" ]]; then
    IFS=':' read -r count first_ts < "$DENY_AGGREGATE_FILE" || true
    count="${count:-0}"
    first_ts="${first_ts:-$NOW}"
    # Reset window if it's fully elapsed.
    if (( NOW - first_ts > AUTO_DEGRADE_WINDOW_SEC )); then
      count=0
      first_ts=$NOW
    fi
  fi
  count=$((count + 1))
  echo "${count}:${first_ts}" > "$DENY_AGGREGATE_FILE"

  if (( count >= AUTO_DEGRADE_DENY_THRESHOLD )); then
    # Trip auto-degradation: write bypass sentinel with mtime in the future.
    local expiry=$((NOW + AUTO_DEGRADE_DURATION_SEC))
    echo "auto-degraded" > "$BYPASS_FILE" 2>/dev/null || true
    if command -v gtouch >/dev/null 2>&1; then
      gtouch -d "@$expiry" "$BYPASS_FILE" 2>/dev/null || true
    else
      touch -t "$(date -r "$expiry" +%Y%m%d%H%M.%S 2>/dev/null || date -d "@$expiry" +%Y%m%d%H%M.%S 2>/dev/null)" "$BYPASS_FILE" 2>/dev/null || true
    fi
    HEARTBEAT_DEAD=1
    HEARTBEAT_REASON="auto-degraded — ${count} denies / 0 consultation markers in window. trace-mcp MCP channel appears unresponsive. Auto-bypass for $((AUTO_DEGRADE_DURATION_SEC / 60))min; will re-arm on next consultation marker"
    rm -f "$DENY_AGGREGATE_FILE" 2>/dev/null || true
  fi
}

# Reset deny aggregate as soon as ANY consultation marker exists — that proves
# the MCP channel is alive in this session.
if [[ -d "$CONSULTED_DIR" ]] && [[ -n "$(ls -A "$CONSULTED_DIR" 2>/dev/null)" ]]; then
  rm -f "$DENY_AGGREGATE_FILE" 2>/dev/null || true
fi

# ─── Read ──────────────────────────────────────────────────────────
if [[ "$TOOL_NAME" == "Read" ]]; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

  # .env files — always block, even when heartbeat is dead.
  # Secret leakage risk is independent of trace-mcp availability.
  if is_sensitive_env_file "$FILE_PATH"; then
    REL_PATH=$(echo "$FILE_PATH" | sed "s|^$(pwd)/||")
    deny \
      "Use get_env_vars for .env files — it masks sensitive values (passwords, API keys, tokens)." \
      "trace-mcp alternatives for ${REL_PATH}:\\n- get_env_vars { \\\"file\\\": \\\"${REL_PATH}\\\" } — list keys + types without exposing secrets\\n- get_env_vars { \\\"pattern\\\": \\\"DB_\\\" } — filter by key prefix\\nNever read .env files directly — secrets will leak into AI model context.\\n(Template files like .env.example/.env.sample are allowed.)"
  fi

  # Non-code files — always allow.
  if echo "$FILE_PATH" | grep -qiE "$NONCODE_EXT_RE"; then
    exit 0
  fi

  # Files outside source dirs (e.g. configs without standard extensions).
  BASENAME=$(basename "$FILE_PATH")
  if [[ "$BASENAME" != *.* ]] || echo "$FILE_PATH" | grep -qE '(node_modules|vendor|dist|build|\.git)/'; then
    exit 0
  fi

  # Code files: route through consultation marker / heartbeat.
  if echo "$FILE_PATH" | grep -qiE "$CODE_EXT_RE"; then
    REL_PATH=$(echo "$FILE_PATH" | sed "s|^${PROJECT_ROOT}/||")

    # Heartbeat fallback — server is unavailable, allow Read with warning.
    # This is the legitimate fallback path; agents do not control it.
    if (( HEARTBEAT_DEAD == 1 )); then
      allow_with_context \
        "trace-mcp guard: ${HEARTBEAT_REASON}. Allowing Read as fallback — restart trace-mcp or run \\\"trace-mcp serve\\\" to re-enable strict routing."
    fi

    FILE_HASH=$(file_sha256 "$FILE_PATH")
    READ_STATE="$READS_DIR/$FILE_HASH"
    DENY_STATE="$READS_DIR/$FILE_HASH.deny"
    PREV_COUNT=0
    PREV_MTIME=""
    if [[ -f "$READ_STATE" ]]; then
      IFS=':' read -r PREV_COUNT PREV_MTIME < "$READ_STATE" || true
      PREV_COUNT="${PREV_COUNT:-0}"
    fi
    CUR_MTIME=$(file_mtime "$FILE_PATH")
    if [[ "$CUR_MTIME" != "$PREV_MTIME" ]]; then
      PREV_COUNT=0
    fi

    # Consultation marker check — server-side flag that the agent has called
    # a trace-mcp tool that touches this file. If present, Read is allowed.
    REL_PATH_FOR_HASH="$REL_PATH"
    CONSULTED_HASH=$(file_sha256 "$REL_PATH_FOR_HASH")
    HAS_MARKER=0
    if [[ -n "$PROJECT_HASH" && -f "$CONSULTED_DIR/$CONSULTED_HASH" ]]; then
      HAS_MARKER=1
    fi

    if (( HAS_MARKER == 1 )); then
      # Reset deny escalation — the agent did consult trace-mcp.
      rm -f "$DENY_STATE" 2>/dev/null || true
      # Repeat-read limit on unchanged file: force narrower lookups.
      if (( PREV_COUNT >= REPEAT_READ_LIMIT )); then
        deny \
          "Already read ${REL_PATH} ${PREV_COUNT}x this session — use get_symbol/get_outline instead of re-reading." \
          "trace-mcp alternatives for ${REL_PATH}:\\n- get_symbol { \\\"fqn\\\": \\\"SymbolName\\\" } — read ONE symbol instead of the whole file\\n- get_outline { \\\"path\\\": \\\"${REL_PATH}\\\" } — signatures only (much cheaper than full reads)\\n- get_context_bundle { \\\"symbol_id\\\": \\\"...\\\" } — symbol + its imports in one call\\n- get_feature_context { \\\"description\\\": \\\"what you need\\\" } — NL query over the indexed codebase\\nThe counter resets automatically if you Edit/Write this file."
      fi
      echo "$((PREV_COUNT + 1)):${CUR_MTIME}" > "$READ_STATE"
      exit 0
    fi

    # No marker → first check whether we should auto-degrade based on
    # session-wide failure pattern. If maybe_auto_degrade trips, it sets
    # HEARTBEAT_DEAD=1 and we fall through to the fallback branch below.
    maybe_auto_degrade
    if (( HEARTBEAT_DEAD == 1 )); then
      allow_with_context \
        "trace-mcp guard: ${HEARTBEAT_REASON}. Allowing Read as fallback."
    fi

    # No marker → deny. Track repeat denies for escalation.
    DENY_COUNT=0
    if [[ -f "$DENY_STATE" ]]; then
      DENY_COUNT=$(cat "$DENY_STATE" 2>/dev/null || echo 0)
      DENY_COUNT="${DENY_COUNT:-0}"
    fi
    DENY_COUNT=$((DENY_COUNT + 1))
    echo "$DENY_COUNT" > "$DENY_STATE"

    if (( DENY_COUNT >= 2 )); then
      # Escalated: hard imperative, no advisory framing, no fallback hint.
      deny \
        "BLOCKED (attempt #${DENY_COUNT}). Read of ${REL_PATH} requires a prior trace-mcp consultation — none recorded." \
        "Required next call: get_outline { \\\"path\\\": \\\"${REL_PATH}\\\" }\\nAfter that call succeeds, Read of this file will be allowed automatically.\\nIf trace-mcp is genuinely unreachable, the heartbeat sentinel will detect it and switch this hook to fallback mode within ${STALE_THRESHOLD_SEC}s."
    fi

    # First-time deny: standard advisory, no "retry will work" hint.
    echo "0:${CUR_MTIME}" > "$READ_STATE"
    deny \
      "Use trace-mcp for code reading — call get_outline first to record consultation, then Read will be allowed." \
      "trace-mcp alternatives for ${REL_PATH}:\\n- get_outline { \\\"path\\\": \\\"${REL_PATH}\\\" } — see file structure (signatures only); after this call, Read of this file is allowed\\n- get_symbol { \\\"fqn\\\": \\\"SymbolName\\\" } — read one specific symbol\\n- search { \\\"query\\\": \\\"keyword\\\" } — find symbols by name\\n- get_feature_context { \\\"description\\\": \\\"what you need\\\" } — relevant code for a task"
  fi

  exit 0
fi

# ─── Grep ──────────────────────────────────────────────────────────
if [[ "$TOOL_NAME" == "Grep" ]]; then
  GREP_PATH=$(echo "$INPUT" | jq -r '.tool_input.path // empty')
  GREP_GLOB=$(echo "$INPUT" | jq -r '.tool_input.glob // empty')
  GREP_TYPE=$(echo "$INPUT" | jq -r '.tool_input.type // empty')

  GREP_BLOCK_ENV=0
  if echo "$GREP_GLOB" | grep -qiE '\.env' && ! echo "$GREP_GLOB" | grep -qiE "$ENV_EXAMPLE_RE"; then
    GREP_BLOCK_ENV=1
  fi
  if is_sensitive_env_file "$GREP_PATH"; then
    GREP_BLOCK_ENV=1
  fi
  if (( GREP_BLOCK_ENV == 1 )); then
    deny \
      "Use get_env_vars for .env files — it masks sensitive values." \
      "trace-mcp alternatives:\\n- get_env_vars { \\\"pattern\\\": \\\"search_term\\\" } — find env vars by key pattern without exposing values\\n(Template files like .env.example/.env.sample are allowed — grep those directly.)"
  fi

  if echo "$GREP_GLOB" | grep -qiE '\.(md|json|ya?ml|toml|txt|html|xml|csv|cfg|ini|lock|log)'; then
    exit 0
  fi
  if [[ "$GREP_TYPE" == "md" || "$GREP_TYPE" == "json" || "$GREP_TYPE" == "yaml" || "$GREP_TYPE" == "toml" || "$GREP_TYPE" == "xml" || "$GREP_TYPE" == "html" || "$GREP_TYPE" == "csv" ]]; then
    exit 0
  fi
  if echo "$GREP_PATH" | grep -qE '(node_modules|vendor|dist|build|\.git)'; then
    exit 0
  fi

  # Heartbeat / bypass fallback applies to Grep too. Also try auto-degrade.
  if (( HEARTBEAT_DEAD == 1 )); then
    allow_with_context \
      "trace-mcp guard: ${HEARTBEAT_REASON}. Allowing Grep as fallback — restart trace-mcp to re-enable strict routing."
  fi
  maybe_auto_degrade
  if (( HEARTBEAT_DEAD == 1 )); then
    allow_with_context \
      "trace-mcp guard: ${HEARTBEAT_REASON}. Allowing Grep as fallback."
  fi

  PATTERN=$(echo "$INPUT" | jq -r '.tool_input.pattern // empty')
  deny \
    "Use trace-mcp for code search — it understands symbols and relationships." \
    "trace-mcp alternatives for searching \\\"${PATTERN}\\\":\\n- search { \\\"query\\\": \\\"${PATTERN}\\\" } — find symbols by name (supports kind, language, file_pattern filters)\\n- find_usages { \\\"fqn\\\": \\\"SymbolName\\\" } — find all usages (imports, calls, renders)\\n- get_call_graph { \\\"fqn\\\": \\\"FunctionName\\\" } — who calls it + what it calls\\nUse Grep only for non-code files (.md, .json, .yaml, config)."
fi

# ─── Glob ──────────────────────────────────────────────────────────
if [[ "$TOOL_NAME" == "Glob" ]]; then
  GLOB_PATTERN=$(echo "$INPUT" | jq -r '.tool_input.pattern // empty')

  if echo "$GLOB_PATTERN" | grep -qiE '\.env' && ! echo "$GLOB_PATTERN" | grep -qiE "$ENV_EXAMPLE_RE"; then
    deny \
      "Use get_env_vars for .env files — it masks sensitive values." \
      "trace-mcp alternatives:\\n- get_env_vars {} — list all env vars across all .env files\\n(Template files like .env.example/.env.sample are allowed — glob those directly.)"
  fi

  if echo "$GLOB_PATTERN" | grep -qiE '\.(md|json|ya?ml|toml|txt|html|xml|csv|cfg|ini|lock|log)'; then
    exit 0
  fi

  if (( HEARTBEAT_DEAD == 1 )); then
    allow_with_context \
      "trace-mcp guard: ${HEARTBEAT_REASON}. Allowing Glob as fallback."
  fi
  maybe_auto_degrade
  if (( HEARTBEAT_DEAD == 1 )); then
    allow_with_context \
      "trace-mcp guard: ${HEARTBEAT_REASON}. Allowing Glob as fallback."
  fi

  deny \
    "Use trace-mcp for code file discovery — it knows your project structure." \
    "trace-mcp alternatives:\\n- get_project_map { \\\"summary_only\\\": true } — project overview (frameworks, languages, structure)\\n- search { \\\"query\\\": \\\"keyword\\\", \\\"file_pattern\\\": \\\"src/tools/*\\\" } — find symbols in specific paths\\n- get_outline { \\\"path\\\": \\\"path/to/file\\\" } — see what is in a file\\nUse Glob only for non-code file patterns."
fi

# ─── Bash ──────────────────────────────────────────────────────────
if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

  # .env access via shell — block (independent of heartbeat).
  if echo "$COMMAND" | grep -qiE "$ENV_FILE_RE" && ! echo "$COMMAND" | grep -qiE "$ENV_EXAMPLE_RE"; then
    deny \
      "Use get_env_vars for .env files — it masks sensitive values (passwords, API keys, tokens)." \
      "trace-mcp alternatives:\\n- get_env_vars {} — list all env vars across all .env files\\n- get_env_vars { \\\"pattern\\\": \\\"DB_\\\" } — filter by key prefix\\nNever access .env files via shell — secrets will leak into AI model context.\\n(Template files like .env.example/.env.sample are allowed.)"
  fi

  # git show/diff/log -p/blame on code paths — these are de-facto Read.
  if echo "$COMMAND" | grep -qiE "$CODE_EXT_RE"; then
    if echo "$COMMAND" | grep -qE '(^|[ |;&])git +(show|blame|cat-file)( |$)'; then
      deny \
        "Use trace-mcp instead of \\\"git show/blame/cat-file\\\" for reading code." \
        "trace-mcp alternatives:\\n- get_symbol { \\\"fqn\\\": \\\"...\\\" } — current source\\n- get_outline { \\\"path\\\": \\\"...\\\" } — file structure\\n- get_changed_symbols / compare_branches — git-aware diffs\\nUse git show/blame/cat-file only on non-code files."
    fi
    if echo "$COMMAND" | grep -qE '(^|[ |;&])git +log +.*(-p|--patch)( |$)'; then
      deny \
        "Use trace-mcp instead of \\\"git log -p\\\" for reading code." \
        "trace-mcp alternatives:\\n- compare_branches { \\\"branch\\\": \\\"current\\\" } — symbol-level diff\\n- get_changed_symbols { } — diff-aware symbol list"
    fi
    if echo "$COMMAND" | grep -qE '(^|[ |;&])git +diff( |$)'; then
      deny \
        "Use trace-mcp instead of \\\"git diff\\\" on code files." \
        "trace-mcp alternatives:\\n- compare_branches { \\\"branch\\\": \\\"current\\\" } — symbol-level diff\\n- get_changed_symbols { } — diff-aware symbol list\\nUse git diff only on non-code files."
    fi
  fi

  # Safe Bash whitelist (allows env-prefixed forms like `LC_ALL=C git ...`).
  if echo "$COMMAND" | grep -qE "$SAFE_BASH_RE"; then
    exit 0
  fi

  # Code exploration via shell on code files — block.
  # Triggers: grep/rg/find/cat/head/tail/less/more/awk/sed/bat/code/subl/view
  # appearing as a command (start of line or after pipe / && / ; / xargs)
  # combined with a code-file extension somewhere in the command.
  if echo "$COMMAND" | grep -qE '(^|[ |;&]|xargs +)(grep|rg|find|cat|head|tail|less|more|awk|sed|bat|view|subl|code)( |$)' && echo "$COMMAND" | grep -qiE "$CODE_EXT_RE"; then
    deny \
      "Use trace-mcp instead of shell commands for code exploration." \
      "trace-mcp has structured tools for this:\\n- search — find symbols by name\\n- get_symbol — read a specific symbol\\n- get_outline — file structure\\n- find_usages — all usages of a symbol\\nUse Bash only for builds, tests, git, and system commands."
  fi

  # Input redirection from a code file: `cmd < src/foo.ts`.
  if echo "$COMMAND" | grep -qE '< +[^ ]+' && echo "$COMMAND" | grep -qiE "$CODE_EXT_RE"; then
    deny \
      "Use trace-mcp instead of shell input-redirection on code files." \
      "trace-mcp alternatives:\\n- get_symbol — read a specific symbol\\n- get_outline — file structure"
  fi

  exit 0
fi

# ─── Agent ─────────────────────────────────────────────────────────
# Whitelist-based: allow Agent(general-purpose) only when description
# contains an explicit non-exploration verb. Agent(Explore) is always denied.
if [[ "$TOOL_NAME" == "Agent" ]]; then
  SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // "general-purpose"')
  DESCRIPTION=$(echo "$INPUT" | jq -r '.tool_input.description // ""' | tr '[:upper:]' '[:lower:]')

  if [[ "$SUBAGENT_TYPE" == "Explore" ]]; then
    deny \
      "Agent(Explore) wastes ~50K tokens on overhead. Use trace-mcp tools instead (~4K tokens)." \
      "trace-mcp alternatives:\\n- get_task_context { \\\"task\\\": \\\"your exploration goal\\\" } — focused context in one call\\n- get_feature_context { \\\"description\\\": \\\"what you need\\\" } — NL query → relevant symbols\\n- batch with multiple search/get_outline/get_symbol calls — parallel lookups\\n- get_project_map { \\\"summary_only\\\": true } — project overview"
  fi

  if [[ "$SUBAGENT_TYPE" == "general-purpose" ]]; then
    # Allowed verbs — Agent is reasonable for these.
    ALLOW_RE='\b(write|implement|build|create|generate|run|execute|test|deploy|publish|fix|refactor|migrate|upgrade|configure|install|fetch|web search|search the web|plan|review pr|review the pr|open a pr|open pr)\b'
    if ! echo "$DESCRIPTION" | grep -qE "$ALLOW_RE"; then
      deny \
        "Agent(general-purpose) without an explicit action verb (write/implement/build/run/test/fix/refactor/fetch/plan/...) is treated as exploration. Use trace-mcp tools instead — they cost ~4K tokens vs ~50K per agent." \
        "trace-mcp alternatives:\\n- get_task_context { \\\"task\\\": \\\"${DESCRIPTION}\\\" } — replaces exploration agents (~4K tokens)\\n- get_feature_context { \\\"description\\\": \\\"...\\\" } — NL query → relevant code\\n- find_usages / get_call_graph / get_change_impact — relationship analysis\\n- batch { \\\"calls\\\": [...] } — multiple lookups in one call\\nIf this is real coding work, rephrase the description with a concrete action verb."
    fi
  fi

  exit 0
fi

exit 0
