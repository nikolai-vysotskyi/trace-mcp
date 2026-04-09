@echo off
REM trace-mcp-precompact v0.2.0
REM trace-mcp PreCompact hook (Windows)
REM Injects session snapshot into compacted context to prevent "compaction amnesia".
REM Reads the live snapshot file written by the running trace-mcp MCP server and
REM returns it via the systemMessage field in Claude Code's hook output schema.
REM
REM Also acts as a GC point for guard-hook per-session state dirs
REM (trace-mcp-reads-*, trace-mcp-guard-*) older than 24h.
REM
REM Install: add to ~\.claude\settings.json or .claude\settings.local.json under PreCompact
REM See README.md for setup instructions.

setlocal enabledelayedexpansion

REM --- Guard-hook state GC ---
REM Remove guard-hook per-session state dirs older than 24h (failsafe cleanup).
REM Current session's dir is protected by the 24h threshold.
powershell -NoProfile -Command "Get-ChildItem -Path $env:TEMP -Directory -Filter 'trace-mcp-reads-*' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-24) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue; Get-ChildItem -Path $env:TEMP -Directory -Filter 'trace-mcp-guard-*' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-24) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue" 2>nul

REM Determine project root from working directory
set "PROJECT_ROOT=%CD%"

REM Compute project hash using PowerShell (sha256, first 12 hex chars)
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "[System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes('%PROJECT_ROOT%'))).Replace('-','').Substring(0,12).ToLower()"`) do set "PROJECT_HASH=%%i"

if "%PROJECT_HASH%"=="" goto :done

set "SNAPSHOT_FILE=%USERPROFILE%\.trace-mcp\sessions\%PROJECT_HASH%-snapshot.json"

if not exist "%SNAPSHOT_FILE%" goto :done

REM Read markdown from snapshot file and output as systemMessage
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$j = Get-Content '%SNAPSHOT_FILE%' -Raw | ConvertFrom-Json; if ($j.markdown) { $j.markdown }"`) do set "MARKDOWN=%%i"

if "%MARKDOWN%"=="" goto :done

powershell -NoProfile -Command "$m = (Get-Content '%SNAPSHOT_FILE%' -Raw | ConvertFrom-Json).markdown; @{systemMessage=$m} | ConvertTo-Json -Compress"

:done
exit /b 0
