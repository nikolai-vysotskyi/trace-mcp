@echo off
REM trace-mcp-session-start v0.1.0
REM trace-mcp SessionStart hook (Windows)
REM Injects compact wake-up context (~300 tokens) at session start.
REM Soft budget ~15s; degrades silently on failure.

setlocal enabledelayedexpansion

if "%TRACE_MCP_SESSION_START_OFF%"=="1" exit /b 0

REM Locate the trace-mcp CLI.
set "TRACE_MCP_BIN=trace-mcp"
where trace-mcp >nul 2>&1
if errorlevel 1 (
  if exist "%USERPROFILE%\.trace-mcp\bin\trace-mcp.cmd" (
    set "TRACE_MCP_BIN=%USERPROFILE%\.trace-mcp\bin\trace-mcp.cmd"
  ) else (
    exit /b 0
  )
)

set "PROJECT_ROOT=%CD%"

REM Run the wake-up CLI and pipe through PowerShell to format additionalContext.
REM PowerShell handles JSON parsing and shaping into Claude Code's hookSpecificOutput envelope.
powershell -NoProfile -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$json = & '%TRACE_MCP_BIN%' memory wake-up --project '%PROJECT_ROOT%' --json 2>$null;" ^
  "if (-not $json) { exit 0 };" ^
  "try { $w = $json | ConvertFrom-Json } catch { exit 0 };" ^
  "$lines = @();" ^
  "$lines += '[trace-mcp wake-up]';" ^
  "$lines += 'Project: ' + $w.project.name + ' (' + $w.project.root + ')';" ^
  "$lines += 'Decisions: ' + $w.decisions.total_active + ' active';" ^
  "if ($w.decisions.recent.Count -gt 0) {" ^
  "  $lines += 'Recent decisions:';" ^
  "  $top = $w.decisions.recent | Select-Object -First 5;" ^
  "  foreach ($d in $top) {" ^
  "    $title = if ($d.title.Length -gt 80) { $d.title.Substring(0,80)+'...' } else { $d.title };" ^
  "    $link = if ($d.symbol) { ' -> ' + $d.symbol } elseif ($d.file) { ' -> ' + $d.file } else { '' };" ^
  "    $lines += '  - #' + $d.id + ' [' + $d.type + '] ' + $title + $link;" ^
  "  }" ^
  "} else { $lines += 'No recent decisions yet -- run trace-mcp memory mine.' };" ^
  "$lines += 'Memory: ' + $w.memory.sessions_mined + ' sessions mined, ' + $w.memory.sessions_indexed + ' indexed, ' + $w.memory.total_decisions + ' total decisions';" ^
  "$lines += 'Tip: call get_wake_up / query_decisions for richer context.';" ^
  "$ctx = $lines -join \"`n\";" ^
  "@{hookSpecificOutput=@{hookEventName='SessionStart';additionalContext=$ctx}} | ConvertTo-Json -Compress -Depth 5"

exit /b 0
