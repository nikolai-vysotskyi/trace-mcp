#!/usr/bin/env bash
# trace-mcp-guard v0.16
# REQUIRES: trace-mcp >= 1.32.7   (status JSON sentinel introduced in this version)
#
# v0.16 changes (TRA-869 — sentinels moved out of $TMPDIR):
#   - The heartbeat, status, consultation-marker and bypass paths are read from
#     <state home>/status/ first, $TMPDIR second. $TMPDIR is per-process: the
#     server is spawned by the MCP client and this hook by the agent harness,
#     and on macOS they routinely hold different values. Measured live: the
#     server refreshed /var/folders/.../T/trace-mcp-alive-<hash> every 5s while
#     the hook looked in /tmp/multica-task-<id>/, so every call reported
#     "trace-mcp server not running" and degraded to the Read/Grep fallback,
#     against a healthy connected session.
#   - The $TMPDIR fallback keeps a server older than that fix discoverable.
#
# v0.15.1 changes (TRA-845 — Bash branch had no liveness fallback):
#   - Read, Grep and Glob all degrade to allow-with-warning when trace-mcp is
#     unreachable (no heartbeat, stale heartbeat, stalled channel, transport
#     mismatch, manual or auto bypass). The Bash branch never checked any of
#     it, so with the daemon stopped `grep -rn foo src/`, `cat src/x.ts`,
#     `ls src/`, `git diff src/x.ts` and `cmd < src/x.ts` were hard-denied
#     while the tools they redirect to could not answer either.
#   - Each of those six deny sites now calls bash_fallback_if_unavailable
#     first. Ordinary Bash calls (builds, tests, git status) stay silent, and
#     the .env rule stays unconditional — it is a secrets rule, not a
#     navigation-cost tradeoff.
#
# v0.15 changes (guard v2 — TRA-711, navigation streak gate):
#   - The guard no longer intervenes on an isolated navigation call. TRA-705
#     measured the trace path at 1.45x the cost of a bare grep agent on a light
#     navigation question with identical correctness (27/30 vs 27/30) — routing
#     that question through us is a measured regression, not a saving. The win
#     is on multi-step work (1.39x our way), so the guard now waits for the
#     session to actually be crawling.
#   - Navigation-class denies (Read/Grep/Glob/Bash code exploration/git
#     show|diff|log -p) now fire from the TRACE_MCP_GUARD_NAV_MIN'th (default 3)
#     navigation attempt within TRACE_MCP_GUARD_NAV_WINDOW seconds (default
#     300). Below that the hook exits silently.
#   - Relationship questions ("who calls X", "what breaks if I change Y",
#     "which tests cover Z") bypass the gate and are routed from the first
#     call — that is the shape where the advantage is measured. The
#     UserPromptSubmit hook (v0.3.0) sets the flag and resets the streak on
#     each new user prompt.
#   - Security rules (.env) and Agent(Explore) are unaffected: they are not
#     navigation-cost tradeoffs.
#
# v0.14 changes (fixes TRA-152 — recursive/pathless grep-cat bypass):
#   - The Bash grep/rg/find/cat/head/tail/etc. code-exploration rule required
#     a code-file extension at the very END of the command string ($-anchored
#     CODE_EXT_RE). That never matched recursive/pathless forms with no
#     filename at all (`grep -rn foo src/`, `grep -rln -i avif app/`), nor
#     commands where the filename isn't the last token (`cat src/App.tsx |
#     wc -l`) — the dominant real-world shape of these commands.
#   - Fix: the rule now also fires on a known source-tree directory argument
#     (same SOURCE_DIR_RE heuristic the ls/find rule already used), and the
#     extension check itself no longer requires the match to be at the end
#     of the command.
#
# v0.13 changes (transport-aware liveness — fixes GH #297):
#   - Status JSON now carries `transport` ("stdio" | "http" — which command
#     produced the sentinel). If PROJECT_ROOT/.mcp.json declares a different
#     transport for trace-mcp, the heartbeat is proof of the WRONG process
#     being alive (e.g. a leftover `serve-http` while the client is
#     configured for stdio `serve`) — treated as dead instead of trusted.
#   - `mcp_sessions_active == 0` now marks the channel dead unconditionally
#     (previously only checked when tool_calls_total > 0, which meant "no
#     client ever connected" was invisible to the stall detector).
#   - Requires trace-mcp server writing the `transport` field (schema 2);
#     older status JSON without it simply skips the transport check.
#
# v0.11 changes (enforcement tier — TRACE_MCP_ENFORCE):
#   - New env var TRACE_MCP_ENFORCE with three values:
#       advisory (DEFAULT): warn on stderr, allow the tool call (exit 0).
#       strict:             hard-deny via permissionDecision:deny JSON.
#                           The denial message names the trace-mcp route to use.
#       off:                fully silent, always allow (exit 0).
#     Unknown/typo value falls back to advisory (never hard-blocks on bad input).
#   - Exemptions that always pass even under strict:
#       * Read with offset/limit present (targeted pre-Edit reads).
#       * Non-code files (.md/.json/.yaml/.env/config).
#       * Paths outside the project root (not in an indexed repo).
#       * Anything the heartbeat/bypass logic would already allow (MCP down).
#   - scripts/trace-mcp-enable-guard.sh gains a --strict flag that writes
#     TRACE_MCP_ENFORCE=strict into the hook's env block in settings.json.
#     Running without --strict (re)sets TRACE_MCP_ENFORCE=advisory.
#
# v0.10 changes (fix wave for hook over-triggering):
#   - Agent verb allowlist expanded: compare/audit/benchmark/measure/verify/
#     evaluate/rewrite/convert/expand/reduce/flip/validate/inspect/add/
#     remove/delete/update/enable/disable/wire/port/extract/inline/flatten/
#     harden/patch/bump/rename/move/split/merge/drop/introduce/replace/
#     annotate/optimize/profile/debug — these are concrete actions, not
#     exploration. Allowlist now matches ANY word in the description, so
#     multi-word descriptions like "add empty-index warning to co_changes"
#     and "reduce fps in scanners" are correctly allowed.
#   - Opt-in hook backoff (TRACE_MCP_GUARD_BACKOFF_LIMIT, default off): when
#     set to N, the same advice category goes silent after N hits in one
#     session. Default is off to keep legacy behaviour intact.
#   - `git stash list/show/pop/push/drop/save/apply` and
#     `git show stash@{N}[:path]` are now allowed regardless of file
#     extension — stash extraction is a git-internal op, not source reading.
#   - `ls`/`find` on /tmp, /var, /private, /usr, /etc, $HOME, plus existing
#     dist/build/.git exclusions, are explicitly whitelisted.
#   - Heartbeat-dead fallback message no longer promises "within 30s" —
#     it now reads: "If MCP is unreachable, fall back to native tools."
# trace-mcp PreToolUse guard
# Routes Read/Grep/Glob/Bash/Agent on source code files through trace-mcp.
#
# v0.9 changes:
#   - .md "doc tour" detection: when N+ markdown files are read inside source
#     directories in one session (per-feature docs co-located with code), the
#     hook injects a get_feature_context / get_task_context hint via
#     additionalContext. Read still passes — this is a nudge, not a block.
#     README/CHANGELOG/LICENSE in repo root are unaffected.
#   - `ls` on source-tree paths is now denied (e.g. `ls src/...`,
#     `ls /abs/.../packages/foo/`), redirecting to get_project_map / get_outline.
#     Plain `ls`, `ls .`, `ls -la`, `ls dist/`, `ls node_modules/...` keep working.
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
# Resolution order:
#   1. <PROJECT_ROOT>/.trace-mcp/guard-mode file (per-project, written at
#      registration by the CLI/daemon, and by the desktop app)
#   2. TRACE_MCP_GUARD_MODE env var (global default for non-app users)
#   3. "strict"
PROJECT_MODE_FILE="$(pwd)/.trace-mcp/guard-mode"
if [[ -f "$PROJECT_MODE_FILE" ]]; then
  GUARD_MODE=$(head -n1 "$PROJECT_MODE_FILE" 2>/dev/null | tr -d ' \t\n\r')
fi
GUARD_MODE="${GUARD_MODE:-${TRACE_MCP_GUARD_MODE:-strict}}"
case "$GUARD_MODE" in
  strict|coach|off) ;;
  *) GUARD_MODE="strict" ;;
esac

# Coach is a 7-day onboarding grace period, not a permanent setting. The
# desktop app promotes it to strict on expiry, but a project is now armed with
# coach at registration (TRA-341) and may never be opened in the app — so the
# hook expires it too. Clearing install-date makes this fire once; a later
# manual switch back to coach writes no date and so never expires.
PROJECT_INSTALL_DATE_FILE="$(pwd)/.trace-mcp/install-date"
if [[ "$GUARD_MODE" == "coach" && -f "$PROJECT_INSTALL_DATE_FILE" ]]; then
  INSTALLED_AT=$(head -n1 "$PROJECT_INSTALL_DATE_FILE" 2>/dev/null | tr -d ' \t\n\r')
  if [[ "$INSTALLED_AT" =~ ^[0-9]+$ ]] && (( $(date +%s) >= INSTALLED_AT + 7 * 24 * 60 * 60 )); then
    GUARD_MODE="strict"
    echo "strict" > "$PROJECT_MODE_FILE" 2>/dev/null || true
    rm -f "$PROJECT_INSTALL_DATE_FILE" 2>/dev/null || true
  fi
fi
if [[ "$GUARD_MODE" == "off" ]]; then
  exit 0
fi

# ─── Enforcement tier (TRACE_MCP_ENFORCE) ─────────────────────────
# Independent of GUARD_MODE. Controls what happens when the guard wants
# to deny a native tool call that trace-mcp can serve.
#
#   advisory — always allow + hint (overrides GUARD_MODE=strict).
#   strict   — always hard-deny (overrides GUARD_MODE=coach).
#   off      — silent, always allow (exit 0).
#   unset    — fall back to GUARD_MODE (back-compat; NEVER hard-block on typo/bad value).
#
# Resolution: TRACE_MCP_ENFORCE env var (set by scripts/trace-mcp-enable-guard.sh --strict).
# When unset, ENFORCE_TIER is empty — GUARD_MODE governs behaviour (back-compat).
ENFORCE_TIER="${TRACE_MCP_ENFORCE:-}"
case "$ENFORCE_TIER" in
  advisory|strict|off) ;;
  *) ENFORCE_TIER="" ;;   # unknown value → treat as unset; never hard-block on typo
esac
if [[ "$ENFORCE_TIER" == "off" ]]; then
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

# Ask the TS classifier whether the path is a sensitive .env file. The
# classifier is the single source of truth for the secrecy model (see
# src/utils/env-classifier.ts) and recognises trust signals the shell
# cannot see — notably the "# Managed by <trusted-tool>" provenance
# header on tool-emitted files such as ~/.trace-mcp/launcher.env.
#
# Falls back to the filename-only regex when the CLI is missing,
# returns a non-JSON answer, or the path is a pattern rather than a
# real file (grep/glob arguments). The fallback preserves the legacy
# behaviour, so the hook never gets *less* strict on classifier failure.
classify_env_tier() {
  local p="$1"
  local out tier
  # Only worth spawning trace-mcp when the path actually exists — the
  # provenance check needs to read the file head. Otherwise filename
  # alone is the most we can decide.
  [[ -f "$p" ]] || { echo ""; return; }
  command -v trace-mcp >/dev/null 2>&1 || { echo ""; return; }
  out=$(trace-mcp classify-env "$p" 2>/dev/null) || { echo ""; return; }
  # Extract the `tier` field without a JSON dependency. The CLI emits a
  # single line of compact JSON like {"tier":"managed","reasons":[...]}.
  tier=$(echo "$out" | sed -n 's/.*"tier"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  echo "$tier"
}

is_sensitive_env_file() {
  local p="$1"
  echo "$p" | grep -qiE "$ENV_FILE_RE" || return 1
  echo "$p" | grep -qiE "$ENV_EXAMPLE_RE" && return 1
  case "$(classify_env_tier "$p")" in
    managed|template|not-env) return 1 ;;
  esac
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
  # Enforcement decision matrix:
  #
  # ENFORCE_TIER=advisory → always allow + hint (overrides GUARD_MODE=strict).
  # ENFORCE_TIER=strict   → always hard-deny (overrides GUARD_MODE=coach).
  # ENFORCE_TIER="" (unset/invalid) → fall back to GUARD_MODE: coach=soft, strict=hard.
  # ENFORCE_TIER=off      → early exit 0 before reaching here; unreachable.
  local should_block=1
  if [[ "$ENFORCE_TIER" == "advisory" ]]; then
    should_block=0
  elif [[ "$ENFORCE_TIER" == "strict" ]]; then
    should_block=1
  elif [[ "$GUARD_MODE" == "coach" ]]; then
    # No ENFORCE_TIER override; coach mode never blocks.
    should_block=0
  fi

  if (( should_block == 0 )); then
    # Allow but surface the recommendation via additionalContext.
    cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "[trace-mcp guard] $reason\\n$context"
  }
}
EOF
    exit 0
  fi

  # Hard block.
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

# ─── Hook backoff (per-session, per-advice-category) ───────────────
# Records how many times we've fired the SAME advice category in this
# session. After HOOK_BACKOFF_LIMIT hits, the next call in the same
# category exits silently — anti-spam for users who set the limit. The
# default is effectively off (1000) to keep legacy behaviour; set
# TRACE_MCP_GUARD_BACKOFF_LIMIT=3 to opt in. Different categories are
# tracked independently. Counters reset when READS_DIR is wiped (per
# session via session_end hook, or after Edit/Write of guarded files).
HOOK_BACKOFF_LIMIT=${TRACE_MCP_GUARD_BACKOFF_LIMIT:-1000}

backoff_hit() {
  local category="$1"
  category=$(echo "$category" | tr -c 'a-zA-Z0-9_-' '_')
  local counter_file="$READS_DIR/.backoff-${category}"
  local count=0
  if [[ -f "$counter_file" ]]; then
    count=$(cat "$counter_file" 2>/dev/null || echo 0)
    count="${count:-0}"
  fi
  count=$((count + 1))
  echo "$count" > "$counter_file" 2>/dev/null || true
  if (( count > HOOK_BACKOFF_LIMIT )); then
    # Demoted: emit nothing, let the tool call proceed silently.
    exit 0
  fi
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

# The server↔hook sentinels live under the state home, NOT $TMPDIR (TRA-869).
# $TMPDIR is per-process: the server is spawned by the MCP client, this hook by
# the agent harness, and on macOS those routinely hold different values (a
# per-user /var/folders/.../T vs. whatever a task runner exports). A sentinel
# written to one is invisible in the other, so the hook reported "server not
# running" against a live session and degraded to the Read/Grep fallback
# trace-mcp exists to replace. $TMPDIR stays as the second choice so a server
# installed before that fix is still found.
TRACE_STATE_HOME="${TRACE_MCP_DATA_DIR:-$HOME/.trace}"
case "$TRACE_STATE_HOME" in "~"/*) TRACE_STATE_HOME="$HOME/${TRACE_STATE_HOME#\~/}" ;; esac
STATUS_HOME="$TRACE_STATE_HOME/status"
TMP_HOME="${TMPDIR:-/tmp}"

# First path that exists; the state-home one when neither does, so anything this
# hook writes itself (the auto-degradation bypass) lands in the shared location.
pick_path() {
  if [[ -e "$1" ]]; then echo "$1"; else echo "$2"; fi
}

CONSULTED_DIR=$(pick_path "$STATUS_HOME/trace-mcp-consulted-${PROJECT_HASH}" "$TMP_HOME/trace-mcp-consulted-${PROJECT_HASH}")
HEARTBEAT_FILE=$(pick_path "$STATUS_HOME/trace-mcp-alive-${PROJECT_HASH}" "$TMP_HOME/trace-mcp-alive-${PROJECT_HASH}")
STATUS_FILE=$(pick_path "$STATUS_HOME/trace-mcp-status-${PROJECT_HASH}.json" "$TMP_HOME/trace-mcp-status-${PROJECT_HASH}.json")
BYPASS_FILE=$(pick_path "$STATUS_HOME/trace-mcp-bypass-${PROJECT_HASH}" "$TMP_HOME/trace-mcp-bypass-${PROJECT_HASH}")
mkdir -p "$STATUS_HOME" 2>/dev/null || true
# Per-session read ledger: written and read by this hook family only, all
# spawned by the same client, so $TMPDIR is the right home for it.
READS_DIR="$TMP_HOME/trace-mcp-reads-${SESSION_ID}"
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

# ─── Navigation streak gate (guard v2 — TRA-711) ───────────────────
# TRA-705 measured the trace path costing 1.45x MORE than a bare grep agent on
# a single light navigation question, at equal correctness (27/30 vs 27/30);
# the advantage only appears on multi-step work (1.39x our way). Routing every
# isolated "where is X defined" through trace-mcp is therefore a measured
# regression, so the guard now stays silent until a session is actually
# crawling: navigation-class denies fire from the NAV_STREAK_MIN'th navigation
# attempt inside a rolling window, not from the first.
#
# Two things reset the streak: a window of quiet (nothing navigational for
# NAV_STREAK_WINDOW_SEC) and a new user prompt (the UserPromptSubmit hook
# clears the counter — a new question is a new streak).
#
# The gate is bypassed entirely for relationship questions ("who calls X",
# "what breaks if I change Y", "which tests cover Z") — the shape where the
# advantage IS measured. The UserPromptSubmit hook flags those.
#
# Security rules (.env access) and the Agent(Explore) rule never pass through
# this gate: they are not navigation-cost tradeoffs.
NAV_STREAK_MIN=${TRACE_MCP_GUARD_NAV_MIN:-3}
NAV_STREAK_WINDOW_SEC=${TRACE_MCP_GUARD_NAV_WINDOW:-300}
NAV_STREAK_FILE="$READS_DIR/.nav-streak"
NAV_FORCE_FILE="$READS_DIR/.nav-force"

# Record one navigation attempt. Exits 0 (silent allow) while the session is
# still below the intervention threshold; returns normally once it is at or
# past it, letting the caller fall through to deny().
nav_hit() {
  # Relationship question in flight → intervene from the first call.
  if [[ -f "$NAV_FORCE_FILE" ]]; then
    return 0
  fi
  if (( NAV_STREAK_MIN <= 1 )); then
    return 0
  fi

  local now count last
  now=$(date +%s)
  count=0
  last=0
  if [[ -f "$NAV_STREAK_FILE" ]]; then
    read -r count last < "$NAV_STREAK_FILE" 2>/dev/null || true
  fi
  [[ "$count" =~ ^[0-9]+$ ]] || count=0
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
  if (( last == 0 || now - last > NAV_STREAK_WINDOW_SEC )); then
    count=0
  fi
  count=$((count + 1))
  echo "$count $now" > "$NAV_STREAK_FILE" 2>/dev/null || true
  if (( count < NAV_STREAK_MIN )); then
    exit 0
  fi
}

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

# No-client-connected detection (GH #297 defect 2): mcp_sessions_active == 0
# is an unambiguous signal that no MCP client is actually attached to this
# process, even when tool_calls_total is 0 (so the stall check above never
# fires) and the heartbeat itself is fresh (the process is alive and ticking
# on its own). Without this, a running-but-never-connected server looks
# identical to a healthy one and the guard hard-blocks demanding tools the
# session doesn't have.
if (( HEARTBEAT_DEAD == 0 )) && [[ -f "$STATUS_FILE" ]]; then
  STATUS_SESSIONS=$(jq -r '.mcp_sessions_active // -1' "$STATUS_FILE" 2>/dev/null || echo -1)
  if [[ "$STATUS_SESSIONS" =~ ^[0-9]+$ ]] && (( STATUS_SESSIONS == 0 )); then
    HEARTBEAT_DEAD=1
    HEARTBEAT_REASON="trace-mcp process is alive but no MCP client is connected (mcp_sessions_active: 0)"
  fi
fi

# Transport mismatch detection (GH #297 defect 1): the status JSON's
# `transport` field records whether the process behind it is `serve`
# (stdio) or `serve-http`. If PROJECT_ROOT/.mcp.json declares trace-mcp with
# a transport that doesn't match, the heartbeat is proof of the WRONG
# process being alive — e.g. a `serve-http` left running while the client is
# configured for stdio `serve`, which never actually started. Only checked
# when both the status file's transport and an unambiguous client
# expectation are available; absent either, we can't tell and don't guess.
if (( HEARTBEAT_DEAD == 0 )) && [[ -f "$STATUS_FILE" ]] && [[ -f "$PROJECT_ROOT/.mcp.json" ]]; then
  STATUS_TRANSPORT=$(jq -r '.transport // empty' "$STATUS_FILE" 2>/dev/null || echo "")
  # trace-mcp entries with a "type"/"url" key are HTTP; entries with a
  # "command" key (no type/url) are stdio. Skip silently on missing/malformed
  # config or an entry not named trace/trace-http/trace-mcp/trace-mcp-http
  # rather than guess. "trace"/"trace-http" are the post-rename keys
  # (TRA-611/614 "Migrate to trace"); the "trace-mcp"/"trace-mcp-http" keys
  # are checked too for pre-migration configs. See TRA-641.
  EXPECTED_TRANSPORT=$(jq -r '
    (.mcpServers // {}) as $s
    | ($s["trace"] // $s["trace-http"] // $s["trace-mcp"] // $s["trace-mcp-http"] // empty) as $e
    | if ($e | length) == 0 then empty
      elif ($e.type == "http") or ($e.url != null) then "http"
      elif ($e.command != null) then "stdio"
      else empty end
  ' "$PROJECT_ROOT/.mcp.json" 2>/dev/null || echo "")
  if [[ -n "$STATUS_TRANSPORT" ]] && [[ -n "$EXPECTED_TRANSPORT" ]] && [[ "$STATUS_TRANSPORT" != "$EXPECTED_TRANSPORT" ]]; then
    HEARTBEAT_DEAD=1
    HEARTBEAT_REASON="trace-mcp heartbeat is from a '${STATUS_TRANSPORT}' process but .mcp.json configures trace-mcp as '${EXPECTED_TRANSPORT}' — the transport your client actually connects over is not running"
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

  # Targeted pre-Edit reads (offset/limit present) — always allow regardless
  # of ENFORCE_TIER. Read-before-Edit is a mandatory workflow step; blocking it
  # would prevent the agent from safely modifying code files. This exemption
  # applies even under strict enforcement because the agent is reading a narrow
  # slice (not doing wholesale exploration).
  READ_OFFSET=$(echo "$INPUT" | jq -r '.tool_input.offset // empty')
  READ_LIMIT=$(echo "$INPUT" | jq -r '.tool_input.limit // empty')
  if [[ -n "$READ_OFFSET" ]] || [[ -n "$READ_LIMIT" ]]; then
    exit 0
  fi

  # .env files — always block, even when heartbeat is dead.
  # Secret leakage risk is independent of trace-mcp availability.
  if is_sensitive_env_file "$FILE_PATH"; then
    REL_PATH=$(echo "$FILE_PATH" | sed "s|^$(pwd)/||")
    deny \
      "Use get_env_vars for .env files — it masks sensitive values (passwords, API keys, tokens)." \
      "trace-mcp alternatives for ${REL_PATH}:\\n- get_env_vars { \\\"file\\\": \\\"${REL_PATH}\\\" } — list keys + types without exposing secrets\\n- get_env_vars { \\\"pattern\\\": \\\"DB_\\\" } — filter by key prefix\\nNever read .env files directly — secrets will leak into AI model context.\\n(Template files like .env.example/.env.sample are allowed.)"
  fi

  # Non-code files — allow, but watch for "Second Brain" / per-feature .md
  # tours. Markdown files co-located with code (e.g. src/pipelines/steps/foo/
  # foo.md sitting next to executor.js) are a popular doc layout. Reading
  # 5+ of them is the same kind of token-burning navigation the guard blocks
  # for .ts files, just under a different extension. Counter is per-session;
  # README/CHANGELOG/LICENSE in repo root are unaffected because they don't
  # live under src/lib/packages/...
  if echo "$FILE_PATH" | grep -qiE "$NONCODE_EXT_RE"; then
    if echo "$FILE_PATH" | grep -qiE '\.md$' \
       && echo "$FILE_PATH" | grep -qE '/(src|lib|packages|apps?|server|client|pkg|internal|modules|services|pipelines|cmd|tests?|specs?|features?)/' \
       && ! echo "$FILE_PATH" | grep -qE '/(docs?|node_modules|vendor|dist|build|\.git|target|out)/'; then
      MD_TOUR_THRESHOLD=${TRACE_MCP_GUARD_MD_HINT_THRESHOLD:-3}
      MD_TOUR_FILE="$READS_DIR/.md-tour-count"
      MD_TOUR_COUNT=0
      if [[ -f "$MD_TOUR_FILE" ]]; then
        MD_TOUR_COUNT=$(cat "$MD_TOUR_FILE" 2>/dev/null || echo 0)
        MD_TOUR_COUNT="${MD_TOUR_COUNT:-0}"
      fi
      MD_TOUR_COUNT=$((MD_TOUR_COUNT + 1))
      echo "$MD_TOUR_COUNT" > "$MD_TOUR_FILE" 2>/dev/null || true
      if (( MD_TOUR_COUNT >= MD_TOUR_THRESHOLD )); then
        REL_PATH=$(echo "$FILE_PATH" | sed "s|^${PROJECT_ROOT}/||")
        allow_with_context \
          "trace-mcp guard: ${MD_TOUR_COUNT}x .md reads inside source dirs this session — looks like a doc tour. For per-feature docs co-located with code, get_feature_context / get_task_context is usually faster than reading docs file-by-file. Reading ${REL_PATH} is allowed; this is a hint, not a block.\\nAlternatives:\\n- get_feature_context { \\\"description\\\": \\\"what these docs describe\\\" }\\n- get_task_context { \\\"task\\\": \\\"what you are working on\\\" }\\n- search { \\\"query\\\": \\\"keyword\\\", \\\"file_pattern\\\": \\\"**/*.md\\\" } — find specific doc by name"
      fi
    fi
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

    # Out-of-repo paths — trace-mcp cannot index them, so strict must not block.
    # A path is out-of-repo when it is absolute and does not start with PROJECT_ROOT,
    # or when REL_PATH still starts with / (absolute path outside cwd).
    if [[ "$FILE_PATH" == /* ]] && [[ "$REL_PATH" == /* ]]; then
      # Absolute path that doesn't live under PROJECT_ROOT — not indexed.
      exit 0
    fi

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

    # Navigation gate: an isolated read is cheaper natively than through us.
    nav_hit
    # No marker → deny. Track repeat denies for escalation.
    DENY_COUNT=0
    if [[ -f "$DENY_STATE" ]]; then
      DENY_COUNT=$(cat "$DENY_STATE" 2>/dev/null || echo 0)
      DENY_COUNT="${DENY_COUNT:-0}"
    fi
    DENY_COUNT=$((DENY_COUNT + 1))
    echo "$DENY_COUNT" > "$DENY_STATE"

    if (( DENY_COUNT >= 2 )); then
      backoff_hit "read-escalated"
      # Escalated: hard imperative, no advisory framing.
      deny \
        "BLOCKED (attempt #${DENY_COUNT}). Read of ${REL_PATH} requires a prior trace-mcp consultation — none recorded." \
        "Required next call: get_outline { \\\"path\\\": \\\"${REL_PATH}\\\" }\\nAfter that call succeeds, Read of this file will be allowed automatically.\\nIf trace-mcp is unreachable, fall back to native tools (Read/Grep) — the guard will auto-degrade after ${AUTO_DEGRADE_DENY_THRESHOLD} consecutive denies with no consultation marker."
    fi

    # First-time deny: standard advisory, no "retry will work" hint.
    echo "0:${CUR_MTIME}" > "$READ_STATE"
    backoff_hit "read-first"
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

  nav_hit
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

  nav_hit
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

  # Git stash internals: `git stash list/show/pop/push/drop/save/apply`,
  # and `git show stash@{N}[:path]` for stash inspection/extraction. These
  # are workflow ops on git-internal refs, not source-code reading, so
  # they bypass the code-ext deny below.
  if echo "$COMMAND" | grep -qE '(^|[ |;&])git +stash( |$)'; then
    exit 0
  fi
  if echo "$COMMAND" | grep -qE '(^|[ |;&])git +show +(--[a-zA-Z=-]+ +)*stash@\{[0-9]+\}(:|$| )'; then
    exit 0
  fi

  # ─── Fallback when trace-mcp can't answer (TRA-845) ───────────────
  # Read/Grep/Glob all degrade to allow-with-warning when the heartbeat is
  # dead, bypassed or auto-degraded. The Bash branch never did, so a stopped
  # daemon hard-denied `grep -rn foo src/`, `cat src/x.ts`, `ls src/` and
  # `git diff` with no working alternative — the "self-inflicted footgun"
  # an external review named. Called immediately before each navigation
  # deny below (not at branch entry) so ordinary Bash calls stay silent.
  # The .env rule above stays unconditional: it is a secrets rule, not a
  # navigation-cost tradeoff.
  # ponytail: reads the liveness verdict only; it deliberately does NOT call
  # maybe_auto_degrade. The deny counter is shared across tools, and feeding
  # it from six Bash sites tripped the auto-bypass on ordinary sessions. Read/
  # Grep/Glob denies still drive it, and the bypass sentinel they write is
  # honoured here — Bash rides along instead of counting twice.
  bash_fallback_if_unavailable() {
    if (( HEARTBEAT_DEAD == 1 )); then
      allow_with_context \
        "trace-mcp guard: ${HEARTBEAT_REASON}. Allowing Bash as fallback — restart trace-mcp to re-enable strict routing."
    fi
  }

  # git show/diff/log -p/blame on code paths — these are de-facto Read.
  if echo "$COMMAND" | grep -qiE "$CODE_EXT_RE"; then
    if echo "$COMMAND" | grep -qE '(^|[ |;&])git +(show|blame|cat-file)( |$)'; then
      bash_fallback_if_unavailable
      nav_hit
      backoff_hit "bash-git-show"
      deny \
        "Use trace-mcp instead of \\\"git show/blame/cat-file\\\" for reading code." \
        "trace-mcp alternatives:\\n- get_symbol { \\\"fqn\\\": \\\"...\\\" } — current source\\n- get_outline { \\\"path\\\": \\\"...\\\" } — file structure\\n- get_changed_symbols / compare_branches — git-aware diffs\\nUse git show/blame/cat-file only on non-code files."
    fi
    if echo "$COMMAND" | grep -qE '(^|[ |;&])git +log +.*(-p|--patch)( |$)'; then
      bash_fallback_if_unavailable
      nav_hit
      backoff_hit "bash-git-log-p"
      deny \
        "Use trace-mcp instead of \\\"git log -p\\\" for reading code." \
        "trace-mcp alternatives:\\n- compare_branches { \\\"branch\\\": \\\"current\\\" } — symbol-level diff\\n- get_changed_symbols { } — diff-aware symbol list"
    fi
    if echo "$COMMAND" | grep -qE '(^|[ |;&])git +diff( |$)'; then
      bash_fallback_if_unavailable
      nav_hit
      backoff_hit "bash-git-diff"
      deny \
        "Use trace-mcp instead of \\\"git diff\\\" on code files." \
        "trace-mcp alternatives:\\n- compare_branches { \\\"branch\\\": \\\"current\\\" } — symbol-level diff\\n- get_changed_symbols { } — diff-aware symbol list\\nUse git diff only on non-code files."
    fi
  fi

  # ─── Shared source-dir heuristic ──────────────────────────────────
  # Used by both the `ls`/`find` rule below and the grep/cat/etc rule further
  # down. Matching on known source-tree directory names (rather than
  # requiring a trailing file extension on the whole command) is what lets
  # these rules catch pathless/recursive forms like `grep -rn foo src/` or
  # `find src -type f` where no filename with an extension ever appears.
  SOURCE_DIR_RE='(^|[ /])(src|lib|packages|apps?|server|client|pkg|internal|modules|services|pipelines|cmd)([/ ]|$)'
  EXCLUDE_DIR_RE='(node_modules|vendor|dist|build|coverage|\.git|\.trace-mcp|target|out)/'
  SAFE_ROOT_RE='(^|[ ])(/tmp|/var|/private|/usr|/etc|~/|\$HOME)'

  # `ls` / `find` on source-tree paths — code exploration disguised as listing.
  # Allows: `ls`, `ls .`, `ls -la`, `ls /tmp/...`, `ls dist/`, `find . -name foo`,
  #         `find /tmp -type f`.
  # Denies: `ls src/...`, `ls /abs/.../packages/foo/`, `find src -type f`,
  #         `find packages/ -name '*.json'`.
  # Pattern: command starts with `ls` or `find` (with the usual command-prefix
  # delimiters) AND any argument component is a known source-tree directory.
  # Note: the existing `find` rule below catches `find ... *.ts` via code-ext
  # match; this rule additionally catches `find src -type f` (no extension).
  if echo "$COMMAND" | grep -qE '(^|[ |;&]|xargs +)(ls|find)( |$)' \
     && echo "$COMMAND" | grep -qE "$SOURCE_DIR_RE" \
     && ! echo "$COMMAND" | grep -qE "$EXCLUDE_DIR_RE" \
     && ! echo "$COMMAND" | grep -qE "$SAFE_ROOT_RE"; then
    bash_fallback_if_unavailable
    nav_hit
    backoff_hit "bash-ls-find"
    deny \
      "Use trace-mcp instead of \\\"ls\\\"/\\\"find\\\" on source-tree paths — it knows your project structure." \
      "trace-mcp alternatives:\\n- get_project_map { \\\"summary_only\\\": true } — frameworks + structure overview\\n- get_outline { \\\"path\\\": \\\"src/foo/bar.ts\\\" } — symbols in a file (cheaper than Read)\\n- search { \\\"query\\\": \\\"keyword\\\", \\\"file_pattern\\\": \\\"src/**\\\" } — find symbols in a tree\\nUse \\\"ls\\\"/\\\"find\\\" only on non-source dirs (dist/, build/, /tmp, ~, node_modules/)."
  fi

  # Safe Bash whitelist (allows env-prefixed forms like `LC_ALL=C git ...`).
  if echo "$COMMAND" | grep -qE "$SAFE_BASH_RE"; then
    exit 0
  fi

  # Code exploration via shell on code files — block.
  # Triggers: grep/rg/find/cat/head/tail/less/more/awk/sed/bat/code/subl/view
  # appearing as a command (start of line or after pipe / && / ; / xargs)
  # combined with EITHER:
  #   - a code-file extension anywhere in the command, not just at the very
  #     end — `$CODE_EXT_RE` is `$`-anchored (correct for whole-path matches
  #     elsewhere in this script) but was being reused here to test substrings
  #     of a whole command line, which misses `cat src/App.tsx | wc -l` and
  #     anything with flags/pipes after the file path, OR
  #   - a known source-tree directory argument with no extension at all —
  #     `grep -rn foo src/`, `grep -rln -i avif app/` — the dominant
  #     real-world shape (recursive/pathless search), which the old
  #     extension-only check never matched.
  CODE_EXT_ANYWHERE_RE='\.(ts|tsx|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|kts|rb|php|cs|cpp|c|h|hpp|swift|scala|vue|svelte|astro|blade\.php)([^a-zA-Z0-9]|$)'
  if echo "$COMMAND" | grep -qE '(^|[ |;&]|xargs +)(grep|rg|find|cat|head|tail|less|more|awk|sed|bat|view|subl|code)( |$)' \
     && ! echo "$COMMAND" | grep -qE "$EXCLUDE_DIR_RE" \
     && ! echo "$COMMAND" | grep -qE "$SAFE_ROOT_RE" \
     && { echo "$COMMAND" | grep -qiE "$CODE_EXT_ANYWHERE_RE" || echo "$COMMAND" | grep -qE "$SOURCE_DIR_RE"; }; then
    bash_fallback_if_unavailable
    nav_hit
    backoff_hit "bash-code-shell"
    deny \
      "Use trace-mcp instead of shell commands for code exploration." \
      "trace-mcp has structured tools for this:\\n- search — find symbols by name\\n- get_symbol — read a specific symbol\\n- get_outline — file structure\\n- find_usages — all usages of a symbol\\nUse Bash only for builds, tests, git, and system commands."
  fi

  # Input redirection from a code file: `cmd < src/foo.ts`.
  if echo "$COMMAND" | grep -qE '< +[^ ]+' && echo "$COMMAND" | grep -qiE "$CODE_EXT_RE"; then
    bash_fallback_if_unavailable
    nav_hit
    backoff_hit "bash-input-redir"
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
    # Allowed verbs — Agent is reasonable for these. The regex matches ANY
    # word in the description (not just the first word), so multi-word
    # descriptions like "add empty-index warning to co_changes" match via
    # `add` and "reduce fps in security scanners" matches via `reduce`.
    #
    # Pure-exploration verbs we deliberately DO NOT add: explore, investigate,
    # understand, find (out), research, discover, document, list, where (is),
    # how (does), analyze (alone — typically maps to exploration; pair it
    # with fix/refactor/etc. to opt back in).
    ALLOW_RE='\b(write|writes|writing|wrote|implement|implements|implementing|implemented|build|builds|building|built|create|creates|creating|created|generate|generates|generating|generated|run|runs|running|ran|execute|executes|executing|executed|test|tests|testing|tested|deploy|deploys|deploying|deployed|publish|publishes|publishing|published|fix|fixes|fixing|fixed|refactor|refactors|refactoring|refactored|migrate|migrates|migrating|migrated|upgrade|upgrades|upgrading|upgraded|configure|configures|configuring|configured|install|installs|installing|installed|fetch|fetches|fetching|fetched|web search|search the web|plan|plans|planning|planned|review pr|review the pr|open a pr|open pr|compare|compares|comparing|compared|audit|audits|auditing|audited|benchmark|benchmarks|benchmarking|benchmarked|measure|measures|measuring|measured|verify|verifies|verifying|verified|evaluate|evaluates|evaluating|evaluated|rewrite|rewrites|rewriting|rewrote|rewritten|convert|converts|converting|converted|expand|expands|expanding|expanded|reduce|reduces|reducing|reduced|flip|flips|flipping|flipped|validate|validates|validating|validated|inspect|inspects|inspecting|inspected|add|adds|adding|added|remove|removes|removing|removed|delete|deletes|deleting|deleted|update|updates|updating|updated|enable|enables|enabling|enabled|disable|disables|disabling|disabled|wire|wires|wiring|wired|port|ports|porting|ported|extract|extracts|extracting|extracted|inline|inlines|inlining|inlined|flatten|flattens|flattening|flattened|harden|hardens|hardening|hardened|patch|patches|patching|patched|bump|bumps|bumping|bumped|rename|renames|renaming|renamed|move|moves|moving|moved|split|splits|splitting|merge|merges|merging|merged|drop|drops|dropping|dropped|introduce|introduces|introducing|introduced|replace|replaces|replacing|replaced|annotate|annotates|annotating|annotated|optimize|optimizes|optimizing|optimized|profile|profiles|profiling|profiled|debug|debugs|debugging|debugged)\b'
    if ! echo "$DESCRIPTION" | grep -qE "$ALLOW_RE"; then
      backoff_hit "agent-no-verb"
      deny \
        "Agent(general-purpose) without an explicit action verb is treated as exploration. Use trace-mcp tools instead — they cost ~4K tokens vs ~50K per agent." \
        "trace-mcp alternatives:\\n- get_task_context { \\\"task\\\": \\\"${DESCRIPTION}\\\" } — replaces exploration agents (~4K tokens)\\n- get_feature_context { \\\"description\\\": \\\"...\\\" } — NL query → relevant code\\n- find_usages / get_call_graph / get_change_impact — relationship analysis\\n- batch { \\\"calls\\\": [...] } — multiple lookups in one call\\nIf this is real coding work, rephrase the description with a concrete action verb (add/fix/refactor/compare/audit/benchmark/rewrite/reduce/expand/extract/harden/wire/...)."
    fi
  fi

  exit 0
fi

exit 0
