#!/usr/bin/env bash
# Re-enable the trace-mcp PreToolUse guard if it was manually disabled.
# (Equivalent to `bash trace-mcp-disable-guard.sh 0`.)

set -euo pipefail

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
