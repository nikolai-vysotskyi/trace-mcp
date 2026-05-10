@echo off
REM trace-mcp-stop v0.1.0
REM trace-mcp Stop hook (Windows)
REM Async session mining: spawns a detached `trace-mcp memory mine` and exits
REM immediately so the agent's turn completion is never blocked.

setlocal enabledelayedexpansion

if "%TRACE_MCP_STOP_OFF%"=="1" exit /b 0

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

REM Single-flight + detached background mine via PowerShell Start-Process.
REM `-WindowStyle Hidden -PassThru` avoids a console flash and lets us write
REM the PID for cooperative single-flight checking.
powershell -NoProfile -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$projectRoot = '%PROJECT_ROOT%';" ^
  "$sha = [System.Security.Cryptography.SHA256]::Create();" ^
  "$hash = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($projectRoot))).Replace('-','').Substring(0,12).ToLower();" ^
  "$lockFile = Join-Path $env:TEMP ('trace-mcp-stop-mining-' + $hash + '.pid');" ^
  "if (Test-Path $lockFile) {" ^
  "  $oldPid = Get-Content $lockFile -ErrorAction SilentlyContinue;" ^
  "  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { exit 0 };" ^
  "  Remove-Item $lockFile -ErrorAction SilentlyContinue;" ^
  "}" ^
  "$logFile = Join-Path $env:TEMP ('trace-mcp-stop-mining-' + $hash + '.log');" ^
  "$proc = Start-Process -FilePath '%TRACE_MCP_BIN%' -ArgumentList @('memory','mine','--project',$projectRoot) -WindowStyle Hidden -PassThru -RedirectStandardOutput $logFile -RedirectStandardError $logFile;" ^
  "if ($proc) { $proc.Id | Out-File -FilePath $lockFile -Encoding ascii -Force }"

exit /b 0
