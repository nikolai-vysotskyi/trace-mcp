#!/usr/bin/env bash
# Re-enable the trace-mcp PreToolUse guard if it was manually disabled,
# and optionally set the enforcement tier for the hook.
#
# Usage:
#   bash scripts/trace-mcp-enable-guard.sh            # re-enable, advisory tier (default)
#   bash scripts/trace-mcp-enable-guard.sh --strict   # re-enable, strict tier (hard-deny)
#   bash scripts/trace-mcp-enable-guard.sh --advisory # re-enable, advisory tier (explicit)
#
# The --strict flag writes TRACE_MCP_ENFORCE=strict into the guard hook's env
# block in the Claude Code settings file so the setting persists across sessions.
# Running without --strict (or with --advisory) writes TRACE_MCP_ENFORCE=advisory,
# which reverts a previous --strict install.
#
# Enforcement tiers:
#   advisory (default): warn the agent on each violation, allow the tool call.
#   strict:             hard-deny the tool call; agent must use trace-mcp instead.
#   off:                set via TRACE_MCP_ENFORCE=off in env; no script flag.

set -euo pipefail

# ─── Parse arguments ───────────────────────────────────────────────
ENFORCE_TIER="advisory"
for arg in "$@"; do
  case "$arg" in
    --strict)   ENFORCE_TIER="strict" ;;
    --advisory) ENFORCE_TIER="advisory" ;;
    *)
      echo "usage: $0 [--strict | --advisory]" >&2
      exit 1
      ;;
  esac
done

# ─── Remove the bypass sentinel (re-enable normal guard operation) ──
PROJECT_ROOT="$(pwd)"
if command -v sha256sum >/dev/null 2>&1; then
  PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | sha256sum | cut -c1-12)
elif command -v shasum >/dev/null 2>&1; then
  PROJECT_HASH=$(echo -n "$PROJECT_ROOT" | shasum -a 256 | cut -c1-12)
else
  echo "error: neither sha256sum nor shasum found" >&2
  exit 1
fi

BYPASS_FILE="${TMPDIR:-/tmp}/trace-mcp-bypass-${PROJECT_HASH}"
rm -f "$BYPASS_FILE"
echo "trace-mcp guard re-enabled for: $PROJECT_ROOT"

# ─── Persist TRACE_MCP_ENFORCE in the hook env block ───────────────
# Find the settings file that contains the guard hook entry and update
# the env block so the setting survives across sessions.
# We look in both global (~/.claude/settings.json) and local
# (.claude/settings.local.json) — update whichever contains the hook.
#
# Claude Code settings schema for a hook with env:
#   { "hooks": { "PreToolUse": [ { "matcher": "...", "hooks": [
#     { "type": "command", "command": "...", "env": { "KEY": "VALUE" } }
#   ] } ] } }
#
# We use Python (universally available on macOS/Linux) for JSON mutation
# to avoid jq's write limitations.

_update_settings() {
  local settings_file="$1"
  [[ -f "$settings_file" ]] || return 0

  python3 - "$settings_file" "$ENFORCE_TIER" <<'PYEOF'
import json, sys, os, tempfile

settings_file = sys.argv[1]
enforce_tier  = sys.argv[2]

with open(settings_file, 'r') as f:
    settings = json.load(f)

hooks_block = settings.get('hooks', {})
pre_tool_use = hooks_block.get('PreToolUse', [])

changed = False
for entry in pre_tool_use:
    hook_list = entry.get('hooks', [])
    for hook in hook_list:
        cmd = hook.get('command', '')
        if 'trace-mcp-guard' in cmd:
            env = hook.get('env', {})
            if env.get('TRACE_MCP_ENFORCE') != enforce_tier:
                env['TRACE_MCP_ENFORCE'] = enforce_tier
                hook['env'] = env
                changed = True

if not changed:
    sys.exit(0)

# Atomic write via temp file + rename.
dir_ = os.path.dirname(settings_file) or '.'
with tempfile.NamedTemporaryFile('w', dir=dir_, suffix='.tmp', delete=False) as tf:
    json.dump(settings, tf, indent=2)
    tf.write('\n')
    tmp = tf.name
os.replace(tmp, settings_file)
sys.exit(0)
PYEOF
}

HOME_DIR="$HOME"
GLOBAL_SETTINGS="${HOME_DIR}/.claude/settings.json"
LOCAL_SETTINGS=".claude/settings.local.json"

# Try global first, then local — update whichever has the hook registered.
_update_settings "$GLOBAL_SETTINGS" || true
_update_settings "$LOCAL_SETTINGS"  || true

if [[ "$ENFORCE_TIER" == "strict" ]]; then
  echo "Enforcement tier set to STRICT — the guard will hard-deny native Read/Grep/ls/find on indexed source paths."
  echo "Agents must use trace-mcp tools (search / get_outline / get_symbol / find_usages / search_text) instead."
  echo "Revert: bash scripts/trace-mcp-enable-guard.sh --advisory"
else
  echo "Enforcement tier set to ADVISORY — the guard will warn but allow native tool calls."
fi
