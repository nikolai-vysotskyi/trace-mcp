#!/bin/bash
# trace-mcp-launcher v0.2.0
# Stable shim: MCP clients invoke this path forever; it resolves node + cli.js
# at runtime from a config file written by `trace-mcp init`, with a minimal
# probe fallback for when the config is stale (e.g. Node was reinstalled).
#
# Managed by trace-mcp — do not edit by hand. Re-run `trace-mcp init` to refresh.

set -u

TRACE_HOME="${TRACE_MCP_HOME:-$HOME/.trace-mcp}"
CONFIG="$TRACE_HOME/launcher.env"
LOG="$TRACE_HOME/launcher.log"

log() {
  # Best-effort append; never abort on log failure.
  printf '[%s] %s\n' "$(date -u +%FT%TZ 2>/dev/null || echo '-')" "$1" >> "$LOG" 2>/dev/null || true
}

die() {
  log "ERROR: $1"
  printf 'trace-mcp launcher: %s\n' "$1" >&2
  printf 'Recovery: npm i -g trace-mcp && trace-mcp init\n' >&2
  printf '          (or set TRACE_MCP_NODE_OVERRIDE / TRACE_MCP_CLI_OVERRIDE)\n' >&2
  exit 127
}

# --- 1. Parse config safely (no `source` — RCE-safe, whitelist keys) ---
NODE_PATH=""
CLI_PATH=""

if [ -r "$CONFIG" ]; then
  # Read line by line, split on first `=`, whitelist allowed keys, strip one
  # layer of surrounding quotes. Unknown keys and shell metacharacters in
  # values are never evaluated — values are treated as opaque strings.
  while IFS='=' read -r key value || [ -n "$key" ]; do
    # Skip comments and blank lines
    case "$key" in
      ''|\#*) continue ;;
    esac
    # Strip surrounding double-quotes (emitted by init for safety)
    value="${value%\"}"
    value="${value#\"}"
    case "$key" in
      TRACE_MCP_NODE) NODE_PATH="$value" ;;
      TRACE_MCP_CLI)  CLI_PATH="$value" ;;
      # TRACE_MCP_VERSION exists but is informational only
    esac
  done < "$CONFIG"
fi

# --- 2. Env overrides (escape hatch for debugging) ---
if [ -n "${TRACE_MCP_NODE_OVERRIDE:-}" ]; then NODE_PATH="$TRACE_MCP_NODE_OVERRIDE"; fi
if [ -n "${TRACE_MCP_CLI_OVERRIDE:-}"  ]; then CLI_PATH="$TRACE_MCP_CLI_OVERRIDE";   fi

# --- 3. Fast path: config is good → exec directly ---
if [ -n "$NODE_PATH" ] && [ -x "$NODE_PATH" ] && [ -n "$CLI_PATH" ] && [ -f "$CLI_PATH" ]; then
  log "exec(config) node=$NODE_PATH cli=$CLI_PATH argc=$#"
  exec "$NODE_PATH" "$CLI_PATH" "$@"
fi

# --- 4. Probe fallback (stable sources only, no version globs) ---

# Resolve node from an nvm-layout tree ($1 = root, e.g. ~/.nvm or ~/Library/.../Herd/config/nvm).
# Handles: concrete aliases (v22.22.2), chained aliases (default → lts/hydrogen), and
# major-only shortcuts (default=22 → glob versions/node/v22.*).
node_from_nvm_tree() {
  local root="$1"
  [ -f "$root/alias/default" ] || return 1

  local ver
  ver=$(head -1 "$root/alias/default" 2>/dev/null)
  # Follow up to 2 levels of alias indirection (default → lts/hydrogen → v18.x.y)
  local i
  for i in 1 2; do
    if [ -n "$ver" ] && [ -f "$root/alias/$ver" ]; then
      ver=$(head -1 "$root/alias/$ver" 2>/dev/null)
    fi
  done
  [ -n "$ver" ] || return 1

  # Exact-match: v22.22.2 or bare v22.22.2 (no leading v is legal too)
  if [ -x "$root/versions/node/$ver/bin/node" ]; then
    echo "$root/versions/node/$ver/bin/node"
    return 0
  fi
  if [ -x "$root/versions/node/v$ver/bin/node" ]; then
    echo "$root/versions/node/v$ver/bin/node"
    return 0
  fi

  # Major-only shortcut: alias=`22` → expand to newest v22.* (sort -V = version-sort)
  if [[ "$ver" =~ ^[0-9]+$ ]]; then
    local match
    match=$(ls -d "$root/versions/node/v$ver".* 2>/dev/null | sort -V | tail -1)
    if [ -n "$match" ] && [ -x "$match/bin/node" ]; then
      echo "$match/bin/node"
      return 0
    fi
  fi

  return 1
}

probe_node() {
  # 4a. System-wide stable paths (Homebrew, /usr/local)
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done

  # 4b. Volta — stable symlink regardless of active version
  if [ -x "$HOME/.volta/bin/node" ]; then
    echo "$HOME/.volta/bin/node"
    return 0
  fi

  # 4c. nvm default alias (dereference chained aliases; handle major-only shortcuts)
  if node_from_nvm_tree "$HOME/.nvm"; then return 0; fi

  # 4d. Herd (same nvm-compatible tree)
  if node_from_nvm_tree "$HOME/Library/Application Support/Herd/config/nvm"; then return 0; fi

  # 4e. fnm default alias (three possible locations)
  for fnm_dir in \
    "$HOME/.local/share/fnm/aliases/default" \
    "$HOME/.fnm/aliases/default" \
    "$HOME/Library/Application Support/fnm/aliases/default"; do
    if [ -x "$fnm_dir/bin/node" ]; then
      echo "$fnm_dir/bin/node"
      return 0
    fi
  done

  return 1
}

probe_cli() {
  # Standard layout across nvm/Herd/brew/npm: dist/cli.js sits under
  # <node_prefix>/lib/node_modules/trace-mcp/dist/cli.js
  local node_bin="$1"
  local candidate
  candidate="$(dirname "$node_bin")/../lib/node_modules/trace-mcp/dist/cli.js"
  if [ -f "$candidate" ]; then
    # Normalise the .. path for cleaner logging (best-effort; leave as-is if realpath is missing)
    if command -v realpath >/dev/null 2>&1; then
      realpath "$candidate" 2>/dev/null || echo "$candidate"
    else
      echo "$candidate"
    fi
    return 0
  fi
  return 1
}

if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  NODE_PATH=$(probe_node) || die "node binary not found — install Node.js (brew install node / nvm / volta) or set TRACE_MCP_NODE_OVERRIDE"
  log "probe: node=$NODE_PATH"
fi

if [ -z "$CLI_PATH" ] || [ ! -f "$CLI_PATH" ]; then
  CLI_PATH=$(probe_cli "$NODE_PATH") || die "trace-mcp package not found next to node=$NODE_PATH — run: npm i -g trace-mcp && trace-mcp init"
  log "probe: cli=$CLI_PATH"
fi

log "exec(probe) node=$NODE_PATH cli=$CLI_PATH argc=$#"
exec "$NODE_PATH" "$CLI_PATH" "$@"
