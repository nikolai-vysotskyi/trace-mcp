@echo off
REM trace-mcp-session-end v0.1.0
REM trace-mcp SessionEnd hook (Windows)
REM Lightweight cleanup + journal flush. Soft budget ~5s.

setlocal enabledelayedexpansion

if "%TRACE_MCP_SESSION_END_OFF%"=="1" exit /b 0

set "PROJECT_ROOT=%CD%"

powershell -NoProfile -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$input_text = [Console]::In.ReadToEnd();" ^
  "$sessionId = '';" ^
  "if ($input_text) { try { $env_obj = $input_text | ConvertFrom-Json; $sessionId = [string]$env_obj.session_id } catch {} };" ^
  "if ($sessionId) {" ^
  "  $readsDir = Join-Path $env:TEMP ('trace-mcp-reads-' + $sessionId);" ^
  "  if (Test-Path $readsDir) { Remove-Item $readsDir -Recurse -Force -ErrorAction SilentlyContinue }" ^
  "}" ^
  "$projectRoot = '%PROJECT_ROOT%';" ^
  "$sha = [System.Security.Cryptography.SHA256]::Create();" ^
  "$hash = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($projectRoot))).Replace('-','').Substring(0,12).ToLower();" ^
  "$journalDir = Join-Path $env:USERPROFILE '.trace-mcp\sessions';" ^
  "if (-not (Test-Path $journalDir)) { New-Item -ItemType Directory -Path $journalDir -Force | Out-Null };" ^
  "$journalFile = Join-Path $journalDir ($hash + '-end.log');" ^
  "$ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ');" ^
  "$sid = if ($sessionId) { $sessionId } else { 'unknown' };" ^
  "Add-Content -Path $journalFile -Value ($ts + \"`t\" + $sid) -ErrorAction SilentlyContinue"

exit /b 0
