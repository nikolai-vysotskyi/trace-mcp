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
REM      Both the English and the Russian shapes of the POSIX hook are matched.
REM      Two things make that work on Windows: this file stays ASCII-only (a
REM      .cmd is read in the machine's OEM codepage, so the Russian
REM      alternatives are written as .NET regex \uXXXX escapes), and stdin is
REM      decoded as UTF-8 explicitly rather than through the console codepage,
REM      so a non-ASCII prompt survives the trip.
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
  "$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8);" ^
  "$input_text = $stdin.ReadToEnd();" ^
  "if (-not $input_text) { exit 0 };" ^
  "try { $env_obj = $input_text | ConvertFrom-Json } catch { exit 0 };" ^
  "$prompt = $env_obj.prompt; if (-not $prompt) { $prompt = $env_obj.user_prompt };" ^
  "$sid = $env_obj.session_id; if (-not $sid) { $sid = 'default' };" ^
  "$navDir = Join-Path $env:TEMP ('trace-mcp-reads-' + $sid);" ^
  "New-Item -ItemType Directory -Force -Path $navDir | Out-Null;" ^
  "Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $navDir '.nav-streak');" ^
  "$navForce = Join-Path $navDir '.nav-force';" ^
  "$navRe = '(who (calls|uses|invokes|imports)|call(ers|ed by|[- ]graph)|what (breaks|will break|would break)|blast radius|impact of (changing|renaming|removing)|affected by|safe to (change|rename|delete|remove)|(which|what) tests|tests? (cover|covering|for)|test coverage (for|of)|all (usages|references|callers|dependents)|where is .* used|depends on this|reverse dependenc)';" ^
  "$navReRu = '(\u043a\u0442\u043e (\u0432\u044b\u0437\u044b\u0432\u0430\u0435\u0442|\u0438\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0435\u0442|\u0438\u043c\u043f\u043e\u0440\u0442\u0438\u0440\u0443\u0435\u0442)|\u0447\u0442\u043e \u0441\u043b\u043e\u043c\u0430\u0435\u0442\u0441\u044f|\u0447\u0442\u043e \u0437\u0430\u0442\u0440\u043e\u043d|\u043d\u0430 \u0447\u0442\u043e \u043f\u043e\u0432\u043b\u0438\u044f|\u043a\u0430\u043a\u0438\u0435 \u0442\u0435\u0441\u0442\u044b|\u0433\u0434\u0435 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0435\u0442\u0441\u044f|\u043a\u0442\u043e \u0437\u0430\u0432\u0438\u0441\u0438\u0442|\u0432\u0441\u0435 (\u0432\u044b\u0437\u043e\u0432\u044b|\u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043d\u0438\u044f|\u043c\u0435\u0441\u0442\u0430 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043d\u0438\u044f))';" ^
  "if ($prompt -and ($prompt -imatch $navRe -or $prompt -imatch $navReRu)) { New-Item -ItemType File -Force -Path $navForce | Out-Null } else { Remove-Item -Force -ErrorAction SilentlyContinue $navForce };" ^
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
