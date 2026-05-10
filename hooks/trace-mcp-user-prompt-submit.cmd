@echo off
REM trace-mcp-user-prompt-submit v0.1.0
REM trace-mcp UserPromptSubmit hook (Windows)
REM Injects top-3 FTS5 decision matches as additionalContext on each prompt.
REM Soft budget ~10s; degrades silently.

setlocal enabledelayedexpansion

if "%TRACE_MCP_USER_PROMPT_OFF%"=="1" exit /b 0

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

REM PowerShell reads stdin (the Claude Code hook envelope), extracts the prompt,
REM runs the decisions search, and emits the additionalContext envelope.
powershell -NoProfile -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$input_text = [Console]::In.ReadToEnd();" ^
  "if (-not $input_text) { exit 0 };" ^
  "try { $env_obj = $input_text | ConvertFrom-Json } catch { exit 0 };" ^
  "$prompt = $env_obj.prompt; if (-not $prompt) { $prompt = $env_obj.user_prompt };" ^
  "if (-not $prompt) { exit 0 };" ^
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
