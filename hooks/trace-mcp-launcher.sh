#!/bin/bash
# trace-mcp-launcher v0.6.0
# Stable shim: MCP clients invoke this path forever; it resolves node + cli.js
# at runtime from a config file written by `trace-mcp init`, with a probe
# fallback for when the config is stale (e.g. Node was reinstalled, or the
# global package moved to a different npm prefix).
#
# Managed by trace-mcp — do not edit by hand. Re-run `trace-mcp init` to refresh.

set -u

# The shim inherits the MCP client's PATH, and a client started in a project
# directory routinely carries that repository's `node_modules/.bin` on it. Every
# helper this script runs (date, sed, head, ls, realpath, mv, ...) would
# otherwise be resolvable to a repo-controlled executable. Pin PATH to system
# directories for our own work and hand the client's PATH back to node right
# before exec — the server itself needs it to find git, LSP servers and npm.
CLIENT_PATH="$PATH"
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

TRACE_HOME="${TRACE_MCP_HOME:-$HOME/.trace}"
CONFIG="$TRACE_HOME/launcher.env"
LOG="$TRACE_HOME/launcher.log"
# One global node_modules root per line, appended by each install.
PKG_ROOTS_FILE="$TRACE_HOME/pkg-roots"

# Rotate once per invocation, before the first append (TRA-702). The shim runs
# once per MCP client launch and writes a couple of lines, so a size check here
# costs one stat and bounds the file at 2 x LOG_MAX_BYTES across both
# generations. Without it launcher.log only ever grew — 9.7 MB observed.
LOG_MAX_BYTES=${TRACE_MCP_LOG_MAX_BYTES:-5242880}
rotate_log() {
  [ -f "$LOG" ] || return 0
  # stat is not portable between GNU and BSD; try both, give up quietly.
  size=$(stat -f %z "$LOG" 2>/dev/null || stat -c %s "$LOG" 2>/dev/null || echo 0)
  case "$size" in
    ''|*[!0-9]*) return 0 ;;
  esac
  [ "$size" -gt "$LOG_MAX_BYTES" ] || return 0
  mv -f "$LOG" "$LOG.1" 2>/dev/null || true
}
rotate_log

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

# cli.js is built for the `engines.node` range in package.json. An older node
# does not fail loudly — it dies on a SyntaxError the MCP client can only report
# as "failed to connect", which is why the major is checked before we exec.
NODE_MIN_MAJOR=${TRACE_MCP_NODE_MIN_MAJOR:-22}
# Env input, and it lands in `[ -lt ]` — bound it here for the same reason
# is_bounded_major exists below. Anything else falls back to the default.
case "$NODE_MIN_MAJOR" in
  [0-9]|[0-9][0-9]|[0-9][0-9][0-9]) ;;
  *) NODE_MIN_MAJOR=22 ;;
esac

# --- 1. Parse config safely (no `source` — RCE-safe, whitelist keys) ---
NODE_PATH=""
CLI_PATH=""
NODE_MAJOR=""

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
      # Major version of TRACE_MCP_NODE, verified when the pair was recorded.
      # Cached so the fast path never has to spawn node just to check it.
      TRACE_MCP_NODE_MAJOR) NODE_MAJOR="$value" ;;
      # TRACE_MCP_VERSION exists but is informational only
    esac
  done < "$CONFIG"
fi

# --- 2. Env overrides (escape hatch for debugging) ---
# USING_OVERRIDE gates persistence (never bake an override into the config);
# USING_NODE_OVERRIDE gates the version check, and only the node override may
# waive that.
USING_OVERRIDE=0
USING_NODE_OVERRIDE=0
if [ -n "${TRACE_MCP_NODE_OVERRIDE:-}" ]; then
  NODE_PATH="$TRACE_MCP_NODE_OVERRIDE"
  USING_OVERRIDE=1
  USING_NODE_OVERRIDE=1
fi
if [ -n "${TRACE_MCP_CLI_OVERRIDE:-}"  ]; then CLI_PATH="$TRACE_MCP_CLI_OVERRIDE";   USING_OVERRIDE=1; fi

# The fast path lives below, after the helpers it needs — see section 3.

# --- 4. Probe fallback (stable sources only, no version globs) ---

# True for a value `[ -lt ]` can safely compare. Digits alone are not enough:
# a long-but-numeric string makes bash arithmetic abort with "integer
# expression expected", the test fails, and the gate would fail OPEN. Three
# digits covers every Node major this shim will ever meet.
is_bounded_major() {
  case "${1:-}" in
    [0-9]|[0-9][0-9]|[0-9][0-9][0-9]) return 0 ;;
    *) return 1 ;;
  esac
}

# Major version of a node binary, or non-zero if it will not run at all.
node_major() {
  local v
  v=$("$1" -v 2>/dev/null) || return 1
  v="${v#v}"
  v="${v%%.*}"
  is_bounded_major "$v" || return 1
  echo "$v"
}

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

# Node shipped inside a prefix we only know about because our package lives
# there: a bundled runtime (Hermes, Antigravity) or a corporate
# `npm config set prefix`. pkg_roots() already enumerates those roots for the
# cli.js lookup; the node beside one of them is exactly the pair
# `trace-mcp init` recorded. Without this, a machine whose ONLY node is such a
# runtime dies with "node binary not found" while a working node + cli.js sit
# on disk — the mirror image of the prefix-pairing bug fixed in v0.4.0.
node_from_pkg_roots() {
  local root candidate
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    # <prefix>/lib/node_modules → <prefix>/bin/node
    candidate="$root/../../bin/node"
    if [ -x "$candidate" ]; then
      normalise_path "$candidate"
      return 0
    fi
  done <<< "$(pkg_roots)"
  return 1
}

# Every node worth trying, one per line, most-likely-first.
node_candidates() {
  local n fnm_dir candidate

  # 4a. System-wide stable paths (Homebrew, /usr/local)
  # 4b. Volta — stable symlink regardless of active version
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    [ -x "$candidate" ] && echo "$candidate"
  done

  # 4c. nvm default alias (dereference chained aliases; handle major-only shortcuts)
  # 4d. Herd (same nvm-compatible tree)
  n=$(node_from_nvm_tree "$HOME/.nvm") && echo "$n"
  n=$(node_from_nvm_tree "$HOME/Library/Application Support/Herd/config/nvm") && echo "$n"

  # 4e. fnm default alias (three possible locations)
  for fnm_dir in \
    "$HOME/.local/share/fnm/aliases/default" \
    "$HOME/.fnm/aliases/default" \
    "$HOME/Library/Application Support/fnm/aliases/default"; do
    [ -x "$fnm_dir/bin/node" ] && echo "$fnm_dir/bin/node"
  done

  # 4f. Last resort: a prefix that only pkg_roots knows about.
  n=$(node_from_pkg_roots) && echo "$n"

  return 0
}

# First candidate new enough to run cli.js. Picking merely the first one that
# exists is what makes a machine whose default node is an old LTS fail forever:
# the exec succeeds, cli.js dies on a SyntaxError, and the pair gets healed into
# launcher.env so every later start repeats it — with no error line anywhere.
probe_node() {
  local c m
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    m=$(node_major "$c") || continue
    if [ "$m" -ge "$NODE_MIN_MAJOR" ]; then
      echo "$c"
      return 0
    fi
  done <<< "$(node_candidates)"
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

  # Roots recorded by past installs. This is how a prefix we cannot name in
  # advance — a bundled runtime, a corporate `npm config set prefix` — becomes
  # findable, without asking npm at runtime. Values are opaque paths, never
  # evaluated; same trust model as launcher.env.
  if [ -r "$PKG_ROOTS_FILE" ]; then
    while IFS= read -r root || [ -n "$root" ]; do
      case "$root" in ''|\#*) continue ;; esac
      [ -d "$root" ] && echo "$root"
    done < "$PKG_ROOTS_FILE"
  fi

  # Runtimes that bundle their own node and install us into it. Named here
  # because their prefix is on no standard list and predates the registry
  # above — an install under one of them now records itself too.
  [ -d "$HOME/.hermes/node/lib/node_modules" ] &&
    echo "$HOME/.hermes/node/lib/node_modules"

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
  local node="$1" cli="$2" major="${3:-}" tmp old_umask
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
    # Cache the verified major so the fast path stays a pure stat check.
    case "$major" in
      ''|*[!0-9]*) ;;
      *) printf 'TRACE_MCP_NODE_MAJOR="%s"\n' "$major" ;;
    esac
    # TRACE_MCP_VERSION is deliberately dropped: the probed cli.js may be a
    # different build than the one the stale config described, and a wrong
    # version is worse than none. `trace-mcp init` restores it.
  } > "$tmp" 2>/dev/null && mv -f "$tmp" "$CONFIG" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  umask "$old_umask"
  return 0
}

# --- 3. Fast path: config is good → exec directly ---
#
# A config recorded before the version gate existed carries no verified major.
# Check it once here (one `node -v`), then cache it, so the check costs nothing
# from the next start on — and an already-poisoned config heals itself instead
# of failing forever.
# Only the NODE override exempts a run from the gate. Sharing one flag with
# TRACE_MCP_CLI_OVERRIDE would let a CLI-only debugging override carry the
# configured node past the check — the exact failure this gate exists to stop.
if [ "$USING_NODE_OVERRIDE" = 0 ] && [ -n "$NODE_PATH" ] && [ -x "$NODE_PATH" ]; then
  if ! is_bounded_major "$NODE_MAJOR"; then
    NODE_MAJOR=$(node_major "$NODE_PATH") || NODE_MAJOR=0
    # Cache only a pair we are actually going to use — never write back a
    # node we are about to reject.
    if [ "$NODE_MAJOR" -ge "$NODE_MIN_MAJOR" ] && [ -n "$CLI_PATH" ] && [ -f "$CLI_PATH" ]; then
      heal_config "$NODE_PATH" "$CLI_PATH" "$NODE_MAJOR"
    fi
  fi
  if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
    log "config node=$NODE_PATH is node $NODE_MAJOR, need >= $NODE_MIN_MAJOR — reprobing"
    NODE_PATH=""
  fi
fi

if [ -n "$NODE_PATH" ] && [ -x "$NODE_PATH" ] && [ -n "$CLI_PATH" ] && [ -f "$CLI_PATH" ]; then
  log "exec(config) node=$NODE_PATH cli=$CLI_PATH argc=$#"
  PATH="$CLIENT_PATH"
  exec "$NODE_PATH" "$CLI_PATH" "$@"
fi

# --- 5. Resolve whatever the config could not ---
HEALED=0

if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
  if ! NODE_PATH=$(probe_node); then
    if [ -n "$(node_candidates)" ]; then
      die "no Node.js >= $NODE_MIN_MAJOR found — trace-mcp needs it; upgrade Node or set TRACE_MCP_NODE_OVERRIDE"
    fi
    die "node binary not found — install Node.js (brew install node / nvm / volta) or set TRACE_MCP_NODE_OVERRIDE"
  fi
  NODE_MAJOR=$(node_major "$NODE_PATH") || NODE_MAJOR=""
  log "probe: node=$NODE_PATH (v$NODE_MAJOR)"
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
  heal_config "$NODE_PATH" "$CLI_PATH" "$NODE_MAJOR"
fi

log "exec(probe) node=$NODE_PATH cli=$CLI_PATH argc=$#"
PATH="$CLIENT_PATH"
exec "$NODE_PATH" "$CLI_PATH" "$@"
