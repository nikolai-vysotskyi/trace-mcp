#!/bin/bash
# trace-mcp-launcher v0.4.0
# Stable shim: MCP clients invoke this path forever; it resolves node + cli.js
# at runtime from a config file written by `trace-mcp init`, with a probe
# fallback for when the config is stale (e.g. Node was reinstalled, or the
# global package moved to a different npm prefix).
#
# Managed by trace-mcp — do not edit by hand. Re-run `trace-mcp init` to refresh.

set -u

TRACE_HOME="${TRACE_MCP_HOME:-$HOME/.trace}"
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
USING_OVERRIDE=0
if [ -n "${TRACE_MCP_NODE_OVERRIDE:-}" ]; then NODE_PATH="$TRACE_MCP_NODE_OVERRIDE"; USING_OVERRIDE=1; fi
if [ -n "${TRACE_MCP_CLI_OVERRIDE:-}"  ]; then CLI_PATH="$TRACE_MCP_CLI_OVERRIDE";   USING_OVERRIDE=1; fi

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

# Print every global `node_modules` root worth searching, one per line,
# most-likely-first.
#
# Node and cli.js are resolved INDEPENDENTLY on purpose: any working node can
# run any cli.js. Tying the package lookup to the prefix of the selected node
# (the pre-v0.4.0 behaviour) killed the server whenever the two lived in
# different prefixes — the single largest source of launcher failures.
#
# $1 (optional): the node binary we are about to use; its own prefix is tried
# first, since that is the pair `trace-mcp init` recorded.
pkg_roots() {
  local n fnm_dir root
  if [ -n "${1:-}" ]; then
    echo "$(dirname "$1")/../lib/node_modules"
  fi

  # Version-manager prefixes first: that is where `npm i -g` lands for nvm /
  # Herd / fnm / Volta users, which is most of them.
  if n=$(node_from_nvm_tree "$HOME/.nvm"); then
    echo "$(dirname "$n")/../lib/node_modules"
  fi
  if n=$(node_from_nvm_tree "$HOME/Library/Application Support/Herd/config/nvm"); then
    echo "$(dirname "$n")/../lib/node_modules"
  fi
  for fnm_dir in \
    "$HOME/.local/share/fnm/aliases/default" \
    "$HOME/.fnm/aliases/default" \
    "$HOME/Library/Application Support/fnm/aliases/default"; do
    [ -d "$fnm_dir/lib/node_modules" ] && echo "$fnm_dir/lib/node_modules"
  done
  # Volta keeps each global package under its own image directory.
  [ -d "$HOME/.volta/tools/image/packages/trace-mcp/lib/node_modules" ] &&
    echo "$HOME/.volta/tools/image/packages/trace-mcp/lib/node_modules"

  # System prefixes.
  for root in /opt/homebrew/lib/node_modules /usr/local/lib/node_modules; do
    [ -d "$root" ] && echo "$root"
  done

  # Custom prefixes (`npm config set prefix`) and bundled runtimes we don't
  # know by name. Read from config, never by running `npm root -g`: the shim
  # inherits the MCP client's PATH, which in a project directory can contain a
  # repository-controlled `node_modules/.bin`, so spawning a PATH-resolved
  # `npm` would turn a stale config into code execution from the opened repo
  # (and could hang the handshake on top of that).
  n="${NPM_CONFIG_PREFIX:-}"
  if [ -z "$n" ] && [ -r "$HOME/.npmrc" ]; then
    n=$(sed -n 's/^[[:space:]]*prefix[[:space:]]*=[[:space:]]*//p' "$HOME/.npmrc" | tail -1)
    # Strip surrounding quotes and expand a leading ~ — npm accepts both.
    n="${n%\"}"; n="${n#\"}"; n="${n%\'}"; n="${n#\'}"
    case "$n" in '~'/*) n="$HOME/${n#\~/}" ;; esac
  fi
  [ -n "$n" ] && [ -d "$n/lib/node_modules" ] && echo "$n/lib/node_modules"

  return 0
}

# Normalise a `..`-containing path for cleaner logging and config rewrites.
# Best-effort: leave it as-is when realpath is unavailable.
normalise_path() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1" 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

# Find dist/cli.js in any known global root. $1 = roots, newline-separated.
probe_cli() {
  local roots="$1" root cli bak

  while IFS= read -r root; do
    [ -n "$root" ] || continue
    cli="$root/trace-mcp/dist/cli.js"
    if [ -f "$cli" ]; then
      normalise_path "$cli"
      return 0
    fi
  done <<< "$roots"

  # Last resort: an update is swapping the package right this second. Both npm
  # and our own updater rename the live directory aside before unpacking the
  # new one, so a stale-but-working copy is on disk for the length of the
  # window. Serving the previous version beats losing every tool for the
  # rest of the client's session.
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    for bak in "$root"/trace-mcp.tmcp-bak-* "$root"/.trace-mcp-*; do
      if [ -f "$bak/dist/cli.js" ]; then
        normalise_path "$bak/dist/cli.js"
        return 0
      fi
    done
  done <<< "$roots"

  return 1
}

# Persist a freshly probed pair so the next start takes the fast path, and so
# a client that never reaches `trace-mcp init` still stops paying for the probe.
heal_config() {
  local node="$1" cli="$2" tmp old_umask
  # The shim strips exactly one pair of quotes and never expands; a literal
  # quote in a path would corrupt the file, so skip rather than mangle.
  case "$node$cli" in *'"'*) return 0 ;; esac
  # Never pin the config to a swap-window backup: that directory is about to
  # be deleted, so the "fast path" it buys would be a dangling one.
  case "$cli" in
    *trace-mcp.tmcp-bak-*|*/.trace-mcp-*) return 0 ;;
  esac
  if [ ! -d "$TRACE_HOME" ]; then
    mkdir -p "$TRACE_HOME" 2>/dev/null || return 0
    chmod 700 "$TRACE_HOME" 2>/dev/null || true
  fi
  tmp="$CONFIG.tmp.$$"
  # launcher.env is a 0600 file by contract (src/init/launcher.ts). The
  # process umask must not be allowed to widen it during a heal.
  old_umask=$(umask)
  umask 077
  {
    printf '# Managed by trace-mcp — do not edit by hand.\n'
    printf '# Rewritten by the launcher after a successful probe.\n'
    printf 'TRACE_MCP_NODE="%s"\n' "$node"
    printf 'TRACE_MCP_CLI="%s"\n' "$cli"
    # TRACE_MCP_VERSION is deliberately dropped: the probed cli.js may be a
    # different build than the one the stale config described, and a wrong
    # version is worse than none. `trace-mcp init` restores it.
  } > "$tmp" 2>/dev/null && mv -f "$tmp" "$CONFIG" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  umask "$old_umask"
  return 0
}

HEALED=0

if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  NODE_PATH=$(probe_node) || die "node binary not found — install Node.js (brew install node / nvm / volta) or set TRACE_MCP_NODE_OVERRIDE"
  log "probe: node=$NODE_PATH"
  HEALED=1
fi

if [ -z "$CLI_PATH" ] || [ ! -f "$CLI_PATH" ]; then
  ROOTS=$(pkg_roots "$NODE_PATH")
  CLI_PATH=$(probe_cli "$ROOTS") || die "trace-mcp package not found in any known npm prefix — run: npm i -g trace-mcp && trace-mcp init"
  log "probe: cli=$CLI_PATH"
  HEALED=1
fi

# Overrides are a debugging escape hatch; never bake them into the config.
if [ "$HEALED" = 1 ] && [ "$USING_OVERRIDE" = 0 ]; then
  heal_config "$NODE_PATH" "$CLI_PATH"
fi

log "exec(probe) node=$NODE_PATH cli=$CLI_PATH argc=$#"
exec "$NODE_PATH" "$CLI_PATH" "$@"
