# trace-mcp-hidden-run v0.1.0 (Windows)
# Hidden launcher shim for trace-mcp Claude Code hooks.
#
# Problem: registering a hook as `cmd /c "...cmd"` makes Windows allocate a
# visible console window for every invocation. During agentic editing the
# PostToolUse reindex hook fires on every Edit/Write/MultiEdit, so dozens of
# console windows flash per minute (issue #230).
#
# Fix: register hooks as
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
#     -WindowStyle Hidden -File "<dir>\trace-mcp-hidden-run.ps1" "<dir>\<hook>.cmd"
# PowerShell launched with -WindowStyle Hidden owns a hidden console; the child
# cmd inherits that hidden console instead of allocating a fresh visible one, so
# nothing flashes. This shim runs the existing, tested .cmd hook logic verbatim
# via `cmd /c`, forwarding stdin (the PostToolUse JSON payload), relaying
# stdout/stderr, and propagating the exit code.
#
# Managed by trace-mcp - do not edit by hand. Re-run `trace-mcp init` to refresh.

#Requires -Version 5.1

$ErrorActionPreference = 'SilentlyContinue'

# The target .cmd hook to run is passed as the first positional argument.
$target = $args[0]
if (-not $target) {
    # No target given: nothing to run. Exit cleanly so a stray registration
    # never blocks a tool call.
    exit 0
}

# Read the hook payload (PostToolUse/PreToolUse JSON etc.) from stdin so it can
# be piped through to the child .cmd, which parses tool_name / file_path from it.
$stdin = [Console]::In.ReadToEnd()

# Run the .cmd via cmd.exe /c inside this hidden console. Piping $stdin forwards
# the JSON payload; stdout/stderr are inherited so any hook output (e.g. the
# SessionStart wake-up context) reaches Claude Code unchanged.
$stdin | & cmd.exe /c "`"$target`""

exit $LASTEXITCODE
