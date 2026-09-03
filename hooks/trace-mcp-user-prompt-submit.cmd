@echo off
REM trace-mcp-user-prompt-submit v0.3.0
REM trace-mcp UserPromptSubmit hook (Windows)
REM
REM Two jobs, in this order:
REM   1. Guard v2 routing signal (TRA-711, ported to Windows in TRA-757). Each
REM      new user prompt starts a new navigation streak, so the counter the
REM      PreToolUse guard keeps is cleared here. The prompt is also matched
REM      against relationship-question shapes ("who calls X", "what breaks if I
REM      change Y", "which tests cover Z") - the shape where TRA-705 measured
REM      trace-mcp winning; a match writes a flag that makes the guard route
REM      from the FIRST navigation call instead of waiting for the third.
REM      Unlike the POSIX hook this matches English shapes only: a .cmd file is
REM      read in the machine's OEM codepage, so non-ASCII patterns cannot be
REM      embedded here reliably.
REM   2. Injects top-3 FTS5 decision matches as additionalContext on each prompt.
REM
REM Soft budget ~10s; degrades silently.

setlocal enabledelayedexpansion

if "%TRACE_MCP_USER_PROMPT_OFF%"=="1" exit /b 0

REM A missing CLI must not cost us the guard signal (job 1 needs no binary), so
REM it leaves TRACE_MCP_BIN empty and PowerShell skips job 2 instead of exiting.
set "TRACE_MCP_BIN=trace-mcp"
where trace-mcp >nul 2>&1
if errorlevel 1 (
  if exist "%USERPROFILE%\.trace-mcp\bin\trace-mcp.cmd" (
    set "TRACE_MCP_BIN=%USERPROFILE%\.trace-mcp\bin\trace-mcp.cmd"
  ) else (
    set "TRACE_MCP_BIN="
  )
)

set "PROJECT_ROOT=%CD%"

REM PowerShell reads stdin (the Claude Code hook envelope), extracts the prompt,
REM runs the decisions search, and emits the additionalContext envelope.
powershell -NoProfile -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$input_text = [Console]::In.ReadToEnd();" ^
  "if (-not $input_text) { exit 0 };" ^
  "try { $env_obj = $input_text | ConvertFrom-Json } catch { exit 0 };" ^
  "$prompt = $env_obj.prompt; if (-not $prompt) { $prompt = $env_obj.user_prompt };" ^
  "$sid = $env_obj.session_id; if (-not $sid) { $sid = 'default' };" ^
  "$navDir = Join-Path $env:TEMP ('trace-mcp-reads-' + $sid);" ^
  "New-Item -ItemType Directory -Force -Path $navDir | Out-Null;" ^
  "Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $navDir '.nav-streak');" ^
  "$navForce = Join-Path $navDir '.nav-force';" ^
  "$navRe = '(who (calls|uses|invokes|imports)|call(ers|ed by|[- ]graph)|what (breaks|will break|would break)|blast radius|impact of (changing|renaming|removing)|affected by|safe to (change|rename|delete|remove)|(which|what) tests|tests? (cover|covering|for)|test coverage (for|of)|all (usages|references|callers|dependents)|where is .* used|depends on this|reverse dependenc)';" ^
  "if ($prompt -and $prompt -imatch $navRe) { New-Item -ItemType File -Force -Path $navForce | Out-Null } else { Remove-Item -Force -ErrorAction SilentlyContinue $navForce };" ^
  "if (-not $prompt) { exit 0 };" ^
  "if (-not '%TRACE_MCP_BIN%') { exit 0 };" ^
  "$query = ($prompt -replace \"`n\",' ').Substring(0, [Math]::Min(200, $prompt.Length));" ^
  "$json = & '%TRACE_MCP_BIN%' memory decisions --project '%PROJECT_ROOT%' --search $query --limit 3 --json 2>$null;" ^
  "if (-not $json) { exit 0 };" ^
  "try { $list = $json | ConvertFrom-Json } catch { exit 0 };" ^
  "if (-not $list -or $list.Count -eq 0) { exit 0 };" ^
  "$lines = @('[trace-mcp memory] ' + $list.Count + ' relevant decision(s) for your prompt:');" ^
  "foreach ($d in $list) {" ^
  "  $title = if ($d.title.Length -gt 100) { $d.title.Substring(0,100)+'...' } else { $d.title };" ^
  "  $content = if ($d.content -and $d.content.Length -gt 240) { $d.content.Substring(0,240)+'...' } else { $d.content };" ^
  "  $lines += '  - #' + $d.id + ' [' + $d.type + '] ' + $title;" ^
  "  if ($content) { $lines += '    ' + $content };" ^
  "  if ($d.symbol_id) { $lines += '    -> ' + $d.symbol_id }" ^
  "  elseif ($d.file_path) { $lines += '    -> ' + $d.file_path };" ^
  "}" ^
  "$lines += 'If any of these contradict the request, surface the conflict before acting.';" ^
  "$ctx = $lines -join \"`n\";" ^
  "@{hookSpecificOutput=@{hookEventName='UserPromptSubmit';additionalContext=$ctx}} | ConvertTo-Json -Compress -Depth 5"

exit /b 0
